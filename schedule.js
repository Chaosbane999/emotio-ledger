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

// A week only has so many useful slots. Past this, extra "sessions" stop being
// scheduling and start being confetti — grow the block instead of fragmenting.
const MAX_PIECES_PER_WEEK = 3;
const MAX_PIECES_PER_MONTH = 10;

/**
 * Expand one allocation into the sessions its recipe demands.
 * `buckets` is the month's working weeks, so a short week takes a smaller
 * share than a full one rather than being handed an impossible load.
 * Returns [{ minutes, week, anchored, dow, time }].
 */
function expand(alloc, recipe, buckets) {
  const weeks = buckets.length;
  const totalMin = Math.round(alloc.hours * 60);
  if (totalMin <= 0 || weeks === 0) return [];

  const block = Math.max(15, recipe.block_minutes || 60);
  const splittable = !!recipe.splittable;
  const sessions = [];

  /** Split `minutes` into at most `cap` sittings of roughly `block` each. */
  const chop = (minutes, week, cap) => {
    if (minutes <= 0.5) return;
    if (!splittable) { sessions.push({ minutes, week }); return; }
    const hard = recipe.max_sittings > 0 ? recipe.max_sittings : cap;
    const pieces = Math.min(Math.max(1, Math.ceil(minutes / block)), hard);
    const size = minutes / pieces;
    for (let i = 0; i < pieces; i++) sessions.push({ minutes: size, week });
  };

  switch (recipe.cadence) {
    case 'weekly':
    case 'fortnightly': {
      const step = recipe.cadence === 'fortnightly' ? 2 : 1;
      const active = [];
      for (let w = 0; w < weeks; w += step) active.push(w);
      // weight each week by its working days, so a 3-day week gets 3 days' worth
      const days = active.map((w) => buckets[w].length);
      const totalDays = days.reduce((s, d) => s + d, 0) || 1;

      active.forEach((w, i) => {
        const per = totalMin * (days[i] / totalDays);
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
      const pieces = splittable
        ? Math.min(Math.max(1, Math.ceil(totalMin / block)), MAX_PIECES_PER_MONTH)
        : 1;
      const size = totalMin / pieces;
      for (let i = 0; i < pieces; i++) {
        sessions.push({ minutes: size, week: Math.min(weeks - 1, Math.floor((i * weeks) / pieces)) });
      }
      break;
    }
  }
  return sessions.filter((s) => s.minutes > 0.5);
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

  const recipeFor = db.prepare('SELECT * FROM recipes WHERE deliverable_id = ?');

  const wanted = [];
  for (const r of rows) {
    const recipe = recipeFor.get(r.deliverable_id) || DEFAULT_RECIPE;
    for (const s of expand(r, recipe, buckets)) {
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

  const flexible = wanted.filter((w) => !w.anchored).sort((a, b) => b.minutes - a.minutes);
  for (const item of flexible) {
    const home = Math.min(item.week, weeks - 1);
    // nearest-first: home week, then ±1, ±2 ...
    const order = [home];
    for (let d = 1; d < weeks; d++) {
      if (home - d >= 0) order.push(home - d);
      if (home + d < weeks) order.push(home + d);
    }
    if (!order.some((w) => tryWeek(item, w))) unplaced.push(item);
  }

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
