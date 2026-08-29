/**
 * Whole-system maths audit.
 *
 * Every identity the app relies on, checked against the live database for every
 * month that exists. Run with `node audit.js`. Exits non-zero on any failure so
 * it can gate a deploy.
 */
const { db, get } = require('./db');
const cap = require('./capacity');
const sch = require('./schedule');

let checks = 0, failures = [];
const ok = (cond, what) => { checks++; if (!cond) failures.push(what); };
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
const onQuarter = (n) => near(n * 4, Math.round(n * 4), 1e-6);

const periods = db.prepare('SELECT period FROM months ORDER BY period').all().map((m) => m.period);
const STD = Number(get('standard_rate') || 100);

console.log(`auditing ${periods.length} month(s): ${periods.join(', ')}\n`);

for (const P of periods) {
  const a = cap.agencySummary(P), t = a.totals;
  const days = cap.workingDays(P);

  // ---- 1. capacity, per person -------------------------------------------
  for (const p of a.staff) {
    const row = db.prepare('SELECT * FROM people WHERE id = ?').get(p.person_id);
    const lv = db.prepare('SELECT annual_hours, sick_hours FROM leave WHERE person_id = ? AND period = ?')
      .get(p.person_id, P) || { annual_hours: 0, sick_hours: 0 };

    const gross = days * (row.weekly_hours / 5);
    ok(near(p.gross_hours, gross, 0.02), `${P} ${p.name}: gross = days x weekly/5 (${p.gross_hours} vs ${gross.toFixed(2)})`);
    ok(near(p.available_hours, Math.max(0, gross - lv.annual_hours - lv.sick_hours), 0.02),
      `${P} ${p.name}: available = gross - leave - sick`);
    ok(near(p.client_hours, p.available_hours * row.utilisation, 0.02),
      `${P} ${p.name}: client = available x utilisation`);
    ok(near(p.client_hours + p.internal_hours, p.available_hours, 0.02),
      `${P} ${p.name}: client + unsold = available`);
    ok(p.available_hours >= -0.001, `${P} ${p.name}: available not negative`);
    ok(near(p.spare_hours,
      p.available_hours - p.allocated_client_hours
        - Math.max(p.allocated_internal_hours, p.internal_hours), 0.02),
      `${P} ${p.name}: spare = available - client - internal`);
    ok(p.spare_hours <= p.client_hours - p.allocated_client_hours + 0.02,
      `${P} ${p.name}: spare never flatters the old figure`);
    ok(onQuarter(p.allocated_client_units), `${P} ${p.name}: allocated units on a quarter`);
    ok(near(p.allocated_client_units,
      Math.round(p.allocated_client_hours * row.rate / STD / 0.25) * 0.25, 0.01),
      `${P} ${p.name}: units = hours x rate / standard`);
  }

  // ---- 2. every contract --------------------------------------------------
  for (const c of a.contracts) {
    const lineUnits = c.lines.reduce((s, l) => s + l.units, 0);
    const lineHours = c.lines.reduce((s, l) => s + l.hours, 0);

    ok(near(c.people_units, lineUnits), `${P} ${c.name}: people_units = sum of lines`);
    ok(near(c.people_hours, lineHours), `${P} ${c.name}: people_hours = sum of lines`);
    ok(near(c.allocated_units, c.people_units + c.third_party_units),
      `${P} ${c.name}: allocated = people + third party`);
    for (const l of c.lines) {
      ok(onQuarter(l.units), `${P} ${c.name}/${l.person_name}: unit on a quarter (${l.units})`);
      ok(near(l.units, Math.round(l.hours * l.rate / STD / 0.25) * 0.25, 0.01),
        `${P} ${c.name}/${l.person_name}: unit conversion`);
      ok(l.hours >= 0, `${P} ${c.name}/${l.person_name}: hours not negative`);
    }

    if (c.no_balance) {
      ok(c.balanced === true, `${P} ${c.name}: exempt contracts never flagged unbalanced`);
      if (c.type === 'internal') ok(c.contracted_units === 0, `${P} ${c.name}: internal has no contracted value`);
    } else {
      ok(near(c.variance, c.contracted_units + c.carryover.units - c.allocated_units),
        `${P} ${c.name}: variance = contracted + carried - allocated`);
      ok(c.balanced === near(c.variance, 0), `${P} ${c.name}: balanced flag matches variance`);
    }

    if (c.type === 'pot') {
      ok(near(c.pot_remaining, c.pot_units - c.pot_drawn), `${P} ${c.name}: pot remaining = pot - drawn`);
      ok(c.pot_drawn >= -0.001, `${P} ${c.name}: pot drawn not negative`);
      ok(c.months_left >= 0, `${P} ${c.name}: months left not negative`);
    }
  }

  // ---- 3. agency roll-up --------------------------------------------------
  const capU = a.staff.reduce((s, p) => s + p.client_units, 0);
  const capH = a.staff.reduce((s, p) => s + p.client_hours, 0);
  const allU = a.staff.reduce((s, p) => s + p.allocated_client_units, 0);
  const allH = a.staff.reduce((s, p) => s + p.allocated_client_hours, 0);

  ok(near(t.capacity_units, capU, 0.02), `${P} totals: capacity_units = sum per person`);
  ok(near(t.capacity_hours, capH, 0.02), `${P} totals: capacity_hours = sum per person`);
  ok(near(t.allocated_units, allU, 0.02), `${P} totals: allocated_units = sum per person`);
  ok(near(t.allocated_hours, allH, 0.02), `${P} totals: allocated_hours = sum per person`);
  ok(near(t.headroom_units, t.capacity_units - t.allocated_units, 0.02), `${P} totals: headroom units identity`);
  ok(near(t.headroom_hours, a.staff.reduce((s, p) => s + p.spare_hours, 0), 0.02),
    `${P} totals: headroom hours = sum of everyone's spare`);
  ok(near(t.headroom_hours,
    t.capacity_hours - t.allocated_hours - t.internal_overspend_hours, 0.02),
    `${P} totals: headroom hours = capacity - allocated - internal overspend`);

  const live = a.contracts.filter((c) => c.type !== 'internal' && c.status === 'live');
  const retainers = live.filter((c) => c.type !== 'pot');
  const pots = live.filter((c) => c.type === 'pot');

  // contracted = retainer values + whatever pots have drawn this month
  ok(near(t.contracted_units,
    retainers.reduce((s, c) => s + c.contracted_units, 0)
    + pots.reduce((s, c) => s + c.allocated_units, 0), 0.02),
    `${P} totals: contracted = retainers + pot draw`);

  ok(near(t.assigned_units, live.reduce((s, c) => s + c.allocated_units, 0), 0.02),
    `${P} totals: assigned = sum of live allocated`);

  // the clock-hours tiles must reconcile through the orphan figure
  ok(near(t.contracted_hours - t.orphan_hours, t.allocated_hours, 0.02),
    `${P} totals: live clock hours - orphan = allocated (${t.contracted_hours} - ${t.orphan_hours} vs ${t.allocated_hours})`);

  // and on a book where every retainer balances, contracted must equal assigned
  if (retainers.every((c) => c.balanced)) {
    ok(near(t.contracted_units, t.assigned_units, 0.02),
      `${P} totals: balanced book means contracted = assigned (${t.contracted_units} vs ${t.assigned_units})`);
  }

  // held and pipeline work must not consume capacity
  for (const status of ['hold', 'pipeline']) {
    const ids = db.prepare('SELECT id FROM contracts WHERE status = ? AND archived = 0').all(status).map((r) => r.id);
    if (!ids.length) continue;
    const h = db.prepare(`SELECT COALESCE(SUM(hours),0) h FROM allocations
      WHERE period = ? AND contract_id IN (${ids.join(',')})`).get(P).h;
    ok(h === 0 || t.allocated_hours < allH + h + 0.01, `${P}: ${status} work excluded from allocated hours`);
  }

  // ---- 4. the scheduler ---------------------------------------------------
  const maxClient = Number(get('max_client_minutes_per_day') || 240);
  for (const p of db.prepare('SELECT id, name, weekly_hours FROM people WHERE active = 1 AND archived = 0').all()) {
    const plan = sch.planPerson(p.id, P);
    const perDay = (p.weekly_hours / 5) * 60;

    // The plan covers what is still to do: each allocation line less what is
    // already logged against it (a remainder under the 15-minute grain is
    // dropped — it cannot be scheduled), plus kept blocks, which stay in the
    // plan at their planned length. With nothing logged this reduces to the
    // old identity: scheduled + unplaced = allocated + anchors.
    const lines = db.prepare(`SELECT a.contract_id, a.deliverable_id, a.hours FROM allocations a
      JOIN contracts c ON c.id = a.contract_id
      WHERE a.person_id = ? AND a.period = ? AND c.archived = 0 AND a.hours > 0`).all(p.id, P);
    const loggedBy = new Map(db.prepare(`SELECT contract_id, deliverable_id, SUM(minutes) m
        FROM time_entries WHERE person_id = ? AND date LIKE ? AND source != 'skip'
       GROUP BY contract_id, deliverable_id`).all(p.id, `${P}-%`)
      .map((r) => [`${r.contract_id}:${r.deliverable_id}`, r.m]));
    let remainMin = 0;
    for (const l of lines) {
      const rem = l.hours * 60 - (loggedBy.get(`${l.contract_id}:${l.deliverable_id}`) || 0);
      if (rem >= 15) remainMin += rem;
      else if (!loggedBy.has(`${l.contract_id}:${l.deliverable_id}`) && rem > 0) remainMin += rem;
    }
    const keptMin = db.prepare(`SELECT COALESCE(SUM(b.minutes),0) m FROM schedule_blocks b
      WHERE b.person_id = ? AND b.period = ?
        AND EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = b.id)`).get(p.id, P).m;
    const anchorRows = db.prepare(`SELECT an.*, c.* FROM anchors an
      LEFT JOIN contracts c ON c.id = an.contract_id WHERE an.person_id = ?`).all(p.id);
    const anchors = anchorRows.reduce((s2, an) =>
      s2 + cap.anchorMinutes(an, an.id ? an : null, P) / 60, 0);
    const expect = remainMin / 60 + keptMin / 60 + anchors;
    const accounted = plan.totals.scheduled_hours + plan.totals.unplaced_hours;
    ok(near(accounted, expect, 0.02),
      `${P} ${p.name}: scheduled + unplaced = remaining + kept + anchors (${accounted} vs ${expect.toFixed(2)})`);

    const byDay = {}, byDayContract = {};
    for (const b of plan.blocks) {
      ok(b.minutes % 15 === 0, `${P} ${p.name}: block on a quarter hour (${b.minutes}m)`);
      ok(b.start < b.end, `${P} ${p.name}: block start before end`);
      ok(b.minutes > 0, `${P} ${p.name}: block has duration`);
      byDay[b.date] = (byDay[b.date] || 0) + b.minutes;
      const k = `${b.date}|${b.contract_id}`;
      byDayContract[k] = (byDayContract[k] || 0) + b.minutes;
    }
    // Weekday ceilings police the working week. Weekends are the overflow
    // valve — their whole point is holding what those ceilings squeezed out —
    // so they answer only to the length of the day itself.
    const isWeekend = (d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
    for (const [d, m] of Object.entries(byDay)) {
      if (isWeekend(d)) {
        ok(m <= 24 * 60, `${P} ${p.name}: ${d} weekend overflow fits the day (${m})`);
      } else {
        ok(m <= perDay + 0.5, `${P} ${p.name}: ${d} within daily capacity (${m} vs ${perDay})`);
      }
    }
    for (const [k, m] of Object.entries(byDayContract)) {
      if (isWeekend(k.slice(0, 10))) continue;
      const isInternal = plan.blocks.find((b) => `${b.date}|${b.contract_id}` === k)?.contract_type === 'internal';
      if (!isInternal) ok(m <= maxClient + 0.5, `${P} ${p.name}: ${k} within per-client daily cap (${m})`);
    }
    // no two blocks may overlap on the same day
    const byDate = {};
    for (const b of plan.blocks) (byDate[b.date] = byDate[b.date] || []).push(b);
    for (const [d, list] of Object.entries(byDate)) {
      const sorted = [...list].sort((x, y) => x.start.localeCompare(y.start));
      for (let i = 1; i < sorted.length; i++) {
        ok(sorted[i].start >= sorted[i - 1].end, `${P} ${p.name}: ${d} blocks do not overlap`);
      }
    }
  }
}

// ---- 5. month copy fidelity -------------------------------------------
if (periods.length >= 2) {
  for (let i = 1; i < periods.length; i++) {
    const m = db.prepare('SELECT copied_from FROM months WHERE period = ?').get(periods[i]);
    if (!m || !m.copied_from) continue;
    const src = db.prepare('SELECT COUNT(*) n FROM allocations WHERE period = ?').get(m.copied_from).n;
    const dst = db.prepare('SELECT COUNT(*) n FROM allocations WHERE period = ?').get(periods[i]).n;
    ok(dst >= src * 0.5, `${periods[i]}: copied forward from ${m.copied_from} plausibly`);
  }
}

// ---- 6. time entries: reality accounts exactly ------------------------
{
  const entries = db.prepare('SELECT * FROM time_entries').all();
  for (const e of entries) {
    ok(Number.isInteger(e.minutes) && e.minutes >= 0, `entry ${e.id}: minutes is a whole non-negative number`);
    if (e.source === 'skip') ok(e.minutes === 0, `entry ${e.id}: a skip carries no minutes`);
    else ok(e.minutes > 0, `entry ${e.id}: worked time is positive`);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(e.date), `entry ${e.id}: date well-formed`);
    if (e.block_id != null) {
      const b = db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(e.block_id);
      if (b) {
        ok(b.person_id === e.person_id, `entry ${e.id}: answers for its own person's block`);
        ok(b.contract_id === e.contract_id, `entry ${e.id}: keeps its block's contract`);
      }
    }
  }
  // a block is one thing or the other, never both, and skipped at most once
  const mixed = db.prepare(`
    SELECT block_id FROM time_entries WHERE block_id IS NOT NULL GROUP BY block_id
    HAVING SUM(source = 'skip') > 0 AND SUM(source != 'skip') > 0`).all();
  ok(mixed.length === 0, 'no block is both skipped and worked');
  // orphaned skips (their block deleted by a plan rebuild) all share a NULL
  // block_id — they are separate events, not one block skipped twice
  const doubleSkip = db.prepare(`
    SELECT block_id FROM time_entries WHERE source = 'skip' AND block_id IS NOT NULL
     GROUP BY block_id HAVING COUNT(*) > 1`).all();
  ok(doubleSkip.length === 0, 'no block is skipped twice');

  const timeMod = require('./time');
  for (const period of periods) {
    const v = timeMod.variance(period);
    const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);
    ok(sum(v.rows, 'planned_minutes') === v.totals.planned_minutes, `${period}: variance cells sum to planned`);
    ok(sum(v.rows, 'logged_minutes') === v.totals.logged_minutes, `${period}: variance cells sum to logged`);
    ok(sum(v.by_person, 'logged_minutes') === v.totals.logged_minutes, `${period}: person rollup conserves logged`);
    ok(sum(v.by_contract, 'logged_minutes') === v.totals.logged_minutes, `${period}: contract rollup conserves logged`);
    ok(sum(v.by_person, 'planned_minutes') === v.totals.planned_minutes, `${period}: person rollup conserves planned`);
    ok(sum(v.by_contract, 'planned_minutes') === v.totals.planned_minutes, `${period}: contract rollup conserves planned`);
    const tableLogged = db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM time_entries
      WHERE date LIKE ? AND source != 'skip'`).get(`${period}-%`).m;
    ok(v.totals.logged_minutes === tableLogged, `${period}: variance logged = table sum`);
    const tablePlanned = db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM schedule_blocks
      WHERE date LIKE ? AND draft = 0`).get(`${period}-%`).m;
    ok(v.totals.planned_minutes === tablePlanned, `${period}: variance planned = table sum`);
    for (const r of v.rows) {
      ok(near(r.variance_hours, r.logged_hours - r.planned_hours),
        `${period}: variance = logged - planned (${r.person_name} / ${r.contract_name})`);
    }
    for (const pr of v.by_person) {
      ok(near(timeMod.loggedHours(pr.id, period), pr.logged_minutes / 60),
        `${period}: loggedHours agrees with variance for ${pr.name}`);
    }
  }
}

