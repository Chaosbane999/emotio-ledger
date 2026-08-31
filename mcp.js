// MCP server (Streamable HTTP, stateless) exposing EmotioHours as read-only
// analysis tools — plan vs reality, capacity, drawdown. Deliberately no
// writes: an agent can interrogate time management here, never mutate it.
// Enabled only when MCP_TOKEN is set; auth via Bearer header or ?token=
// query for clients that cannot set headers. The token is admin-scoped, so
// money fields (rates, units, variance) are visible — never hand this token
// to a member.
const { db } = require('./db');
const cap = require('./capacity');
const time = require('./time');

const TOKEN = process.env.MCP_TOKEN || '';
const PERIOD_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const period = (s) => {
  const p = s || cap.thisPeriod();
  if (!PERIOD_RE.test(p)) throw new Error('period must be YYYY-MM');
  return p;
};
const date = (s, field) => {
  if (!DATE_RE.test(s || '')) throw new Error(`${field} must be YYYY-MM-DD`);
  return s;
};
const getPerson = (id) => {
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(Number(id));
  if (!p) throw new Error(`no person with id ${id}`);
  return p;
};
const getContract = (id) => {
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(Number(id));
  if (!c) throw new Error(`no contract with id ${id}`);
  return c;
};

const tools = [
  { name: 'list_months',
    description: 'Planning months that exist, with working days and clock hours each.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_people',
    description: 'People with id, department, weekly hours and target. Includes archived people only when asked.',
    inputSchema: { type: 'object', properties: {
      include_archived: { type: 'boolean' } } } },
  { name: 'list_contracts',
    description: 'Contracts with id, type (retainer/pot/project/internal), status, department, run dates and pot size.',
    inputSchema: { type: 'object', properties: {
      include_archived: { type: 'boolean' } } } },
  { name: 'agency_overview',
    description: 'The agency dashboard for one month: capacity, allocated, contracted units, per-person load, out-of-balance contracts. Filter to one department to match the Agency tabs (management people appear in both).',
    inputSchema: { type: 'object', properties: {
      period: { type: 'string', description: 'YYYY-MM, defaults to the current month' },
      department: { type: 'string', enum: ['marketing', 'design'] } } } },
  { name: 'contract_summary',
    description: 'One contract in one month: allocation lines (people, third parties, fixed commitments), units, balance/variance, pot drawdown for pots.',
    inputSchema: { type: 'object', properties: {
      contract_id: { type: 'number' }, period: { type: 'string' } },
      required: ['contract_id'] } },
  { name: 'contract_time_report',
    description: 'Planned vs logged hours for one contract in one month, split by person and deliverable.',
    inputSchema: { type: 'object', properties: {
      contract_id: { type: 'number' }, period: { type: 'string' } },
      required: ['contract_id'] } },
  { name: 'person_month',
    description: 'One person in one month: capacity, allocations by contract, internal hours, spare, leave.',
    inputSchema: { type: 'object', properties: {
      person_id: { type: 'number' }, period: { type: 'string' } },
      required: ['person_id'] } },
  { name: 'time_report',
    description: 'Logged time over a date range, grouped by contract, person and deliverable, with planned-hours context. Any filter may be omitted.',
    inputSchema: { type: 'object', properties: {
      from: { type: 'string', description: 'YYYY-MM-DD' },
      to: { type: 'string', description: 'YYYY-MM-DD' },
      contract_id: { type: 'number' }, person_id: { type: 'number' },
      department: { type: 'string', enum: ['marketing', 'design'] },
      deliverable_id: { type: 'number' } }, required: ['from', 'to'] } },
  { name: 'time_variance',
    description: 'Plan vs reality for one month: per person and contract, hours planned against hours logged and the gap. The core time-management health check.',
    inputSchema: { type: 'object', properties: {
      period: { type: 'string' }, person_id: { type: 'number' } } } },
  { name: 'week_view',
    description: "A person's week: the planned blocks (with pending/confirmed/skipped state and draft flag) and logged entries, day by day. date picks the week containing it.",
    inputSchema: { type: 'object', properties: {
      person_id: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['person_id', 'date'] } },
  { name: 'day_view',
    description: "A person's single day: plan blocks and logged entries.",
    inputSchema: { type: 'object', properties: {
      person_id: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['person_id', 'date'] } },
];

const impl = {
  list_months() {
    return db.prepare('SELECT period FROM months ORDER BY period').all()
      .map((m) => ({ period: m.period, working_days: cap.workingDays(m.period),
        clock_hours: cap.monthHours(m.period) }));
  },
  list_people({ include_archived } = {}) {
    return db.prepare(`SELECT id, name, initials, department, weekly_hours, utilisation, rate,
      active, archived FROM people ${include_archived ? '' : 'WHERE archived = 0'} ORDER BY name`).all();
  },
  list_contracts({ include_archived } = {}) {
    return db.prepare(`SELECT id, name, type, status, department, monthly_units, pot_units,
      pot_start, pot_end, starts_on, ends_on, exec_person_id, archived
      FROM contracts ${include_archived ? '' : 'WHERE archived = 0'} ORDER BY sort_order, name`).all();
  },
  agency_overview(a = {}) {
    return cap.agencySummary(period(a.period),
      ['marketing', 'design'].includes(a.department) ? a.department : null);
  },
  contract_summary(a) {
    return cap.contractSummary(getContract(a.contract_id), period(a.period));
  },
  contract_time_report(a) {
    getContract(a.contract_id);
    return time.contractTimeReport(Number(a.contract_id), period(a.period));
  },
  person_month(a) {
    getPerson(a.person_id);
    const v = cap.personView(Number(a.person_id), period(a.period));
    if (!v) throw new Error('no view for that person and month');
    return v;
  },
  time_report(a) {
    return time.report({
      from: date(a.from, 'from'), to: date(a.to, 'to'),
      contractIds: null,
      contractId: Number(a.contract_id) || null,
      personId: Number(a.person_id) || null,
      department: ['marketing', 'design'].includes(a.department) ? a.department : null,
      deliverableId: Number(a.deliverable_id) || null,
    });
  },
  time_variance(a = {}) {
    return time.variance(period(a.period), Number(a.person_id) || null);
  },
  week_view(a) {
    getPerson(a.person_id);
    return time.weekView(Number(a.person_id), time.mondayOf(date(a.date, 'date')));
  },
  day_view(a) {
    getPerson(a.person_id);
    return time.dayView(Number(a.person_id), date(a.date, 'date'));
  },
};

function handle(req, res) {
  if (!TOKEN) return res.status(404).end();
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (bearer !== TOKEN && (req.query.token || '') !== TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const m = req.body || {};
  if (m.id === undefined || m.id === null) return res.status(202).end(); // notification
  const reply = (result) => res.json({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize':
      return reply({
        protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'emotiohours', version: '1.0.0' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const name = m.params && m.params.name;
      const fn = impl[name];
      if (!fn) return fail(-32602, `unknown tool: ${name}`);
      try {
        const out = fn((m.params && m.params.arguments) || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not supported: ${m.method}`);
  }
}

module.exports = { handle };
