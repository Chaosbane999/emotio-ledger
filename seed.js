/**
 * Seeds a fresh database.
 *
 * Two layers, deliberately separated:
 *
 *   1. Structure — the deliverable library, scheduling recipes, channel list
 *      and a generic third-party rate card. Not commercially sensitive, so it
 *      lives in this file and ships with the repo.
 *
 *   2. The book of business — people, rates, clients, contract values and
 *      allocations. Commercially sensitive, so it lives in `seed-data.json`,
 *      which is gitignored and never reaches GitHub. Without it the app starts
 *      structurally complete but empty, ready to be filled in through the UI
 *      or by dropping the file in and re-running.
 *
 * Safe to re-run: it only inserts what is missing.
 */
const fs = require('fs');
const path = require('path');
const { db, set, get } = require('./db');
const harvest = require('./harvest');

const PERIOD = process.env.SEED_PERIOD || '2026-08';

// ---------------------------------------------------------------------------
// Layer 1 — structure
// ---------------------------------------------------------------------------
// name, internal?, cadence, distribution, block mins, splittable, max sittings
const DELIVERABLES = [
  ['General Management',           0, 'weekly',  'spread',    30,  1, 0],
  ['Google Ads — management',      0, 'weekly',  'spread',    45,  1, 0],
  ['Google Ads — campaign build',  0, 'oneoff',  'frontload', 240, 1, 2],
  ['Paid Social Media Marketing',  0, 'weekly',  'spread',    45,  1, 0],
  ['Organic Social Media',         0, 'weekly',  'spread',    60,  1, 0],
  ['Email Marketing',              0, 'weekly',  'spread',    120, 0, 0],
  ['SEO / On-Page Optimisation',   0, 'monthly', 'spread',    120, 1, 0],
  ['Backlinks',                    0, 'monthly', 'spread',    120, 1, 0],
  ['AI Optimisation',              0, 'monthly', 'spread',    120, 1, 0],
  ['Design Work',                  0, 'monthly', 'deadline',  120, 0, 0],
  ['Asset Creation',               0, 'monthly', 'spread',    120, 1, 0],
  ['Automations',                  0, 'monthly', 'frontload', 180, 1, 0],
  ['Blog / Content Creation',      0, 'monthly', 'spread',    120, 1, 0],
  ['Reporting & Client Calls',     0, 'monthly', 'anchored',  120, 0, 0],
  ['Strategy',                     0, 'monthly', 'spread',    60,  1, 0],
  ['Internal',                     1, 'weekly',  'spread',    60,  1, 0],
  ['Training',                     1, 'monthly', 'spread',    90,  1, 0],
  ['Management',                   1, 'weekly',  'spread',    60,  1, 0],
];

const CHANNELS = ['Google Ads', 'Meta Ads', 'TikTok Ads', 'LinkedIn Ads', 'Pinterest Ads', 'Snapchat Ads'];

// Generic tool names with placeholder costs — set the real units in Settings.
const DEFAULT_THIRD_PARTIES = [
  ['SE Ranking — list management', 1],
  ['Stape', 1],
  ['Feed optimisation', 1],
  ['Blaze', 1],
  ['CallRail', 1],
  ['Backlink package', 3],
  ['Third party — to be itemised', 0],
];

// ---------------------------------------------------------------------------

function seedStructure() {
  const insD = db.prepare('INSERT OR IGNORE INTO deliverables (name, internal, sort_order) VALUES (?, ?, ?)');
  const insR = db.prepare(`INSERT OR IGNORE INTO recipes
    (deliverable_id, cadence, distribution, block_minutes, splittable, max_sittings, anchor_dow, anchor_time)
    VALUES (?, ?, ?, ?, ?, ?, 4, '14:00')`);
  DELIVERABLES.forEach(([name, internal, cad, dist, block, split, max], i) => {
    insD.run(name, internal, i);
    const d = db.prepare('SELECT id FROM deliverables WHERE name = ?').get(name);
    insR.run(d.id, cad, dist, block, split, max);
  });

  const insCh = db.prepare('INSERT OR IGNORE INTO channels (name, sort_order) VALUES (?, ?)');
  CHANNELS.forEach((n, i) => insCh.run(n, i));

  harvest.seedTaskMap();
}

// ---------------------------------------------------------------------------
// Layer 2 — the book of business, if the private file is present
// ---------------------------------------------------------------------------

