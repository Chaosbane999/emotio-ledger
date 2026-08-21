const express = require('express');
const crypto = require('crypto');
const path = require('path');

const { db, get, set } = require('./db');
const cap = require('./capacity');
const schedule = require('./schedule');
const harvest = require('./harvest');
const seed = require('./seed');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSCODE = process.env.APP_PASSCODE || '';
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// ---- passcode gate, same shape as EmotioGantt ----
const authToken = PASSCODE ? crypto.createHash('sha256').update(PASSCODE).digest('hex') : null;

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const clientIp = (req) => (req.ip || '').replace(/^::ffff:/, '');

const loginFails = new Map();
app.post('/login', (req, res) => {
  if (!authToken) return res.json({ ok: true });
  const ip = clientIp(req);
  const fails = loginFails.get(ip) || 0;
  setTimeout(() => {
    if ((req.body.passcode || '') === PASSCODE) {
      loginFails.delete(ip);
      res.setHeader('Set-Cookie',
        `el_auth=${authToken}; Path=/; HttpOnly; SameSite=Lax;${req.secure ? ' Secure;' : ''} Max-Age=31536000`);
      return res.json({ ok: true });
    }
    loginFails.set(ip, fails + 1);
    res.status(401).json({ ok: false });
  }, Math.min(5000, Math.max(0, fails - 4) * 1000));
});

app.use((req, res, next) => {
  if (!authToken) return next();
  if (ALLOWED_IPS.includes(clientIp(req))) return next();
  if (readCookie(req, 'el_auth') === authToken) return next();
  if (req.path === '/login.html' || req.path.startsWith('/style.css')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not signed in' });
  return res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const period = (req) => req.query.period || get('default_period') || cap.thisPeriod();
const num = (v, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v));

/** Wrap a handler so thrown errors become clean JSON rather than a stack. */
const ok = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
};
const okAsync = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
};

const listPeople = () => db.prepare('SELECT * FROM people ORDER BY active = 0, sort_order, name').all();
const listDeliverables = () => db.prepare('SELECT * FROM deliverables WHERE active = 1 ORDER BY internal, sort_order').all();
const listThirdParties = () => db.prepare('SELECT * FROM third_parties WHERE active = 1 ORDER BY sort_order, name').all();
const listContracts = () => db.prepare('SELECT * FROM contracts WHERE archived = 0 ORDER BY sort_order, name').all();

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

app.get('/api/bootstrap', ok((req, res) => {
  const p = period(req);
  res.json({
    period: p,
    periods: [-3, -2, -1, 0, 1, 2].map((d) => cap.shiftPeriod(p, d)),
    people: listPeople(),
    deliverables: listDeliverables(),
    third_parties: listThirdParties(),
    channels: db.prepare('SELECT * FROM channels ORDER BY sort_order, name').all(),
    contracts: listContracts(),
    settings: {
      standard_rate: cap.standardRate(),
      work_start: get('work_start'),
      work_end: get('work_end'),
      lunch_start: get('lunch_start'),
      lunch_minutes: Number(get('lunch_minutes')),
      max_client_minutes_per_day: Number(get('max_client_minutes_per_day')),
      holidays: get('holidays') || '',
      harvest_connected: harvest.configured(),
      harvest_account_id: get('harvest_account_id') || '',
      last_sync: get('last_sync') || '',
    },
  });
}));

app.get('/api/agency', ok((req, res) => res.json(cap.agencySummary(period(req)))));

app.get('/api/person/:id', ok((req, res) => {
  const v = cap.personView(Number(req.params.id), period(req));
  if (!v) return res.status(404).json({ error: 'no such person' });
  res.json(v);
}));

app.get('/api/contract/:id', ok((req, res) => {
  const p = period(req);
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'no such contract' });

  const actuals = db.prepare(`
    SELECT a.person_id, a.deliverable_id, SUM(a.hours) AS hours,
           p.name AS person_name, d.name AS deliverable_name
      FROM actuals a
      LEFT JOIN people p       ON p.id = a.person_id
      LEFT JOIN deliverables d ON d.id = a.deliverable_id
     WHERE a.contract_id = ? AND a.period = ?
     GROUP BY a.person_id, a.deliverable_id`).all(c.id, p);

  res.json({
    contract: c,
    summary: cap.contractSummary(c, p),
    channels: db.prepare('SELECT channel_id FROM contract_channels WHERE contract_id = ?')
      .all(c.id).map((r) => r.channel_id),
    actuals: actuals.map((a) => ({ ...a, hours: cap.round2(a.hours) })),
    actual_hours: cap.round2(actuals.reduce((s, a) => s + a.hours, 0)),
  });
}));

