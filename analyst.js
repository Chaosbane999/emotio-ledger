// ---------------------------------------------------------------------------
// The analyst — a chat box on Reports that answers questions about the team's
// time ("who is not keeping their time sheet up, and why?", "which clients
// will not get their hours this month?").
//
// It never sees the database. It is handed the same read-only tools the MCP
// server exposes, plus two digests built for exactly these questions, and it
// calls whichever it needs before it answers. Nothing here writes anything.
// Admin only — the tools carry rates and units.
// ---------------------------------------------------------------------------
const { db } = require('./db');
const cap = require('./capacity');
const ai = require('./ai');
const mcp = require('./mcp');

const r2 = (n) => Math.round(n * 100) / 100;
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const periodArg = (s) => {
  const p = s || cap.thisPeriod();
  if (!/^\d{4}-\d{2}$/.test(p)) throw new Error('period must be YYYY-MM');
  return p;
};

/**
 * How well each person is keeping their time sheet in a month, up to today:
 * hours logged against the hours they were around for, working days with
 * nothing on them, planned blocks never answered, and how late time goes in.
 */
function timekeepingHealth(a = {}) {
  const period = periodArg(a.period);
  const today = todayIso();
  const like = `${period}-%`;
  // today is still in progress — a day only counts as missed once it is over
  const elapsed = cap.workingDates(period).filter((d) => d < today);
  const people = db.prepare('SELECT * FROM people WHERE archived = 0 AND active = 1 ORDER BY name').all()
    .filter((p) => !a.person_id || p.id === Number(a.person_id));

  const rows = people.map((p) => {
    const pattern = cap.patternOf(p.id);
    const byDay = new Map(db.prepare(`SELECT date, SUM(minutes) m FROM time_entries
      WHERE person_id = ? AND date LIKE ? AND source != 'skip' GROUP BY date`).all(p.id, like)
      .map((r) => [r.date, r.m]));
    let expected = 0; let logged = 0; const empty = []; const thin = [];
    for (const d of elapsed) {
      const capMin = cap.capacityMinutes(p, d, pattern);
      if (capMin <= 0) continue;
      const got = byDay.get(d) || 0;
      expected += capMin; logged += got;
      if (!got) empty.push(d);
      else if (got < capMin * 0.5) thin.push(d);
    }
    const lv = db.prepare('SELECT annual_hours, sick_hours FROM leave WHERE person_id = ? AND period = ?')
      .get(p.id, period) || { annual_hours: 0, sick_hours: 0 };
    const pending = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(b.minutes), 0) m, MIN(b.date) oldest
      FROM schedule_blocks b WHERE b.person_id = ? AND b.date LIKE ? AND b.date < ? AND b.draft = 0
       AND NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.block_id = b.id)`).get(p.id, like, today);
    const skipped = db.prepare(`SELECT COUNT(*) n FROM time_entries
      WHERE person_id = ? AND date LIKE ? AND source = 'skip'`).get(p.id, like).n;
    // how long after the day itself the time was typed in
    const late = db.prepare(`SELECT COUNT(*) n,
        SUM(CASE WHEN julianday(date(created_at)) - julianday(date) >= 1 THEN 1 ELSE 0 END) next_day_or_later,
        SUM(CASE WHEN julianday(date(created_at)) - julianday(date) >= 3 THEN 1 ELSE 0 END) three_days_or_later,
        AVG(MAX(0, julianday(date(created_at)) - julianday(date))) avg_days
      FROM time_entries WHERE person_id = ? AND date LIKE ? AND source != 'skip'`).get(p.id, like);
    const last = db.prepare(`SELECT MAX(date) d FROM time_entries
      WHERE person_id = ? AND source != 'skip'`).get(p.id).d;
    const sources = Object.fromEntries(db.prepare(`SELECT source, COUNT(*) n FROM time_entries
      WHERE person_id = ? AND date LIKE ? AND source != 'skip' GROUP BY source`).all(p.id, like)
      .map((r) => [r.source, r.n]));
    return {
      person_id: p.id, name: p.name, department: p.department, weekly_hours: p.weekly_hours,
      working_days_elapsed: elapsed.filter((d) => cap.capacityMinutes(p, d, pattern) > 0).length,
      expected_hours_to_date: r2(expected / 60),
      logged_hours_to_date: r2(logged / 60),
      logged_pct_of_expected: expected ? Math.round((logged / expected) * 100) : null,
      leave_hours_this_month: r2((lv.annual_hours || 0) + (lv.sick_hours || 0)),
      days_with_nothing_logged: empty,
      days_under_half_logged: thin,
      planned_blocks_never_answered: pending.n, planned_hours_never_answered: r2(pending.m / 60),
      oldest_unanswered_block: pending.oldest || null,
      blocks_marked_skipped: skipped,
      entries: late.n,
      entries_logged_a_day_or_more_late: late.next_day_or_later || 0,
      entries_logged_three_or_more_days_late: late.three_days_or_later || 0,
      average_days_late: late.n ? r2(late.avg_days || 0) : null,
      entry_sources: sources,
      last_day_with_time_logged: last,
    };
  });
  return {
    period, as_of: today,
    notes: ['Leave is recorded as hours per month, not per day, so a day with nothing logged may be holiday or sickness — weigh days_with_nothing_logged against leave_hours_this_month before calling it a gap.',
      'expected_hours_to_date is the person\'s working pattern before leave. Today is excluded because it is still in progress.',
      'entry_sources: confirm = planned block accepted as planned, adjust = done but changed, timer = live timer, manual = typed in with no plan behind it.'],
    people: rows,
  };
}

/**
 * Which clients are at risk of not getting their allocated hours this month:
 * hours logged against the allocation and against where the month is, line by
 * line, and any retainer whose contracted units are not fully allocated.
 */
function contractsAtRisk(a = {}) {
  const period = periodArg(a.period);
  const today = todayIso();
  const days = cap.workingDates(period);
  const gone = days.filter((d) => d <= today).length;
  const monthPct = days.length ? gone / days.length : 0;
  const out = [];
  for (const c of db.prepare("SELECT * FROM contracts WHERE archived = 0 AND status = 'live' AND type != 'internal'").all()) {
    if (cap.runState(c, period) !== 'in') continue;
    const s = cap.contractSummary(c, period);
    if (!s.people_hours && !s.logged_hours && !s.contracted_units) continue;
    const expected = s.people_hours * monthPct;
    out.push({
      contract_id: c.id, name: c.name, type: c.type, department: c.department,
      allocated_hours: s.people_hours, logged_hours: s.logged_hours,
      remaining_hours: r2(s.people_hours - s.logged_hours),
      logged_pct_of_allocation: s.people_hours ? Math.round((s.logged_hours / s.people_hours) * 100) : null,
      expected_hours_by_now: r2(expected),
      behind_pace_hours: r2(expected - s.logged_hours),
      contracted_units: s.contracted_units, allocated_units: s.allocated_units,
      unallocated_units: c.type === 'retainer' ? r2(Math.max(0, s.variance)) : null,
      over_allocated_units: c.type === 'retainer' ? r2(Math.max(0, -s.variance)) : null,
      ends_on: c.ends_on || null,
      lines: s.lines.map((l) => ({ person: l.person_name, task: l.deliverable_name,
        allocated_hours: l.hours, logged_hours: l.logged_hours || 0 })),
    });
  }
  out.sort((x, y) => y.behind_pace_hours - x.behind_pace_hours);
  return {
    period, as_of: today, working_days_total: days.length, working_days_gone: gone,
    month_elapsed_pct: Math.round(monthPct * 100),
    notes: ['behind_pace_hours = allocation × share of the month gone − hours logged. Positive means delivery is behind where the month is; negative means ahead.',
      'A past month has month_elapsed_pct 100, so behind_pace_hours is simply the hours that were never delivered.',
      'unallocated_units: contract value nobody has been given hours for yet (1 unit = £100 of contract value).'],
    contracts: out,
  };
}

const extraTools = [
  { name: 'timekeeping_health',
    description: 'START HERE for questions about who is or is not keeping their time sheet properly. Per person for one month up to today: expected vs logged hours, working days with nothing logged, planned blocks never answered, how late time is entered, and how it was entered.',
    inputSchema: { type: 'object', properties: {
      period: { type: 'string', description: 'YYYY-MM, defaults to the current month' },
      person_id: { type: 'number' } } } },
  { name: 'contracts_at_risk',
    description: 'START HERE for questions about clients at risk of not getting their time. Per live client contract for one month: allocated vs logged hours, how far behind the pace of the month, line by line per person and task, and contract value not yet allocated to anyone.',
    inputSchema: { type: 'object', properties: {
      period: { type: 'string', description: 'YYYY-MM, defaults to the current month' } } } },
];
const impl = { ...mcp.impl, timekeeping_health: timekeepingHealth, contracts_at_risk: contractsAtRisk };
// Responses API tool shape (flat, not nested under "function")
const toolDefs = [...extraTools, ...mcp.tools].map((t) => ({
  type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false,
}));

const MAX_TOOL_CHARS = 60000;
function runTool(name, argText) {
  const fn = impl[name];
  if (!fn) return `Error: unknown tool ${name}`;
  try {
    const text = JSON.stringify(fn(argText ? JSON.parse(argText) : {}));
    return text.length > MAX_TOOL_CHARS
      ? `${text.slice(0, MAX_TOOL_CHARS)}\n…[truncated — narrow the request with a person, contract or shorter range]`
      : text;
  } catch (e) { return `Error: ${e.message}`; }
}

const system = () => `You are the studio manager and agency analyst for Emotio, a marketing and design agency.
You answer the managing director's questions about how the team is managing its time, using
EmotioHours — the agency's capacity and time-tracking system — through the tools provided.

Today is ${todayIso()} (Europe/London). The current month is ${cap.thisPeriod()}. Unless the question
names another period, answer for the current month to date; for "last month" and the like, pass that period.

How to work:
- Always get the facts from the tools before answering. Never guess or invent a number, a name or a reason.
  Start with timekeeping_health for questions about people's time keeping and contracts_at_risk for
  questions about clients; go deeper with the other tools (time_variance, week_view, person_month,
  contract_time_report, time_report) when you need to explain WHY.
- Be direct and specific, as a good studio manager would be: name the people and the clients, give the
  hours and dates, and say what the evidence is. Lead with the answer, then the evidence, then what you
  would do about it.
- Separate what the data shows from what you infer. If the data cannot tell you why (for example a day
  with nothing logged might be holiday — leave is only recorded as monthly hours), say so rather than accuse.
- Be fair: compare like with like (part-timers against their own hours), and mention who is doing well when it is relevant.
- Hours as "12.5 h", dates as dd/mm/yyyy, British English. 1 unit = £100 of contract value.
- Format for a narrow chat panel: short paragraphs, "## " headings, "- " bullets and **bold** only.
  No tables, no code blocks. Keep it tight — a report someone reads in a minute, unless asked for detail.
- You can read but not change anything. If asked to change something, say where in EmotioHours to do it.`;

async function openai(path, body) {
  const key = ai.apiKey();
  if (!key) throw new Error('Add an OpenAI API key in Settings first.');
  const res = await fetch(`https://api.openai.com/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message
      ? `OpenAI: ${String(data.error.message).slice(0, 300)}` : `OpenAI returned ${res.status}.`);
  }
  return data;
}

