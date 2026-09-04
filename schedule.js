const { db, get } = require('./db');
const cap = require('./capacity');

// ---------------------------------------------------------------------------
// Turning allocations into calendar blocks.
//
// A deliverable is not just a number of hours — it carries a recipe describing
// the shape those hours must take. A weekly email is 2h every week, not 8h in
// a heap; a campaign build is one long sitting, not four fragments.
// ---------------------------------------------------------------------------

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const fromMin = (mins) => {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/** Free intervals in a working day, in minutes-from-midnight. */
function dayWindows() {
  const start = toMin(get('work_start') || '09:00');
  const end = toMin(get('work_end') || '17:30');
  return carveLunch(start, end);
}

function carveLunch(start, end) {
  const lunch = toMin(get('lunch_start') || '13:00');
  const lunchLen = Number(get('lunch_minutes') || 30);
  if (lunch <= start || lunch >= end) return [[start, end]];
  return [[start, lunch], [Math.min(end, lunch + lunchLen), end]];
}

/**
 * Free intervals for one person on one date. A working pattern narrows the
 * day to their own hours; no pattern means the agency-standard day. A day
 * the pattern leaves out has no window at all.
 */
function personWindows(pattern, iso) {
  if (!pattern) return dayWindows();
  const d = pattern.get(cap.isoDow(iso));
  if (!d) return [];
  return carveLunch(toMin(d.start), toMin(d.end));
}

// A backstop against confetti, not a design constraint. It only bites when the
// block size implies absurd fragmentation; a deliberate block size well inside
// these bounds is honoured exactly, which is what someone setting "2 hours a
// sitting" expects to get.
const MAX_PIECES_PER_WEEK = 6;
const MAX_PIECES_PER_MONTH = 16;

// Nobody books 119 minutes. Every block lands on a quarter hour, minimum 15 min,
// so the calendar reads in the same units people actually plan in.
const GRAIN = 15;
const snap = (mins) => Math.max(GRAIN, Math.round(mins / GRAIN) * GRAIN);

/**
 * Split `total` into `n` quarter-hour pieces summing to exactly `total`.
 * Rounding each piece independently loses minutes — 600 into three snapped
 * 195s is 585 — and those minutes vanish from the plan silently.
 */
/**
 * Share `total` across buckets weighted by `weights`, in quarter-hour pieces
 * that sum to exactly `total`. Snapping each share independently drifts upward
 * — a few minutes per week becomes an hour a month, and the schedule then
 * claims more time than was ever allocated.
 */
function shareExact(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((r) => Math.floor(r / GRAIN) * GRAIN);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rem >= GRAIN; k++, rem -= GRAIN) out[order[k % order.length][1]] += GRAIN;
  return out;
}

function splitExact(total, n) {
  if (total <= 0) return [];
  // Never ask for more pieces than the total can fill at a quarter each. A
  // floor of one grain per piece silently invents time: 30 minutes cut three
  // ways became 3 x 15 = 45, and that inflation accumulated across a month.
  const pieces = Math.max(1, Math.min(n, Math.floor(total / GRAIN) || 1));
  const base = Math.floor(total / pieces / GRAIN) * GRAIN;
  const out = Array.from({ length: pieces }, () => base);
  let rem = total - base * pieces;
  for (let i = 0; rem >= GRAIN; i++, rem -= GRAIN) out[i % pieces] += GRAIN;
  if (rem > 0) out[0] += rem;          // sub-grain tail, kept so the sum is exact
  return out.filter((m) => m > 0);
}

/**
 * Expand one allocation into the sessions its recipe demands.
 * `buckets` is the month's working weeks, so a short week takes a smaller
 * share than a full one rather than being handed an impossible load.
 * Returns [{ minutes, week, anchored, dow, time }].
 */
