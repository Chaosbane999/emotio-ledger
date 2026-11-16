// Calendar import: each person can link their own published calendar (an
// Outlook "publish calendar" ICS link, or any ICS feed from a known calendar
// host). Meetings arrive on their time sheet as SUGGESTIONS — nothing is
// logged until the person confirms the client and task. The link is a secret
// that reads someone's diary: it is stored per person, never sent back to the
// browser, and only ever fetched from an allow-listed calendar host.
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS calendar_links (
  person_id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  last_sync TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  date TEXT NOT NULL,
  start TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | logged | dismissed
  entry_id INTEGER,
  UNIQUE (person_id, uid, date, start)
);
CREATE INDEX IF NOT EXISTS calendar_events_person_date ON calendar_events (person_id, date);
-- titles a person never wants offered (a daily huddle already covered by a
-- fixed commitment, say)
CREATE TABLE IF NOT EXISTS calendar_ignores (
  person_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (person_id, title)
);
`);

const ALLOWED_HOSTS = [
  /^outlook\.office365\.com$/, /^outlook\.office\.com$/, /^outlook\.live\.com$/,
  /^calendar\.google\.com$/, /^p\d+-caldav\.icloud\.com$/,
];
const BACK_DAYS = 21;      // how far back meetings are offered for logging
const AHEAD_DAYS = 14;     // and how far ahead they are shown
const MAX_BYTES = 8 * 1024 * 1024;

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://')); }
  catch (e) { throw new Error('That does not look like a calendar link.'); }
  if (u.protocol !== 'https:') throw new Error('The calendar link must start with https://');
  if (!ALLOWED_HOSTS.some((re) => re.test(u.hostname))) {
    throw new Error('Only Outlook / Microsoft 365, Google and iCloud calendar links are accepted.');
  }
  return u.toString();
}

// ---------------------------------------------------------------------------
// ICS parsing. Wall-clock times are kept as "naive" UTC dates (the clock
// reading, no zone) so recurrences repeat at the same clock time across a
// clock change, then each occurrence is converted to London time.
// ---------------------------------------------------------------------------

const WINDOWS_TZ = {
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', UTC: 'UTC',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev', 'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai', 'India Standard Time': 'Asia/Kolkata',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
};
const zoneOk = new Map();
function zoneOf(tzid) {
  if (!tzid) return 'Europe/London';
  const z = WINDOWS_TZ[tzid] || tzid;
  if (!zoneOk.has(z)) {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); zoneOk.set(z, true); }
    catch (e) { zoneOk.set(z, false); }
  }
  return zoneOk.get(z) ? z : 'Europe/London';
}

const fmtCache = new Map();
function offsetMin(utcMs, tz) {
  if (tz === 'UTC') return 0;
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  }
  const p = fmtCache.get(tz).formatToParts(new Date(utcMs));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(utcMs / 60000) * 60000) / 60000;
}
/** A clock reading in `tz` -> the same instant as a London clock reading. */
function toLondon(naiveMs, tz) {
  let utc = naiveMs - offsetMin(naiveMs, tz) * 60000;
  utc = naiveMs - offsetMin(utc, tz) * 60000;
  return utc + offsetMin(utc, 'Europe/London') * 60000;
}

function parseDt(value, params) {
  const m = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  if (m[4] === undefined) return { allDay: true, ms: Date.UTC(+m[1], +m[2] - 1, +m[3]) };
  return { allDay: false, ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]),
    tz: m[7] ? 'UTC' : zoneOf(params.TZID) };
}
function parseDuration(v) {
  const m = String(v || '').match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (+m[1] || 0) * 10080 + (+m[2] || 0) * 1440 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
const unescape = (s) => String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function parseIcs(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...ps] = line.slice(0, i).split(';');
    const value = line.slice(i + 1);
    const params = Object.fromEntries(ps.map((p) => {
      const j = p.indexOf('='); return [p.slice(0, j).toUpperCase(), p.slice(j + 1).replace(/^"|"$/g, '')];
    }));
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.title = unescape(value); break;
      case 'DTSTART': cur.start = parseDt(value, params); break;
      case 'DTEND': cur.end = parseDt(value, params); break;
      case 'DURATION': cur.duration = parseDuration(value); break;
      case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map((kv) => kv.split('='))); break;
      case 'EXDATE': for (const v of value.split(',')) { const d = parseDt(v, params); if (d) cur.exdates.push(d.ms); } break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDt(value, params); break;
      case 'STATUS': cur.status = value.toUpperCase(); break;
      case 'TRANSP': cur.transp = value.toUpperCase(); break;
      case 'CLASS': cur.klass = value.toUpperCase(); break;
      case 'X-MICROSOFT-CDO-BUSYSTATUS': cur.busy = value.toUpperCase(); break;
      default:
    }
  }
  return events;
}

const DAY = 86400000;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Occurrence start times (naive ms) of one event inside [lo, hi]. */
function occurrences(ev, lo, hi) {
  const s = ev.start.ms;
  if (!ev.rrule) return s >= lo && s <= hi ? [s] : [];
  const r = ev.rrule;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? (parseDt(r.UNTIL, {})?.ms ?? Infinity) : Infinity;
  const untilDay = until === Infinity ? Infinity : Math.floor(until / DAY) * DAY + DAY - 1;
  const tod = s % DAY;                                   // clock time of day
  const sd = new Date(s);
  const byday = (r.BYDAY || '').split(',').filter(Boolean).map((t) => {
    const m = t.match(/^([+-]?\d+)?([A-Z]{2})$/); return m ? { n: m[1] ? Number(m[1]) : 0, d: WD.indexOf(m[2]) } : null;
  }).filter(Boolean);
  const bymd = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const setpos = (r.BYSETPOS || '').split(',').filter(Boolean).map(Number);
  const out = []; let made = 0; let guard = 0;
  const emit = (dayMs) => {
    const t = dayMs + tod;
    if (t < s) return true;
    if (t > untilDay || made >= count) return false;
    made += 1;
    if (t >= lo && t <= hi) out.push(t);
    return t <= hi;
  };
  const monthDays = (y, m) => {
    const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let days = [];
    if (byday.length) {
      for (const b of byday) {
        const all = [];
        for (let d = 1; d <= n; d += 1) if (new Date(Date.UTC(y, m, d)).getUTCDay() === b.d) all.push(d);
        if (b.n > 0) { if (all[b.n - 1]) days.push(all[b.n - 1]); }
        else if (b.n < 0) { if (all[all.length + b.n]) days.push(all[all.length + b.n]); }
        else days.push(...all);
      }
    } else if (bymd.length) {
      days = bymd.map((d) => (d < 0 ? n + 1 + d : d)).filter((d) => d >= 1 && d <= n);
    } else if (sd.getUTCDate() <= n) days = [sd.getUTCDate()];
    days = [...new Set(days)].sort((a, b) => a - b);
    if (setpos.length) days = setpos.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter(Boolean).sort((a, b) => a - b);
    return days.map((d) => Date.UTC(y, m, d));
  };
  const freq = r.FREQ;
  if (freq === 'DAILY') {
    const startDay = s - tod;
    for (let d = startDay; guard < 6000; d += interval * DAY, guard += 1) {
      if (byday.length && !byday.some((b) => b.d === new Date(d).getUTCDay())) continue;
      if (!emit(d)) break;
    }
  } else if (freq === 'WEEKLY') {
    const days = byday.length ? byday.map((b) => b.d) : [sd.getUTCDay()];
    const monday = s - tod - ((sd.getUTCDay() + 6) % 7) * DAY;
    let go = true;
    for (let w = monday; go && guard < 3000; w += interval * 7 * DAY, guard += 1) {
      for (const d of days.map((x) => w + ((x + 6) % 7) * DAY).sort((a, b) => a - b)) {
        if (!emit(d)) { go = false; break; }
      }
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const step = freq === 'YEARLY' ? 12 * interval : interval;
    let go = true;
    for (let i = 0; go && guard < 1200; i += step, guard += 1) {
      const y = sd.getUTCFullYear() + Math.floor((sd.getUTCMonth() + i) / 12);
      const m = (sd.getUTCMonth() + i) % 12;
      for (const d of monthDays(y, m)) if (!emit(d)) { go = false; break; }
    }
  } else if (s >= lo && s <= hi) out.push(s);
  const ex = new Set(ev.exdates.map(dayKey));
  return out.filter((t) => !ex.has(dayKey(t)));
}

/** Every timed, busy meeting in the window, as London date / start / minutes. */
function meetingsFrom(text, todayIso) {
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  const lo = today - (BACK_DAYS + 1) * DAY; const hi = today + (AHEAD_DAYS + 2) * DAY;
  const all = parseIcs(text).filter((e) => e.uid && e.start && !e.start.allDay);
  // a changed single instance replaces the series' occurrence on that day
  const overridden = new Map();
  for (const e of all) {
    if (!e.recurrenceId) continue;
    if (!overridden.has(e.uid)) overridden.set(e.uid, new Set());
    overridden.get(e.uid).add(dayKey(e.recurrenceId.ms));
  }
  const out = new Map();
  for (const e of all) {
    if (e.status === 'CANCELLED' || e.transp === 'TRANSPARENT' || e.klass === 'PRIVATE'
      || e.klass === 'CONFIDENTIAL' || e.busy === 'FREE') continue;
    const mins = e.end && !e.end.allDay ? Math.round((e.end.ms - e.start.ms) / 60000) : (e.duration || 30);
    if (mins < 5 || mins > 12 * 60) continue;
    const starts = e.recurrenceId ? (e.start.ms >= lo && e.start.ms <= hi ? [e.start.ms] : [])
      : occurrences(e, lo, hi).filter((t) => !overridden.get(e.uid)?.has(dayKey(t)));
    for (const t of starts) {
      const l = new Date(toLondon(t, e.start.tz)).toISOString();
      const date = l.slice(0, 10); const start = l.slice(11, 16);
      if (date < dayKey(today - BACK_DAYS * DAY) || date > dayKey(today + AHEAD_DAYS * DAY)) continue;
      out.set(`${e.uid}|${date}|${start}`, { uid: e.uid, date, start, minutes: mins,
        title: (e.title || 'Meeting').slice(0, 200) });
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function fetchIcs(url) {
  let next = url;
  for (let hop = 0; hop < 4; hop += 1) {
    next = checkUrl(next);                         // every hop stays on the allow-list
    const res = await fetch(next, { redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'EmotioHours calendar import' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      next = new URL(res.headers.get('location'), next).toString(); continue;
    }
    if (!res.ok) throw new Error(`The calendar link answered ${res.status} — check it is still published.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('That calendar is too large to import.');
    const text = buf.toString('utf8');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That link did not return a calendar.');
    return text;
  }
  throw new Error('The calendar link redirected too many times.');
}

