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
const FUT = T.todayLondon();          // ticks only work once the day has come
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
// the future cannot be ticked — plan yes, reality no
const FUT3 = T.addDays(T.todayLondon(), 3);
if (FUT3.slice(0, 7) === FUT_PERIOD) {
  db.prepare(`INSERT INTO schedule_blocks (id, person_id, period, contract_id, deliverable_id, label, date, start, minutes)
    VALUES (25, 1, ?, 10, 100, 'Client A — SEO', ?, '09:00', 60)`).run(FUT_PERIOD, FUT3);
  throws(() => T.confirmBlock(1, 25), 'future block cannot be confirmed');
  throws(() => T.confirmDay(1, FUT3), 'future day cannot be confirmed');
  throws(() => T.addEntry(1, { block_id: 25, date: FUT3, minutes: 30, source: 'adjust' }), 'future worked entry refused');
  throws(() => T.addEntry(1, { date: FUT3, contract_id: 10, deliverable_id: 100, minutes: 30 }), 'future manual entry refused');
  const skF = T.skipBlock(1, 25, 'client cancelled next week');
  eq(skF.minutes, 0, 'skipping a future block is allowed — a statement about the plan');
  T.deleteEntry(1, skF.id);
  db.prepare('DELETE FROM schedule_blocks WHERE id = 25').run();
}
throws(() => T.moveBlock(1, 20, FUT, '10:00'), 'cannot land on another block (10:00–11:00 hits 10:30–12:00)');
throws(() => T.moveBlock(1, 20, FUT, 'nonsense'), 'bad time refused');
const cfM = T.confirmBlock(1, 20, '');
eq(cfM.start, '14:00', 'tick commits at the moved position');
eq(cfM.date, FUT, 'tick commits on the moved day');
throws(() => T.moveBlock(1, 20, FUT, '16:00'), 'an accounted block cannot be re-planned');
// today's entries stay freely editable — the lock is only about the past
const eFut = T.updateEntry(1, cfM.id, { minutes: 75 });
eq(eFut.minutes, 75, "today's entry edits without override");
throws(() => T.updateEntry(1, cfM.id, { date: T.addDays(T.todayLondon(), 2) }),
  'worked time cannot be moved into the future');
T.deleteEntry(1, eFut.id);
eq(T.dayView(1, FUT).blocks.find((b) => b.id === 20).status, 'pending', 'delete restores pending, no override needed');

// --- bump: displaced plan moves to the next free slot ------------------------
{
  const TD = T.todayLondon();
  {
    db.prepare(`INSERT INTO schedule_blocks (id, person_id, period, contract_id, deliverable_id, label, date, start, minutes)
      VALUES (50, 1, ?, 10, 100, 'Client A — SEO', ?, '09:00', 60),
             (51, 1, ?, 10, 100, 'Client A — SEO', ?, '10:00', 60)`)
      .run(TD.slice(0, 7), TD, TD.slice(0, 7), TD);
    const bumped = T.bumpBlock(1, 50);
    ok(bumped.date >= TD, 'bump never goes backwards');
    ok(!(bumped.date === TD && bumped.start === '09:00'), 'bump actually moved it');
    const others = db.prepare('SELECT start, minutes FROM schedule_blocks WHERE person_id = 1 AND date = ? AND id != 50').all(bumped.date);
    const bs = Number(bumped.start.slice(0, 2)) * 60 + Number(bumped.start.slice(3));
    for (const o of others) {
      const os = Number(o.start.slice(0, 2)) * 60 + Number(o.start.slice(3));
      ok(bs + bumped.minutes <= os || os + o.minutes <= bs, 'bumped slot is genuinely free');
    }
    db.prepare('DELETE FROM schedule_blocks WHERE id IN (50, 51)').run();
  }
}