app.get('/api/leave', ok((req, res) => {
  res.json(db.prepare('SELECT * FROM leave WHERE period = ?').all(period(req)));
}));

// ---------------------------------------------------------------------------
// write — allocations
// ---------------------------------------------------------------------------

app.post('/api/allocation', ok((req, res) => {
  const { contract_id, person_id, deliverable_id } = req.body;
  const p = req.body.period || period(req);
  const hours = Math.max(0, num(req.body.hours));
  if (!contract_id || !person_id || !deliverable_id) throw new Error('contract, person and deliverable are all required');

  if (hours === 0) {
    db.prepare('DELETE FROM allocations WHERE contract_id=? AND period=? AND person_id=? AND deliverable_id=?')
      .run(contract_id, p, person_id, deliverable_id);
  } else {
    db.prepare(`INSERT INTO allocations (contract_id, period, person_id, deliverable_id, hours)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contract_id, period, person_id, deliverable_id)
      DO UPDATE SET hours = excluded.hours`).run(contract_id, p, person_id, deliverable_id, hours);
  }
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract_id);
  res.json(cap.contractSummary(c, p));
}));

app.post('/api/tp-allocation', ok((req, res) => {
  const { contract_id, third_party_id } = req.body;
  const p = req.body.period || period(req);
  const units = Math.max(0, num(req.body.units));
  if (!contract_id || !third_party_id) throw new Error('contract and service are both required');

  if (units === 0) {
    db.prepare('DELETE FROM tp_allocations WHERE contract_id=? AND period=? AND third_party_id=?')
      .run(contract_id, p, third_party_id);
  } else {
    db.prepare(`INSERT INTO tp_allocations (contract_id, period, third_party_id, units) VALUES (?, ?, ?, ?)
      ON CONFLICT(contract_id, period, third_party_id) DO UPDATE SET units = excluded.units`)
      .run(contract_id, p, third_party_id, units);
  }
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract_id);
  res.json(cap.contractSummary(c, p));
}));

app.post('/api/carryover', ok((req, res) => {
  const { contract_id } = req.body;
  const p = req.body.period || period(req);
  const units = num(req.body.units);
  if (!contract_id) throw new Error('contract is required');
  if (units === 0) {
    db.prepare('DELETE FROM carryover WHERE contract_id = ? AND period = ?').run(contract_id, p);
  } else {
    db.prepare(`INSERT INTO carryover (contract_id, period, units, from_period, note) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contract_id, period) DO UPDATE SET
        units = excluded.units, from_period = excluded.from_period, note = excluded.note`)
      .run(contract_id, p, units, req.body.from_period || cap.shiftPeriod(p, -1), req.body.note || '');
  }
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract_id);
  res.json(cap.contractSummary(c, p));
}));

app.post('/api/contract/:id/channels', ok((req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM contract_channels WHERE contract_id = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO contract_channels (contract_id, channel_id) VALUES (?, ?)');
  for (const ch of req.body.channels || []) ins.run(id, Number(ch));
  res.json({ ok: true });
}));

app.post('/api/leave', ok((req, res) => {
  const { person_id } = req.body;
  const p = req.body.period || period(req);
  db.prepare(`INSERT INTO leave (person_id, period, annual_hours, sick_hours) VALUES (?, ?, ?, ?)
    ON CONFLICT(person_id, period) DO UPDATE SET
      annual_hours = excluded.annual_hours, sick_hours = excluded.sick_hours`)
    .run(person_id, p, Math.max(0, num(req.body.annual_hours)), Math.max(0, num(req.body.sick_hours)));
  res.json(cap.agencySummary(p));
}));

// ---------------------------------------------------------------------------
// write — settings CRUD
// ---------------------------------------------------------------------------