const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

function store(personId, meetings, today) {
  const keep = new Set();
  const ins = db.prepare(`INSERT INTO calendar_events (person_id, uid, date, start, minutes, title)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (person_id, uid, date, start) DO UPDATE SET minutes = excluded.minutes, title = excluded.title`);
  for (const m of meetings) {
    ins.run(personId, m.uid, m.date, m.start, m.minutes, m.title);
    keep.add(`${m.uid}|${m.date}|${m.start}`);
  }
  // a pending suggestion whose meeting has gone from the calendar (cancelled,
  // moved) goes too; anything already answered is history and stays
  const lo = new Date(Date.parse(`${today}T00:00:00Z`) - BACK_DAYS * DAY).toISOString().slice(0, 10);
  for (const r of db.prepare(`SELECT id, uid, date, start FROM calendar_events
      WHERE person_id = ? AND status = 'pending'`).all(personId)) {
    if (r.date < lo || !keep.has(`${r.uid}|${r.date}|${r.start}`)) {
      db.prepare('DELETE FROM calendar_events WHERE id = ?').run(r.id);
    }
  }
}

async function sync(personId) {
  const link = db.prepare('SELECT * FROM calendar_links WHERE person_id = ?').get(personId);
  if (!link) throw new Error('No calendar is connected.');
  const today = londonToday();
  try {
    const meetings = meetingsFrom(await fetchIcs(link.url), today);
    store(personId, meetings, today);
    db.prepare("UPDATE calendar_links SET last_sync = datetime('now'), last_error = '' WHERE person_id = ?").run(personId);
    return { meetings: meetings.length };
  } catch (e) {
    db.prepare('UPDATE calendar_links SET last_error = ? WHERE person_id = ?').run(String(e.message).slice(0, 300), personId);
    throw e;
  }
}