/**
 * One turn of the conversation. messages: [{role: 'user'|'assistant', content}]
 * — the browser keeps the thread and sends it each time; nothing is stored here.
 *
 * Uses OpenAI's Responses API: the newer models refuse function tools on the
 * older chat-completions route. Nothing is stored at OpenAI either — the
 * model's working between tool calls is passed back to it each round
 * (encrypted) rather than kept on their side. A model that will not work that
 * way gets one retry with OpenAI holding the turn instead.
 */
async function ask(messages) {
  const thread = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!thread.length || thread[thread.length - 1].role !== 'user') throw new Error('Ask a question first.');

  const run = async (stateless) => {
    const input = [...thread];
    const used = [];
    for (let round = 0; round < 8; round++) {
      const data = await openai('responses', {
        model: ai.model(), instructions: system(), input, tools: toolDefs,
        // the last round must answer with what it has
        tool_choice: round === 7 ? 'none' : 'auto',
        ...(stateless ? { store: false, include: ['reasoning.encrypted_content'] } : {}),
      });
      const out = Array.isArray(data.output) ? data.output : [];
      const calls = out.filter((o) => o.type === 'function_call');
      if (!calls.length) {
        const parts = out.filter((o) => o.type === 'message').flatMap((o) => o.content || []);
        const refusal = parts.find((c) => c.type === 'refusal');
        if (refusal) throw new Error(String(refusal.refusal).slice(0, 300));
        const answer = parts.filter((c) => c.type === 'output_text').map((c) => c.text).join('\n').trim();
        if (!answer) throw new Error('The analyst came back with nothing — try asking again.');
        return { answer, looked_at: [...new Set(used)], model: ai.model() };
      }
      // hand back everything it produced (its reasoning and its calls), then the results
      input.push(...out);
      for (const call of calls) {
        used.push(call.name);
        input.push({ type: 'function_call_output', call_id: call.call_id, output: runTool(call.name, call.arguments) });
      }
    }
    throw new Error('The analyst could not finish — try a narrower question.');
  };

  try { return await run(true); }
  catch (e) {
    if (/encrypted_content|include|store/i.test(e.message)) return run(false);
    throw e;
  }
}

/**
 * The chat models this key can use, straight from OpenAI so the list is never
 * out of date. Everything that is not a text chat model is left out.
 */
async function listModels() {
  const current = ai.model();
  if (!ai.configured()) return { current, models: [current], live: false };
  try {
    const data = await openai('models');
    const skip = /audio|realtime|tts|transcribe|whisper|image|embedding|moderation|search|instruct|codex|computer-use|dall-e|sora|babbage|davinci|deep-research|-\d{4}-\d{2}-\d{2}$|-\d{4}$/;
    const ids = (data.data || []).map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !skip.test(id))
      .sort((x, y) => y.localeCompare(x, 'en', { numeric: true }));
    if (!ids.includes(current)) ids.unshift(current);
    return { current, models: ids, live: true };
  } catch (e) {
    return { current, models: [current], live: false, error: e.message };
  }
}

module.exports = { ask, listModels, timekeepingHealth, contractsAtRisk };
