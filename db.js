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

-- Leave and sick, typed by hand, per person per period ('YYYY-MM').
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

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---- defaults ----
const defaults = {
  standard_rate: '100',       // £ that defines one unit
  work_start: '09:00',
  work_end: '17:30',
  lunch_start: '13:00',
  lunch_minutes: '30',
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