async function syncAll() {
  for (const l of db.prepare('SELECT person_id FROM calendar_links').all()) {
    try { await sync(l.person_id); } catch (e) { /* recorded on the link */ }
  }
}

function status(personId) {
  const l = db.prepare('SELECT last_sync, last_error FROM calendar_links WHERE person_id = ?').get(personId);
  // the link itself is never sent back — it reads the person's whole diary
  return l ? { connected: true, last_sync: l.last_sync, last_error: l.last_error, ignored: ignoredTitles(personId) } : { connected: false };
}

async function connect(personId, url) {
  const clean = checkUrl(url);
  // prove it is a calendar before saving it
  const meetings = meetingsFrom(await fetchIcs(clean), londonToday());
  db.prepare(`INSERT INTO calendar_links (person_id, url, last_sync) VALUES (?, ?, datetime('now'))
    ON CONFLICT (person_id) DO UPDATE SET url = excluded.url, last_sync = excluded.last_sync, last_error = ''`)
    .run(personId, clean);
  store(personId, meetings, londonToday());
  return { ...status(personId), meetings: meetings.length };
}

function disconnect(personId) {
  db.prepare('DELETE FROM calendar_links WHERE person_id = ?').run(personId);
  db.prepare("DELETE FROM calendar_events WHERE person_id = ? AND status = 'pending'").run(personId);
  return status(personId);
}

