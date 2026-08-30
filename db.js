const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'ledger.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
-- People. rate is £/hour; the standard rate (settings.standard_rate, £100)
-- pegs the unit, so units = hours * rate / standard_rate.
-- utilisation is the share of available hours that goes to client work;
-- the remainder is the internal + training budget.
CREATE TABLE IF NOT EXISTS people (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  harvest_user_id  INTEGER UNIQUE,
  name             TEXT    NOT NULL,
  initials         TEXT    NOT NULL DEFAULT '',
  weekly_hours     REAL    NOT NULL DEFAULT 37.5,
  rate             REAL    NOT NULL DEFAULT 100,
  utilisation      REAL    NOT NULL DEFAULT 0.87,
  colour           TEXT    NOT NULL DEFAULT '#14867d',
  active           INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0
);

-- Sign-in sessions. A row per signed-in device, revocable individually.
-- person_id NULL means the shared passcode was used, which is always admin.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  person_id  INTEGER REFERENCES people(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL DEFAULT 'member',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Leave and sick, typed by hand, per period ('YYYY-MM').
CREATE TABLE IF NOT EXISTS leave (
  person_id     INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  period        TEXT    NOT NULL,
  annual_hours  REAL    NOT NULL DEFAULT 0,
  sick_hours    REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, period)
);

-- Contracts. type:
--   retainer — fixed units each month, must balance, carry-over allowed
--   pot      — a fixed allowance drawn down across a period, no monthly balance
--   internal — the internal/training budget; "contracted" is derived per person
CREATE TABLE IF NOT EXISTS contracts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  exec_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  type           TEXT    NOT NULL DEFAULT 'retainer',
  status         TEXT    NOT NULL DEFAULT 'live',   -- live | hold | pipeline
  monthly_units  REAL    NOT NULL DEFAULT 0,
  pot_units      REAL    NOT NULL DEFAULT 0,
  pot_start      TEXT,
  pot_end        TEXT,
  harvest_ids    TEXT    NOT NULL DEFAULT '',       -- comma-separated project ids
  notes          TEXT    NOT NULL DEFAULT '',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0
);

-- The standard deliverable library.
CREATE TABLE IF NOT EXISTS deliverables (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  internal   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Scheduling recipe per deliverable. Editable in Settings.
--   cadence      weekly | fortnightly | monthly | oneoff
--   distribution spread | frontload | anchored | deadline
CREATE TABLE IF NOT EXISTS recipes (
  deliverable_id INTEGER PRIMARY KEY REFERENCES deliverables(id) ON DELETE CASCADE,
  cadence        TEXT    NOT NULL DEFAULT 'weekly',
  distribution   TEXT    NOT NULL DEFAULT 'spread',
  block_minutes  INTEGER NOT NULL DEFAULT 60,
  splittable     INTEGER NOT NULL DEFAULT 1,
  max_sittings   INTEGER NOT NULL DEFAULT 0,        -- 0 = unlimited
  anchor_dow     INTEGER NOT NULL DEFAULT 2,        -- 1=Mon .. 5=Fri
  anchor_time    TEXT    NOT NULL DEFAULT '10:00'
);

-- Per-person overrides of a scheduling recipe. Settings holds the agency
-- default; anything here wins for that person only. A row exists only where
-- someone actually works differently.
CREATE TABLE IF NOT EXISTS person_recipes (
  person_id      INTEGER NOT NULL REFERENCES people(id)       ON DELETE CASCADE,
  deliverable_id INTEGER NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  cadence        TEXT    NOT NULL DEFAULT 'weekly',
  distribution   TEXT    NOT NULL DEFAULT 'spread',
  block_minutes  INTEGER NOT NULL DEFAULT 60,
  splittable     INTEGER NOT NULL DEFAULT 1,
  max_sittings   INTEGER NOT NULL DEFAULT 0,
  anchor_dow     INTEGER NOT NULL DEFAULT 2,
  anchor_time    TEXT    NOT NULL DEFAULT '10:00',
  PRIMARY KEY (person_id, deliverable_id)
);

-- Third-party rate card. Consumes contract units, no team hours.
CREATE TABLE IF NOT EXISTS third_parties (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  default_units REAL    NOT NULL DEFAULT 1,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- Channel scope tags (Meta, TikTok...). Recorded, not separately costed.
CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contract_channels (
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id)  ON DELETE CASCADE,
  PRIMARY KEY (contract_id, channel_id)
);

-- Allocations are entered in HOURS. Units are always derived.
CREATE TABLE IF NOT EXISTS allocations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id    INTEGER NOT NULL REFERENCES contracts(id)    ON DELETE CASCADE,
  period         TEXT    NOT NULL,
  person_id      INTEGER NOT NULL REFERENCES people(id)       ON DELETE CASCADE,
  deliverable_id INTEGER NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  hours          REAL    NOT NULL DEFAULT 0,
  UNIQUE (contract_id, period, person_id, deliverable_id)
);