function loadBusinessData() {
  const file = process.env.SEED_DATA || path.join(__dirname, 'seed-data.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`seed-data.json is not valid JSON: ${e.message}`); return null; }
}

function seedBusiness(data) {
  const insP = db.prepare(`INSERT OR IGNORE INTO people
    (name, harvest_user_id, weekly_hours, rate, utilisation, initials, active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  (data.people || []).forEach((p, i) =>
    insP.run(p.name, p.harvest_user_id ?? null, p.weekly_hours, p.rate, p.utilisation, p.initials, p.active, i));

  const insT = db.prepare('INSERT OR IGNORE INTO third_parties (name, default_units, sort_order) VALUES (?, ?, ?)');
  (data.third_parties || DEFAULT_THIRD_PARTIES.map(([name, u]) => ({ name, default_units: u })))
    .forEach((t, i) => insT.run(t.name, t.default_units, i));

  const personBy = (i) => db.prepare('SELECT * FROM people WHERE initials = ?').get(i);
  const contractBy = (n) => db.prepare('SELECT * FROM contracts WHERE name = ?').get(n);
  const delivBy = (n) => db.prepare('SELECT * FROM deliverables WHERE name = ?').get(n);

  const insC = db.prepare(`INSERT OR IGNORE INTO contracts
    (name, exec_person_id, type, status, monthly_units, pot_units, pot_start, pot_end, harvest_ids, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  (data.contracts || []).forEach((c, i) => {
    const ex = c.exec ? personBy(c.exec) : null;
    insC.run(c.name, ex ? ex.id : null, c.type, c.status, c.monthly_units,
      c.pot_units, c.pot_start, c.pot_end, c.harvest_ids || '', i);
  });

  const insA = db.prepare(`INSERT OR IGNORE INTO allocations
    (contract_id, period, person_id, deliverable_id, hours) VALUES (?, ?, ?, ?, ?)`);
  for (const a of data.allocations || []) {
    const c = contractBy(a.contract), p = personBy(a.person), d = delivBy(a.deliverable);
    if (c && p && d) insA.run(c.id, a.period, p.id, d.id, a.hours);
  }

  const insTA = db.prepare(`INSERT OR IGNORE INTO tp_allocations
    (contract_id, period, third_party_id, units) VALUES (?, ?, ?, ?)`);
  for (const t of data.tp_allocations || []) {
    const c = contractBy(t.contract);
    const tp = db.prepare('SELECT id FROM third_parties WHERE name = ?').get(t.service);
    if (c && tp) insTA.run(c.id, t.period, tp.id, t.units);
  }

  for (const a of data.anchors || []) {
    const p = personBy(a.person);
    if (!p) continue;
    const already = db.prepare('SELECT 1 FROM anchors WHERE person_id = ? AND label = ?').get(p.id, a.label);
    if (already) continue;
    const c = a.contract ? contractBy(a.contract) : null;
    db.prepare('INSERT INTO anchors (person_id, contract_id, label, dow, time, minutes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, c ? c.id : null, a.label, a.dow, a.time, a.minutes);
  }

  const linkCh = db.prepare('INSERT OR IGNORE INTO contract_channels (contract_id, channel_id) VALUES (?, ?)');
  for (const cc of data.contract_channels || []) {
    const c = contractBy(cc.contract);
    const ch = db.prepare('SELECT id FROM channels WHERE name = ?').get(cc.channel);
    if (c && ch) linkCh.run(c.id, ch.id);
  }
}

function run() {
  seedStructure();

  const data = loadBusinessData();
  if (data) seedBusiness(data);
  else {
    // structure only — give them a usable rate card to edit
    const insT = db.prepare('INSERT OR IGNORE INTO third_parties (name, default_units, sort_order) VALUES (?, ?, ?)');
    DEFAULT_THIRD_PARTIES.forEach(([n, u], i) => insT.run(n, u, i));
  }

  if (!get('seeded_at')) set('seeded_at', new Date().toISOString());
  set('default_period', PERIOD);

  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return {
    period: PERIOD,
    business_data: data ? 'loaded from seed-data.json' : 'none — structure only',
    people: count('people'),
    contracts: count('contracts'),
    deliverables: count('deliverables'),
    third_parties: count('third_parties'),
    allocations: count('allocations'),
    task_map: count('task_map'),
  };
}

if (require.main === module) console.log(JSON.stringify(run(), null, 2));

module.exports = { run, PERIOD };