app.post('/api/people', ok((req, res) => {
  const b = req.body;
  if (b.id) {
    db.prepare(`UPDATE people SET name=?, initials=?, weekly_hours=?, rate=?, utilisation=?, active=?, harvest_user_id=?
      WHERE id=?`).run(b.name, b.initials || '', num(b.weekly_hours, 37.5), num(b.rate, 100),
      Math.min(1, Math.max(0, num(b.utilisation, 0.87))), b.active ? 1 : 0,
      b.harvest_user_id ? Number(b.harvest_user_id) : null, b.id);
  } else {
    db.prepare(`INSERT INTO people (name, initials, weekly_hours, rate, utilisation, active, harvest_user_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, 50)`).run(b.name, b.initials || '', num(b.weekly_hours, 37.5),
      num(b.rate, 100), Math.min(1, Math.max(0, num(b.utilisation, 0.87))), b.active ? 1 : 0,
      b.harvest_user_id ? Number(b.harvest_user_id) : null);
  }
  res.json(listPeople());
}));

app.delete('/api/people/:id', ok((req, res) => {
  db.prepare('UPDATE people SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json(listPeople());
}));

app.post('/api/contracts', ok((req, res) => {
  const b = req.body;
  const fields = [b.name, b.exec_person_id || null, b.type || 'retainer', b.status || 'live',
    num(b.monthly_units), num(b.pot_units), b.pot_start || null, b.pot_end || null,
    b.harvest_ids || '', b.notes || ''];
  if (b.id) {
    db.prepare(`UPDATE contracts SET name=?, exec_person_id=?, type=?, status=?, monthly_units=?,
      pot_units=?, pot_start=?, pot_end=?, harvest_ids=?, notes=? WHERE id=?`).run(...fields, b.id);
  } else {
    db.prepare(`INSERT INTO contracts (name, exec_person_id, type, status, monthly_units,
      pot_units, pot_start, pot_end, harvest_ids, notes, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 50)`).run(...fields);
  }
  res.json(listContracts());
}));

app.delete('/api/contracts/:id', ok((req, res) => {
  db.prepare('UPDATE contracts SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  res.json(listContracts());
}));

app.post('/api/third-parties', ok((req, res) => {
  const b = req.body;
  if (b.id) {
    db.prepare('UPDATE third_parties SET name=?, default_units=?, active=? WHERE id=?')
      .run(b.name, num(b.default_units), b.active === false ? 0 : 1, b.id);
  } else {
    db.prepare('INSERT INTO third_parties (name, default_units, sort_order) VALUES (?, ?, 50)')
      .run(b.name, num(b.default_units));
  }
  res.json(listThirdParties());
}));

app.delete('/api/third-parties/:id', ok((req, res) => {
  db.prepare('UPDATE third_parties SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json(listThirdParties());
}));

app.post('/api/deliverables', ok((req, res) => {
  const b = req.body;
  let id = b.id;
  if (id) db.prepare('UPDATE deliverables SET name = ?, active = ? WHERE id = ?')
    .run(b.name, b.active === false ? 0 : 1, id);
  else {
    db.prepare('INSERT INTO deliverables (name, internal, sort_order) VALUES (?, ?, 50)')
      .run(b.name, b.internal ? 1 : 0);
    id = db.prepare('SELECT id FROM deliverables WHERE name = ?').get(b.name).id;
  }
  if (b.recipe) {
    const r = b.recipe;
    db.prepare(`INSERT INTO recipes (deliverable_id, cadence, distribution, block_minutes,
      splittable, max_sittings, anchor_dow, anchor_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deliverable_id) DO UPDATE SET cadence=excluded.cadence,
      distribution=excluded.distribution, block_minutes=excluded.block_minutes,
      splittable=excluded.splittable, max_sittings=excluded.max_sittings,
      anchor_dow=excluded.anchor_dow, anchor_time=excluded.anchor_time`)
      .run(id, r.cadence || 'monthly', r.distribution || 'spread', num(r.block_minutes, 60),
        r.splittable ? 1 : 0, num(r.max_sittings), num(r.anchor_dow, 2), r.anchor_time || '10:00');
  }
  res.json(db.prepare(`SELECT d.*, r.cadence, r.distribution, r.block_minutes, r.splittable,
    r.max_sittings, r.anchor_dow, r.anchor_time FROM deliverables d
    LEFT JOIN recipes r ON r.deliverable_id = d.id ORDER BY d.internal, d.sort_order`).all());
}));

app.get('/api/recipes', ok((req, res) => {
  res.json(db.prepare(`SELECT d.id, d.name, d.internal, r.cadence, r.distribution, r.block_minutes,
    r.splittable, r.max_sittings, r.anchor_dow, r.anchor_time
    FROM deliverables d LEFT JOIN recipes r ON r.deliverable_id = d.id
    WHERE d.active = 1 ORDER BY d.internal, d.sort_order`).all());
}));

app.get('/api/anchors', ok((req, res) => {
  res.json(db.prepare(`SELECT a.*, p.name AS person_name, c.name AS contract_name FROM anchors a
    JOIN people p ON p.id = a.person_id
    LEFT JOIN contracts c ON c.id = a.contract_id ORDER BY p.name, a.dow, a.time`).all());
}));

app.post('/api/anchors', ok((req, res) => {
  const b = req.body;
  if (b.id) {
    db.prepare('UPDATE anchors SET person_id=?, contract_id=?, label=?, dow=?, time=?, minutes=? WHERE id=?')
      .run(b.person_id, b.contract_id || null, b.label, num(b.dow, 2), b.time || '10:00', num(b.minutes, 60), b.id);
  } else {
    db.prepare('INSERT INTO anchors (person_id, contract_id, label, dow, time, minutes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.person_id, b.contract_id || null, b.label, num(b.dow, 2), b.time || '10:00', num(b.minutes, 60));
  }
  res.json({ ok: true });
}));

app.delete('/api/anchors/:id', ok((req, res) => {
  db.prepare('DELETE FROM anchors WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/settings', ok((req, res) => {
  const allowed = ['standard_rate', 'work_start', 'work_end', 'lunch_start', 'lunch_minutes',
    'max_client_minutes_per_day', 'holidays', 'harvest_account_id', 'harvest_token', 'default_period'];
  for (const [k, v] of Object.entries(req.body)) if (allowed.includes(k)) set(k, v);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// scheduling + export
// ---------------------------------------------------------------------------

app.get('/api/schedule/:id', ok((req, res) => {
  const plan = schedule.planPerson(Number(req.params.id), period(req));
  if (!plan) return res.status(404).json({ error: 'no such person' });
  res.json(plan);
}));

app.get('/api/schedule/:id/ics', ok((req, res) => {
  const p = period(req);
  const plan = schedule.planPerson(Number(req.params.id), p);
  if (!plan) return res.status(404).json({ error: 'no such person' });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const safe = plan.person.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-${p}.ics"`);
  res.send(schedule.toIcs(plan, stamp));
}));

// ---------------------------------------------------------------------------
// harvest
// ---------------------------------------------------------------------------

app.post('/api/harvest/sync-people', okAsync(async (req, res) => res.json(await harvest.syncPeople())));
app.post('/api/harvest/sync-actuals', okAsync(async (req, res) => res.json(await harvest.syncActuals(period(req)))));
app.get('/api/harvest/projects', okAsync(async (req, res) => res.json(await harvest.listProjects())));

app.get('/api/harvest/unmapped', ok((req, res) => {
  res.json(db.prepare(`SELECT harvest_task, harvest_project, SUM(hours) AS hours
    FROM actuals WHERE period = ? AND deliverable_id IS NULL
    GROUP BY harvest_task ORDER BY hours DESC`).all(period(req)));
}));

app.post('/api/harvest/map-task', ok((req, res) => {
  const pattern = harvest.stripPrefix(req.body.task || '');
  if (!pattern) throw new Error('nothing to map');
  db.prepare(`INSERT INTO task_map (pattern, deliverable_id) VALUES (?, ?)
    ON CONFLICT(pattern) DO UPDATE SET deliverable_id = excluded.deliverable_id`)
    .run(pattern, Number(req.body.deliverable_id));
  res.json({ ok: true, pattern });
}));

// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ ok: true, period: cap.thisPeriod() }));

// first boot: populate with the real book of business
if (!get('seeded_at')) {
  try { console.log('seeding:', JSON.stringify(seed.run())); }
  catch (e) { console.error('seed failed:', e.message); }
}

app.listen(PORT, () => console.log(`EmotioHours on http://localhost:${PORT}`));