function expand(alloc, recipe, buckets, ceiling) {
  const weeks = buckets.length;
  const totalMin = Math.round(alloc.hours * 60);
  if (totalMin <= 0 || weeks === 0) return [];

  const block = Math.max(15, recipe.block_minutes || 60);
  const splittable = !!recipe.splittable;
  const sessions = [];

  /**
   * Split `minutes` into sittings of roughly `block`, at most `cap` of them.
   *
   * max_sittings is a preference about fragmentation, never a promise the
   * result will fit: two 6h pieces cannot be placed when a client is capped at
   * 4h a day. So the ceiling sets a floor on how many pieces there must be, and
   * feasibility wins over the preference.
   */
  const chop = (minutes, week, cap) => {
    if (minutes <= 0.5) return;
    if (!splittable) { sessions.push({ minutes, week }); return; }
    const hard = recipe.max_sittings > 0 ? recipe.max_sittings : cap;
    // FLOOR, not ceil: the block size is a minimum sitting. 75 minutes with
    // 30-minute blocks is 45 + 30, never 30 + 30 + 15 — rounding the piece
    // count UP guaranteed a runt below the block size whenever the total
    // wasn't an exact multiple. The daily ceiling can still force smaller
    // pieces; physics beats preference, as ever.
    const wanted = Math.min(Math.max(1, Math.floor(minutes / block)), hard);
    const needed = ceiling ? Math.ceil(minutes / ceiling) : 1;
    const pieces = Math.max(wanted, needed);
    for (const m of splitExact(minutes, pieces)) sessions.push({ minutes: m, week });
  };

  switch (recipe.cadence) {
    // one sitting every working day, the month's hours shared across them
    case 'daily': {
      const allDays = buckets.flat().length;
      if (!allDays) break;
      const perDay = shareExact(totalMin, buckets.map((b) => b.length));
      buckets.forEach((bk, w) => {
        if (perDay[w] < GRAIN) return;
        for (const m of shareExact(perDay[w], bk.map(() => 1))) {
          if (m >= GRAIN) sessions.push({ minutes: m, week: w });
        }
      });
      break;
    }

    case 'weekly':
    case 'fortnightly': {
      const step = recipe.cadence === 'fortnightly' ? 2 : 1;
      const active = [];
      for (let w = 0; w < weeks; w += step) { if (buckets[w].length) active.push(w); }
      if (!active.length) break;

      // The block size is a minimum sitting EVERYWHERE, including here. A
      // 3h/month task on a weekly cadence used to become 45 minutes every
      // week — the month was split into weekly shares before the block
      // minimum ever applied. When the weekly share would fall below the
      // block, place fewer, full-size sittings on evenly spaced weeks
      // instead: 180m with a 60m block is 3 x 60m, never 4 x 45m.
      const block2 = Math.max(15, recipe.block_minutes || 60);
      if (recipe.distribution !== 'anchored' && totalMin / active.length < block2) {
        const n = Math.min(active.length, Math.max(1, Math.floor(totalMin / block2) || 1));
        splitExact(totalMin, n).forEach((m, i) => {
          sessions.push({ minutes: m, week: active[Math.floor((i * active.length) / n)] });
        });
        break;
      }

      // weight each week by its working days, so a 3-day week gets 3 days' worth
      const days = active.map((w) => buckets[w].length);
      const shares = shareExact(totalMin, days);

      active.forEach((w, i) => {
        const per = shares[i];
        if (per < GRAIN) return;
        if (recipe.distribution === 'anchored') {
          sessions.push({ minutes: per, week: w, anchored: true, dow: recipe.anchor_dow, time: recipe.anchor_time });
        } else {
          chop(per, w, MAX_PIECES_PER_WEEK);
        }
      });
      break;
    }

    case 'oneoff': {
      const w = recipe.distribution === 'deadline' ? weeks - 1 : 0;
      chop(totalMin, w, MAX_PIECES_PER_WEEK);
      break;
    }

    case 'monthly':
    default: {
      if (recipe.distribution === 'frontload') { chop(totalMin, 0, MAX_PIECES_PER_WEEK); break; }
      if (recipe.distribution === 'deadline') { chop(totalMin, weeks - 1, MAX_PIECES_PER_WEEK); break; }
      if (recipe.distribution === 'anchored') {
        sessions.push({
          minutes: totalMin, week: weeks - 1, anchored: true,
          dow: recipe.anchor_dow, time: recipe.anchor_time,
        });
        break;
      }
      // spread across the month, weighted by working days per week
      const byBlock = Math.min(Math.max(1, Math.floor(totalMin / block)), MAX_PIECES_PER_MONTH);
      const byCeiling = ceiling ? Math.ceil(totalMin / ceiling) : 1;
      const pieces = splittable ? Math.max(byBlock, byCeiling) : 1;
      splitExact(totalMin, pieces).forEach((m, i) => {
        sessions.push({ minutes: m, week: Math.min(weeks - 1, Math.floor((i * weeks) / pieces)) });
      });
      break;
    }
  }
  return sessions.map((s) => ({ ...s, minutes: Math.round(s.minutes), splittable, min_block: block }))
    .filter((s) => s.minutes >= GRAIN);
}

