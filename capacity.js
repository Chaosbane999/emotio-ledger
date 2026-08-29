const { db, get } = require('./db');

// ---------------------------------------------------------------------------
// Periods are 'YYYY-MM'.
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const periodOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const thisPeriod = () => periodOf(new Date());

function parsePeriod(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`bad period: ${period}`);
  return { year: y, month: m };
}

function shiftPeriod(period, delta) {
  const { year, month } = parsePeriod(period);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function holidaySet() {
  return new Set((get('holidays') || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Every working weekday in the period, as 'YYYY-MM-DD', excluding holidays. */
function workingDates(period) {
  const { year, month } = parsePeriod(period);
  const hols = holidaySet();
  const out = [];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= last; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    if (hols.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

const workingDays = (period) => workingDates(period).length;

/**
 * A normal working month for one full-time person — working days x a standard
 * day. This is what the month picker shows, because "how long is this month" is
 * a question about the calendar, not about how many people happen to be on the
 * team.
 */
function monthHours(period) {
  const week = Number(get('standard_week') || 37.5);
  return round2(workingDays(period) * (week / 5));
}

/** Total client-facing hours the whole team has, across everyone. */
function teamHours(period) {
  const days = workingDays(period);
  return round2(activePeople().reduce((s, p) => s + days * (p.weekly_hours / 5), 0));
}

/** ISO week index (0-based) of each working date within the period. */
function weekBuckets(period) {
  const dates = workingDates(period);
  const buckets = [];
  let current = [];
  let lastDow = -1;
  for (const iso of dates) {
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (lastDow !== -1 && dow <= lastDow) { buckets.push(current); current = []; }
    current.push(iso);
    lastDow = dow;
  }
  if (current.length) buckets.push(current);
  // A trailing stub — a month ending on a Monday leaves a 1-day "week" that
  // cannot absorb a full week's share. Fold it into the week before.
  if (buckets.length > 1 && buckets[buckets.length - 1].length < 3) {
    const stub = buckets.pop();
    buckets[buckets.length - 1].push(...stub);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Units. A unit is `standard_rate` of contract value — one hour at standard rate.
// ---------------------------------------------------------------------------

const standardRate = () => Number(get('standard_rate') || 100);

/**
 * Hours worked by someone on `rate` -> units of contract value consumed.
 *
 * Rounded to the same quarter grain as hours. An awkward rate (£33.30) would
 * otherwise produce 3.33 u from 10 clean hours, and those fractions accumulate
 * across a grid nobody can then reconcile by eye. Rounding here rather than at
 * display time keeps the balance rule and the screen showing the same number.
 */
const QUARTER = 0.25;
const toUnits = (hours, rate) => {
  const raw = (Number(hours) || 0) * (Number(rate) || 0) / standardRate();
  return Math.round(raw / QUARTER) * QUARTER;
};

/** Units of contract value -> clock hours for someone on `rate`. */
const toHours = (units, rate) => (Number(units) || 0) * standardRate() / (Number(rate) || 1);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Per-person capacity for a period.
// ---------------------------------------------------------------------------

function personCapacity(person, period) {
  const days = workingDays(period);
  const perDay = person.weekly_hours / 5;
  const gross = days * perDay;

  const lv = db.prepare('SELECT annual_hours, sick_hours FROM leave WHERE person_id = ? AND period = ?')
    .get(person.id, period) || { annual_hours: 0, sick_hours: 0 };

  const available = Math.max(0, gross - lv.annual_hours - lv.sick_hours);
  const clientHours = available * person.utilisation;
  const internalHours = available - clientHours;

  return {
    person_id: person.id,
    name: person.name,
    rate: person.rate,
    utilisation: person.utilisation,
    working_days: days,
    gross_hours: round2(gross),
    annual_hours: round2(lv.annual_hours),
    sick_hours: round2(lv.sick_hours),
    available_hours: round2(available),
    // The utilisation target still governs how much is sellable — that is what
    // protects headroom. What is left over is simply unsold time, not a budget
    // internal work is measured against.
    client_hours: round2(clientHours),
    unsold_hours: round2(internalHours),
    internal_hours: round2(internalHours),
    client_units: round2(toUnits(clientHours, person.rate)),
  };
}

/**
 * Hours genuinely left in someone's day: what they have, less client work, less
 * internal time.
 *
 * Internal is counted at whatever is larger — what they have actually booked,
 * or the allowance their utilisation target sets aside. Taking the booked
 * figure alone would hand back the training allowance as sellable room in any
 * month where the internal hours had not been entered yet, and taking the
 * allowance alone hides an overspend: 132 sellable + 19.5 booked internal is
 * 151.5 against a 150 h month, and the old figure reported 11 h over when the
 * real position was 12.5 h.
 */
const spareHours = (available, allocatedClient, allocatedInternal, allowance) =>
  round2(available - allocatedClient - Math.max(allocatedInternal, allowance));

const activePeople = () =>
  db.prepare('SELECT * FROM people WHERE active = 1 AND archived = 0 ORDER BY sort_order, name').all();

// ---------------------------------------------------------------------------
// Contract reconciliation.
// ---------------------------------------------------------------------------

/**
 * A contract's position for one period.
 * Retainers must balance: contracted + carried == people units + third-party units.
 * Pots are exempt and tracked against the pot instead.
 */
function contractSummary(contract, period) {
  const rows = db.prepare(`
    SELECT a.person_id, a.deliverable_id, a.hours, p.rate, p.name AS person_name,
           d.name AS deliverable_name
      FROM allocations a
      JOIN people p       ON p.id = a.person_id
      JOIN deliverables d ON d.id = a.deliverable_id
     WHERE a.contract_id = ? AND a.period = ?`).all(contract.id, period);

  const lineLogged = db.prepare(`SELECT person_id, deliverable_id, SUM(minutes) m
      FROM time_entries WHERE contract_id = ? AND date LIKE ? AND source != 'skip'
     GROUP BY person_id, deliverable_id`).all(contract.id, `${period}-%`);
  const loggedOf = new Map(lineLogged.map((r) => [`${r.person_id}:${r.deliverable_id}`, r.m]));

  const lines = rows.map((r) => ({
    person_id: r.person_id,
    person_name: r.person_name,
    deliverable_id: r.deliverable_id,
    deliverable_name: r.deliverable_name,
    hours: round2(r.hours),
    logged_hours: round2((loggedOf.get(`${r.person_id}:${r.deliverable_id}`) || 0) / 60),
    rate: r.rate,
    units: round2(toUnits(r.hours, r.rate)),
  }));

  const tpRows = db.prepare(`
    SELECT t.id, t.name, ta.units
      FROM tp_allocations ta
      JOIN third_parties t ON t.id = ta.third_party_id
     WHERE ta.contract_id = ? AND ta.period = ?`).all(contract.id, period);

  const co = db.prepare('SELECT units, from_period, note FROM carryover WHERE contract_id = ? AND period = ?')
    .get(contract.id, period) || { units: 0, from_period: '', note: '' };

  const loggedMin = db.prepare(`SELECT COALESCE(SUM(minutes), 0) m FROM time_entries
    WHERE contract_id = ? AND date LIKE ? AND source != 'skip'`)
    .get(contract.id, `${period}-%`).m;

  const peopleUnits = lines.reduce((s, l) => s + l.units, 0);
  const peopleHours = lines.reduce((s, l) => s + l.hours, 0);
  const tpUnits = tpRows.reduce((s, t) => s + t.units, 0);
  const allocatedUnits = peopleUnits + tpUnits;

  // Internal time has no client and no contracted value, so there is nothing to
  // reconcile it against. It is simply the hours recorded. Deriving a "budget"
  // from the utilisation target produced a balance that looked meaningful and
  // was not — and one dominated by whoever happened to be most expensive.
  const contractedUnits = contract.type === 'internal' ? 0 : contract.monthly_units;

  const availableUnits = contractedUnits + (co.units || 0);
  const variance = round2(availableUnits - allocatedUnits);

  const summary = {
    contract_id: contract.id,
    name: contract.name,
    type: contract.type,
    status: contract.status,
    starts_on: contract.starts_on || null,
    ends_on: contract.ends_on || null,
    logged_hours: round2(loggedMin / 60),
    period,
    lines,
    third_parties: tpRows.map((t) => ({ id: t.id, name: t.name, units: round2(t.units) })),
    carryover: { units: round2(co.units), from_period: co.from_period, note: co.note },
    contracted_units: round2(contractedUnits),
    available_units: round2(availableUnits),
    people_hours: round2(peopleHours),
    people_units: round2(peopleUnits),
    third_party_units: round2(tpUnits),
    allocated_units: round2(allocatedUnits),
    variance,
    // Neither reconciles monthly: a pot is drawn down across its whole window
    // in whatever shape suits, and internal time was never sold to anyone.
    no_balance: contract.type === 'internal' || contract.type === 'pot',
    balanced: (contract.type === 'pot' || contract.type === 'internal')
      ? true : Math.abs(variance) < 0.005,
  };

  if (contract.type === 'pot') Object.assign(summary, potPosition(contract, period, allocatedUnits));
  return summary;
}

/** Drawdown position for a fixed-pot contract. */
function potPosition(contract, period, thisPeriodUnits) {
  const start = contract.pot_start || period;
  const end = contract.pot_end || period;

  const drawnRows = db.prepare(`
    SELECT a.hours, p.rate FROM allocations a
      JOIN people p ON p.id = a.person_id
     WHERE a.contract_id = ? AND a.period >= ? AND a.period <= ?`).all(contract.id, start, end);
  const drawnPeople = drawnRows.reduce((s, r) => s + toUnits(r.hours, r.rate), 0);
  const drawnTp = db.prepare(
    'SELECT COALESCE(SUM(units),0) AS u FROM tp_allocations WHERE contract_id = ? AND period >= ? AND period <= ?')
    .get(contract.id, start, end).u;

  const drawn = drawnPeople + drawnTp;
  const remaining = contract.pot_units - drawn;

  // Time progress across the window, in hours. The drawdown above is about
  // VALUE allocated; this is about WORK done. Showing the drawdown as a
  // progress bar read as "nearly all logged" when almost nothing had been —
  // a bar must compare logged time to allocated time, nothing else.
  const windowAllocHours = drawnRows.reduce((s, r) => s + r.hours, 0);
  const windowLoggedMin = db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM time_entries
    WHERE contract_id = ? AND date >= ? AND date <= ? AND source != 'skip'`)
    .get(contract.id, `${start}-01`, `${end}-31`).m;

  // How many months of the window remain. Deliberately no burn-rate forecast:
  // projecting the pace so far assumes nothing changes — no contract ending, no
  // allocation moving — when drawing a pot as the work demands is its whole
  // point. A forecast built on that assumption is worse than no forecast.
  let total = 0, elapsed = 0, cur = start;
  while (cur <= end && total < 120) {
    total += 1;
    if (cur <= period) elapsed += 1;
    cur = shiftPeriod(cur, 1);
  }

  return {
    pot_units: round2(contract.pot_units),
    pot_start: start,
    pot_end: end,
    pot_drawn: round2(drawn),
    pot_remaining: round2(remaining),
    pot_this_period: round2(thisPeriodUnits),
    window_allocated_hours: round2(windowAllocHours),
    window_logged_hours: round2(windowLoggedMin / 60),
    months_total: total,
    months_left: Math.max(0, total - elapsed),
    pot_exhausted: remaining <= 0.005,
  };
}

// ---------------------------------------------------------------------------
// Agency roll-up. Cross-person totals are ALWAYS units, never hours.
// ---------------------------------------------------------------------------

function agencySummary(period) {
  const people = activePeople();
  const contracts = db.prepare(
    "SELECT * FROM contracts WHERE archived = 0 ORDER BY sort_order, name").all();

  const caps = people.map((p) => personCapacity(p, period));
  const capById = new Map(caps.map((c) => [c.person_id, c]));

  // allocated hours per person, split client vs internal
  const allocRows = db.prepare(`
    SELECT a.person_id, c.type, SUM(a.hours) AS hours
      FROM allocations a
      JOIN contracts c ON c.id = a.contract_id
     WHERE a.period = ? AND c.archived = 0 AND c.status = 'live'
     GROUP BY a.person_id, c.type`).all(period);

  const perPerson = new Map(caps.map((c) => [c.person_id, {
    ...c, allocated_client_hours: 0, allocated_internal_hours: 0, actual_hours: 0,
  }]));
  for (const r of allocRows) {
    const e = perPerson.get(r.person_id);
    if (!e) continue;
    if (r.type === 'internal') e.allocated_internal_hours += r.hours;
    else e.allocated_client_hours += r.hours;
  }

  const actRows = db.prepare(
    'SELECT person_id, SUM(hours) AS hours FROM actuals WHERE period = ? GROUP BY person_id').all(period);
  for (const r of actRows) {
    const e = perPerson.get(r.person_id);
    if (e) e.actual_hours = round2(r.hours);
  }

  const staff = [...perPerson.values()].map((e) => {
    const p = people.find((x) => x.id === e.person_id);
    const clientHours = round2(e.allocated_client_hours);
    return {
      ...e,
      allocated_client_hours: clientHours,
      allocated_internal_hours: round2(e.allocated_internal_hours),
      allocated_client_units: round2(toUnits(clientHours, p.rate)),
      // clock headroom — is this person physically overbooked?
      spare_hours: spareHours(e.available_hours, clientHours,
        e.allocated_internal_hours, e.internal_hours),
      load_pct: e.client_hours > 0 ? Math.round((clientHours / e.client_hours) * 100) : 0,
      internal_spare_hours: round2(e.internal_hours - e.allocated_internal_hours),
    };
  });

  const summaries = contracts.map((c) => ({ contract: c, summary: contractSummary(c, period) }));
  const live = summaries.filter((s) => s.contract.type !== 'internal' && s.contract.status === 'live');
  const pipeline = summaries.filter((s) => s.contract.status === 'pipeline');

  // Two headroom figures, because they answer different questions.
  //   units — "can we sell another contract?"  (value the team can deliver)
  //   hours — "has anyone got room in their diary?"  (clock time available)
  // They diverge whenever rates differ: a director is few hours but many units,
  // an offshore specialist the reverse. Summing hours across people is fine as a
  // capacity measure; it is only meaningless as a measure of contract value, so
  // the balance rule still runs on units alone.
  const capacityUnits = staff.reduce((s, p) => s + p.client_units, 0);
  const allocatedUnits = staff.reduce((s, p) => s + p.allocated_client_units, 0);
  const capacityHours = staff.reduce((s, p) => s + p.client_hours, 0);
  const allocatedHours = staff.reduce((s, p) => s + p.allocated_client_hours, 0);
  // The headline answers "has anyone got room in their diary", so it has to be
  // the same room the Spare column reports — internal overspend included.
  const headroomHours = staff.reduce((s, p) => s + p.spare_hours, 0);
  const internalOverspend = staff.reduce(
    (s, p) => s + Math.max(0, p.allocated_internal_hours - p.internal_hours), 0);

  const constrained = staff.filter((p) => p.spare_hours < 0)
    .sort((a, b) => a.spare_hours - b.spare_hours);

  return {
    period,
    working_days: workingDays(period),
    staff,
    contracts: summaries.map((s) => s.summary),
    totals: {
      capacity_units: round2(capacityUnits),
      allocated_units: round2(allocatedUnits),
      headroom_units: round2(capacityUnits - allocatedUnits),
      capacity_hours: round2(capacityHours),
      allocated_hours: round2(allocatedHours),
      headroom_hours: round2(headroomHours),
      internal_overspend_hours: round2(internalOverspend),
      // What clients have committed for this month. A pot has no monthly figure
      // — its value lives in pot_units — so what it commits this month is
      // whatever has been drawn against it.
      contracted_units: round2(
        live.filter((x) => x.contract.type !== 'pot')
          .reduce((s, x) => s + x.summary.contracted_units, 0)
        + live.filter((x) => x.contract.type === 'pot')
          .reduce((s, x) => s + x.summary.allocated_units, 0)),

      // What has been assigned against it: team units plus third-party spend.
      // On a balanced book this equals contracted_units exactly.
      assigned_units: round2(live.reduce((s, x) => s + x.summary.allocated_units, 0)),
      // clock hours on the live book, whoever holds them
      contracted_hours: round2(live.reduce((s, x) => s + x.summary.people_hours, 0)),

      // Hours on live contracts held by someone no longer in the capacity list.
      // They inflate the clock-hours figure while contributing no capacity,
      // which is exactly the gap that made the two tiles disagree.
      orphan_hours: round2(live.reduce((s, x) => s + x.summary.lines
        .filter((l) => !staff.some((p) => p.person_id === l.person_id))
        .reduce((n, l) => n + l.hours, 0), 0)),
      // hours sitting on the contracts that breach their value
      overrun_hours: round2(live.filter((x) => x.summary.variance < -0.005)
        .reduce((s, x) => s + x.summary.people_hours, 0)),
      third_party_units: round2(summaries.reduce((s, x) => s + x.summary.third_party_units, 0)),
      pipeline_units: round2(pipeline.reduce((s, x) => s + x.summary.contracted_units, 0)),
      pipeline_hours: round2(pipeline.reduce((s, x) => s + x.summary.people_hours, 0)),
      unbalanced: summaries.filter((s) => !s.summary.balanced).length,
      // the binding constraint, named — headroom in units is meaningless if
      // the one person who can do the work is already full
      constraint: constrained.length
        ? { name: constrained[0].name, over_by_hours: round2(-constrained[0].spare_hours) }
        : null,
    },
  };
}

/** One person's month: their contracts, deliverables, allocated vs logged. */
function personView(personId, period) {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return null;
  const cap = personCapacity(person, period);

  const rows = db.prepare(`
    SELECT c.id AS contract_id, c.name AS contract_name, c.type,
           d.id AS deliverable_id, d.name AS deliverable_name, a.hours
      FROM allocations a
      JOIN contracts c    ON c.id = a.contract_id
      JOIN deliverables d ON d.id = a.deliverable_id
     WHERE a.person_id = ? AND a.period = ? AND c.archived = 0
     ORDER BY c.type = 'internal', c.sort_order, c.name, d.sort_order`).all(personId, period);

  const actualByContract = new Map();
  for (const r of db.prepare(
    'SELECT contract_id, SUM(hours) AS h FROM actuals WHERE person_id = ? AND period = ? GROUP BY contract_id')
    .all(personId, period)) actualByContract.set(r.contract_id, round2(r.h));

  const lines = rows.map((r) => ({
    ...r,
    hours: round2(r.hours),
    units: round2(toUnits(r.hours, person.rate)),
  }));

  const clientHours = lines.filter((l) => l.type !== 'internal').reduce((s, l) => s + l.hours, 0);
  const internalHours = lines.filter((l) => l.type === 'internal').reduce((s, l) => s + l.hours, 0);
  const actualTotal = db.prepare(
    'SELECT COALESCE(SUM(hours),0) AS h FROM actuals WHERE person_id = ? AND period = ?')
    .get(personId, period).h;

  return {
    person: {
      id: person.id, name: person.name, rate: person.rate,
      utilisation: person.utilisation, weekly_hours: person.weekly_hours,
    },
    period,
    capacity: cap,
    lines,
    // the dashboard context: for each contract this person touches, the whole
    // contract's month — allocated hours, logged hours, and who else is on it.
    // Names and hours only; nothing here reveals a rate.
    contract_context: Object.fromEntries([...new Set(lines.map((l) => l.contract_id))]
      .map((cid) => {
        const alloc = db.prepare(`SELECT p.id, p.name, p.initials, SUM(a.hours) h
            FROM allocations a JOIN people p ON p.id = a.person_id
           WHERE a.contract_id = ? AND a.period = ? GROUP BY p.id ORDER BY h DESC`)
          .all(cid, period);
        const loggedMin = db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM time_entries
           WHERE contract_id = ? AND date LIKE ? AND source != 'skip'`)
          .get(cid, `${period}-%`).m;
        return [cid, {
          allocated_hours: round2(alloc.reduce((s2, a2) => s2 + a2.h, 0)),
          logged_hours: round2(loggedMin / 60),
          people: alloc.map((a2) => ({ id: a2.id, name: a2.name, initials: a2.initials, hours: round2(a2.h) })),
        }];
      })),
    actual_by_contract: Object.fromEntries(actualByContract),
    totals: {
      client_hours: round2(clientHours),
      client_units: round2(toUnits(clientHours, person.rate)),
      internal_hours: round2(internalHours),
      internal_budget_hours: cap.internal_hours,
      spare_hours: spareHours(cap.available_hours, clientHours,
        internalHours, cap.internal_hours),
      load_pct: cap.client_hours > 0 ? Math.round((clientHours / cap.client_hours) * 100) : 0,
      actual_hours: round2(actualTotal),
      // reality, from the time system — replaces the Harvest figure
      logged_hours: round2((db.prepare(`SELECT COALESCE(SUM(minutes), 0) m FROM time_entries
        WHERE person_id = ? AND date LIKE ? AND source != 'skip'`)
        .get(personId, `${period}-%`).m) / 60),
      actual_vs_allocated: round2(actualTotal - (clientHours + internalHours)),
    },
  };
}

module.exports = {
  periodOf, thisPeriod, parsePeriod, shiftPeriod,
  workingDates, workingDays, weekBuckets, monthHours, teamHours,
  standardRate, toUnits, toHours, round2,
  personCapacity, activePeople,
  contractSummary,
  agencySummary, personView,
};
