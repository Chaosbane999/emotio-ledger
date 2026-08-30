const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { db, get, set } = require('./db');
const cap = require('./capacity');
const schedule = require('./schedule');
const time = require('./time');
const harvest = require('./harvest');
const seed = require('./seed');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// ---- passcode gate ----------------------------------------------------
// The passcode lives in the database so it can be changed in Settings without
// a redeploy; APP_PASSCODE is the fallback for a fresh instance that has never
// had one set. Stored as scrypt with a per-install salt, never in plain text.
// The session cookie carries a value derived from that hash rather than the
// passcode itself, so a stolen cookie never reveals it — and changing the
// passcode changes the derived value, which signs every other device out.

const ENV_PASSCODE = process.env.APP_PASSCODE || '';
const ALLOWED_IPS = (process.env.ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);

const scrypt = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');

const storedRecord = () => get('passcode_hash') || '';

/** Is the app protected at all? */
const gateOn = () => Boolean(storedRecord() || ENV_PASSCODE);

/** The value a valid session cookie must hold right now. */
function sessionToken() {
  const rec = storedRecord();
  if (rec) return crypto.createHash('sha256').update(`v2:${rec}`).digest('hex');
  return ENV_PASSCODE ? crypto.createHash('sha256').update(ENV_PASSCODE).digest('hex') : null;
}

