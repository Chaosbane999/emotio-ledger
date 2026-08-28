const { db } = require('./db');
const cap = require('./capacity');

// ---------------------------------------------------------------------------
// Time entries: what actually happened, against schedule_blocks: the plan.
//
// All arithmetic in this file is integer minutes. Hours only appear at the
// edge, divided by 60 for display, so totals are exact by construction —
// there is nothing to round and no drift to accumulate.
// ---------------------------------------------------------------------------

const MAX_DAY_MINUTES = 24 * 60;

const isDate = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');

/** SQLite's datetime('now') is UTC 'YYYY-MM-DD HH:MM:SS'; parse it as such. */
const parseUtc = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);

/** The timer runs on the wall clock in London, whatever the server is set to. */
const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function londonParts(d) {
  const p = Object.fromEntries(LONDON.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayLondon = () => londonParts(new Date()).date;
const toHours = (mins) => round2(mins / 60);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const blockCols = `b.id, b.person_id, b.contract_id, b.deliverable_id, b.label,
  b.date, b.start, b.minutes, b.anchored`;

function entriesFor(personId, from, to) {
  return db.prepare(`
    SELECT e.*, c.name AS contract_name, d.name AS deliverable_name
      FROM time_entries e
      LEFT JOIN contracts c    ON c.id = e.contract_id
      LEFT JOIN deliverables d ON d.id = e.deliverable_id
     WHERE e.person_id = ? AND e.date >= ? AND e.date <= ?
     ORDER BY e.date, COALESCE(e.start, '99'), e.id`).all(personId, from, to);
}

function blocksFor(personId, from, to) {
  return db.prepare(`
    SELECT ${blockCols}, c.name AS contract_name, d.name AS deliverable_name
      FROM schedule_blocks b
      LEFT JOIN contracts c    ON c.id = b.contract_id
      LEFT JOIN deliverables d ON d.id = b.deliverable_id
     WHERE b.person_id = ? AND b.date >= ? AND b.date <= ?
     ORDER BY b.date, b.start`).all(personId, from, to);
}

/**
 * A block is accounted for by the entries that reference it:
 *   skipped — a skip entry says it did not happen
 *   done    — one or more worked entries cover it (a split is several)
 *   pending — nothing said yet
 * Skip and work on the same block are refused at write time, so the states
 * cannot overlap and every block lands in exactly one of the three.
 *
 * The accounting looks up every entry that references the block, whatever
 * date the entry landed on — work moved wholesale to another day must still
 * mark its block done, or confirm-day would log the same block twice.
 */
function decorate(blocks) {
  if (!blocks.length) return [];
  const refs = db.prepare(`SELECT * FROM time_entries
    WHERE block_id IN (${blocks.map(() => '?').join(',')})`)
    .all(...blocks.map((b) => b.id));
  const byBlock = new Map();
  for (const e of refs) {
    if (!byBlock.has(e.block_id)) byBlock.set(e.block_id, []);
    byBlock.get(e.block_id).push(e);
  }
  return blocks.map((b) => {
    const mine = byBlock.get(b.id) || [];
    const skipped = mine.some((e) => e.source === 'skip');
    const worked = mine.filter((e) => e.source !== 'skip');
    return {
      ...b,
      status: skipped ? 'skipped' : worked.length ? 'done' : 'pending',
      logged_minutes: worked.reduce((s, e) => s + e.minutes, 0),
      entry_ids: mine.map((e) => e.id),
    };
  });
}

function dayView(personId, date) {
  if (!isDate(date)) throw new Error('bad date');
  const entries = entriesFor(personId, date, date);
  const blocks = decorate(blocksFor(personId, date, date));
  const worked = entries.filter((e) => e.source !== 'skip');
  return {
    person_id: personId,
    date,
    blocks,
    entries,
    timer: currentTimer(personId),
    totals: {
      planned_minutes: blocks.reduce((s, b) => s + b.minutes, 0),
      logged_minutes: worked.reduce((s, e) => s + e.minutes, 0),
      pending: blocks.filter((b) => b.status === 'pending').length,
      done: blocks.filter((b) => b.status === 'done').length,
      skipped: blocks.filter((b) => b.status === 'skipped').length,
    },
  };
}

/** Monday of the week containing `date`. */
function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;            // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function weekView(personId, date) {
  if (!isDate(date)) throw new Error('bad date');
  const start = mondayOf(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = days[6];
  const entries = entriesFor(personId, start, end);
  const blocks = decorate(blocksFor(personId, start, end));
  const worked = entries.filter((e) => e.source !== 'skip');
  const perDay = days.map((d) => ({
    date: d,
    planned_minutes: blocks.filter((b) => b.date === d).reduce((s, b) => s + b.minutes, 0),
    logged_minutes: worked.filter((e) => e.date === d).reduce((s, e) => s + e.minutes, 0),
  }));
  return {
    person_id: personId, start, days, blocks, entries,
    timer: currentTimer(personId),
    totals: {
      planned_minutes: perDay.reduce((s, d) => s + d.planned_minutes, 0),
      logged_minutes: perDay.reduce((s, d) => s + d.logged_minutes, 0),
      per_day: perDay,
      pending: blocks.filter((b) => b.status === 'pending').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const getBlock = (id) => db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(id);
const getEntry = (id) => db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);

function blockGuard(personId, blockId) {
  const b = getBlock(blockId);
  if (!b) throw new Error('no such block');
  if (b.person_id !== personId) throw new Error('not your block');
  return b;
}

/** Refuse mixing skip and work on one block — a block is one thing or the other. */
function entryStateOf(blockId) {
  const rows = db.prepare('SELECT source FROM time_entries WHERE block_id = ?').all(blockId);
  return {
    hasSkip: rows.some((r) => r.source === 'skip'),
    hasWork: rows.some((r) => r.source !== 'skip'),
  };
}

function addEntry(personId, body) {
  const date = body.date;
  if (!isDate(date)) throw new Error('bad date');
  const start = body.start ? String(body.start).slice(0, 5) : null;
  if (start !== null && !isTime(start)) throw new Error('bad start time');
  const minutes = Number(body.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_DAY_MINUTES) {
    throw new Error('minutes must be a whole number of minutes in the day');
  }
  const note = String(body.note || '').slice(0, 2000);
  const source = ['confirm', 'adjust', 'timer', 'manual'].includes(body.source)
    ? body.source : 'manual';

  let contractId; let deliverableId; let blockId = null;
  if (body.block_id) {
    const b = blockGuard(personId, body.block_id);
    const state = entryStateOf(b.id);
    if (state.hasSkip) throw new Error('This block is marked as skipped — unskip it first.');
    // the entry answers for the planned block, so it keeps the block's identity
    contractId = b.contract_id;
    deliverableId = b.deliverable_id;
    blockId = b.id;
  } else {
    contractId = Number(body.contract_id) || null;
    deliverableId = Number(body.deliverable_id) || null;
    if (!contractId || !deliverableId) throw new Error('pick a contract and a deliverable');
    if (!db.prepare('SELECT id FROM contracts WHERE id = ? AND archived = 0').get(contractId)) {
      throw new Error('no such contract');
    }
    if (!db.prepare('SELECT id FROM deliverables WHERE id = ?').get(deliverableId)) {
      throw new Error('no such deliverable');
    }
  }

  const r = db.prepare(`
    INSERT INTO time_entries (block_id, person_id, contract_id, deliverable_id,
      date, start, minutes, note, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(blockId, personId, contractId, deliverableId, date, start, minutes, note, source);
  return getEntry(Number(r.lastInsertRowid));
}

/** One tap: the block happened exactly as planned. */
function confirmBlock(personId, blockId, note) {
  const b = blockGuard(personId, blockId);
  const state = entryStateOf(b.id);
  if (state.hasSkip) throw new Error('This block is marked as skipped — unskip it first.');
  if (state.hasWork) throw new Error('Already confirmed.');
  return addEntry(personId, {
    block_id: b.id, date: b.date, start: b.start, minutes: b.minutes,
    note: note || '', source: 'confirm',
  });
}

/** Everything still pending on a date, accepted as planned in one go. */
function confirmDay(personId, date) {
  if (!isDate(date)) throw new Error('bad date');
  const view = dayView(personId, date);
  const out = [];
  for (const b of view.blocks) {
    if (b.status === 'pending') out.push(confirmBlock(personId, b.id, ''));
  }
  return { confirmed: out.length };
}

function skipBlock(personId, blockId, note) {
  const b = blockGuard(personId, blockId);
  const state = entryStateOf(b.id);
  if (state.hasWork) throw new Error('Time is already logged against this block.');
  if (state.hasSkip) throw new Error('Already skipped.');
  const r = db.prepare(`
    INSERT INTO time_entries (block_id, person_id, contract_id, deliverable_id,
      date, start, minutes, note, source)
    VALUES (?, ?, ?, ?, ?, NULL, 0, ?, 'skip')`)
    .run(b.id, personId, b.contract_id, b.deliverable_id, b.date,
      String(note || '').slice(0, 2000));
  return getEntry(Number(r.lastInsertRowid));
}

/**
 * A day that has passed is settled: its committed time is part of the record
 * the variance numbers stand on. Editing it is still possible — mistakes are
 * real — but only as a deliberate override, never as a casual drag.
 */
function assertUnlocked(e, override) {
  if (e.date < todayLondon() && !override) {
    throw new Error('That day has passed — its time is fixed. Use override to correct a mistake.');
  }
}

function updateEntry(personId, entryId, body) {
  const e = getEntry(entryId);
  if (!e || e.person_id !== personId) throw new Error('no such entry');
  assertUnlocked(e, body.override === true);
  const next = {
    date: body.date !== undefined ? body.date : e.date,
    start: body.start !== undefined ? (body.start ? String(body.start).slice(0, 5) : null) : e.start,
    minutes: body.minutes !== undefined ? Number(body.minutes) : e.minutes,
    note: body.note !== undefined ? String(body.note || '').slice(0, 2000) : e.note,
  };
  if (!isDate(next.date)) throw new Error('bad date');
  if (next.start !== null && !isTime(next.start)) throw new Error('bad start time');
  if (e.source === 'skip') {
    if (next.minutes !== 0) throw new Error('a skipped block has no minutes — unskip it instead');
  } else if (!Number.isInteger(next.minutes) || next.minutes <= 0 || next.minutes > MAX_DAY_MINUTES) {
    throw new Error('minutes must be a whole number of minutes in the day');
  }
  // moving or resizing a confirmed block is, by definition, an adjustment
  const source = e.source === 'confirm'
    && (next.date !== e.date || next.start !== e.start || next.minutes !== e.minutes)
    ? 'adjust' : e.source;
  db.prepare(`UPDATE time_entries SET date = ?, start = ?, minutes = ?, note = ?, source = ?
    WHERE id = ?`).run(next.date, next.start, next.minutes, next.note, source, entryId);
  return getEntry(entryId);
}

function deleteEntry(personId, entryId, override) {
  const e = getEntry(entryId);
  if (!e || e.person_id !== personId) throw new Error('no such entry');
  // deleting a skip is just unskipping tomorrow's question — never locked
  if (e.source !== 'skip') assertUnlocked(e, override === true);
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(entryId);
  return { deleted: entryId };
}

/**
 * Dragging on the calendar arranges the PLAN — it commits nothing. The block
 * moves; the tick is still the only thing that turns plan into record.
 */
function moveBlock(personId, blockId, date, start) {
  const b = blockGuard(personId, blockId);
  const state = entryStateOf(b.id);
  if (state.hasWork || state.hasSkip) {
    throw new Error('This block is already accounted for — move the logged entry instead.');
  }
  if (!isDate(date)) throw new Error('bad date');
  if (!isTime(start)) throw new Error('bad start time');
  if (date.slice(0, 7) !== b.period) {
    throw new Error('A plan lives inside its month — move it within ' + b.period + '.');
  }
  // the schedule audit promises blocks never overlap; a drag must keep that true
  const startMin = toMinOfDayLocal(start);
  const endMin = startMin + b.minutes;
  const clash = db.prepare(`SELECT id, start, minutes, label FROM schedule_blocks
    WHERE person_id = ? AND date = ? AND id != ? AND start IS NOT NULL`).all(personId, date, b.id)
    .find((o) => {
      const os = toMinOfDayLocal(o.start);
      return startMin < os + o.minutes && os < endMin;
    });
  if (clash) throw new Error(`That slot overlaps “${clash.label}” at ${clash.start}.`);
  db.prepare('UPDATE schedule_blocks SET date = ?, start = ? WHERE id = ?').run(date, start, b.id);
  return getBlock(b.id);
}
const toMinOfDayLocal = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

/** How much a block can grow before it hits the next block that day. */
function growthRoom(personId, block) {
  if (!block.start) return Infinity;
  const startMin = toMinOfDayLocal(block.start);
  const later = db.prepare(`SELECT start FROM schedule_blocks
    WHERE person_id = ? AND date = ? AND id != ? AND start IS NOT NULL`)
    .all(personId, block.date, block.id)
    .map((o) => toMinOfDayLocal(o.start))
    .filter((m) => m >= startMin + block.minutes)
    .sort((a, b) => a - b);
  return later.length ? later[0] - startMin - block.minutes : Infinity;
}

/** Resize a still-pending planned block. Same rules as moving one. */
function resizeBlock(personId, blockId, minutes) {
  const b = blockGuard(personId, blockId);
  const state = entryStateOf(b.id);
  if (state.hasWork || state.hasSkip) {
    throw new Error('This block is already accounted for — resize the logged entry instead.');
  }
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > MAX_DAY_MINUTES || minutes % 15 !== 0) {
    throw new Error('Block length is quarter hours, at least one.');
  }
  const grow = minutes - b.minutes;
  if (grow > 0 && grow > growthRoom(personId, b)) {
    throw new Error('That would run into the next block — move something first.');
  }
  db.prepare('UPDATE schedule_blocks SET minutes = ? WHERE id = ?').run(minutes, b.id);
  return { ...getBlock(b.id), delta: minutes - b.minutes };
}

// ---------------------------------------------------------------------------
// Rebalancing. A resize changes how much of the month one contract takes, so
// the rest of that contract's plan no longer sums to what was allocated. The
// proposal puts the difference back — trimming or extending upcoming blocks,
// working from the end of the month inwards so near-term work is disturbed
// last. It is only ever a PROPOSAL: nothing moves until it is applied.
// ---------------------------------------------------------------------------

function rebalanceCandidates(personId, contractId, period, excludeBlockId) {
  return decorate(db.prepare(`
    SELECT ${blockCols}, c.name AS contract_name, d.name AS deliverable_name
      FROM schedule_blocks b
      LEFT JOIN contracts c    ON c.id = b.contract_id
      LEFT JOIN deliverables d ON d.id = b.deliverable_id
     WHERE b.person_id = ? AND b.contract_id = ? AND b.period = ?
       AND b.date >= ? AND b.id != ? AND b.anchored = 0
     ORDER BY b.date DESC, b.start DESC`)
    .all(personId, contractId, period, todayLondon(), excludeBlockId || 0))
    .filter((b) => b.status === 'pending');
}

/**
 * delta is the change in minutes the contract just consumed (+ took more,
 * - took less). The proposal offsets it: trim upcoming blocks when time was
 * added, extend them when time was freed. Whatever cannot be placed is
 * reported, never silently dropped.
 */
function rebalancePlan(personId, contractId, period, delta, excludeBlockId) {
  cap.parsePeriod(period);
  const contract = db.prepare('SELECT id, name, type FROM contracts WHERE id = ?').get(contractId);
  if (!contract) throw new Error('no such contract');
  if (!Number.isInteger(delta) || delta === 0) throw new Error('nothing to balance');

  const candidates = rebalanceCandidates(personId, contractId, period, excludeBlockId);
  const proposal = [];
  let remaining = Math.abs(delta);

  if (delta > 0) {
    // took more: trim upcoming blocks, latest first, a block may go entirely
    for (const b of candidates) {
      if (remaining < 15) break;
      const take = Math.min(b.minutes, remaining);
      proposal.push({
        block_id: b.id, date: b.date, start: b.start, label: b.label,
        from_minutes: b.minutes, to_minutes: b.minutes - take,
      });
      remaining -= take;
    }
  } else {
    // took less: grow a block where there is room; the packer lays blocks
    // back-to-back, so usually there is none — then the freed time comes back
    // as its own NEW block, placed in genuinely free space like the packer
    // would have placed it
    for (const b of candidates) {
      if (remaining < 15) break;
      const room = growthRoom(personId, b);
      const grow = Math.min(remaining, room === Infinity ? remaining : Math.floor(room / 15) * 15);
      if (grow < 15) continue;
      proposal.push({
        block_id: b.id, date: b.date, start: b.start, label: b.label,
        from_minutes: b.minutes, to_minutes: b.minutes + grow,
      });
      remaining -= grow;
    }
    if (remaining >= 15) {
      const source = candidates[0]
        || decorate([getBlock(excludeBlockId)].filter(Boolean))[0];
      if (source) {
        const tryDates = [...new Set([...candidates.map((c) => c.date), source.date])]
          .sort().reverse();
        for (const dte of tryDates) {
          const slot = findFreeSlot(personId, dte, remaining);
          if (!slot) continue;
          proposal.push({
            block_id: null, new_block: true,
            contract_id: contractId,
            deliverable_id: source.deliverable_id,
            period,
            date: dte, start: slot,
            label: source.label || source.contract_name || 'Rescheduled time',
            from_minutes: 0, to_minutes: remaining,
          });
          remaining = 0;
          break;
        }
      }
    }
  }

  return {
    contract_id: contract.id,
    contract_name: contract.name,
    contract_type: contract.type,
    delta,
    proposal,
    unplaced_minutes: remaining >= 15 ? remaining : 0,
    upcoming_blocks: candidates.length,
  };
}

/** First stretch of `minutes` free of blocks inside the working day, or null. */
function findFreeSlot(personId, date, minutes) {
  const { get } = require('./db');
  const dayStart = toMinOfDayLocal(get('work_start') || '09:00');
  const dayEnd = toMinOfDayLocal(get('work_end') || '17:30');
  const busy = db.prepare(`SELECT start, minutes FROM schedule_blocks
    WHERE person_id = ? AND date = ? AND start IS NOT NULL ORDER BY start`)
    .all(personId, date)
    .map((b) => [toMinOfDayLocal(b.start), toMinOfDayLocal(b.start) + b.minutes]);
  let cursor = dayStart;
  for (const [bs, be] of busy) {
    if (bs - cursor >= minutes) return fromMinOfDayLocal(cursor);
    cursor = Math.max(cursor, be);
  }
  return dayEnd - cursor >= minutes ? fromMinOfDayLocal(cursor) : null;
}

/** Apply chosen rebalance rows. 0 minutes removes the block outright.
 *  A new_block row creates the block the proposal promised. */
function applyRebalance(personId, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('nothing to apply');
  const applied = [];
  for (const ch of changes) {
    if (ch.new_block) {
      const minutes = Number(ch.minutes);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes % 15 !== 0) {
        throw new Error('minutes must be whole quarter hours');
      }
      if (!isDate(ch.date) || !isTime(ch.start)) throw new Error('bad slot for the new block');
      const r = db.prepare(`INSERT INTO schedule_blocks
        (person_id, period, contract_id, deliverable_id, label, date, start, minutes, anchored, manual)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`)
        .run(personId, String(ch.date).slice(0, 7), Number(ch.contract_id) || null,
          Number(ch.deliverable_id) || null, String(ch.label || '').slice(0, 200),
          ch.date, ch.start, minutes);
      applied.push({ block_id: Number(r.lastInsertRowid), created: true, minutes });
      continue;
    }
    const b = blockGuard(personId, Number(ch.block_id));
    const state = entryStateOf(b.id);
    if (state.hasWork || state.hasSkip) throw new Error(`“${b.label}” is already accounted for.`);
    const minutes = Number(ch.minutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes % 15 !== 0) {
      throw new Error('minutes must be whole quarter hours');
    }
    if (minutes === 0) {
      db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(b.id);
      applied.push({ block_id: b.id, removed: true });
      continue;
    }
    const grow = minutes - b.minutes;
    if (grow > 0 && grow > growthRoom(personId, b)) {
      throw new Error(`“${b.label}” would run into the next block.`);
    }
    db.prepare('UPDATE schedule_blocks SET minutes = ? WHERE id = ?').run(minutes, b.id);
    applied.push({ block_id: b.id, minutes });
  }
  return { applied };
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

function currentTimer(personId) {
  const t = db.prepare(`
    SELECT t.*, c.name AS contract_name, d.name AS deliverable_name
      FROM timers t
      LEFT JOIN contracts c    ON c.id = t.contract_id
      LEFT JOIN deliverables d ON d.id = t.deliverable_id
     WHERE t.person_id = ?`).get(personId);
  if (!t) return null;
  const elapsed = Math.max(0, Math.round((Date.now() - parseUtc(t.started_at).getTime()) / 60000));
  return { ...t, elapsed_minutes: elapsed };
}

function startTimer(personId, body) {
  if (currentTimer(personId)) throw new Error('A timer is already running — stop it first.');
  let contractId; let deliverableId; let blockId = null; let label = '';
  if (body.block_id) {
    const b = blockGuard(personId, body.block_id);
    const state = entryStateOf(b.id);
    if (state.hasSkip) throw new Error('This block is marked as skipped — unskip it first.');
    contractId = b.contract_id; deliverableId = b.deliverable_id;
    blockId = b.id; label = b.label;
  } else {
    contractId = Number(body.contract_id) || null;
    deliverableId = Number(body.deliverable_id) || null;
    if (!contractId || !deliverableId) throw new Error('pick a contract and a deliverable');
  }
  db.prepare(`INSERT INTO timers (person_id, block_id, contract_id, deliverable_id, label, started_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`)
    .run(personId, blockId, contractId, deliverableId, label);
  return currentTimer(personId);
}

function stopTimer(personId, note) {
  const t = currentTimer(personId);
  if (!t) throw new Error('No timer running.');
  const started = londonParts(parseUtc(t.started_at));
  const minutes = Math.max(1, t.elapsed_minutes);
  const entry = addEntry(personId, {
    block_id: t.block_id || undefined,
    contract_id: t.contract_id, deliverable_id: t.deliverable_id,
    date: started.date, start: started.time,
    minutes: Math.min(minutes, MAX_DAY_MINUTES),
    note: note || '', source: 'timer',
  });
  db.prepare('DELETE FROM timers WHERE person_id = ?').run(personId);
  return entry;
}

function cancelTimer(personId) {
  db.prepare('DELETE FROM timers WHERE person_id = ?').run(personId);
  return { cancelled: true };
}

// ---------------------------------------------------------------------------
// Variance — the whole point. Planned vs logged, per contract and per person.
// ---------------------------------------------------------------------------

function variance(period) {
  cap.parsePeriod(period);
  const like = `${period}-%`;

  const planned = db.prepare(`
    SELECT person_id, contract_id, SUM(minutes) m, COUNT(*) n
      FROM schedule_blocks WHERE date LIKE ? GROUP BY person_id, contract_id`).all(like);
  const logged = db.prepare(`
    SELECT person_id, contract_id, SUM(minutes) m, COUNT(*) n
      FROM time_entries WHERE date LIKE ? AND source != 'skip'
     GROUP BY person_id, contract_id`).all(like);
  const skipped = db.prepare(`
    SELECT person_id, contract_id, COUNT(*) n
      FROM time_entries WHERE date LIKE ? AND source = 'skip'
     GROUP BY person_id, contract_id`).all(like);
  // blocks whose fate is still unknown — the nag list
  const pending = db.prepare(`
    SELECT b.person_id, b.contract_id, COUNT(*) n, SUM(b.minutes) m
      FROM schedule_blocks b
     WHERE b.date LIKE ? AND b.date <= date('now')
       AND NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = b.id)
     GROUP BY b.person_id, b.contract_id`).all(like);

  const people = new Map(db.prepare('SELECT id, name FROM people').all().map((p) => [p.id, p.name]));
  const contracts = new Map(db.prepare('SELECT id, name, type FROM contracts').all()
    .map((c) => [c.id, c]));

  const cells = new Map();          // person|contract -> aggregate
  const key = (p, c) => `${p}|${c ?? 0}`;
  const cell = (p, c) => {
    const k = key(p, c);
    if (!cells.has(k)) {
      cells.set(k, {
        person_id: p, person_name: people.get(p) || `#${p}`,
        contract_id: c ?? null,
        contract_name: c ? (contracts.get(c)?.name || `#${c}`) : 'Unassigned',
        contract_type: c ? (contracts.get(c)?.type || '') : '',
        planned_minutes: 0, logged_minutes: 0,
        blocks: 0, skipped: 0, pending: 0, pending_minutes: 0,
      });
    }
    return cells.get(k);
  };
  for (const r of planned) { const c = cell(r.person_id, r.contract_id); c.planned_minutes += r.m; c.blocks += r.n; }
  for (const r of logged) cell(r.person_id, r.contract_id).logged_minutes += r.m;
  for (const r of skipped) cell(r.person_id, r.contract_id).skipped += r.n;
  for (const r of pending) { const c = cell(r.person_id, r.contract_id); c.pending += r.n; c.pending_minutes += r.m; }

  const rows = [...cells.values()].map((c) => ({
    ...c,
    planned_hours: toHours(c.planned_minutes),
    logged_hours: toHours(c.logged_minutes),
    variance_hours: toHours(c.logged_minutes - c.planned_minutes),
  }));

  const roll = (group) => {
    const m = new Map();
    for (const r of rows) {
      const k = group(r);
      if (!m.has(k.id)) m.set(k.id, { ...k, planned_minutes: 0, logged_minutes: 0, skipped: 0, pending: 0, pending_minutes: 0 });
      const g = m.get(k.id);
      g.planned_minutes += r.planned_minutes;
      g.logged_minutes += r.logged_minutes;
      g.skipped += r.skipped;
      g.pending += r.pending;
      g.pending_minutes += r.pending_minutes;
    }
    return [...m.values()].map((g) => ({
      ...g,
      planned_hours: toHours(g.planned_minutes),
      logged_hours: toHours(g.logged_minutes),
      variance_hours: toHours(g.logged_minutes - g.planned_minutes),
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };

  const byPerson = roll((r) => ({ id: r.person_id, name: r.person_name }));
  const byContract = roll((r) => ({ id: r.contract_id ?? 0, name: r.contract_name, type: r.contract_type }));

  return {
    period,
    rows: rows.sort((a, b) => a.person_name.localeCompare(b.person_name)
      || a.contract_name.localeCompare(b.contract_name)),
    by_person: byPerson,
    by_contract: byContract,
    totals: {
      planned_minutes: rows.reduce((s, r) => s + r.planned_minutes, 0),
      logged_minutes: rows.reduce((s, r) => s + r.logged_minutes, 0),
      planned_hours: toHours(rows.reduce((s, r) => s + r.planned_minutes, 0)),
      logged_hours: toHours(rows.reduce((s, r) => s + r.logged_minutes, 0)),
      pending_blocks: rows.reduce((s, r) => s + r.pending, 0),
    },
  };
}

/** Hours a person has logged in a period — the person view's "Logged" tile. */
function loggedHours(personId, period) {
  const r = db.prepare(`SELECT COALESCE(SUM(minutes), 0) m FROM time_entries
    WHERE person_id = ? AND date LIKE ? AND source != 'skip'`).get(personId, `${period}-%`);
  return toHours(r.m);
}

const crypto = require('node:crypto');

/** The person's private feed token, created on first use, revocable by null-ing. */
function calendarToken(personId) {
  const p = db.prepare('SELECT calendar_token FROM people WHERE id = ?').get(personId);
  if (!p) throw new Error('no such person');
  if (p.calendar_token) return p.calendar_token;
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE people SET calendar_token = ? WHERE id = ?').run(token, personId);
  return token;
}

const personByToken = (token) => (token && token.length >= 20
  ? db.prepare('SELECT id, name FROM people WHERE calendar_token = ?').get(token)
  : undefined) || null;

/**
 * What the subscription serves: the same picture as the Time calendar, from a
 * week back to the end of next month.
 *
 *   - committed time appears as it actually happened — real slot, real
 *     length, the note carried into the event
 *   - blocks still pending appear as the plan they are
 *   - a done block does NOT also appear at its planned slot: its entries
 *     answer for it, and showing both would double the day
 *   - skipped work vanishes — it is not happening
 *
 * An entry logged without a start time (a timerless total) becomes an
 * all-day event rather than being pinned to an invented hour.
 */
function feedItems(personId) {
  const today = todayLondon();
  const from = addDays(today, -7);
  const to = `${cap.shiftPeriod(today.slice(0, 7), 2)}-01`;

  const planned = decorate(blocksFor(personId, from, to))
    .filter((b) => b.status === 'pending' && b.start)
    .map((b) => ({
      uid: `ledger-block-${b.id}@emotio`,
      date: b.date,
      start: b.start,
      end: fromMinOfDayLocal(toMinOfDayLocal(b.start) + b.minutes),
      minutes: b.minutes,
      label: b.label,
      deliverable: `${b.deliverable_name || ''} · planned`,
      contract_name: b.contract_name || '',
      anchored: b.anchored,
    }));

  const logged = entriesFor(personId, from, to)
    .filter((e) => e.source !== 'skip')
    .map((e) => {
      const label = e.contract_name
        ? `${e.contract_name}${e.deliverable_name ? ` — ${e.deliverable_name}` : ''}`
        : (e.deliverable_name || 'Logged time');
      return {
        uid: `ledger-entry-${e.id}@emotio`,
        date: e.date,
        start: e.start,
        end: e.start ? fromMinOfDayLocal(toMinOfDayLocal(e.start) + e.minutes) : null,
        all_day: !e.start,
        minutes: e.minutes,
        label: `✓ ${label}`,
        deliverable: [e.note, 'logged'].filter(Boolean).join(' · '),
        contract_name: e.contract_name || '',
        anchored: 0,
      };
    });

  return [...logged, ...planned]
    .sort((a, b2) => (a.date === b2.date
      ? String(a.start || '99').localeCompare(String(b2.start || '99'))
      : a.date.localeCompare(b2.date)));
}
const fromMinOfDayLocal = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

module.exports = {
  dayView, weekView, mondayOf, addDays, todayLondon,
  addEntry, confirmBlock, confirmDay, skipBlock, updateEntry, deleteEntry, moveBlock,
  resizeBlock, rebalancePlan, applyRebalance,
  startTimer, stopTimer, cancelTimer, currentTimer,
  variance, loggedHours,
  calendarToken, personByToken, feedItems,
  _internal: { isDate, isTime, parseUtc, londonParts },
};