const DEFAULT_RECIPE = {
  cadence: 'monthly', distribution: 'spread', block_minutes: 120,
  splittable: 1, max_sittings: 0, anchor_dow: 2, anchor_time: '10:00',
};

const lastDayOf = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/**
 * The stretch of THIS period a contract is actually live for, as ISO dates.
 * Returns null when the contract is not live in this period at all.
 *
 * Without this the packer treated every month as an open field and would keep
 * laying work down past the day a contract ended — it had no way to know the
 * end existed. A pot narrows the window too: its months are the only ones its
 * allowance may be drawn in.
 */
function contractWindow(contract, from, to) {
  let start = from;
  let end = to;
  if (contract.starts_on && contract.starts_on > start) start = contract.starts_on;
  if (contract.ends_on   && contract.ends_on   < end)   end   = contract.ends_on;
  if (contract.type === 'pot') {
    if (contract.pot_start && `${contract.pot_start}-01` > start) start = `${contract.pot_start}-01`;
    if (contract.pot_end) {
      const potEnd = lastDayOf(contract.pot_end);
      if (potEnd < end) end = potEnd;
    }
  }
  return start > end ? null : { start, end };
}

/**
 * Build a month of calendar blocks for one person.
 * Anchored sessions are placed first and never moved; everything else is
 * packed around them, largest sessions first so long blocks get real room.
 */