function passcodeMatches(candidate) {
  const rec = storedRecord();
  if (rec) {
    const [salt, want] = rec.split(':');
    if (!salt || !want) return false;
    const got = scrypt(candidate, salt);
    const a = Buffer.from(got, 'hex'), b = Buffer.from(want, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ENV_PASSCODE) return true;
  const a = Buffer.from(String(candidate)), b = Buffer.from(ENV_PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Check a plain value against a stored "salt:hash" record. */
function verifyAgainst(candidate, record) {
  if (!record) return false;
  const [salt, want] = record.split(':');
  if (!salt || !want) return false;
  const a = Buffer.from(scrypt(candidate, salt), 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const hashSecret = (value) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${scrypt(value, salt)}`;
};

function setPasscode(next) {
  const salt = crypto.randomBytes(16).toString('hex');
  set('passcode_hash', `${salt}:${scrypt(next, salt)}`);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const clientIp = (req) => (req.ip || '').replace(/^::ffff:/, '');

// The legacy shared-passcode cookie is retired. It granted admin to any
// browser that still carried it — including a member's — which quietly
// defeated the roles. Everyone signs in properly now; the old cookie is
// expired on sight rather than honoured.
const clearLegacyCookie = (res) => {
  res.setHeader('Set-Cookie', 'el_auth=; Path=/; HttpOnly; Max-Age=0');
};

// ---- sessions ----------------------------------------------------------
// A row per signed-in device, so access can be revoked per person rather than
// by changing one passcode for everyone.

const newSession = (personId, role) => {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, person_id, role) VALUES (?, ?, ?)')
    .run(token, personId, role);
  return token;
};

const sessionCookie = (req, res, token) => {
  const secure = req.secure ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `el_sess=${token}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=31536000`);
};

/** Who is this request? null when not signed in. */
function currentUser(req) {
  const tok = readCookie(req, 'el_sess');
  if (tok) {
    const row = db.prepare(`SELECT s.person_id, s.role, p.name, p.archived
      FROM sessions s LEFT JOIN people p ON p.id = s.person_id
      WHERE s.token = ?`).get(tok);
    if (row && !row.archived) return { person_id: row.person_id, role: row.role, name: row.name };
  }
  return null;
}

const loginFails = new Map();
app.post('/login', (req, res) => {
  if (!gateOn()) return res.json({ ok: true, role: 'admin' });
  const ip = clientIp(req);
  const fails = loginFails.get(ip) || 0;

  setTimeout(() => {
    const email = String(req.body.email || '').trim().toLowerCase();

    // per-person sign-in
    if (email) {
      const p = db.prepare(`SELECT * FROM people
        WHERE lower(email) = ? AND archived = 0 AND password_hash != ''`).get(email);
      if (p && verifyAgainst(String(req.body.password || ''), p.password_hash)) {
        loginFails.delete(ip);
        sessionCookie(req, res, newSession(p.id, p.role || 'member'));
        return res.json({ ok: true, role: p.role || 'member', name: p.name });
      }
      loginFails.set(ip, fails + 1);
      return res.status(401).json({ ok: false });
    }

    // shared passcode — always admin
    if (passcodeMatches(req.body.passcode || '')) {
      loginFails.delete(ip);
      sessionCookie(req, res, newSession(null, 'admin'));
      return res.json({ ok: true, role: 'admin' });
    }
    loginFails.set(ip, fails + 1);
    res.status(401).json({ ok: false });
  }, Math.min(5000, Math.max(0, fails - 4) * 1000));
});

app.post('/logout', (req, res) => {
  const tok = readCookie(req, 'el_sess');
  if (tok) db.prepare('DELETE FROM sessions WHERE token = ?').run(tok);
  res.setHeader('Set-Cookie', ['el_sess=; Path=/; HttpOnly; Max-Age=0',
    'el_auth=; Path=/; HttpOnly; Max-Age=0']);
  res.json({ ok: true });
});

// ---- gate + role enforcement -------------------------------------------

app.use((req, res, next) => {
  if (!gateOn()) { req.user = { person_id: null, role: 'admin', name: 'Admin' }; return next(); }
  if (ALLOWED_IPS.includes(clientIp(req))) { req.user = { person_id: null, role: 'admin' }; return next(); }

  const user = currentUser(req);
  if (user) { req.user = user; return next(); }

  if (req.path === '/login.html' || req.path.startsWith('/style.css')) return next();
  if (req.path.startsWith('/calendar/')) return next();   // the token IS the auth
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not signed in' });
  return res.redirect('/login.html');
});

const isAdmin = (req) => req.user?.role === 'admin';

/**
 * The accounts a person works on: anything they hold an allocation against in
 * any period, plus anything they own outright. This is what "their contracts"
 * means everywhere a member is scoped.
 */
function contractsFor(personId) {
  if (!personId) return new Set();
  const rows = db.prepare(`
    SELECT DISTINCT c.id FROM contracts c
     WHERE c.exec_person_id = ?
        OR EXISTS (SELECT 1 FROM allocations a WHERE a.contract_id = c.id AND a.person_id = ?)`)
    .all(personId, personId);
  return new Set(rows.map((r) => r.id));
}
/** Throws unless this contract is one of theirs (admins pass everything). */
function assertOwnContract(req, contractId) {
  if (isAdmin(req)) return;
  if (!contractsFor(req.user?.person_id).has(Number(contractId))) {
    throw new Error('That contract is not one of yours.');
  }
}

/** Admin-only routes: everything that reveals rates or changes the agency. */
app.use((req, res, next) => {
  if (isAdmin(req) || !req.path.startsWith('/api/')) return next();

  // A member may read their own person view, their own leave, their own
  // schedule and the recipes that shape it. Every one of these is scoped to
  // their own id — none of them carries a rate or a unit.
  const own = String(req.user?.person_id ?? '');
  const mineRe = own && new RegExp(`^/api/(person|schedule|person-recipes|time)/${own}(/|$)`);
  const shared = ['/api/bootstrap', '/api/me', '/api/workdays', '/api/months', '/api/leave'];
  // their accounts: contracts they work on, and reports over those contracts.
  // Every one of these is scoped inside its handler, and money is stripped on
  // the way out regardless.
  const accountRead = ['/api/contracts', '/api/contract-summaries', '/api/report',
    '/api/anchors', '/api/export/time.csv']
    .includes(req.path) || /^\/api\/contract\/\d+(\/|$)/.test(req.path);
  const accountWrite = ['/api/allocation', '/api/tp-allocation', '/api/contracts', '/api/anchors']
    .includes(req.path) || /^\/api\/anchors\/\d+$/.test(req.path);
  const allowed = shared.includes(req.path) || (mineRe && mineRe.test(req.path))
    || accountRead || (req.method !== 'GET' && accountWrite);

  if (!allowed) return res.status(403).json({ error: 'Not available on your account.' });

  const writable = own && new RegExp(`^/api/(schedule|person-recipes|time)/${own}(/|$)`);
  if (req.method !== 'GET' && !(writable && writable.test(req.path)) && !accountWrite) {
    return res.status(403).json({ error: 'Read-only on your account.' });
  }

  // Strip money once, here, for everything a member is ever sent. Leaving it
  // to each handler to remember send() is a rule that only has to be missed
  // once — and it was, on the contract detail, the moment contracts opened up.
  const original = res.json.bind(res);
  res.json = (payload) => original(stripMoney(payload));
  next();
});

app.get('/api/me', (req, res) => res.json({
  person_id: req.user?.person_id ?? null,
  role: req.user?.role || 'member',
  name: req.user?.name || 'Admin',
}));

/**
 * The calendar subscription. No session — the long random token is the
 * credential, scoped to one person's schedule and nothing else. Serves the
 * plan as it stands, so a rearranged week flows into their calendar app on
 * its next refresh.
 */
app.get('/calendar/:token.ics', (req, res) => {
  const person = time.personByToken(String(req.params.token || ''));
  if (!person) return res.status(404).type('text').send('not found');
  const ics = schedule.toIcs({
    person,
    period: 'live',
    // each item carries a uid keyed to its row (block or entry), so a
    // subscription refresh updates events in place instead of duplicating
    blocks: time.feedItems(person.id),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/calendar').send(ics);
});

/**
 * Assets are served immutable for a year, so the HTML must name a version or a
 * browser will keep its first copy forever. Without this a deploy simply did
 * not reach anyone already signed in — a fixed stylesheet stayed broken on
 * their screen and looked like the fix had never been made.
 */
const PUBLIC_DIR = path.join(__dirname, 'public');
const BUILD = crypto.createHash('sha1')
  .update(['app.js', 'style.css'].map((f) => {
    try { return fs.readFileSync(path.join(PUBLIC_DIR, f)); } catch { return ''; }
  }).join('|'))
  .digest('hex').slice(0, 10);

const pageCache = new Map();
const sendPage = (file) => (req, res) => {
  if (!pageCache.has(file)) {
    pageCache.set(file, fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8')
      .replace(/(src|href)="((?:app|style)\.(?:js|css))"/g, `$1="$2?v=${BUILD}"`));
  }
  res.set('Cache-Control', 'no-store');
  res.type('html').send(pageCache.get(file));
};

for (const [route, file] of [['/', 'index.html'], ['/index.html', 'index.html'],
  ['/login', 'login.html'], ['/login.html', 'login.html']]) {
  app.get(route, sendPage(file));
}

app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, p) => {
    if (/\.(css|js)$/.test(p)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    else if (/\.html$/.test(p)) res.set('Cache-Control', 'no-store');
  },
}));

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

const listPeople = (withArchived) => db.prepare(
  `SELECT id, harvest_user_id, name, initials, weekly_hours, rate, utilisation, colour,
          active, sort_order, archived, email, role, department,
          password_hash != '' AS has_login
     FROM people ${withArchived ? '' : 'WHERE archived = 0'}
    ORDER BY archived, active = 0, sort_order, name`).all();
const listDeliverables = () => db.prepare('SELECT * FROM deliverables WHERE active = 1 ORDER BY internal, sort_order').all();
const listThirdParties = () => db.prepare('SELECT * FROM third_parties WHERE active = 1 ORDER BY sort_order, name').all();
const listContracts = (withArchived) => db.prepare(
  `SELECT * FROM contracts ${withArchived ? '' : 'WHERE archived = 0'} ORDER BY archived, sort_order, name`).all();

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** Units divided by hours gives the rate away, so a member gets neither. */
/**
 * Members see hours, never money. The pattern catches anything named for a
 * rate or units, but several fields are unit-valued without saying so —
 * `variance` and the pot drawdown among them — and a name-shaped denylist
 * cannot infer that. They are listed explicitly, and a test asserts no
 * member-reachable payload carries one.
 */
const UNIT_FIELDS = new Set([
  'variance', 'pot_drawn', 'pot_remaining', 'pot_this_period',
]);
function stripMoney(payload) {
  const scrub = (o) => {
    if (Array.isArray(o)) return o.map(scrub);
    if (o && typeof o === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        if (/rate|_units$|^units$/.test(k) || UNIT_FIELDS.has(k)) continue;
        out[k] = scrub(v);
      }
      return out;
    }
    return o;
  };
  return scrub(payload);
}

const send = (req, res, payload) =>
  res.json(req.user?.role === 'admin' ? payload : stripMoney(payload));

// ---------------------------------------------------------------------------
// time tracking — the plan is schedule_blocks; these record what happened.
// Every route is scoped to :id, and the member gate above has already refused
// anyone reaching for an id that is not their own.
// ---------------------------------------------------------------------------

const personParam = (req) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM people WHERE id = ?').get(id)) throw new Error('no such person');
  return id;
};

app.get('/api/time/:id/day', ok((req, res) => {
  res.json(time.dayView(personParam(req), String(req.query.date || '')));
}));
app.get('/api/time/:id/week', ok((req, res) => {
  res.json(time.weekView(personParam(req), String(req.query.date || '')));
}));
app.post('/api/time/:id/entries', ok((req, res) => {
  res.json(time.addEntry(personParam(req), req.body || {}));
}));
app.patch('/api/time/:id/entries/:entryId', ok((req, res) => {
  res.json(time.updateEntry(personParam(req), Number(req.params.entryId), req.body || {}));
}));
app.delete('/api/time/:id/entries/:entryId', ok((req, res) => {
  res.json(time.deleteEntry(personParam(req), Number(req.params.entryId),
    req.query.override === '1'));
}));
app.post('/api/time/:id/move-block', ok((req, res) => {
  res.json(time.moveBlock(personParam(req), Number(req.body.block_id),
    String(req.body.date || ''), String(req.body.start || '')));
}));
app.post('/api/time/:id/resize-block', ok((req, res) => {
  res.json(time.resizeBlock(personParam(req), Number(req.body.block_id), Number(req.body.minutes)));
}));
app.post('/api/time/:id/bump-block', ok((req, res) => {
  res.json(time.bumpBlock(personParam(req), Number(req.body.block_id)));
}));
app.get('/api/time/:id/plan-check', ok((req, res) => {
  res.json(time.planCheck(personParam(req), Number(req.query.contract_id),
    String(req.query.period || period(req)), Number(req.query.exclude) || 0));
}));
app.get('/api/time/:id/rebalance', ok((req, res) => {
  res.json(time.rebalancePlan(personParam(req), Number(req.query.contract_id),
    String(req.query.period || ''), Number(req.query.delta), Number(req.query.exclude) || 0));
}));
app.post('/api/time/:id/rebalance', ok((req, res) => {
  res.json(time.applyRebalance(personParam(req), req.body.changes));
}));
app.get('/api/time/:id/calendar-link', ok((req, res) => {
  const id = personParam(req);
  const token = time.calendarToken(id);
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  // behind Traefik the forwarded proto is https; plain http only in local dev
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  res.json({
    https: `${proto}://${host}/calendar/${token}.ics`,
    webcal: `webcal://${host}/calendar/${token}.ics`,
  });
}));
app.post('/api/time/:id/confirm', ok((req, res) => {
  res.json(time.confirmBlock(personParam(req), Number(req.body.block_id), req.body.note));
}));
app.post('/api/time/:id/confirm-day', ok((req, res) => {
  res.json(time.confirmDay(personParam(req), String(req.body.date || '')));
}));
app.post('/api/time/:id/skip', ok((req, res) => {
  res.json(time.skipBlock(personParam(req), Number(req.body.block_id), req.body.note));
}));
app.post('/api/time/:id/timer/start', ok((req, res) => {
  res.json(time.startTimer(personParam(req), req.body || {}));
}));
app.post('/api/time/:id/timer/stop', ok((req, res) => {
  res.json(time.stopTimer(personParam(req), req.body?.note));
}));
app.delete('/api/time/:id/timer', ok((req, res) => {
  res.json(time.cancelTimer(personParam(req)));
}));