// --- drafts: a suggestion is invisible until it is sent to the time sheet ----
{
  const TD = T.todayLondon();
  db.prepare(`INSERT INTO schedule_blocks (id, person_id, period, contract_id, deliverable_id, label, date, start, minutes, draft)
    VALUES (60, 1, ?, 10, 100, 'Client A — SEO', ?, '06:00', 60, 1)`).run(TD.slice(0, 7), TD);
  eq(T.dayView(1, TD).blocks.some((b) => b.id === 60), false, 'draft absent from the day view');
  eq(T.feedItems(1).some((b) => b.uid === 'ledger-block-60@emotio'), false, 'draft absent from the calendar feed');
  const vD = T.variance(TD.slice(0, 7));
  const draftPlanned = db.prepare('SELECT COALESCE(SUM(minutes),0) m FROM schedule_blocks WHERE draft = 1').get().m;
  const allPlanned = db.prepare("SELECT COALESCE(SUM(minutes),0) m FROM schedule_blocks WHERE date LIKE ?").get(`${TD.slice(0, 7)}-%`).m;
  eq(vD.totals.planned_minutes, allPlanned - draftPlanned, 'variance ignores drafts');
  // the flip: committed, it is real everywhere
  db.prepare('UPDATE schedule_blocks SET draft = 0 WHERE id = 60').run();
  eq(T.dayView(1, TD).blocks.some((b) => b.id === 60), true, 'committed block appears in the day view');
  ok(T.feedItems(1).some((b) => b.uid === 'ledger-block-60@emotio'), 'committed block reaches the calendar feed');
  db.prepare('DELETE FROM schedule_blocks WHERE id = 60').run();
}