-- Third-party consumption, in units.
CREATE TABLE IF NOT EXISTS tp_allocations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id     INTEGER NOT NULL REFERENCES contracts(id)     ON DELETE CASCADE,
  period          TEXT    NOT NULL,
  third_party_id  INTEGER NOT NULL REFERENCES third_parties(id) ON DELETE CASCADE,
  units           REAL    NOT NULL DEFAULT 0,
  UNIQUE (contract_id, period, third_party_id)
);

-- Declared carry-over. Never silent.
CREATE TABLE IF NOT EXISTS carryover (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  period      TEXT    NOT NULL,
  units       REAL    NOT NULL DEFAULT 0,
  from_period TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  UNIQUE (contract_id, period)
);

-- Actuals pulled from Harvest.
CREATE TABLE IF NOT EXISTS actuals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  period         TEXT    NOT NULL,
  person_id      INTEGER REFERENCES people(id)       ON DELETE CASCADE,
  contract_id    INTEGER REFERENCES contracts(id)    ON DELETE SET NULL,
  deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
  harvest_project TEXT   NOT NULL DEFAULT '',
  harvest_task    TEXT   NOT NULL DEFAULT '',
  hours          REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_actuals_period ON actuals(period);

-- What actually happened, one row per stretch of worked time. The plan stays
-- in schedule_blocks; reality lives here, and the two are never merged --
-- variance IS the comparison between them. block_id ties an entry back to the
-- planned block it accounts for; NULL means unplanned work.
--   source: confirm  - block accepted as planned
--           adjust   - block done, but moved / resized / split
--           timer    - captured live by the timer
--           manual   - typed in with no planned block behind it
--           skip     - block did not happen (minutes must be 0, note says why)
CREATE TABLE IF NOT EXISTS time_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id       INTEGER REFERENCES schedule_blocks(id) ON DELETE SET NULL,
  person_id      INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  contract_id    INTEGER REFERENCES contracts(id)       ON DELETE SET NULL,
  deliverable_id INTEGER REFERENCES deliverables(id)    ON DELETE SET NULL,
  date           TEXT    NOT NULL,
  start          TEXT,
  minutes        INTEGER NOT NULL DEFAULT 0,
  note           TEXT    NOT NULL DEFAULT '',
  source         TEXT    NOT NULL DEFAULT 'manual',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_entries_person_date ON time_entries(person_id, date);
CREATE INDEX IF NOT EXISTS idx_time_entries_block ON time_entries(block_id);

-- One running timer per person, survives a restart because it is a row.
CREATE TABLE IF NOT EXISTS timers (
  person_id      INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  block_id       INTEGER REFERENCES schedule_blocks(id) ON DELETE SET NULL,
  contract_id    INTEGER REFERENCES contracts(id)       ON DELETE SET NULL,
  deliverable_id INTEGER REFERENCES deliverables(id)    ON DELETE SET NULL,
  label          TEXT    NOT NULL DEFAULT '',
  started_at     TEXT    NOT NULL
);

-- Fixed calendar commitments a person already has (weekly calls etc).
CREATE TABLE IF NOT EXISTS anchors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  contract_id INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  dow         INTEGER NOT NULL DEFAULT 2,
  time        TEXT    NOT NULL DEFAULT '10:00',
  minutes     INTEGER NOT NULL DEFAULT 60
);

