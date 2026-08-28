// Exercises time.js against a throwaway database. It wipes tables and seeds
// fixtures, so it must NEVER touch the real data directory: it provisions its
// own before db.js is loaded, whatever the environment says.
// Every assertion is exact — entries are integer minutes, so any drift at all
// is a bug, not noise.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'emotio-time-test-'));
const assert = require('node:assert');
const { db } = require('./db');
const T = require('./time');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.strictEqual(a, b, `${msg} (got ${a}, want ${b})`); };
const throws = (fn, msg) => { checks++; assert.throws(fn, undefined, msg); };

// --- fixtures ---------------------------------------------------------------
db.exec('DELETE FROM time_entries; DELETE FROM timers; DELETE FROM schedule_blocks;');
db.prepare("INSERT INTO people (id, name, initials) VALUES (1, 'Test Person', 'TP'), (2, 'Other Person', 'OP')").run();
db.prepare("INSERT INTO contracts (id, name, type) VALUES (10, 'Client A', 'retainer'), (11, 'Client B', 'retainer')").run();
db.prepare("INSERT INTO deliverables (id, name) VALUES (100, 'SEO'), (101, 'Google Ads')").run();

const block = (id, person, date, start, minutes, contract = 10, deliv = 100) =>
  db.prepare(`INSERT INTO schedule_blocks (id, person_id, period, contract_id, deliverable_id, label, date, start, minutes)
    VALUES (?, ?, ?, ?, ?, 'Client A — SEO', ?, ?, ?)`)
    .run(id, person, date.slice(0, 7), contract, deliv, date, start, minutes);

// Mon 2026-08-03 .. Fri 2026-08-07
block(1, 1, '2026-08-03', '09:00', 120);
block(2, 1, '2026-08-03', '14:00', 90);
block(3, 1, '2026-08-04', '10:00', 60, 11, 101);
block(4, 1, '2026-08-07', '09:00', 240);
block(5, 2, '2026-08-03', '09:00', 60);       // someone else's

// --- helpers under test -----------------------------------------------------
const { isDate, isTime } = T._internal;
ok(isDate('2026-08-03') && !isDate('2026-02-30') && !isDate('2026-13-01') && !isDate('x'), 'date validation');
ok(isTime('09:00') && isTime('23:59') && !isTime('24:00') && !isTime('9:00') && !isTime('09:60'), 'time validation');
eq(T.mondayOf('2026-08-05'), '2026-08-03', 'mondayOf mid-week');
eq(T.mondayOf('2026-08-03'), '2026-08-03', 'mondayOf on a Monday');
eq(T.mondayOf('2026-08-09'), '2026-08-03', 'mondayOf on a Sunday');
eq(T.addDays('2026-08-31', 1), '2026-09-01', 'addDays month roll');

// --- day view before anything logged ---------------------------------------
let day = T.dayView(1, '2026-08-03');
eq(day.totals.planned_minutes, 210, 'planned = 120 + 90');
eq(day.totals.logged_minutes, 0, 'nothing logged yet');
eq(day.totals.pending, 2, 'both blocks pending');

// --- confirm: entry mirrors the block exactly -------------------------------
const e1 = T.confirmBlock(1, 1, 'went to plan');
eq(e1.minutes, 120, 'confirm copies minutes');
eq(e1.start, '09:00', 'confirm copies start');
eq(e1.date, '2026-08-03', 'confirm copies date');
eq(e1.contract_id, 10, 'confirm copies contract');
eq(e1.source, 'confirm', 'source is confirm');
throws(() => T.confirmBlock(1, 1), 'double-confirm refused');
throws(() => T.confirmBlock(1, 5), "someone else's block refused");
throws(() => T.confirmBlock(2, 1), 'cross-person confirm refused');

// --- the past is fixed: a passed day's committed time needs an override -----
throws(() => T.updateEntry(1, e1.id, { minutes: 150 }), 'past-day edit without override refused');
throws(() => T.deleteEntry(1, e1.id), 'past-day delete without override refused');

// --- adjust: resize becomes an adjustment, totals follow --------------------
const e1b = T.updateEntry(1, e1.id, { minutes: 150, override: true });
eq(e1b.minutes, 150, 'resize applied');
eq(e1b.source, 'adjust', 'confirm becomes adjust when changed');
day = T.dayView(1, '2026-08-03');
eq(day.totals.logged_minutes, 150, 'day total follows the resize');
eq(day.blocks.find((b) => b.id === 1).logged_minutes, 150, 'block sees its logged minutes');
eq(day.blocks.find((b) => b.id === 1).status, 'done', 'block is done');