function planPerson(personId, period) {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return null;

  // The pattern decides which days exist for this person at all. Buckets keep
  // the month's week structure (indices must agree with anchors and shares)
  // but each week holds only the days this person works — a week they are
  // entirely off is an empty bucket, and takes no share of anything.
  const pattern = cap.patternOf(personId);
  const worksOn = (iso) => !pattern || Boolean(pattern.get(cap.isoDow(iso)));
  const buckets = cap.weekBuckets(period).map((wk) => wk.filter(worksOn));
  const weeks = buckets.length;
  const dayOf = new Map();          // iso -> { free: [[s,e]], capMin, used: 0, byContract: Map }
  const perDayCapMin = pattern
    ? Math.max(...[...pattern.values()].map((d) => d.minutes))
    : (person.weekly_hours / 5) * 60;
  const maxClientMin = Number(get('max_client_minutes_per_day') || 240);

  for (const week of buckets) {
    for (const iso of week) {
      dayOf.set(iso, {
        iso,
        free: personWindows(pattern, iso).map(([a, b]) => [a, b]),
        capMin: pattern ? cap.dayMinutes(person, iso, pattern) : perDayCapMin,
        used: 0,
        byContract: new Map(),
      });
    }
  }
  if (!dayOf.size) {
    return {
      person: { id: person.id, name: person.name }, period, blocks: [], unplaced: [],
      totals: { scheduled_hours: 0, unplaced_hours: 0, blocks: 0 },
    };
  }

  const rows = db.prepare(`
    SELECT a.hours, a.contract_id, a.deliverable_id,
           c.name AS contract_name, c.type AS contract_type,
           d.name AS deliverable_name
      FROM allocations a
      JOIN contracts c    ON c.id = a.contract_id
      JOIN deliverables d ON d.id = a.deliverable_id
     WHERE a.person_id = ? AND a.period = ? AND c.archived = 0 AND a.hours > 0`)
    .all(personId, period);

  // Committed time is history — a rebuild plans only what is still to do.
  // Each line's hours are reduced by what is already logged against it, and
  // blocks that have been answered (done or skipped) keep their ground.
  const loggedBy = new Map(db.prepare(`
    SELECT contract_id, deliverable_id, SUM(minutes) m FROM time_entries
     WHERE person_id = ? AND date LIKE ? AND source != 'skip'
     GROUP BY contract_id, deliverable_id`).all(personId, `${period}-%`)
    .map((r) => [`${r.contract_id}:${r.deliverable_id}`, r.m]));
  const keptBlocks = db.prepare(`
    SELECT b.* FROM schedule_blocks b
     WHERE b.person_id = ? AND b.period = ?
       AND EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = b.id)`)
    .all(personId, period);

  // a person's own recipe wins over the agency default
  const ownRecipe = db.prepare('SELECT * FROM person_recipes WHERE person_id = ? AND deliverable_id = ?');
  const recipeFor = db.prepare('SELECT * FROM recipes WHERE deliverable_id = ?');

  const allDates = buckets.flat();
  const periodFrom = allDates[0];
  const periodTo = allDates[allDates.length - 1];
  const contractRow = db.prepare('SELECT * FROM contracts WHERE id = ?');

  const wanted = [];
  const offWindow = [];
  for (let r of rows) {
    const loggedMin = loggedBy.get(`${r.contract_id}:${r.deliverable_id}`) || 0;
    if (loggedMin > 0) {
      r = { ...r, hours: Math.max(0, r.hours - loggedMin / 60) };
      if (r.hours * 60 < GRAIN) continue;      // fully delivered — nothing left to plan
    }
    const recipe = ownRecipe.get(personId, r.deliverable_id)
      || recipeFor.get(r.deliverable_id) || DEFAULT_RECIPE;
    const ceiling = r.contract_type === 'internal'
      ? perDayCapMin : Math.min(maxClientMin, perDayCapMin);
    const label = r.contract_type === 'internal'
      ? r.deliverable_name
      : `${r.contract_name} — ${r.deliverable_name}`;

    // Only the days this contract is live for. Expanding against the whole
    // month and hoping the packer stays inside the window does not work —
    // a weekly task would put a session in every week of the month, including
    // the weeks after the contract had finished.
    const win = contractWindow(contractRow.get(r.contract_id) || {}, periodFrom, periodTo);
    if (!win) {
      offWindow.push({ label, minutes: Math.round(r.hours * 60), reason: 'outside the contract dates' });
      continue;
    }
    const live = [];
    buckets.forEach((bk, w) => {
      const days = bk.filter((iso) => iso >= win.start && iso <= win.end);
      if (days.length) live.push({ days, w });
    });
    if (!live.length) {
      offWindow.push({ label, minutes: Math.round(r.hours * 60), reason: 'no working days inside the contract dates' });
      continue;
    }

    const allowed = new Set(live.flatMap((l) => l.days));
    const liveWeeks = live.map((l) => l.w);
    for (const s of expand(r, recipe, live.map((l) => l.days), ceiling)) {
      // expand() counted weeks within the window; map back to the real month
      const week = live[Math.min(s.week, live.length - 1)].w;
      wanted.push({ ...s, ...r, label, week, allowed, liveWeeks });
    }
  }

  // fixed commitments the person already has
  const anchorRows = db.prepare(`
    SELECT an.*, c.name AS contract_name FROM anchors an
      LEFT JOIN contracts c ON c.id = an.contract_id
     WHERE an.person_id = ?`).all(personId);
  for (const a of anchorRows) {
    // a weekly call stops when the contract does
    const win = a.contract_id
      ? contractWindow(contractRow.get(a.contract_id) || {}, periodFrom, periodTo)
      : { start: periodFrom, end: periodTo };
    if (!win) continue;
    const allowed = new Set(allDates.filter((iso) => iso >= win.start && iso <= win.end));
    const cadence = a.cadence || 'weekly';
    const push = (week, dow) => wanted.push({
      minutes: a.minutes, week, anchored: true, dow, time: a.time,
      anchor_id: a.id,
      contract_id: a.contract_id, contract_name: a.contract_name || '',
      deliverable_name: a.label, contract_type: 'retainer', allowed,
      label: a.contract_name ? `${a.contract_name} — ${a.label}` : a.label,
    });
    if (cadence === 'daily') {
      // one sitting every working day inside the window
      for (let w = 0; w < weeks; w++) {
        for (const iso of buckets[w]) {
          if (!allowed.has(iso)) continue;
          push(w, new Date(`${iso}T00:00:00Z`).getUTCDay());
        }
      }
    } else if (cadence === 'monthly') {
      // once a month, on the first week that carries its day
      for (let w = 0; w < weeks; w++) {
        if (buckets[w].some((iso) => allowed.has(iso)
          && new Date(`${iso}T00:00:00Z`).getUTCDay() === a.dow)) { push(w, a.dow); break; }
      }
    } else {
      // weekly, or fortnightly (every other week)
      const step = cadence === 'fortnightly' ? 2 : 1;
      for (let w = 0; w < weeks; w += step) {
        if (buckets[w].some((iso) => allowed.has(iso))) push(w, a.dow);
      }
    }
  }

  // max_sittings is a preference about fragmentation, not a promise the result
  // will fit. A 12h build chopped into two 6h pieces can never be placed when a
  // client is capped at 4h a day, so subdivide anything that cannot physically
  // land before trying to place it at all.
  const ceilingFor = (item) => (item.contract_type === 'internal'
    ? perDayCapMin : Math.min(maxClientMin, perDayCapMin));

  const feasible = (item) => {
    const ceiling = ceilingFor(item);
    if (item.minutes <= ceiling || !item.splittable) return [item];
    const n = Math.ceil(item.minutes / ceiling);
    return splitExact(item.minutes, n)
      .map((minutes) => ({ ...item, minutes, subdivided: true }));
  };

  const placed = [];
  const unplaced = [];

  const take = (day, startMin, minutes) => {
    for (let i = 0; i < day.free.length; i++) {
      const [s, e] = day.free[i];
      if (startMin >= s && startMin + minutes <= e) {
        const rest = [];
        if (startMin - s >= 15) rest.push([s, startMin]);
        if (e - (startMin + minutes) >= 15) rest.push([startMin + minutes, e]);
        day.free.splice(i, 1, ...rest);
        return true;
      }
    }
    return false;
  };

  const fits = (day, minutes, item) => {
    if (day.used + minutes > day.capMin + 0.01) return false;
    if (item.contract_type !== 'internal') {
      const already = day.byContract.get(item.contract_id) || 0;
      if (already + minutes > maxClientMin + 0.01) return false;
    }
    return true;
  };

  const commit = (day, startMin, item) => {
    day.used += item.minutes;
    day.byContract.set(item.contract_id, (day.byContract.get(item.contract_id) || 0) + item.minutes);
    placed.push({
      date: day.iso,
      start: fromMin(startMin),
      end: fromMin(startMin + item.minutes),
      minutes: Math.round(item.minutes),
      label: item.label,
      contract_id: item.contract_id,
      // the id, not just the name — dropping it here meant every saved block
      // lost its category, and every entry confirmed from one inherited the
      // loss, surfacing as "Unmapped" hours in the reports
      deliverable_id: item.deliverable_id || null,
      contract_name: item.contract_name,
      deliverable: item.deliverable_name,
      anchored: !!item.anchored,
      anchor_id: item.anchor_id || null,
    });
  };

  // 0) committed blocks keep their ground — carve their windows out before
  //    any fresh work is placed, and show them in the plan as what they are
  for (const kb of keptBlocks) {
    const day = dayOf.get(kb.date);
    if (day && kb.start) {
      take(day, toMin(kb.start), kb.minutes);
      day.used += kb.minutes;
      if (kb.contract_id) {
        day.byContract.set(kb.contract_id, (day.byContract.get(kb.contract_id) || 0) + kb.minutes);
      }
    }
    placed.push({
      date: kb.date, start: kb.start, end: kb.start ? fromMin(toMin(kb.start) + kb.minutes) : null,
      minutes: kb.minutes, label: kb.label, contract_id: kb.contract_id,
      contract_name: '', deliverable_id: kb.deliverable_id, deliverable: '',
      anchored: !!kb.anchored, kept: true,
    });
  }

  // 1) anchored first — they own their slot
  for (const item of wanted.filter((w) => w.anchored)) {
    const week = (buckets[Math.min(item.week, weeks - 1)] || [])
      .filter((d) => !item.allowed || item.allowed.has(d));
    const iso = week.find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === item.dow) || week[0];
    const day = iso && dayOf.get(iso);
    if (!day) { unplaced.push(item); continue; }
    const startMin = toMin(item.time || '10:00');
    if (take(day, startMin, item.minutes) && fits(day, item.minutes, item)) commit(day, startMin, item);
    else unplaced.push(item);
  }

  // 2) everything else, longest first, into the emptiest day of its week.
  //    If its own week is full, slide to the nearest week that has room —
  //    a weekly task landing a week late beats it disappearing.
  const tryWeek = (item, w) => {
    const week = (buckets[w] || []).filter((iso) => !item.allowed || item.allowed.has(iso));
    const candidates = week.map((iso) => dayOf.get(iso)).filter(Boolean)
      .sort((a, b) => a.used - b.used);
    for (const day of candidates) {
      if (!fits(day, item.minutes, item)) continue;
      const slot = day.free.find(([s, e]) => e - s >= item.minutes);
      if (!slot) continue;
      take(day, slot[0], item.minutes);
      commit(day, slot[0], item);
      return true;
    }
    return false;
  };

  const flexible = wanted.filter((w) => !w.anchored)
    .flatMap(feasible)
    .sort((a, b) => b.minutes - a.minutes);

  /**
   * Place an item, halving it as a last resort. Each leaf either lands or is
   * recorded unplaced exactly once — an earlier version returned all-or-nothing
   * from the recursion, so when one half landed and the other did not the whole
   * item was reported unplaced while half of it was already on the calendar,
   * and scheduled + unplaced came out larger than what was allocated.
   */
  const place = (item) => {
    const home = Math.min(item.week, weeks - 1);
    const order = [home];                       // nearest week first, then out
    for (let d = 1; d < weeks; d++) {
      if (home - d >= 0) order.push(home - d);
      if (home + d < weeks) order.push(home + d);
    }
    // a full week is a reason to slide, never a reason to leave the window
    const open = item.liveWeeks && new Set(item.liveWeeks);
    const reach = open ? order.filter((w) => open.has(w)) : order;
    if (reach.some((w) => tryWeek(item, w))) return;

    // nothing took it whole — split and try each half on its own merits,
    // but never below the recipe's block size: a runt the recipe forbids is
    // worse than the whole thing landing on the weekend valve intact
    const floorMin = Math.max(GRAIN, item.min_block || GRAIN);
    if (item.splittable && item.minutes >= floorMin * 2) {
      const half = snap(item.minutes / 2);
      const rest = item.minutes - half;
      place({ ...item, minutes: half, subdivided: true });
      if (rest >= GRAIN) place({ ...item, minutes: rest, subdivided: true });
      else if (rest > 0) unplaced.push({ ...item, minutes: rest });
      return;
    }
    unplaced.push(item);
  };

  for (const item of flexible) place(item);

  // The overflow valve. A month can simply not have room Monday to Friday;
  // letting that time vanish into a warning made it nobody's problem. It
  // lands on a weekend instead — visible on the calendar, draggable like
  // anything else, and honest about why it is there. Weekends carry no
  // modelled capacity, so the only limit is the day itself; the weekday
  // ceilings exist to protect focus in a working week, not to police a
  // valve whose whole point is that the week was full.
  if (unplaced.length) {
    const weekendDays = new Map();          // iso -> { iso, free }
    const seen = new Set();
    for (const bk of buckets) {
      const monday = new Date(`${bk[0]}T00:00:00Z`);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      for (const offset of [5, 6]) {        // Saturday, Sunday
        const d = new Date(monday); d.setUTCDate(d.getUTCDate() + offset);
        const iso = d.toISOString().slice(0, 10);
        if (iso.slice(0, 7) !== period || seen.has(iso)) continue;
        seen.add(iso);
        weekendDays.set(iso, { iso, free: dayWindows().map(([a, b]) => [a, b]), used: 0, byContract: new Map() });
      }
    }
    const weekends = [...weekendDays.values()].sort((a, b) => a.iso.localeCompare(b.iso));
    const still = [];
    for (const item of unplaced) {
      // a contract window still binds: no weekend outside the dates it ran
      const bounds = item.allowed ? [...item.allowed].sort() : null;
      const legal = weekends.filter((w) => !bounds
        || (w.iso >= bounds[0] && w.iso <= bounds[bounds.length - 1]));
      const landed = legal.find((day) => {
        const slot = day.free.find(([a, b]) => b - a >= item.minutes);
        if (!slot) return false;
        take(day, slot[0], item.minutes);
        placed.push({
          date: day.iso, start: fromMin(slot[0]), end: fromMin(slot[0] + item.minutes),
          minutes: Math.round(item.minutes), label: item.label,
          contract_id: item.contract_id, deliverable_id: item.deliverable_id || null,
          contract_name: item.contract_name, deliverable: item.deliverable_name,
          anchored: false, overflow: true,
        });
        return true;
      });
      if (!landed) still.push(item);
    }
    unplaced.length = 0;
    unplaced.push(...still);
  }

  placed.sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)));

  // Coalesce accidental fragmentation: two sittings of the same task landing
  // back-to-back are one sitting — three 30-minute "General Management" slots
  // in a row are a diary nobody asked for. Anchored and kept blocks are left
  // alone; they mean their exact shape.
  const blocks = [];
  for (const b of placed) {
    const prev = blocks[blocks.length - 1];
    if (prev && !b.anchored && !prev.anchored && !b.kept && !prev.kept
      && prev.date === b.date && prev.end === b.start
      && prev.contract_id === b.contract_id && prev.label === b.label) {
      prev.minutes += b.minutes;
      prev.end = b.end;
      continue;
    }
    blocks.push({ ...b });
  }

  return {
    person: { id: person.id, name: person.name },
    period,
    blocks,
    unplaced: [
      ...unplaced.map((u) => ({ label: u.label, minutes: Math.round(u.minutes), week: u.week + 1, reason: 'no room left that week' })),
      ...offWindow,
    ],
    totals: {
      scheduled_hours: cap.round2(blocks.reduce((s, b) => s + b.minutes, 0) / 60),
      unplaced_hours: cap.round2(
        [...unplaced, ...offWindow].reduce((s, b) => s + b.minutes, 0) / 60),
      blocks: blocks.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Fixed commitments meet saved plans. The packer places anchors when it
// builds a plan — but a commitment added AFTER a plan was committed used to
// exist only in the capacity numbers, never on anyone's calendar. Saving a
// commitment now walks every saved plan it touches, from this month forward,
// and puts its blocks straight in; deleting one lifts its unanswered blocks
// back out. A fixed commitment owns its slot — that is what fixed means.
// ---------------------------------------------------------------------------

const todayLondon = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

/** The dates one anchor occupies in a period — the same choices the packer makes. */
function anchorDates(anchor, contract, period) {
  const pattern = cap.patternOf(anchor.person_id);
  const worksOn = (iso) => !pattern || Boolean(pattern.get(cap.isoDow(iso)));
  const allowed = new Set(cap.anchorWindowDates(contract, period).filter(worksOn));
  if (!allowed.size) return [];
  const buckets = cap.weekBuckets(period);
  const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const pick = (wk) => wk.find((iso) => allowed.has(iso) && dowOf(iso) === anchor.dow)
    || wk.find((iso) => allowed.has(iso));
  const cadence = anchor.cadence || 'weekly';
  const dates = [];
  if (cadence === 'daily') {
    dates.push(...buckets.flat().filter((iso) => allowed.has(iso)));
  } else if (cadence === 'monthly') {
    for (const wk of buckets) {
      const d = wk.find((iso) => allowed.has(iso) && dowOf(iso) === anchor.dow);
      if (d) { dates.push(d); break; }
    }
  } else {
    const step = cadence === 'fortnightly' ? 2 : 1;
    for (let w = 0; w < buckets.length; w += step) {
      const d = pick(buckets[w]);
      if (d) dates.push(d);
    }
  }
  return dates;
}

/** Put one commitment's blocks into every saved plan it belongs in. */
function placeAnchor(anchorId) {
  const a = db.prepare('SELECT * FROM anchors WHERE id = ?').get(anchorId);
  if (!a) return { placed: 0 };
  const contract = a.contract_id
    ? db.prepare('SELECT * FROM contracts WHERE id = ?').get(a.contract_id) : null;
  const label = contract ? `${contract.name} — ${a.label}` : a.label;
  const today = todayLondon();
  const periods = db.prepare('SELECT period FROM months WHERE period >= ? ORDER BY period')
    .all(today.slice(0, 7)).map((r) => r.period);
  const ins = db.prepare(`INSERT INTO schedule_blocks
    (person_id, period, contract_id, deliverable_id, label, date, start, minutes,
     anchored, manual, draft, anchor_id)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, 0, ?, ?)`);
  let placed = 0;
  for (const p of periods) {
    const state = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(draft),0) d
      FROM schedule_blocks WHERE person_id = ? AND period = ?`).get(a.person_id, p);
    if (!state.n) continue;              // no plan yet — the packer places it when one is built
    const draft = state.d === state.n ? 1 : 0;    // a plan still in draft stays a draft
    for (const date of anchorDates(a, contract, p)) {
      if (date < today) continue;        // the past is not retro-planned
      const dupe = db.prepare(`SELECT id FROM schedule_blocks
        WHERE person_id = ? AND date = ? AND anchored = 1
          AND (anchor_id = ? OR (start = ? AND label = ?))`)
        .get(a.person_id, date, a.id, a.time, label);
      if (dupe) continue;
      ins.run(a.person_id, p, a.contract_id, label, date, a.time, a.minutes, draft, a.id);
      placed++;
    }
  }
  return { placed };
}

/** Lift one commitment's unanswered blocks out of today-and-future plans. */
function removeAnchorBlocks(anchorId) {
  return db.prepare(`DELETE FROM schedule_blocks WHERE anchor_id = ? AND date >= ?
    AND NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = schedule_blocks.id)`)
    .run(anchorId, todayLondon()).changes;
}

// ---------------------------------------------------------------------------
// .ics export — Europe/London, with a VTIMEZONE so BST resolves correctly.
// ---------------------------------------------------------------------------

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/London',
  'X-LIC-LOCATION:Europe/London',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:BST',
  'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:GMT',
  'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/**
 * RFC 5545 text escaping. Line endings are normalised and every other control
 * character stripped BEFORE escaping: a raw CR surviving into a value is
 * malformed, and lenient parsers treat a lone CR as a line break — which lets
 * a note forge calendar properties in someone's subscribed calendar.
 */
const esc = (s) => String(s)
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;')
  .replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** RFC 5545 wants lines folded at 75 octets. */
function fold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 74) { out.push(cur); cur = ' '; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.join('\r\n');
}

function toIcs(plan, stamp) {
  // every VEVENT must carry a DTSTAMP — Google refuses feeds without one, so
  // a caller that doesn't provide it gets now rather than "undefined"
  stamp = stamp || `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const dt = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    'PRODID:-//Emotio//EmotioHours//EN',
    `X-WR-CALNAME:${esc(`${plan.person.name} — ${plan.period}`)}`,
    'X-WR-TIMEZONE:Europe/London',
    ...VTIMEZONE,
  ];

  plan.blocks.forEach((b, i) => {
    // a block that carries its own uid keeps it — subscriptions rely on
    // stable uids so a refresh updates events rather than duplicating them
    const uid = b.uid || `ledger-${plan.person.id}-${plan.period}-${i}@emotio`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      // an entry with no clock time is honest as an all-day event; inventing
      // a start hour for it would put a fiction in someone's calendar
      ...(b.all_day
        ? [`DTSTART;VALUE=DATE:${b.date.replace(/-/g, '')}`,
           `DTEND;VALUE=DATE:${nextDay(b.date)}`]
        : [`DTSTART;TZID=Europe/London:${dt(b.date, b.start)}`,
           `DTEND;TZID=Europe/London:${dt(b.date, b.end)}`]),
      fold(`SUMMARY:${esc(b.label)}`),
      fold(`DESCRIPTION:${esc(`${b.deliverable} · ${(b.minutes / 60).toFixed(2)}h${b.anchored ? ' · fixed slot' : ''}`)}`),
      b.contract_name ? fold(`CATEGORIES:${esc(b.contract_name)}`) : null,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  });

  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n') + '\r\n';
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * The hours a saved plan ought to hold: allocations less what is already
 * logged, plus kept blocks and anchors — the same identity the audit runs.
 * "Couldn't place" for a saved plan is this minus what is actually scheduled,
 * so the figure survives the save instead of vanishing with the packer run.
 */
function expectedPlanHours(personId, period) {
  const lines = db.prepare(`SELECT a.contract_id, a.deliverable_id, a.hours FROM allocations a
    JOIN contracts c ON c.id = a.contract_id
    WHERE a.person_id = ? AND a.period = ? AND c.archived = 0 AND a.hours > 0`).all(personId, period);
  const loggedBy = new Map(db.prepare(`SELECT contract_id, deliverable_id, SUM(minutes) m
      FROM time_entries WHERE person_id = ? AND date LIKE ? AND source != 'skip'
     GROUP BY contract_id, deliverable_id`).all(personId, `${period}-%`)
    .map((r) => [`${r.contract_id}:${r.deliverable_id}`, r.m]));
  let remainMin = 0;
  for (const l of lines) {
    const rem = l.hours * 60 - (loggedBy.get(`${l.contract_id}:${l.deliverable_id}`) || 0);
    if (rem >= GRAIN) remainMin += rem;
    else if (!loggedBy.has(`${l.contract_id}:${l.deliverable_id}`) && rem > 0) remainMin += rem;
  }
  const keptMin = db.prepare(`SELECT COALESCE(SUM(b.minutes),0) m FROM schedule_blocks b
    WHERE b.person_id = ? AND b.period = ?
      AND EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = b.id)`).get(personId, period).m;
  // per anchor, honouring cadence, contract window and the person's working
  // pattern — the same arithmetic the scheduler and the audit both use
  const contractOf = db.prepare('SELECT * FROM contracts WHERE id = ?');
  const anchorMin = db.prepare('SELECT * FROM anchors WHERE person_id = ?').all(personId)
    .reduce((s, an) => s + cap.anchorMinutes(
      an, an.contract_id ? contractOf.get(an.contract_id) : null, period), 0);
  return cap.round2((remainMin + keptMin + anchorMin) / 60);
}

module.exports = {
  planPerson, toIcs, expand, dayWindows, expectedPlanHours,
  placeAnchor, removeAnchorBlocks,
};
