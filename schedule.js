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
  const lunch = toMin(get('lunch_start') || '13:00');
  const lunchLen = Number(get('lunch_minutes') || 30);
  if (lunch <= start || lunch >= end) return [[start, end]];
  return [[start, lunch], [Math.min(end, lunch + lunchLen), end]];
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
  const base = Math.max(GRAIN, Math.floor(total / n / GRAIN) * GRAIN);
  const out = Array.from({ length: n }, () => base);
  let rem = total - base * n;
  for (let i = 0; rem >= GRAIN; i++, rem -= GRAIN) out[i % n] += GRAIN;
  return out;
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
    const wanted = Math.min(Math.max(1, Math.ceil(minutes / block)), hard);
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
      for (let w = 0; w < weeks; w += step) active.push(w);
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
      const byBlock = Math.min(Math.max(1, Math.ceil(totalMin / block)), MAX_PIECES_PER_MONTH);
      const byCeiling = ceiling ? Math.ceil(totalMin / ceiling) : 1;
      const pieces = splittable ? Math.max(byBlock, byCeiling) : 1;
      splitExact(totalMin, pieces).forEach((m, i) => {
        sessions.push({ minutes: m, week: Math.min(weeks - 1, Math.floor((i * weeks) / pieces)) });
      });
      break;
    }
  }
  return sessions.map((s) => ({ ...s, minutes: Math.round(s.minutes), splittable }))
    .filter((s) => s.minutes >= GRAIN);
}

const DEFAULT_RECIPE = {
  cadence: 'monthly', distribution: 'spread', block_minutes: 120,
  splittable: 1, max_sittings: 0, anchor_dow: 2, anchor_time: '10:00',
};

/**
 * Build a month of calendar blocks for one person.
 * Anchored sessions are placed first and never moved; everything else is
 * packed around them, largest sessions first so long blocks get real room.
 */
function planPerson(personId, period) {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return null;

  const buckets = cap.weekBuckets(period);
  const weeks = buckets.length;
  const dayOf = new Map();          // iso -> { free: [[s,e]], used: 0, byContract: Map }
  const perDayCapMin = (person.weekly_hours / 5) * 60;
  const maxClientMin = Number(get('max_client_minutes_per_day') || 240);

  for (const week of buckets) {
    for (const iso of week) {
      dayOf.set(iso, { iso, free: dayWindows().map(([a, b]) => [a, b]), used: 0, byContract: new Map() });
    }
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

  // a person's own recipe wins over the agency default
  const ownRecipe = db.prepare('SELECT * FROM person_recipes WHERE person_id = ? AND deliverable_id = ?');
  const recipeFor = db.prepare('SELECT * FROM recipes WHERE deliverable_id = ?');

  const wanted = [];
  for (const r of rows) {
    const recipe = ownRecipe.get(personId, r.deliverable_id)
      || recipeFor.get(r.deliverable_id) || DEFAULT_RECIPE;
    const ceiling = r.contract_type === 'internal'
      ? perDayCapMin : Math.min(maxClientMin, perDayCapMin);
    for (const s of expand(r, recipe, buckets, ceiling)) {
      const label = r.contract_type === 'internal'
        ? r.deliverable_name
        : `${r.contract_name} — ${r.deliverable_name}`;
      wanted.push({ ...s, ...r, label });
    }
  }

  // fixed commitments the person already has
  const anchorRows = db.prepare(`
    SELECT an.*, c.name AS contract_name FROM anchors an
      LEFT JOIN contracts c ON c.id = an.contract_id
     WHERE an.person_id = ?`).all(personId);
  for (const a of anchorRows) {
    for (let w = 0; w < weeks; w++) {
      wanted.push({
        minutes: a.minutes, week: w, anchored: true, dow: a.dow, time: a.time,
        contract_id: a.contract_id, contract_name: a.contract_name || '',
        deliverable_name: a.label, contract_type: 'retainer',
        label: a.contract_name ? `${a.contract_name} — ${a.label}` : a.label,
      });
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
    if (day.used + minutes > perDayCapMin + 0.01) return false;
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
      contract_name: item.contract_name,
      deliverable: item.deliverable_name,
      anchored: !!item.anchored,
    });
  };

  // 1) anchored first — they own their slot
  for (const item of wanted.filter((w) => w.anchored)) {
    const week = buckets[Math.min(item.week, weeks - 1)] || [];
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
    const week = buckets[w] || [];
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

  /** Place an item, halving it as a last resort before giving up. */
  const place = (item) => {
    const home = Math.min(item.week, weeks - 1);
    const order = [home];                       // nearest week first, then out
    for (let d = 1; d < weeks; d++) {
      if (home - d >= 0) order.push(home - d);
      if (home + d < weeks) order.push(home + d);
    }
    if (order.some((w) => tryWeek(item, w))) return true;

    // nothing took it whole — split and try again rather than dropping work
    if (item.splittable && item.minutes >= GRAIN * 2) {
      const half = snap(item.minutes / 2);
      const rest = item.minutes - half;
      const a = place({ ...item, minutes: half, subdivided: true });
      const b = rest >= GRAIN ? place({ ...item, minutes: rest, subdivided: true }) : true;
      return a && b;
    }
    return false;
  };

  for (const item of flexible) if (!place(item)) unplaced.push(item);

  placed.sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)));

  return {
    person: { id: person.id, name: person.name },
    period,
    blocks: placed,
    unplaced: unplaced.map((u) => ({ label: u.label, minutes: Math.round(u.minutes), week: u.week + 1 })),
    totals: {
      scheduled_hours: cap.round2(placed.reduce((s, b) => s + b.minutes, 0) / 60),
      unplaced_hours: cap.round2(unplaced.reduce((s, b) => s + b.minutes, 0) / 60),
      blocks: placed.length,
    },
  };
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

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;')
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
  const dt = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    'PRODID:-//Emotio//EmotioHours//EN',
    `X-WR-CALNAME:${esc(`${plan.person.name} — ${plan.period}`)}`,
    'X-WR-TIMEZONE:Europe/London',
    ...VTIMEZONE,
  ];

  plan.blocks.forEach((b, i) => {
    const uid = `ledger-${plan.person.id}-${plan.period}-${i}@emotio`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/London:${dt(b.date, b.start)}`,
      `DTEND;TZID=Europe/London:${dt(b.date, b.end)}`,
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

module.exports = { planPerson, toIcs, expand, dayWindows };