/** Admin only (the member gate never lets a member reach a path without their id). */
app.get('/api/time-variance', ok((req, res) => {
  res.json(time.variance(String(req.query.period || period(req)),
    Number(req.query.person_id) || null));
}));
app.get('/api/report', ok((req, res) => {
  // a member's report covers their accounts and nothing else
  const scope = isAdmin(req) ? null : [...contractsFor(req.user?.person_id)];
  const asked = Number(req.query.contract_id) || null;
  if (scope && asked && !scope.includes(asked)) throw new Error('That contract is not one of yours.');
  res.json(time.report({
    from: String(req.query.from || ''),
    to: String(req.query.to || ''),
    contractIds: scope,
    contractId: asked,
    personId: Number(req.query.person_id) || null,
    department: ['marketing', 'design'].includes(req.query.department) ? req.query.department : null,
    deliverableId: Number(req.query.deliverable_id) || null,
  }));
}));
app.get('/api/contract/:id/time-report', ok((req, res) => {
  assertOwnContract(req, req.params.id);
  res.json(time.contractTimeReport(Number(req.params.id), period(req)));
}));
const sendCsv = (res, name, csv) => {
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.type('text/csv').send(csv);
};
app.get('/api/export/time.csv', ok((req, res) => {
  const p = req.query.period ? String(req.query.period) : null;
  const scope = isAdmin(req) ? null : [...contractsFor(req.user?.person_id)];
  const asked = Number(req.query.contract_id) || null;
  if (scope && asked && !scope.includes(asked)) throw new Error('That contract is not one of yours.');
  sendCsv(res, `time-${p || req.query.from || 'all'}.csv`, time.exportEntries({
    period: p,
    contractIds: scope,
    from: req.query.from ? String(req.query.from) : null,
    to: req.query.to ? String(req.query.to) : null,
    contractId: Number(req.query.contract_id) || null,
    personId: Number(req.query.person_id) || null,
    department: ['marketing', 'design'].includes(req.query.department) ? req.query.department : null,
    deliverableId: Number(req.query.deliverable_id) || null,
  }));
}));
/** A member exports their own time; the gate has already checked the id. */
app.get('/api/time/:id/export.csv', ok((req, res) => {
  const p = req.query.period ? String(req.query.period) : null;
  sendCsv(res, `my-time-${p || 'all'}.csv`,
    time.exportEntries({ period: p, personId: personParam(req) }));
}));