-- Maps Harvest task names onto the deliverable library. 357 Harvest tasks are
-- really ~14 deliverables wearing client prefixes; the pattern is matched against
-- the task name with its client prefix stripped. Editable in Settings.
CREATE TABLE IF NOT EXISTS task_map (
  pattern        TEXT    PRIMARY KEY,
  deliverable_id INTEGER NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE
);

-- A person's committed plan for a month. The packer produces a first draft;
-- once saved, these rows are the plan and can be moved, resized or deleted by
-- hand. Regenerating discards manual edits, which is why it asks first.
CREATE TABLE IF NOT EXISTS schedule_blocks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id      INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  period         TEXT    NOT NULL,
  contract_id    INTEGER REFERENCES contracts(id)    ON DELETE CASCADE,
  deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
  label          TEXT    NOT NULL,
  date           TEXT    NOT NULL,
  start          TEXT    NOT NULL,
  minutes        INTEGER NOT NULL,
  anchored       INTEGER NOT NULL DEFAULT 0,
  manual         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_blocks ON schedule_blocks(person_id, period);

-- Months that exist. Adding one copies the previous month's allocations
-- forward so you edit a populated month rather than starting from nothing.
CREATE TABLE IF NOT EXISTS months (
  period     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  copied_from TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// migration: archived people stay in history but drop out of every view
try { db.exec('ALTER TABLE people ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); }
catch (e) { /* already there */ }

// repair: saved schedule blocks lost their deliverable_id (the packer only
// carried the name), and entries confirmed from them inherited the loss.
// The label keeps the name — "Contract — Deliverable", or just the
// deliverable for internal work — so the id can be recovered from it.
db.exec(`
  UPDATE schedule_blocks SET deliverable_id = (
    SELECT d.id FROM deliverables d
     WHERE schedule_blocks.label = d.name
        OR schedule_blocks.label LIKE '% — ' || d.name)
   WHERE deliverable_id IS NULL;
  UPDATE time_entries SET deliverable_id = (
    SELECT b.deliverable_id FROM schedule_blocks b WHERE b.id = time_entries.block_id)
   WHERE deliverable_id IS NULL AND block_id IS NOT NULL;
`);

// migration: people belong to a department too, so the agency view can show
// capacity and load per department, not just contracts.
try { db.exec("ALTER TABLE people ADD COLUMN department TEXT NOT NULL DEFAULT 'marketing'"); }
catch (e) { /* already there */ }

// migration: fixed commitments gain a cadence — daily, weekly, fortnightly or
// monthly — where before every one was implicitly weekly.
try { db.exec("ALTER TABLE anchors ADD COLUMN cadence TEXT NOT NULL DEFAULT 'weekly'"); }
catch (e) { /* already there */ }

// migration: a plan now has a draft stage. A suggestion is saved as draft
// blocks the person can push around; nothing reaches the time sheet, the
// calendar feed, or the variance numbers until they send it there.
try { db.exec('ALTER TABLE schedule_blocks ADD COLUMN draft INTEGER NOT NULL DEFAULT 0'); }
catch (e) { /* already there */ }

// repair: entries orphaned by early plan rebuilds lost their deliverable and
// reported as "Uncategorised". Where the person had exactly one deliverable
// allocated on that contract that month, the answer is unambiguous.
db.exec(`
  UPDATE time_entries SET deliverable_id = (
    SELECT a.deliverable_id FROM allocations a
     WHERE a.person_id = time_entries.person_id
       AND a.contract_id = time_entries.contract_id
       AND a.period = substr(time_entries.date, 1, 7)
     GROUP BY a.contract_id HAVING COUNT(DISTINCT a.deliverable_id) = 1)
   WHERE deliverable_id IS NULL AND block_id IS NULL AND contract_id IS NOT NULL;
`);

// migration: departments. Everything to date is the marketing department;
// design is joining the time system, so contracts now say whose they are.
try { db.exec("ALTER TABLE contracts ADD COLUMN department TEXT NOT NULL DEFAULT 'marketing'"); }
catch (e) { /* already there */ }


// migration: a private token per person lets their calendar app subscribe to
// their schedule without a login — the token IS the credential, so it is
// random, revocable, and never derived from anything guessable.
try { db.exec('ALTER TABLE people ADD COLUMN calendar_token TEXT'); }
catch (e) { /* already there */ }

// migration: a contract can start or finish mid-month. Without dates the
// scheduler spread work across the whole month regardless, booking time after
// a contract had already ended.
for (const [col, def] of [['starts_on', 'TEXT'], ['ends_on', 'TEXT']]) {
  try { db.exec(`ALTER TABLE contracts ADD COLUMN ${col} ${def}`); }

// The pot window now follows the contract's run dates. Old pot contracts that
// only had pot months get run dates backfilled from them, then every contract's
// pot months are resynced from its run dates.
  catch (e) { /* already there */ }
}

// The pot window follows the contract's run dates: backfill run dates from
// old pot months, then resync pot months from run dates.
db.exec(`
  UPDATE contracts SET starts_on = pot_start || '-01'
   WHERE type = 'pot' AND starts_on IS NULL AND pot_start IS NOT NULL;
  UPDATE contracts SET ends_on = date(pot_end || '-01', '+1 month', '-1 day')
   WHERE type = 'pot' AND ends_on IS NULL AND pot_end IS NOT NULL;
  UPDATE contracts SET
    pot_start = CASE WHEN starts_on IS NULL THEN NULL ELSE substr(starts_on, 1, 7) END,
    pot_end   = CASE WHEN ends_on   IS NULL THEN NULL ELSE substr(ends_on,   1, 7) END;
`);

// migration: backfill bank holidays for instances created before they existed
try {
  const cur = db.prepare("SELECT value FROM settings WHERE key = 'holidays'").get();
  if (!cur || !cur.value.trim()) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('holidays', ?) "
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(UK_BANK_HOLIDAYS);
  }
} catch (e) { /* settings not ready */ }

// migration: anchoring belongs on a contract, not on an agency-wide default —
// every contract's reporting cannot land Thursday at 2pm. Existing anchored
// recipes become deadline work; per-contract Fixed commitments do the pinning.
try { db.exec("UPDATE recipes SET distribution = 'deadline' WHERE distribution = 'anchored'"); }
catch (e) { /* no recipes yet */ }
try { db.exec("UPDATE person_recipes SET distribution = 'deadline' WHERE distribution = 'anchored'"); }
catch (e) { /* table not there yet */ }

// migration: per-person sign-in. A member sees only their own month, in hours;
// an admin sees the whole agency. Rates never reach a member, because units
// divided by hours would give them away.
for (const [col, def] of [
  ['email', "TEXT NOT NULL DEFAULT ''"],
  ['password_hash', "TEXT NOT NULL DEFAULT ''"],
  ['role', "TEXT NOT NULL DEFAULT 'member'"],
]) {
  try { db.exec(`ALTER TABLE people ADD COLUMN ${col} ${def}`); }
  catch (e) { /* already there */ }
}

// migration: seed `months` from whatever periods already have allocations
try {
  const rows = db.prepare('SELECT DISTINCT period FROM allocations').all();
  const ins = db.prepare('INSERT OR IGNORE INTO months (period) VALUES (?)');
  for (const r of rows) ins.run(r.period);
  const dp = db.prepare("SELECT value FROM settings WHERE key = 'default_period'").get();
  if (dp) ins.run(dp.value);
} catch (e) { /* nothing to backfill */ }

// ---- defaults ----
// England & Wales bank holidays. Without these a month is over-counted by a
// day — August 2026 reads 21 working days when the Summer holiday makes it 20.
// Editable in Settings; substitute days are the ones actually taken.
const UK_BANK_HOLIDAYS = [
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04',
  '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03',
  '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
  '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01',
  '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26',
].join(', ');

const defaults = {
  holidays: UK_BANK_HOLIDAYS,
  standard_week: '37.5',      // hours a full-time week, for the month picker
  standard_rate: '100',       // £ that defines one unit
  work_start: '09:00',
  work_end: '17:30',
  lunch_start: '12:30',
  lunch_minutes: '60',
  max_client_minutes_per_day: '240',   // ceiling on one client in one day
  round_display: '0.25',
  harvest_account_id: '',
  harvest_token: '',
};
const putSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) putSetting.run(k, v);

const get = (k) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : null;
};
const set = (k, v) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(k, String(v));
};

module.exports = { db, get, set, DATA_DIR };