// --- planCheck: the plan cannot quietly outgrow the allocation ---------------
{
  const TD = T.todayLondon();
  const PP = TD.slice(0, 7);
  // allocation: 2h. Plan: 2h existing + 10h added by hand = 10h over.
  db.prepare(`INSERT INTO allocations (contract_id, period, person_id, deliverable_id, hours)
    VALUES (11, ?, 1, 101, 2)`).run(PP);
  db.prepare(`INSERT INTO schedule_blocks (id, person_id, period, contract_id, deliverable_id, label, date, start, minutes)
    VALUES (70, 1, ?, 11, 101, 'Client B — Ads', ?, '06:00', 120),
           (71, 1, ?, 11, 101, 'Client B — Ads', ?, '01:00', 600)`).run(PP, TD, PP, TD);
  // earlier fixtures may already hold blocks for this contract this month —
  // the check is about the delta arithmetic, so measure against the baseline
  const baseMin = db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM schedule_blocks
    WHERE person_id = 1 AND contract_id = 11 AND period = ? AND id NOT IN (70, 71)`).get(PP).m;
  const c = T.planCheck(1, 11, PP, 71);
  eq(c.allocated_hours, 2, 'allocation read');
  eq(Math.round(c.planned_hours * 60), baseMin + 720, 'plan read');
  eq(c.over_minutes, baseMin + 720 - 120, 'overage exact');
  ok(c.proposal, 'a proposal comes with the warning');
  const trimmed = c.proposal.proposal.reduce((s2, x) => s2 + (x.from_minutes - x.to_minutes), 0);
  eq(trimmed + c.proposal.unplaced_minutes, c.over_minutes, 'trim + untrimmable = overage exactly');
  ok(!c.proposal.proposal.some((x) => x.block_id === 71), 'the block just added is never on the chopping list');
  // inside the allocation: silence
  db.prepare('DELETE FROM schedule_blocks WHERE id = 71').run();
  const c2 = T.planCheck(1, 11, PP, 0);
  eq(c2.over_minutes, Math.max(0, baseMin + 120 - 120), 'overage falls with the plan');
  db.prepare('DELETE FROM schedule_blocks WHERE id = 70').run();
  db.prepare('DELETE FROM allocations WHERE contract_id = 11 AND period = ?').run(PP);
}

// --- fixed commitments: what is scheduled equals what is budgeted ------------
{
  const cap = require('./capacity');
  db.exec('DELETE FROM anchors');
  db.prepare("INSERT INTO people (id,name,rate) VALUES (90,'Anchor Person',100)").run();
  db.prepare("INSERT INTO contracts (id,name,monthly_units) VALUES (90,'Anchor C',100)").run();
  const ins = db.prepare("INSERT INTO anchors (person_id,contract_id,label,dow,time,minutes,cadence) VALUES (90,90,?,2,'10:00',30,?)");
  const schedule = require('./schedule');
  for (const cad of ['daily', 'weekly', 'fortnightly', 'monthly']) {
    db.exec('DELETE FROM anchors WHERE person_id = 90');
    ins.run(cad, cad);
    const c = db.prepare('SELECT * FROM contracts WHERE id = 90').get();
    const charged = Math.round(cap.anchorLines(c, '2026-08').reduce((s2, l) => s2 + l.hours * 60, 0));
    const placed = schedule.planPerson(90, '2026-08').blocks
      .filter((b) => b.label.includes(cad)).reduce((s2, b) => s2 + b.minutes, 0);
    eq(charged, placed, `anchor ${cad}: scheduled minutes == budgeted minutes`);
  }
  // balance arithmetic still holds with an anchor consuming the contract
  db.exec("DELETE FROM anchors WHERE person_id = 90"); ins.run('weekly', 'weekly');
  const c = db.prepare('SELECT * FROM contracts WHERE id = 90').get();
  const sum = cap.contractSummary(c, '2026-08');
  ok(sum.lines.some((l) => l.anchor), 'anchor shows as a contract line');
  ok(Math.abs(sum.variance - (sum.available_units - sum.allocated_units)) < 0.01,
    'balance arithmetic holds with an anchor');
  db.exec('DELETE FROM anchors WHERE person_id = 90');
  db.prepare('DELETE FROM contracts WHERE id = 90').run();
  db.prepare('DELETE FROM people WHERE id = 90').run();
}

// --- calendar feed -----------------------------------------------------------
const tok = T.calendarToken(1);
ok(tok.length >= 24, 'token is long and random');
eq(T.calendarToken(1), tok, 'token is stable across calls');
eq(T.personByToken(tok).id, 1, 'token resolves to its person');
eq(T.personByToken('short'), null, 'short token rejected');
eq(T.personByToken('x'.repeat(32)), null, 'wrong token rejected');
// block 20 is pending again here (its entry was deleted just above)
let feed = T.feedItems(1);
ok(feed.some((b) => b.uid === 'ledger-block-20@emotio'), 'feed carries the pending block as plan');
eq(feed.find((b) => b.uid === 'ledger-block-20@emotio').end, '15:00', 'feed computes the end time (14:00 + 60m)');
T.skipBlock(1, 21, 'not needed');
feed = T.feedItems(1);
ok(!feed.some((b) => b.uid === 'ledger-block-21@emotio'), 'a skip vanishes from the feed');

// committed time appears as it happened — and its block stops appearing as plan
const cf20 = T.confirmBlock(1, 20, 'all done');
feed = T.feedItems(1);
ok(!feed.some((b) => b.uid === 'ledger-block-20@emotio'), 'a done block no longer appears as plan');
const fe = feed.find((b) => b.uid === `ledger-entry-${cf20.id}@emotio`);
ok(fe, 'the committed entry is in the feed');
eq(fe.start, '14:00', 'entry appears at its real slot');
ok(fe.label.startsWith('✓ '), 'committed events are marked');
ok(fe.deliverable.includes('all done'), 'the note rides along');
// a startless entry becomes an all-day event, never an invented hour
const loose = T.addEntry(1, { date: FUT, contract_id: 10, deliverable_id: 100, minutes: 45, note: 'odds and ends' });
feed = T.feedItems(1);
const fl = feed.find((b) => b.uid === `ledger-entry-${loose.id}@emotio`);
ok(fl && fl.all_day === true && fl.start === null, 'startless entry is all-day');
const schedule = require('./schedule');
const icsAll = schedule.toIcs({ person: { id: 1, name: 'T' }, period: 'live', blocks: feed });
ok(icsAll.includes(`VALUE=DATE:${FUT.replace(/-/g, '')}`), 'all-day event uses DATE value');
ok(icsAll.includes('T140000'), 'timed entry keeps its clock time');
T.deleteEntry(1, loose.id);
T.deleteEntry(1, cf20.id);

// --- resize a planned block; rebalance the month around the change ----------
// fresh future blocks for a clean rebalance scenario, spread across days
const D1 = T.addDays(T.todayLondon(), 4);
const D2 = T.addDays(T.todayLondon(), 5);
const D3 = T.addDays(T.todayLondon(), 6);
const RP = D1.slice(0, 7);
// only usable when all three land in one month (late-month runs skip this)
if (D2.slice(0, 7) === RP && D3.slice(0, 7) === RP) {
  db.prepare(`INSERT INTO schedule_blocks (id, person_id, period, contract_id, deliverable_id, label, date, start, minutes)
    VALUES (30, 1, ?, 11, 101, 'Client B — Ads', ?, '09:00', 60),
           (31, 1, ?, 11, 101, 'Client B — Ads', ?, '09:00', 90),
           (32, 1, ?, 11, 101, 'Client B — Ads', ?, '09:00', 60),
           (33, 1, ?, 11, 101, 'Client B — Ads', ?, '11:00', 30)`)
    .run(RP, D1, RP, D2, RP, D3, RP, D3);

  // resize rules
  throws(() => T.resizeBlock(1, 30, 20), 'off-grain refused');
  throws(() => T.resizeBlock(1, 30, 0), 'zero refused');
  throws(() => T.resizeBlock(2, 30, 90), "someone else's block refused");
  throws(() => T.resizeBlock(1, 32, 60 + 90), 'growing into the 11:00 block refused (only 60m of room)');
  const rs = T.resizeBlock(1, 30, 120);
  eq(rs.minutes, 120, 'resize applied');
  eq(rs.delta, 60, 'delta reported');
  eq(T.dayView(1, D1).totals.logged_minutes, 0, 'resizing a plan commits nothing');

  // took MORE time: trim from the end of the month inwards
  const rb = T.rebalancePlan(1, 11, RP, 60, 30);
  eq(rb.proposal.length, 2, 'a 60m trim spans two blocks (30m + 30m)');
  eq(rb.proposal[0].block_id, 33, 'trim starts at the latest block (11:00 beats 09:00 same day)');
  eq(rb.proposal[0].to_minutes, 0, 'the 30m block goes entirely');
  eq(rb.proposal[1].block_id, 32, 'remainder comes off the next-latest');
  eq(rb.proposal[1].to_minutes, 30, '60m block trimmed to 30m');
  const trimmed = rb.proposal.reduce((s2, p2) => s2 + (p2.from_minutes - p2.to_minutes), 0);
  eq(trimmed + rb.unplaced_minutes, 60, 'trimmed + unplaced = delta exactly');

  // apply it
  T.applyRebalance(1, rb.proposal.map((p2) => ({ block_id: p2.block_id, minutes: p2.to_minutes })));
  const left = db.prepare('SELECT COALESCE(SUM(minutes),0) m FROM schedule_blocks WHERE contract_id = 11 AND person_id = 1 AND period = ?').get(RP).m;
  // 60+90+60+30 originally; resize made it 300; the trim gives the 60 back
  eq(left, 240, 'resize +60 then rebalance -60 restores the original total');
  ok(!db.prepare('SELECT id FROM schedule_blocks WHERE id = 33').get() || rb.proposal[0].to_minutes > 0,
    'a block trimmed to zero is removed');

  // took LESS time: freed minutes return to the plan — grown in place where
  // there is room, or as a new block in free space on a packed day
  const rb2 = T.rebalancePlan(1, 11, RP, -45, 30);
  const returned = rb2.proposal.reduce((s2, p2) => s2 + (p2.to_minutes - p2.from_minutes), 0);
  eq(returned + rb2.unplaced_minutes, 45, 'returned + unplaced = |delta| exactly');
  for (const p2 of rb2.proposal) ok(p2.to_minutes > p2.from_minutes, 'extend only grows');
  // pack a day wall-to-wall: the freed time must come back as a NEW block
  const D4 = D1;
  db.prepare(`INSERT INTO schedule_blocks (id, person_id, period, contract_id, deliverable_id, label, date, start, minutes)
    VALUES (40, 1, ?, 11, 101, 'Client B — Ads', ?, '13:00', 60)`).run(RP, D4);
  const rb3 = T.rebalancePlan(1, 11, RP, -60, 30);
  const back = rb3.proposal.reduce((s2, p2) => s2 + (p2.to_minutes - p2.from_minutes), 0);
  eq(back + rb3.unplaced_minutes, 60, 'packed-day return conserves the delta');
  const nb = rb3.proposal.find((p2) => p2.new_block);
  if (nb) {
    ok(nb.start && nb.to_minutes >= 15, 'new block has a real slot and length');
    const applied = T.applyRebalance(1, [{ new_block: true, contract_id: 11, deliverable_id: nb.deliverable_id,
      date: nb.date, start: nb.start, label: nb.label, minutes: nb.to_minutes }]);
    ok(applied.applied[0].created, 'new block created on apply');
    db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(applied.applied[0].block_id);
  }
  db.prepare('DELETE FROM schedule_blocks WHERE id = 40').run();

  // an accounted block never rebalances (state seeded directly — the API
  // itself refuses to confirm a future block, which is its own rule above)
  db.prepare(`INSERT INTO time_entries (block_id, person_id, contract_id, deliverable_id, date, minutes, source)
    VALUES (31, 1, 11, 101, ?, 90, 'adjust')`).run(T.todayLondon());
  throws(() => T.applyRebalance(1, [{ block_id: 31, minutes: 15 }]), 'accounted block refused');
  throws(() => T.resizeBlock(1, 31, 60), 'accounted block cannot resize');
  db.prepare('DELETE FROM time_entries WHERE block_id = 31').run();
  db.prepare('DELETE FROM schedule_blocks WHERE id IN (30,31,32,33)').run();
} else {
  console.log('  (rebalance scenario skipped: month boundary)');
}

// --- block size is a minimum sitting, never a divisor ------------------------
{
  const { expand } = require('./schedule');
  const wk = [['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']];
  const rec = { cadence: 'weekly', distribution: 'spread', block_minutes: 30,
    splittable: 1, max_sittings: 0, anchor_dow: 2, anchor_time: '10:00' };
  for (const mins of [45, 60, 75, 90, 105, 300]) {
    const pieces = expand({ hours: mins / 60 }, rec, wk, 240).map((x) => x.minutes);
    eq(pieces.reduce((a, b) => a + b, 0), mins, `expand conserves ${mins}m`);
    ok(pieces.every((m) => m >= 30), `no piece under the 30m block (${mins}m -> ${pieces.join('+')})`);
  }
  // smaller than a block: the whole thing, unavoidably
  eq(expand({ hours: 0.25 }, rec, wk, 240).map((x) => x.minutes).join('+'), '15', 'sub-block totals stay whole');

  // a thin month never shaves sittings below the block: 180m/month on a
  // weekly cadence with a 60m block is 3 x 60m on spread weeks, not 4 x 45m
  const month = [
    ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'],
    ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
    ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'],
    ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'],
  ];
  const rec60 = { ...rec, block_minutes: 60 };
  const thin = expand({ hours: 3 }, rec60, month, 240);
  eq(thin.reduce((s, x) => s + x.minutes, 0), 180, 'thin weekly month conserves the total');
  ok(thin.every((x) => x.minutes >= 60), `every sitting at least the block (${thin.map((x) => x.minutes).join('+')})`);
  eq(thin.length, 3, 'three sittings, not four fragments');
  eq(new Set(thin.map((x) => x.week)).size, 3, 'sittings land on different weeks');
}

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

// --- working patterns: capacity, scheduler and the Slack window -------------
{
  const cap = require('./capacity');
  const sch = require('./schedule');

  // 3.5 days: Mon-Wed 09:00-17:30 (7.5h net of the fixture's hour lunch),
  // Thu 09:00-12:30 (3.5h, ends at lunch), Friday off
  db.prepare("INSERT INTO people (id, name, initials, weekly_hours) VALUES (3, 'Part Timer', 'PT', 37.5)").run();
  const pd = db.prepare('INSERT INTO person_days (person_id, dow, start_time, end_time) VALUES (3, ?, ?, ?)');
  for (const dow of [1, 2, 3]) pd.run(dow, '09:00', '17:30');
  pd.run(4, '09:00', '12:30');

  const pat = cap.patternOf(3);
  eq(pat.get(1).minutes, 450, 'a full pattern day is 7.5h net of lunch');
  eq(pat.get(4).minutes, 210, 'the half day is 3.5h');
  eq(pat.get(5), undefined, 'Friday is off');

  // September 2026: 4 Mondays, 5 Tuesdays, 5 Wednesdays, 4 Thursdays, 4 Fridays
  const p3 = db.prepare('SELECT * FROM people WHERE id = 3').get();
  eq(cap.personCapacity(p3, '2026-09').gross_hours, 119, 'gross sums the pattern date by date: 14x7.5 + 4x3.5');

  // the scheduler keeps every fresh block inside the pattern
  db.prepare(`INSERT INTO allocations (contract_id, period, person_id, deliverable_id, hours)
    VALUES (10, '2026-09', 3, 100, 20)`).run();
  const plan = sch.planPerson(3, '2026-09');
  const isoDow = (iso) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const byDay = {};
  for (const b of plan.blocks) byDay[b.date] = (byDay[b.date] || 0) + b.minutes;
  for (const [d, m] of Object.entries(byDay)) {
    const dow = isoDow(d);
    ok(dow <= 5 ? Boolean(pat.get(dow)) : true, `no block on a day off (${d})`);
    if (dow <= 5) ok(m <= pat.get(dow).minutes, `${d} within the pattern's day (${m} vs ${pat.get(dow).minutes})`);
  }
  eq(Math.round((plan.totals.scheduled_hours + plan.totals.unplaced_hours) * 60), 20 * 60,
    'pattern plan still conserves the allocation');

  // the Slack off-window: only during agency hours, only when the pattern says off
  const { offUntil } = require('./slack')._internal;
  const at = (min, dow = 5) => ({ iso: '2026-09-04', dow, min });
  const S9 = 9 * 60, E1730 = 17 * 60 + 30;
  eq(offUntil(null, at(600), S9, E1730), null, 'standard week: never flagged');
  eq(offUntil(pat, at(600, 5), S9, E1730), E1730, 'day off: status until end of agency day');
  eq(offUntil(pat, at(600, 2), S9, E1730), null, 'working: no status');
  eq(offUntil(pat, at(14 * 60, 4), S9, E1730), E1730, 'half day, afternoon: status until end of day');
  eq(offUntil(pat, at(10 * 60, 4), S9, E1730), null, 'half day, morning: working');
  eq(offUntil(pat, at(8 * 60, 5), S9, E1730), null, 'before the agency day: nothing');
  eq(offUntil(pat, at(18 * 60, 5), S9, E1730), null, 'after the agency day: nothing');
  const late = new Map([[5, { start: '13:00', end: '17:30', minutes: 270 }]]);
  eq(offUntil(late, at(600, 5), S9, E1730), 13 * 60, 'late starter: status until their start');
}

console.log(`\n${checks} checks run\nall time identities hold`);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
