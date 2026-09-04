const { db, get, set } = require('./db');
const cap = require('./capacity');

// ---------------------------------------------------------------------------
// Slack working-pattern sync.
//
// The working pattern already says when each person is at work; this module
// makes Slack say it too. During the AGENCY working window — and only then —
// anyone whose own pattern says they are off gets a "Not working" status with
// an expiry, so Slack clears it by itself. Evenings, weekends and bank
// holidays get nothing: Slack presence already covers the times everyone is
// away, and a status that fires every night for every person is noise.
//
// The token is a Slack USER token (xoxp-) from a private app installed by a
// workspace owner/admin, with users.profile:read + users.profile:write user
// scopes. Setting someone ELSE's status needs a paid workspace and an
// admin-owned token — Slack's rule, not ours.
// ---------------------------------------------------------------------------

const TZ = 'Europe/London';

const token = () => (process.env.SLACK_TOKEN || get('slack_token') || '').trim();
const configured = () => Boolean(token());
const enabled = () => configured() && get('slack_enabled') === '1';

/** London wall-clock now: { iso: 'YYYY-MM-DD', dow: 1-7 (Mon-Sun), min }. */
function londonNow(when = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(when).map((p) => [p.type, p.value]));
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return {
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    dow,
    min: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * Is this pattern off right now, inside the agency window? Returns the
 * minute-of-day the off spell ends (for the status expiry), or null when no
 * status is wanted: they are working, it is outside agency hours, or they
 * follow the standard week and are therefore never off when the agency is on.
 */
function offUntil(pattern, now, agencyStart, agencyEnd) {
  if (!pattern) return null;
  if (now.min < agencyStart || now.min >= agencyEnd) return null;
  const day = pattern.get(now.dow);
  if (!day) return agencyEnd;                       // whole day off
  const s = cap.toMinutes(day.start), e = cap.toMinutes(day.end);
  if (now.min < s) return Math.min(s, agencyEnd);   // not started yet
  if (now.min >= e) return agencyEnd;               // finished for the day
  return null;                                      // at work
}

// ---------------------------------------------------------------------------
// Slack calls. Form-encoded throughout — every Web API method accepts it,
// including the ones that are fussy about JSON. Only three methods exist here
// on purpose; the token can do more, this code must not.
// ---------------------------------------------------------------------------

async function slackCall(method, params = {}) {
  const allowed = ['auth.test', 'users.profile.get', 'users.profile.set'];
  if (!allowed.includes(method)) return { ok: false, error: 'method_not_allowed' };
  const t = token();
  if (!t) return { ok: false, error: 'not_configured' };
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${t}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, error: 'request_failed' };
  }
}

// ---------------------------------------------------------------------------
// A short activity log the Settings page can show. Capped; never a token.
// ---------------------------------------------------------------------------

function log(level, message) {
  let entries = [];
  try { entries = JSON.parse(get('slack_log') || '[]'); } catch (e) { /* start fresh */ }
  entries.unshift({ time: new Date().toISOString(), level, message: String(message).slice(0, 300) });
  set('slack_log', JSON.stringify(entries.slice(0, 50)));
}

const recentLog = () => {
  try { return JSON.parse(get('slack_log') || '[]'); } catch (e) { return []; }
};

// ---------------------------------------------------------------------------

async function test() {
  if (!configured()) return { ok: false, error: 'Add a Slack token first.' };
  const r = await slackCall('auth.test');
  if (!r.ok) {
    log('error', `Connection test failed: ${r.error || 'unknown'}`);
    return { ok: false, error: `Slack rejected the token (${r.error || 'unknown'}).` };
  }
  log('info', `Connection test OK — workspace ${r.team || '?'}, signed in as ${r.user || '?'}.`);
  return { ok: true, team: r.team, user: r.user };
}

/**
 * One sync pass. Applies "Not working" to everyone whose pattern says they
 * are off right now, with an expiry so Slack clears it unaided. Applied at
 * most once per person per off spell (the settings map remembers), and never
 * over someone's existing status unless the override setting says to.
 */
async function tick(force = false) {
  if (!enabled() && !force) return { skipped: 'disabled' };
  if (!configured()) return { skipped: 'no token' };

  const now = londonNow();
  if (now.dow >= 6) return { skipped: 'weekend' };
  const holidays = (get('holidays') || '').split(',').map((s) => s.trim());
  if (holidays.includes(now.iso)) return { skipped: 'bank holiday' };

  const agencyStart = cap.toMinutes(get('work_start') || '09:00');
  const agencyEnd = cap.toMinutes(get('work_end') || '17:30');
  const override = get('slack_override') === '1';
  const statusText = get('slack_status_text') || 'Not working';
  const statusEmoji = get('slack_status_emoji') || ':no_entry_sign:';

  let applied = {};
  try { applied = JSON.parse(get('slack_applied') || '{}'); } catch (e) { /* fresh */ }

  const people = db.prepare(
    "SELECT id, name, slack_user_id FROM people WHERE active = 1 AND archived = 0 AND slack_user_id != ''").all();

  const result = { applied: 0, skipped: 0, checked: people.length };
  for (const person of people) {
    const until = offUntil(cap.patternOf(person.id), now, agencyStart, agencyEnd);
    if (until === null) continue;

    const key = `${now.iso}:${until}`;
    if (applied[person.id] === key) { result.skipped++; continue; }

    if (!override) {
      const prof = await slackCall('users.profile.get', { user: person.slack_user_id });
      if (!prof.ok) {
        log('warning', `${person.name}: could not read their status (${prof.error || 'unknown'}); left alone.`);
        result.skipped++;
        continue;
      }
      const p = prof.profile || {};
      const ours = p.status_text === statusText;
      if ((p.status_text || p.status_emoji) && !ours) {
        log('info', `${person.name}: already has a status; left alone.`);
        applied[person.id] = key;      // do not re-read every five minutes
        result.skipped++;
        continue;
      }
    }

    const expiry = Math.floor(Date.now() / 1000) + (until - now.min) * 60;
    const r = await slackCall('users.profile.set', {
      user: person.slack_user_id,
      profile: JSON.stringify({
        status_text: statusText,
        status_emoji: statusEmoji,
        status_expiration: expiry,
      }),
    });
    if (r.ok) {
      applied[person.id] = key;
      const hh = String(Math.floor(until / 60)).padStart(2, '0');
      const mm = String(until % 60).padStart(2, '0');
      log('info', `${person.name}: status set until ${hh}:${mm}.`);
      result.applied++;
    } else {
      log('error', `${person.name}: Slack refused the update (${r.error || 'unknown'}).`);
      result.skipped++;
    }
  }
  set('slack_applied', JSON.stringify(applied));
  return result;
}

module.exports = { configured, enabled, test, tick, recentLog, _internal: { offUntil, londonNow } };