// ---- 6b. departments: the two views sum exactly to the whole ----------
for (const period of periods) {
  const whole = cap.agencySummary(period);
  const mkt = cap.agencySummary(period, 'marketing');
  const des = cap.agencySummary(period, 'design');
  ok(mkt.staff.length + des.staff.length === whole.staff.length,
    `${period}: department staff partition cleanly (${mkt.staff.length}+${des.staff.length} vs ${whole.staff.length})`);
  ok(mkt.contracts.length + des.contracts.length === whole.contracts.length,
    `${period}: department contracts partition cleanly`);
  for (const k of ['capacity_hours', 'capacity_units']) {
    ok(near(mkt.totals[k] + des.totals[k], whole.totals[k], 0.05),
      `${period}: department ${k} sums to the whole (${mkt.totals[k]}+${des.totals[k]} vs ${whole.totals[k]})`);
  }
  ok(near(mkt.totals.contracted_units + des.totals.contracted_units, whole.totals.contracted_units, 0.05),
    `${period}: department contracted_units sum to the whole`);
}

// ---- 7. reports: every rollup sums exactly to the headline ------------
{
  const timeMod = require('./time');
  for (const period of periods) {
    const days = db.prepare(`SELECT MIN(date) lo, MAX(date) hi FROM time_entries WHERE date LIKE ?`)
      .get(`${period}-%`);
    if (!days.lo) continue;
    const r = timeMod.report({ from: days.lo, to: days.hi });
    const sum = (arr) => arr.reduce((s2, x) => s2 + x.minutes, 0);
    ok(sum(r.by_contract) === r.totals.minutes, `${period}: report by-contract sums to total`);
    ok(sum(r.by_person) === r.totals.minutes, `${period}: report by-person sums to total`);
    ok(sum(r.by_deliverable) === r.totals.minutes, `${period}: report by-deliverable sums to total`);
    ok(sum(r.by_department) === r.totals.minutes, `${period}: report by-department sums to total`);
    ok(sum(r.timeline) === r.totals.minutes, `${period}: report timeline sums to total`);
  }
}

// ---- 8. unit conversion, standalone -----------------------------------
for (const [hours, rate, want] of [[10, 33.30, 3.25], [2, 250, 5], [10, 100, 10], [15, 33.30, 5], [4, 250, 10]]) {
  ok(near(cap.toUnits(hours, rate), want), `toUnits(${hours}h, £${rate}) = ${want}u`);
}
ok(near(cap.toHours(1, 100), 1), 'toHours(1u, £100) = 1h');

console.log(`${checks} checks run`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures.slice(0, 40)) console.log('  ✗', f);
  process.exit(1);
}
console.log('all identities hold');
