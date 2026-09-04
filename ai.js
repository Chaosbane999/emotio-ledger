const { db, get } = require('./db');
const T = require('./time');

// ---------------------------------------------------------------------------
// "Describe your day" — free text in, a drafted timesheet out.
//
// The model sees the person's plan for the day, what is already logged, and
// the contracts + deliverables they can log against, then turns a plain
// description ("morning on Crystal SEO, hour of ads for NLG after lunch")
// into proposed entries with best-guess times. Nothing is written here: the
// proposal goes back to the person, who unticks what is wrong and commits
// the rest through the ordinary entry route. The model proposes; the person
// logs.
// ---------------------------------------------------------------------------

const apiKey = () => (process.env.OPENAI_API_KEY || get('openai_api_key') || '').trim();
const configured = () => Boolean(apiKey());
const model = () => get('openai_model') || 'gpt-5.1';

// strict JSON schema: the reply comes back schema-valid, so parsing is a formality
const LOG_DAY_SCHEMA = {
  name: 'log_day',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['entries'],
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['block_id', 'contract_id', 'deliverable_id', 'start', 'minutes', 'note'],
          properties: {
            block_id: { type: ['integer', 'null'], description: 'id of the planned block this work corresponds to, or null for unplanned work' },
            contract_id: { type: 'integer' },
            deliverable_id: { type: 'integer' },
            start: { type: 'string', description: 'HH:MM, 24h' },
            minutes: { type: 'integer', description: 'a multiple of 15' },
            note: { type: 'string', description: 'short paraphrase of what was done, in the person’s words' },
          },
        },
      },
    },
  },
};

const SYSTEM = `You turn a person's plain-English description of their working day into
timesheet entries for a marketing agency's time system. Answer with the log_day JSON.

Rules:
- Only use contract_id + deliverable_id pairs from the assignments list. Internal work
  (training, management, internal projects) is in that list too.
- If a piece of described work clearly corresponds to a PENDING planned block, set its
  block_id and use that block's contract_id and deliverable_id; borrow the block's start
  and length unless the person said otherwise.
- Minutes are multiples of 15, minimum 15. Best-guess start times inside the working
  window; "morning" means from the window start, "after lunch" means from the lunch end.
  Do not overlap the entries you propose with each other or with already-logged entries.
- Cover what was described and nothing more. If a duration is not stated, infer a
  sensible one from context and the planned block sizes.
- Notes are short, first-person-neutral paraphrases ("Crystal Units on-page fixes"),
  never inventions.`;

/** The pieces of the day the model needs, and that validation reuses. */
function dayContext(personId, date) {
  const person = db.prepare('SELECT id, name FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error('no such person');
  const v = T.dayView(personId, date);
  return {
    person,
    view: v,
    working_window: { start: get('work_start') || '09:00', end: get('work_end') || '17:30',
      lunch_start: get('lunch_start') || '13:00', lunch_minutes: Number(get('lunch_minutes') || 30) },
  };
}

/**
 * Ask the model for a draft, then validate every proposed line against the
 * real day: ids must exist, pending blocks must be this person's and still
 * pending, times must be sane. Anything that fails is dropped with a reason
 * rather than silently kept — the person sees exactly what will be logged.
 */
async function draftDay(personId, date, text) {
  if (!configured()) throw new Error('Add an OpenAI API key in Settings first.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
  text = String(text || '').trim().slice(0, 4000);
  if (!text) throw new Error('Describe the day first.');

  const ctx = dayContext(personId, date);
  const pendingBlocks = ctx.view.blocks.filter((b) => b.status === 'pending')
    .map((b) => ({ block_id: b.id, start: b.start, minutes: b.minutes, label: b.label,
      contract_id: b.contract_id, deliverable_id: b.deliverable_id }));
  const logged = ctx.view.entries.filter((e) => e.source !== 'skip')
    .map((e) => ({ start: e.start, minutes: e.minutes, contract: e.contract_name, deliverable: e.deliverable_name }));
  const assignments = ctx.view.assignments.map((a) => ({
    contract_id: a.contract_id, contract: a.name,
    deliverables: a.deliverables.map((d) => ({ deliverable_id: d.id, name: d.name })),
  }));

  const userMessage = `Date: ${date}\n`
    + `Working window: ${JSON.stringify(ctx.working_window)}\n`
    + `Assignments (the only valid contract/deliverable pairs):\n${JSON.stringify(assignments)}\n`
    + `Planned blocks still pending today:\n${JSON.stringify(pendingBlocks)}\n`
    + `Already logged today (do not duplicate or overlap):\n${JSON.stringify(logged)}\n\n`
    + `${ctx.person.name} describes the day:\n"""${text}"""\n\n`
    + 'Propose the entries as log_day JSON.';

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model(),
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_schema', json_schema: LOG_DAY_SCHEMA },
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message
      ? `OpenAI: ${String(data.error.message).slice(0, 200)}`
      : `OpenAI returned ${res.status}.`);
  }
  const msg = data.choices?.[0]?.message || {};
  if (msg.refusal) throw new Error(String(msg.refusal).slice(0, 300));
  let call;
  try { call = { input: JSON.parse(msg.content) }; }
  catch (e) { throw new Error('The assistant returned no usable entries — try rephrasing.'); }

  const valid = [];
  const dropped = [];
  const pairOk = (cid, did) => ctx.view.assignments.some((a) => a.contract_id === cid
    && a.deliverables.some((d) => d.id === did));
  for (const raw of (call.input.entries || [])) {
    const line = { ...raw };
    line.minutes = Math.max(15, Math.round(Number(line.minutes) / 15) * 15);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(line.start || '')) { dropped.push({ ...line, reason: 'no usable start time' }); continue; }
    if (line.block_id != null) {
      const b = ctx.view.blocks.find((x) => x.id === line.block_id && x.status === 'pending');
      if (!b) { line.block_id = null; } else {
        line.contract_id = b.contract_id;
        line.deliverable_id = b.deliverable_id;
        line.label = b.label;
      }
    }
    if (line.block_id == null && !pairOk(line.contract_id, line.deliverable_id)) {
      dropped.push({ ...line, reason: 'not one of this month’s assignments' });
      continue;
    }
    if (!line.label) {
      const a = ctx.view.assignments.find((x) => x.contract_id === line.contract_id);
      line.label = a ? `${a.name} — ${(a.deliverables.find((d) => d.id === line.deliverable_id) || {}).name || ''}` : '';
    }
    valid.push(line);
  }
  return { date, entries: valid, dropped };
}

module.exports = { configured, draftDay };