app.get('/api/bootstrap', ok((req, res) => {
  const p = period(req);
  const withArchived = req.query.archived === '1';
  const months = db.prepare('SELECT period FROM months ORDER BY period').all().map((m) => m.period);
  const payload = {
    period: p,
    // only months that actually exist — new ones are created deliberately
    periods: months,
    months: months.map((m) => ({ period: m, working_days: cap.workingDays(m), hours: cap.monthHours(m) })),
    people: listPeople(withArchived),
    deliverables: listDeliverables(),
    third_parties: listThirdParties(),
    channels: db.prepare('SELECT * FROM channels ORDER BY sort_order, name').all(),
    me: { person_id: req.user?.person_id ?? null, role: req.user?.role || 'member', name: req.user?.name },
    contracts: isAdmin(req) ? listContracts(withArchived)
      : listContracts(withArchived).filter((c) => contractsFor(req.user?.person_id).has(c.id)),
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
      passcode_set: Boolean(get('passcode_hash')),
      staging: process.env.STAGING === '1',
      gate_on: gateOn(),
    },
  };
  send(req, res, payload);
}));

app.get('/api/agency', ok((req, res) => res.json(cap.agencySummary(period(req),
  ['marketing', 'design'].includes(req.query.department) ? req.query.department : null))));

app.get('/api/person/:id', ok((req, res) => {
  const v = cap.personView(Number(req.params.id), period(req));
  if (!v) return res.status(404).json({ error: 'no such person' });
  send(req, res, v);
}));

/**
 * Summaries for the contracts list. The list used to read the whole agency
 * dashboard for this, which a member cannot see — and should not need to, to
 * look at their own accounts. Scoped: everything for an admin, their own for
 * a member.
 */
app.get('/api/contract-summaries', ok((req, res) => {
  const p = period(req);
  const scope = isAdmin(req) ? null : contractsFor(req.user?.person_id);
  const contracts = listContracts(req.query.archived === '1')
    .filter((c) => !scope || scope.has(c.id))
    .map((c) => cap.contractSummary(c, p));
  send(req, res, { period: p, contracts });
}));

app.get('/api/contract/:id', ok((req, res) => {
  const p = period(req);
  assertOwnContract(req, req.params.id);
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

  // through send(), so a member gets the delivery view with the money removed
  send(req, res, {
    contract: c,
    summary: cap.contractSummary(c, p),
    channels: db.prepare('SELECT channel_id FROM contract_channels WHERE contract_id = ?')
      .all(c.id).map((r) => r.channel_id),
    actuals: actuals.map((a) => ({ ...a, hours: cap.round2(a.hours) })),
    actual_hours: cap.round2(actuals.reduce((s, a) => s + a.hours, 0)),
  });
}));

app.get('/api/leave', ok((req, res) => {
  // A member may see their own leave — it carries no rate or unit — but not
  // the team's. The person view reads this, so refusing it outright left them
  // staring at an error with nothing on the page.
  if (req.user?.role !== 'admin') {
    return res.json(db.prepare('SELECT * FROM leave WHERE period = ? AND person_id = ?')
      .all(period(req), req.user?.person_id ?? -1));
  }
  res.json(db.prepare('SELECT * FROM leave WHERE period = ?').all(period(req)));
}));

// ---------------------------------------------------------------------------
// write — allocations
// ---------------------------------------------------------------------------