// ---------------------------------------------------------------------------
// Suggestions on the time sheet
// ---------------------------------------------------------------------------

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The contract a meeting title most plausibly belongs to, from `contracts`. */
function guessContract(title, contracts) {
  const t = ` ${norm(title)} `;
  let best = null;
  for (const c of contracts) {
    const name = norm(c.name);
    if (!name) continue;
    // the whole name, else its first word when that word is distinctive
    const first = name.split(' ')[0];
    const firstIsUnique = first.length >= 4
      && contracts.filter((o) => norm(o.name).split(' ')[0] === first).length === 1;
    const score = t.includes(` ${name} `) ? 100 + name.length
      : firstIsUnique && t.includes(` ${first} `) ? first.length : 0;
    if (score && (!best || score > best.score)) best = { id: c.id, score };
  }
  return best ? best.id : null;
}

/**
 * Pending meetings in a date range, each with a suggested contract. One that
 * is already represented — a logged entry or a fixed commitment covering at
 * least half of it — is left out: it would only be logged twice.
 */
function meetingsFor(personId, from, to, assignments) {
  const rows = db.prepare(`SELECT id, date, start, minutes, title FROM calendar_events
    WHERE person_id = ? AND date >= ? AND date <= ? AND status = 'pending'
    ORDER BY date, start`).all(personId, from, to);
  if (!rows.length) return [];
  const ignored = new Set(db.prepare('SELECT title FROM calendar_ignores WHERE person_id = ?')
    .all(personId).map((r) => r.title));
  const taken = [
    ...db.prepare(`SELECT date, start, minutes FROM time_entries
      WHERE person_id = ? AND date >= ? AND date <= ? AND start IS NOT NULL AND source != 'skip'`).all(personId, from, to),
    ...db.prepare(`SELECT date, start, minutes FROM schedule_blocks
      WHERE person_id = ? AND date >= ? AND date <= ? AND anchored = 1 AND draft = 0 AND start IS NOT NULL`).all(personId, from, to),
  ];
  const contracts = (assignments || []).map((a) => ({ id: a.contract_id, name: a.name }));
  return rows.filter((m) => {
    if (ignored.has(norm(m.title))) return false;
    const s = toMin(m.start); const e = s + m.minutes;
    return !taken.some((x) => {
      if (x.date !== m.date) return false;
      const xs = toMin(x.start);
      return Math.min(e, xs + x.minutes) - Math.max(s, xs) >= m.minutes / 2;
    });
  }).map((m) => ({ ...m, suggested_contract_id: guessContract(m.title, contracts) }));
}

function getMeeting(personId, id) {
  const m = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(Number(id));
  if (!m || m.person_id !== personId) throw new Error('no such meeting');
  return m;
}

function dismiss(personId, id) {
  const m = getMeeting(personId, id);
  db.prepare("UPDATE calendar_events SET status = 'dismissed' WHERE id = ?").run(m.id);
  return { dismissed: m.id };
}

/** Never offer meetings with this one's title again (and hide those waiting). */
function ignoreTitle(personId, id) {
  const m = getMeeting(personId, id);
  db.prepare('INSERT OR IGNORE INTO calendar_ignores (person_id, title) VALUES (?, ?)').run(personId, norm(m.title));
  return { ignored: m.title };
}
const ignoredTitles = (personId) =>
  db.prepare('SELECT title FROM calendar_ignores WHERE person_id = ? ORDER BY title').all(personId).map((r) => r.title);
function unignoreTitle(personId, title) {
  db.prepare('DELETE FROM calendar_ignores WHERE person_id = ? AND title = ?').run(personId, String(title || ''));
  return { ignored: ignoredTitles(personId) };
}
/** How far back meetings are kept for confirming. */
const lookbackFrom = () => new Date(Date.parse(`${londonToday()}T00:00:00Z`) - BACK_DAYS * DAY).toISOString().slice(0, 10);

/** Called once the time entry exists. */
function markLogged(personId, id, entryId) {
  const m = getMeeting(personId, id);
  db.prepare("UPDATE calendar_events SET status = 'logged', entry_id = ? WHERE id = ?").run(entryId, m.id);
}

module.exports = {
  connect, disconnect, sync, syncAll, status, meetingsFor, getMeeting, dismiss, markLogged,
  ignoreTitle, unignoreTitle, lookbackFrom, londonToday,
  _internal: { parseIcs, occurrences, meetingsFrom, toLondon, guessContract, checkUrl },
};