// --- skip: zero minutes, mutually exclusive with work -----------------------
const sk = T.skipBlock(1, 2, 'client cancelled');
eq(sk.minutes, 0, 'skip carries no minutes');
day = T.dayView(1, '2026-08-03');
eq(day.totals.logged_minutes, 150, 'skip adds nothing to logged');
eq(day.blocks.find((b) => b.id === 2).status, 'skipped', 'block shows skipped');
throws(() => T.confirmBlock(1, 2), 'confirm on skipped block refused');
throws(() => T.addEntry(1, { block_id: 2, date: '2026-08-03', minutes: 30 }), 'work on skipped block refused');
throws(() => T.skipBlock(1, 2, 'again'), 'double skip refused');
throws(() => T.skipBlock(1, 1), 'skip on worked block refused');
throws(() => T.updateEntry(1, sk.id, { minutes: 30, override: true }), 'skip cannot gain minutes');
// unskip = delete the skip entry; block returns to pending
T.deleteEntry(1, sk.id);
eq(T.dayView(1, '2026-08-03').blocks.find((b) => b.id === 2).status, 'pending', 'unskip restores pending');

// --- split: two entries answer for one block --------------------------------
T.addEntry(1, { block_id: 2, date: '2026-08-03', start: '14:00', minutes: 45, source: 'adjust' });
T.addEntry(1, { block_id: 2, date: '2026-08-04', start: '09:00', minutes: 45, source: 'adjust' });
day = T.dayView(1, '2026-08-03');
eq(day.blocks.find((b) => b.id === 2).logged_minutes, 90, 'split sums across days');
eq(day.totals.logged_minutes, 195, 'day logged = 150 + 45 (second half is tomorrow)');

// --- unplanned entry --------------------------------------------------------
throws(() => T.addEntry(1, { date: '2026-08-04', minutes: 30 }), 'manual entry needs contract+deliverable');
throws(() => T.addEntry(1, { date: '2026-08-04', contract_id: 10, deliverable_id: 100, minutes: 0 }), 'zero minutes refused');
throws(() => T.addEntry(1, { date: '2026-08-04', contract_id: 10, deliverable_id: 100, minutes: 30.5 }), 'fractional minutes refused');
throws(() => T.addEntry(1, { date: '2026-08-04', contract_id: 10, deliverable_id: 100, minutes: 2000 }), 'over a day refused');
throws(() => T.addEntry(1, { date: '2026-08-04', contract_id: 999, deliverable_id: 100, minutes: 30 }), 'unknown contract refused');
const man = T.addEntry(1, { date: '2026-08-04', contract_id: 10, deliverable_id: 100, minutes: 30, note: 'ad-hoc fix' });
eq(man.block_id, null, 'manual entry has no block');
eq(man.source, 'manual', 'manual source');

// --- confirm-day sweeps only pending ---------------------------------------
const cd = T.confirmDay(1, '2026-08-03');
eq(cd.confirmed, 0, 'nothing pending on the 3rd after split');
block(6, 1, '2026-08-05', '09:00', 75);
block(7, 1, '2026-08-05', '11:00', 45);
const cd2 = T.confirmDay(1, '2026-08-05');
eq(cd2.confirmed, 2, 'both fresh blocks confirmed');
eq(T.dayView(1, '2026-08-05').totals.logged_minutes, 120, 'confirm-day logs 75+45');

// --- week view arithmetic ---------------------------------------------------
const wk = T.weekView(1, '2026-08-05');
eq(wk.start, '2026-08-03', 'week starts Monday');
eq(wk.days.length, 7, 'seven days');
eq(wk.totals.planned_minutes, 210 + 60 + 240 + 120, 'week planned sums all blocks');
const wkLogged = wk.totals.per_day.reduce((s, d) => s + d.logged_minutes, 0);
eq(wk.totals.logged_minutes, wkLogged, 'week total equals sum of days');
eq(wk.totals.logged_minutes, 150 + 45 + 45 + 30 + 120, 'week logged exact');

// --- entry security ---------------------------------------------------------
throws(() => T.updateEntry(2, e1.id, { minutes: 1, override: true }), "cannot edit someone else's entry");
throws(() => T.deleteEntry(2, e1.id), "cannot delete someone else's entry");

// --- drag arranges the plan; only the tick commits ---------------------------
const FUT = T.addDays(T.todayLondon(), 3);          // a future working slot
const FUT_PERIOD = FUT.slice(0, 7);
db.prepare(`INSERT INTO schedule_blocks (id, person_id, period, contract_id, deliverable_id, label, date, start, minutes)
  VALUES (20, 1, ?, 10, 100, 'Client A — SEO', ?, '09:00', 60),
         (21, 1, ?, 10, 100, 'Client A — SEO', ?, '10:30', 90)`)
  .run(FUT_PERIOD, FUT, FUT_PERIOD, FUT);