app.post('/api/allocation', ok((req, res) => {
  const { contract_id, person_id, deliverable_id } = req.body;
  assertOwnContract(req, contract_id);
  const p = req.body.period || period(req);
  // quarter-hour grain, the same grain the schedule is built on
  const hours = Math.max(0, Math.round(num(req.body.hours) * 4) / 4);
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
  // third-party lines consume contract value in units — a commercial act
  if (!isAdmin(req)) throw new Error('Third-party services are set by an administrator.');
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
// months
// ---------------------------------------------------------------------------

/** The working days in a period — the days a block can be moved to. */
app.get('/api/workdays', ok((req, res) => res.json(cap.workingDates(period(req)))));

app.get('/api/months', ok((req, res) => {
  res.json(db.prepare('SELECT * FROM months ORDER BY period').all()
    .map((m) => ({ ...m, working_days: cap.workingDays(m.period), hours: cap.monthHours(m.period) })));
}));

/**
 * Add a month. By default it copies the previous month's allocations forward,
 * so you start from last month's plan and edit it rather than a blank sheet.
 */
app.post('/api/months', ok((req, res) => {
  const p = String(req.body.period || '').trim();
  cap.parsePeriod(p);                                   // throws on a bad shape
  if (db.prepare('SELECT 1 FROM months WHERE period = ?').get(p)) throw new Error(`${p} already exists`);

  const from = req.body.copy_from === null ? null : (req.body.copy_from || cap.shiftPeriod(p, -1));
  let copied = { allocations: 0, third_party: 0 };

  if (from && db.prepare('SELECT 1 FROM months WHERE period = ?').get(from)) {
    const a = db.prepare(`INSERT OR IGNORE INTO allocations (contract_id, period, person_id, deliverable_id, hours)
      SELECT contract_id, ?, person_id, deliverable_id, hours FROM allocations WHERE period = ?`).run(p, from);
    const t = db.prepare(`INSERT OR IGNORE INTO tp_allocations (contract_id, period, third_party_id, units)
      SELECT contract_id, ?, third_party_id, units FROM tp_allocations WHERE period = ?`).run(p, from);
    copied = { allocations: Number(a.changes), third_party: Number(t.changes), blocks: 0 };

    // Carry saved schedules across too, mapped by working-day index: a block on
    // the 3rd working day of one month lands on the 3rd of the next. Months
    // differ in length, so anything past the end is dropped rather than piled
    // onto the last day.
    const fromDays = cap.workingDates(from);
    const toDays = cap.workingDates(p);
    const idx = new Map(fromDays.map((d, i) => [d, i]));
    const blocks = db.prepare('SELECT * FROM schedule_blocks WHERE period = ?').all(from);
    const insB = db.prepare(`INSERT INTO schedule_blocks
      (person_id, period, contract_id, deliverable_id, label, date, start, minutes, anchored, manual, draft)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const b of blocks) {
      const i = idx.get(b.date);
      if (i === undefined || i >= toDays.length) continue;
      // carry the state across: a reviewed plan copies as reviewed, a
      // suggestion copies as a suggestion. Dropping the flag put unreviewed
      // work straight onto next month's time sheet.
      insB.run(b.person_id, p, b.contract_id, b.deliverable_id, b.label,
        toDays[i], b.start, b.minutes, b.anchored, b.manual, b.draft);
      copied.blocks += 1;
    }
  }

  db.prepare('INSERT INTO months (period, copied_from) VALUES (?, ?)').run(p, from || '');
  res.json({ period: p, copied_from: from || null, copied });
}));

/** Remove a month and everything planned in it. */
app.delete('/api/months/:period', ok((req, res) => {
  const p = req.params.period;
  cap.parsePeriod(p);
  // Logged time is the record of work actually done. Deleting a month used to
  // leave it behind with its allocations destroyed — invisible in the picker,
  // still counted by every date-range report, and stripped of the context that
  // made it mean anything. It is refused unless someone insists explicitly.
  const logged = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(minutes),0) m FROM time_entries
    WHERE date LIKE ? AND source != 'skip'`).get(`${p}-%`);
  if (logged.n && req.query.force !== '1') {
    return res.status(409).json({
      error: `${p} has ${cap.round2(logged.m / 60)} h of logged time across ${logged.n} entries. `
        + 'That is a record of work done — export it first, then delete with force.',
      logged_hours: cap.round2(logged.m / 60), logged_entries: logged.n,
    });
  }
  // the plan is disposable with its month; reality only goes when forced
  db.prepare('DELETE FROM schedule_blocks WHERE period = ?').run(p);
  if (req.query.force === '1') {
    db.prepare("DELETE FROM time_entries WHERE date LIKE ?").run(`${p}-%`);
  }
  db.prepare('DELETE FROM allocations WHERE period = ?').run(p);
  db.prepare('DELETE FROM tp_allocations WHERE period = ?').run(p);
  db.prepare('DELETE FROM carryover WHERE period = ?').run(p);
  db.prepare('DELETE FROM actuals WHERE period = ?').run(p);
  db.prepare('DELETE FROM leave WHERE period = ?').run(p);
  db.prepare('DELETE FROM months WHERE period = ?').run(p);
  const left = db.prepare('SELECT period FROM months ORDER BY period').all().map((m) => m.period);
  if (get('default_period') === p && left.length) set('default_period', left[left.length - 1]);
  res.json({ ok: true, months: left });
}));

// ---------------------------------------------------------------------------
// write — settings CRUD
// ---------------------------------------------------------------------------

app.post('/api/people', ok((req, res) => {
  const b = req.body;
  const pDept = ['design', 'management'].includes(b.department) ? b.department : 'marketing';
  if (b.id) {
    db.prepare(`UPDATE people SET name=?, initials=?, weekly_hours=?, rate=?, utilisation=?, active=?,
      archived=?, harvest_user_id=?, department=? WHERE id=?`).run(b.name, b.initials || '', num(b.weekly_hours, 37.5),
      num(b.rate, 100), Math.min(1, Math.max(0, num(b.utilisation, 0.87))), b.active ? 1 : 0,
      b.archived ? 1 : 0, b.harvest_user_id ? Number(b.harvest_user_id) : null, pDept, b.id);
  } else {
    db.prepare(`INSERT INTO people (name, initials, weekly_hours, rate, utilisation, active, harvest_user_id, department, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 50)`).run(b.name, b.initials || '', num(b.weekly_hours, 37.5),
      num(b.rate, 100), Math.min(1, Math.max(0, num(b.utilisation, 0.87))), b.active ? 1 : 0,
      b.harvest_user_id ? Number(b.harvest_user_id) : null, pDept);
  }
  res.json(listPeople());
}));

/** Archive by default; ?hard=1 deletes outright, taking their allocations. */
/** Give someone a sign-in, change their role, or revoke access. */
app.post('/api/people/:id/login', ok((req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'no such person' });
  const b = req.body;

  if (b.email !== undefined) {
    const email = String(b.email).trim().toLowerCase();
    if (email) {
      const clash = db.prepare('SELECT id FROM people WHERE lower(email) = ? AND id != ?').get(email, id);
      if (clash) throw new Error('Another person already uses that email.');
    }
    db.prepare('UPDATE people SET email = ? WHERE id = ?').run(email, id);
  }
  if (b.role) db.prepare('UPDATE people SET role = ? WHERE id = ?')
    .run(b.role === 'admin' ? 'admin' : 'member', id);
  if (b.password) {
    if (String(b.password).length < 8) throw new Error('Use at least 8 characters.');
    db.prepare('UPDATE people SET password_hash = ? WHERE id = ?').run(hashSecret(String(b.password)), id);
  }
  if (b.revoke) {
    db.prepare("UPDATE people SET password_hash = '' WHERE id = ?").run(id);
    db.prepare('DELETE FROM sessions WHERE person_id = ?').run(id);
  }
  res.json(listPeople(req.query.archived === '1'));
}));

app.delete('/api/people/:id', ok((req, res) => {
  const id = Number(req.params.id);
  if (req.query.hard === '1') db.prepare('DELETE FROM people WHERE id = ?').run(id);
  else db.prepare('UPDATE people SET archived = 1, active = 0 WHERE id = ?').run(id);
  res.json(listPeople(req.query.archived === '1'));
}));

app.post('/api/contracts', ok((req, res) => {
  const b = req.body;
  // Shape alone would let '2026-13-01' through. It could not crash anything —
  // these are only ever compared as strings — but it would silently sit outside
  // every window, so reject it at the door instead.
  const date = (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return null;
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
  };
  // Safari has no month picker — it hands users a text box, and they will
  // reasonably type 09-2026. Accept both orders and normalise to YYYY-MM.
  const month = (v) => {
    const t = String(v || '').trim();
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(t)) return t;
    const m = t.match(/^(0?[1-9]|1[0-2])[\/\-](\d{4})$/);
    return m ? `${m[2]}-${String(m[1]).padStart(2, '0')}` : null;
  };
  const dept = b.department === 'design' ? 'design' : 'marketing';

  // A member runs delivery on their accounts, not the commercial terms. They
  // may edit notes and the Harvest mapping on a contract they work on;
  // everything that prices or scopes the deal — value, type, status, dates,
  // owner, department — keeps whatever it already had.
  if (!isAdmin(req)) {
    if (!b.id) throw new Error('New contracts are set up by an administrator.');
    assertOwnContract(req, b.id);
    const cur = db.prepare('SELECT * FROM contracts WHERE id = ?').get(Number(b.id));
    if (!cur) throw new Error('no such contract');
    db.prepare('UPDATE contracts SET notes = ?, harvest_ids = ? WHERE id = ?')
      .run(String(b.notes ?? cur.notes), String(b.harvest_ids ?? cur.harvest_ids), cur.id);
    return send(req, res, listContracts(req.query.archived === '1')
      .filter((c) => contractsFor(req.user.person_id).has(c.id)));
  }

  // The pot window is the contract's run dates, kept as months — one pair of
  // dates on the form, no way to set them inconsistently.
  const startsOn = date(b.starts_on); const endsOn = date(b.ends_on);
  const fields = [b.name, b.exec_person_id || null, b.type || 'retainer', b.status || 'live',
    num(b.monthly_units), num(b.pot_units),
    startsOn ? startsOn.slice(0, 7) : null, endsOn ? endsOn.slice(0, 7) : null,
    startsOn, endsOn, b.harvest_ids || '', b.notes || '', dept];
  if (b.id) {
    db.prepare(`UPDATE contracts SET name=?, exec_person_id=?, type=?, status=?, monthly_units=?,
      pot_units=?, pot_start=?, pot_end=?, starts_on=?, ends_on=?, harvest_ids=?, notes=?, department=?
      WHERE id=?`).run(...fields, b.id);
  } else {
    db.prepare(`INSERT INTO contracts (name, exec_person_id, type, status, monthly_units,
      pot_units, pot_start, pot_end, starts_on, ends_on, harvest_ids, notes, department, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 50)`).run(...fields);
  }
  res.json(listContracts(req.query.archived === '1'));
}));

/** Archive by default; ?hard=1 deletes it and every allocation against it. */
app.delete('/api/contracts/:id', ok((req, res) => {
  const id = Number(req.params.id);
  if (req.query.hard === '1') db.prepare('DELETE FROM contracts WHERE id = ?').run(id);
  else db.prepare('UPDATE contracts SET archived = 1 WHERE id = ?').run(id);
  res.json(listContracts(req.query.archived === '1'));
}));

/** Bring an archived contract or person back. */
app.post('/api/restore', ok((req, res) => {
  if (req.body.contract_id) db.prepare('UPDATE contracts SET archived = 0 WHERE id = ?').run(req.body.contract_id);
  if (req.body.person_id) db.prepare('UPDATE people SET archived = 0, active = 1 WHERE id = ?').run(req.body.person_id);
  res.json({ ok: true });
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

/** Removing a deliverable: hard-delete only when nothing references it —
 *  allocations cascade and blocks/entries null out, so a used deliverable is
 *  archived instead (gone from every picker, history intact). */
app.delete('/api/deliverables/:id', ok((req, res) => {
  const id = Number(req.params.id);
  const used = ['allocations', 'time_entries', 'schedule_blocks', 'actuals', 'timers']
    .reduce((n, t) => n + db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE deliverable_id = ?`).get(id).c, 0);
  if (used) db.prepare('UPDATE deliverables SET active = 0 WHERE id = ?').run(id);
  else db.prepare('DELETE FROM deliverables WHERE id = ?').run(id);
  res.json({ archived: !!used });
}));

app.get('/api/recipes', ok((req, res) => {
  res.json(db.prepare(`SELECT d.id, d.name, d.internal, r.cadence, r.distribution, r.block_minutes,
    r.splittable, r.max_sittings, r.anchor_dow, r.anchor_time
    FROM deliverables d LEFT JOIN recipes r ON r.deliverable_id = d.id
    WHERE d.active = 1 ORDER BY d.internal, d.sort_order`).all());
}));

/** A person's recipes: the agency default for each deliverable, plus their own
 *  override where one exists. */
app.get('/api/person-recipes/:id', ok((req, res) => {
  const id = Number(req.params.id);
  res.json(db.prepare(`
    SELECT d.id, d.name, d.internal,
           COALESCE(pr.cadence, r.cadence)             AS cadence,
           COALESCE(pr.distribution, r.distribution)   AS distribution,
           COALESCE(pr.block_minutes, r.block_minutes) AS block_minutes,
           COALESCE(pr.splittable, r.splittable)       AS splittable,
           COALESCE(pr.max_sittings, r.max_sittings)   AS max_sittings,
           COALESCE(pr.anchor_dow, r.anchor_dow)       AS anchor_dow,
           COALESCE(pr.anchor_time, r.anchor_time)     AS anchor_time,
           pr.person_id IS NOT NULL                    AS overridden
      FROM deliverables d
      LEFT JOIN recipes r         ON r.deliverable_id = d.id
      LEFT JOIN person_recipes pr ON pr.deliverable_id = d.id AND pr.person_id = ?
     WHERE d.active = 1 ORDER BY d.internal, d.sort_order`).all(id));
}));

app.post('/api/person-recipes/:id', ok((req, res) => {
  const b = req.body;
  db.prepare(`INSERT INTO person_recipes
    (person_id, deliverable_id, cadence, distribution, block_minutes, splittable, max_sittings, anchor_dow, anchor_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(person_id, deliverable_id) DO UPDATE SET
      cadence=excluded.cadence, distribution=excluded.distribution,
      block_minutes=excluded.block_minutes, splittable=excluded.splittable,
      max_sittings=excluded.max_sittings, anchor_dow=excluded.anchor_dow,
      anchor_time=excluded.anchor_time`)
    .run(Number(req.params.id), b.deliverable_id, b.cadence || 'monthly', b.distribution || 'spread',
      num(b.block_minutes, 60), b.splittable ? 1 : 0, num(b.max_sittings),
      num(b.anchor_dow, 2), b.anchor_time || '10:00');
  res.json({ ok: true });
}));

/** Drop the override and fall back to the agency default. */
app.delete('/api/person-recipes/:id/:deliverableId', ok((req, res) => {
  db.prepare('DELETE FROM person_recipes WHERE person_id = ? AND deliverable_id = ?')
    .run(Number(req.params.id), Number(req.params.deliverableId));
  res.json({ ok: true });
}));

app.get('/api/anchors', ok((req, res) => {
  const all = db.prepare(`SELECT a.*, p.name AS person_name, c.name AS contract_name FROM anchors a
    JOIN people p ON p.id = a.person_id
    LEFT JOIN contracts c ON c.id = a.contract_id ORDER BY p.name, a.dow, a.time`).all();
  if (isAdmin(req)) return res.json(all);
  const mine = contractsFor(req.user?.person_id);
  res.json(all.filter((a) => a.contract_id && mine.has(a.contract_id)));
}));

app.post('/api/anchors', ok((req, res) => {
  const b = req.body;
  if (!isAdmin(req)) {
    if (!b.contract_id) throw new Error('Pick one of your contracts for this commitment.');
    assertOwnContract(req, b.contract_id);
    if (b.id) {
      const cur = db.prepare('SELECT contract_id FROM anchors WHERE id = ?').get(Number(b.id));
      if (!cur) throw new Error('no such commitment');
      assertOwnContract(req, cur.contract_id);
    }
  }
  const cadence = ['daily', 'weekly', 'fortnightly', 'monthly'].includes(b.cadence) ? b.cadence : 'weekly';
  if (b.id) {
    db.prepare('UPDATE anchors SET person_id=?, contract_id=?, label=?, dow=?, time=?, minutes=?, cadence=? WHERE id=?')
      .run(b.person_id, b.contract_id || null, b.label, num(b.dow, 2), b.time || '10:00', num(b.minutes, 60), cadence, b.id);
  } else {
    db.prepare('INSERT INTO anchors (person_id, contract_id, label, dow, time, minutes, cadence) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(b.person_id, b.contract_id || null, b.label, num(b.dow, 2), b.time || '10:00', num(b.minutes, 60), cadence);
  }
  res.json({ ok: true });
}));

app.delete('/api/anchors/:id', ok((req, res) => {
  if (!isAdmin(req)) {
    const cur = db.prepare('SELECT contract_id FROM anchors WHERE id = ?').get(Number(req.params.id));
    if (!cur) throw new Error('no such commitment');
    assertOwnContract(req, cur.contract_id);
  }
  db.prepare('DELETE FROM anchors WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

/**
 * Change the passcode. Requires the current one, so an unattended open session
 * cannot be used to lock the owner out. Every other device is signed out,
 * because the session token derives from the stored hash.
 */
app.post('/api/passcode', ok((req, res) => {
  const next = String(req.body.next || '');
  if (gateOn() && !passcodeMatches(String(req.body.current || ''))) {
    return res.status(403).json({ error: 'That is not the current passcode.' });
  }
  if (next.length < 8) throw new Error('Use at least 8 characters.');
  if (next !== String(req.body.confirm || '')) throw new Error('The two new passcodes do not match.');

  setPasscode(next);
  clearLegacyCookie(res);          // the changer's own el_sess session survives
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

/**
 * A person's plan. Once committed, the stored blocks ARE the plan and can be
 * edited freely; until then this returns the packer's draft so you can see what
 * it would produce before saving it.
 */
app.get('/api/schedule/:id', ok((req, res) => {
  const id = Number(req.params.id);
  const p = period(req);
  const saved = db.prepare(`
    SELECT b.*, EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = b.id) AS accounted
      FROM schedule_blocks b WHERE b.person_id = ? AND b.period = ? ORDER BY b.date, b.start`).all(id, p);

  if (saved.length) {
    const person = db.prepare('SELECT id, name FROM people WHERE id = ?').get(id);
    // a draft anywhere means the month is under review — the journey's step 2
    const state = saved.some((b) => b.draft) ? 'draft' : 'committed';
    const scheduled = cap.round2(saved.reduce((s, b) => s + b.minutes, 0) / 60);
    // derived, not remembered: the saved plan versus what the allocations say
    // it should hold — the packer's warning used to vanish on save
    const expected = schedule.expectedPlanHours(id, p);
    return res.json({
      person, period: p, state, committed: state === 'committed', blocks: saved, unplaced: [],
      totals: {
        scheduled_hours: scheduled,
        unplaced_hours: Math.max(0, cap.round2(expected - scheduled)),
        blocks: saved.length,
      },
    });
  }

  const plan = schedule.planPerson(id, p);
  if (!plan) return res.status(404).json({ error: 'no such person' });
  res.json({ ...plan, state: 'none', committed: false });
}));

/** Commit the packer's draft, replacing anything already saved. */
app.post('/api/schedule/:id/generate', ok((req, res) => {
  const id = Number(req.params.id);
  const p = period(req);
  const plan = schedule.planPerson(id, p);
  if (!plan) return res.status(404).json({ error: 'no such person' });

  // blocks someone has answered (done or skipped) are history, not plan —
  // a rebuild replaces only what is still pending
  db.prepare(`DELETE FROM schedule_blocks WHERE person_id = ? AND period = ?
    AND NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = schedule_blocks.id)`)
    .run(id, p);
  const ins = db.prepare(`INSERT INTO schedule_blocks
    (person_id, period, contract_id, deliverable_id, label, date, start, minutes, anchored, manual, draft)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`);
  const fresh = plan.blocks.filter((b) => !b.kept);
  for (const b of fresh) {
    ins.run(id, p, b.contract_id || null, b.deliverable_id || null,
      b.label, b.date, b.start, Math.round(b.minutes), b.anchored ? 1 : 0);
  }
  res.json({
    saved: fresh.length,
    kept: plan.blocks.length - fresh.length,
    unplaced: plan.unplaced.length,
    weekend: fresh.filter((b) => b.overflow).length,
    weekend_hours: cap.round2(fresh.filter((b) => b.overflow).reduce((s, b) => s + b.minutes, 0) / 60),
  });
}));

/**
 * Where every person's month stands. Answers the question a manager actually
 * has at the start of a month — whose plan is live, whose is still a
 * suggestion nobody sent, and who has none at all — which previously took
 * clicking through the team one at a time to discover.
 */
app.get('/api/schedule-overview', ok((req, res) => {
  const p = period(req);
  const people = db.prepare(
    'SELECT id, name FROM people WHERE active = 1 AND archived = 0 ORDER BY sort_order, name').all();
  const rows = people.map((person) => {
    const blocks = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(minutes),0) m, COALESCE(SUM(draft),0) d
      FROM schedule_blocks WHERE person_id = ? AND period = ?`).get(person.id, p);
    const state = !blocks.n ? 'none' : blocks.d ? 'draft' : 'committed';
    const expected = schedule.expectedPlanHours(person.id, p);
    const planned = cap.round2(blocks.m / 60);
    const logged = db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM time_entries
      WHERE person_id = ? AND date LIKE ? AND source != 'skip'`).get(person.id, `${p}-%`).m;
    const unconfirmed = db.prepare(`SELECT COUNT(*) n FROM schedule_blocks b
      WHERE b.person_id = ? AND b.period = ? AND b.draft = 0 AND b.date <= date('now')
        AND NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = b.id)`).get(person.id, p).n;
    return {
      person_id: person.id, name: person.name, state,
      blocks: blocks.n, planned_hours: planned,
      expected_hours: expected,
      unscheduled_hours: Math.max(0, cap.round2(expected - planned)),
      overplanned_hours: Math.max(0, cap.round2(planned - expected)),
      logged_hours: cap.round2(logged / 60),
      unconfirmed_blocks: unconfirmed,
    };
  });
  res.json({ period: p, rows });
}));

/** Step 3: the reviewed suggestion goes onto the time sheet in one flip. */
app.post('/api/schedule/:id/commit', ok((req, res) => {
  const r = db.prepare('UPDATE schedule_blocks SET draft = 0 WHERE person_id = ? AND period = ? AND draft = 1')
    .run(Number(req.params.id), period(req));
  res.json({ committed: r.changes });
}));

/** Throw the suggestion away — the time sheet never saw it. */
app.delete('/api/schedule/:id/draft', ok((req, res) => {
  const r = db.prepare('DELETE FROM schedule_blocks WHERE person_id = ? AND period = ? AND draft = 1')
    .run(Number(req.params.id), period(req));
  res.json({ discarded: r.changes });
}));

/** Discard the plan — the uncommitted part. Answered blocks are the record
 *  of what happened and survive; only still-pending plan is cleared, from the
 *  time sheet and the calendar feed alike. */
app.delete('/api/schedule/:id/plan', ok((req, res) => {
  const id = Number(req.params.id);
  const p = period(req);
  const gone = db.prepare(`DELETE FROM schedule_blocks WHERE person_id = ? AND period = ?
    AND NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = schedule_blocks.id)`)
    .run(id, p);
  res.json({ discarded: gone.changes });
}));

/** Move a block to another day, change its time, or resize it. */
app.patch('/api/schedule/block/:blockId', ok((req, res) => {
  const b = db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(Number(req.params.blockId));
  if (!b) return res.status(404).json({ error: 'no such block' });

  const date = req.body.date || b.date;
  const start = req.body.start || b.start;
  // hours in, quarter-hour grain out — the same grain the packer works on
  const mins = req.body.hours !== undefined
    ? Math.max(15, Math.round((Number(req.body.hours) * 60) / 15) * 15)
    : b.minutes;

  db.prepare('UPDATE schedule_blocks SET date=?, start=?, minutes=?, manual=1 WHERE id=?')
    .run(date, start, mins, b.id);
  res.json({ ok: true });
}));

app.delete('/api/schedule/block/:blockId', ok((req, res) => {
  db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(Number(req.params.blockId));
  res.json({ ok: true });
}));

/** Add a block by hand — work the packer knew nothing about. */
app.post('/api/schedule/block', ok((req, res) => {
  const b = req.body;
  if (!b.person_id || !b.date) throw new Error('person and date are required');
  const c = b.contract_id ? db.prepare('SELECT name FROM contracts WHERE id = ?').get(b.contract_id) : null;
  const d = b.deliverable_id ? db.prepare('SELECT name FROM deliverables WHERE id = ?').get(b.deliverable_id) : null;
  const label = b.label || [c?.name, d?.name].filter(Boolean).join(' — ') || 'Untitled';

  const minutes = b.minutes ? Math.max(15, Math.round(Number(b.minutes) / 15) * 15)
    : Math.max(15, Math.round((Number(b.hours || 1) * 60) / 15) * 15);
  db.prepare(`INSERT INTO schedule_blocks
    (person_id, period, contract_id, deliverable_id, label, date, start, minutes, anchored, manual, draft)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`)
    .run(b.person_id, b.period || period(req), b.contract_id || null, b.deliverable_id || null,
      label, b.date, b.start || '09:00', minutes, b.draft ? 1 : 0);
  res.json({ ok: true });
}));

app.get('/api/schedule/:id/ics', ok((req, res) => {
  const p = period(req);
  const id = Number(req.params.id);
  const saved = db.prepare(`
    SELECT b.*, EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = b.id) AS accounted
      FROM schedule_blocks b WHERE b.person_id = ? AND b.period = ? ORDER BY b.date, b.start`).all(id, p);
  const person = db.prepare('SELECT id, name FROM people WHERE id = ?').get(id);
  if (!person) return res.status(404).json({ error: 'no such person' });

  // export whatever they are actually looking at: the committed plan if there
  // is one, otherwise the live draft
  const plan = saved.length
    ? { person, period: p, blocks: saved.map((b) => ({
        ...b, end: addMinutes(b.start, b.minutes), deliverable: b.label })) }
    : schedule.planPerson(id, p);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const safe = person.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-${p}.ics"`);
  res.send(schedule.toIcs(plan, stamp));
}));

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

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