const moved = T.moveBlock(1, 20, FUT, '14:00');
eq(moved.start, '14:00', 'moveBlock repositions the plan');
eq(T.dayView(1, FUT).totals.logged_minutes, 0, 'moving commits nothing');
eq(T.dayView(1, FUT).blocks.find((b) => b.id === 20).status, 'pending', 'moved block still pending');
throws(() => T.moveBlock(2, 20, FUT, '15:00'), "cannot move someone else's block");
throws(() => T.moveBlock(1, 20, '2030-01-05', '09:00'), 'cannot leave its month');
throws(() => T.moveBlock(1, 20, FUT, '10:00'), 'cannot land on another block (10:00–11:00 hits 10:30–12:00)');
throws(() => T.moveBlock(1, 20, FUT, 'nonsense'), 'bad time refused');
const cfM = T.confirmBlock(1, 20, '');
eq(cfM.start, '14:00', 'tick commits at the moved position');
eq(cfM.date, FUT, 'tick commits on the moved day');
throws(() => T.moveBlock(1, 20, FUT, '16:00'), 'an accounted block cannot be re-planned');
// future entries stay freely editable — the lock is only about the past
const eFut = T.updateEntry(1, cfM.id, { minutes: 75 });
eq(eFut.minutes, 75, 'future entry edits without override');
T.deleteEntry(1, eFut.id);
eq(T.dayView(1, FUT).blocks.find((b) => b.id === 20).status, 'pending', 'delete restores pending, no override needed');

// --- calendar feed -----------------------------------------------------------
const tok = T.calendarToken(1);
ok(tok.length >= 24, 'token is long and random');
eq(T.calendarToken(1), tok, 'token is stable across calls');
eq(T.personByToken(tok).id, 1, 'token resolves to its person');
eq(T.personByToken('short'), null, 'short token rejected');
eq(T.personByToken('x'.repeat(32)), null, 'wrong token rejected');
const feed = T.feedBlocks(1);
ok(feed.some((b) => b.id === 20), 'feed carries the upcoming block');
ok(feed.every((b) => b.status !== 'skipped'), 'skipped blocks never reach the calendar');
const fb = feed.find((b) => b.id === 20);
eq(fb.end, '15:00', 'feed computes the end time (14:00 + 60m)');
T.skipBlock(1, 21, 'not needed');
ok(!T.feedBlocks(1).some((b) => b.id === 21), 'a skip vanishes from the feed');

// --- timer ------------------------------------------------------------------
throws(() => T.startTimer(1, {}), 'timer needs contract+deliverable');
T.startTimer(1, { contract_id: 10, deliverable_id: 100 });
throws(() => T.startTimer(1, { contract_id: 10, deliverable_id: 100 }), 'second timer refused');
ok(T.currentTimer(1) && T.currentTimer(1).elapsed_minutes >= 0, 'timer reports elapsed');
const te = T.stopTimer(1, 'quick call');
eq(te.source, 'timer', 'timer entry source');
ok(te.minutes >= 1, 'timer entry is at least a minute');
eq(T.currentTimer(1), null, 'timer gone after stop');
T.startTimer(1, { block_id: 4 });
eq(T.currentTimer(1).contract_id, 10, 'block timer inherits contract');
T.cancelTimer(1);
eq(T.currentTimer(1), null, 'cancel clears timer');

// --- variance: every identity ----------------------------------------------
const v = T.variance('2026-08');
// planned across the period = whatever the table holds for it (the moveBlock
// fixtures land in this month or the next depending on today's date)
const plannedAll = db.prepare("SELECT COALESCE(SUM(minutes),0) m FROM schedule_blocks WHERE date LIKE '2026-08-%'").get().m;
eq(v.totals.planned_minutes, plannedAll, 'variance planned = all blocks');
const dbLogged = db.prepare("SELECT COALESCE(SUM(minutes),0) m FROM time_entries WHERE source != 'skip' AND date LIKE '2026-08-%'").get().m;
eq(v.totals.logged_minutes, dbLogged, 'variance logged = table sum');
const cellPlanned = v.rows.reduce((s, r) => s + r.planned_minutes, 0);
const cellLogged = v.rows.reduce((s, r) => s + r.logged_minutes, 0);
eq(cellPlanned, v.totals.planned_minutes, 'cells sum to planned total');
eq(cellLogged, v.totals.logged_minutes, 'cells sum to logged total');
const personPlanned = v.by_person.reduce((s, r) => s + r.planned_minutes, 0);
const contractPlanned = v.by_contract.reduce((s, r) => s + r.planned_minutes, 0);
eq(personPlanned, v.totals.planned_minutes, 'by-person rollup conserves planned');
eq(contractPlanned, v.totals.planned_minutes, 'by-contract rollup conserves planned');
const personLogged = v.by_person.reduce((s, r) => s + r.logged_minutes, 0);
const contractLogged = v.by_contract.reduce((s, r) => s + r.logged_minutes, 0);
eq(personLogged, v.totals.logged_minutes, 'by-person rollup conserves logged');
eq(contractLogged, v.totals.logged_minutes, 'by-contract rollup conserves logged');
for (const r of v.rows) {
  eq(round100(r.variance_hours), round100(r.logged_hours - r.planned_hours),
    `variance = logged - planned for ${r.person_name}/${r.contract_name}`);
}
function round100(n) { return Math.round(n * 100) / 100; }

// loggedHours agrees with variance
const lh = T.loggedHours(1, '2026-08');
const p1 = v.by_person.find((r) => r.id === 1);
eq(Math.round(lh * 60), p1.logged_minutes, 'loggedHours matches variance by-person');

console.log(`\n${checks} checks run\nall time identities hold`);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
