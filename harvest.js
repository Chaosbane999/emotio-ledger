const { db, get, set } = require('./db');
const cap = require('./capacity');

// ---------------------------------------------------------------------------
// Harvest v2 client. Credentials live in Settings (or env for first boot).
// ---------------------------------------------------------------------------

const creds = () => ({
  account: get('harvest_account_id') || process.env.HARVEST_ACCOUNT_ID || '',
  token: get('harvest_token') || process.env.HARVEST_TOKEN || '',
});

const configured = () => {
  const c = creds();
  return Boolean(c.account && c.token);
};

async function api(path, params = {}) {
  const { account, token } = creds();
  if (!account || !token) throw new Error('Harvest is not connected — add an account id and token in Settings.');

  const url = new URL(`https://api.harvestapp.com/v2/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Harvest-Account-Id': String(account),
      'User-Agent': 'Emotio Allocation Ledger (damon@emotio.co.uk)',
      Accept: 'application/json',
    },
  });

  if (res.status === 401 || res.status === 403) throw new Error('Harvest rejected those credentials.');
  if (res.status === 429) throw new Error('Harvest rate limit hit — wait a moment and try again.');
  if (!res.ok) throw new Error(`Harvest returned ${res.status} for ${path}`);
  return res.json();
}

/** Walk every page of a Harvest collection. */
async function all(path, key, params = {}) {
  const out = [];
  let page = 1;
  for (;;) {
    const data = await api(path, { ...params, page, per_page: 100 });
    out.push(...(data[key] || []));
    if (!data.next_page) break;
    page = data.next_page;
    if (page > 60) break; // safety
  }
  return out;
}

// ---------------------------------------------------------------------------
// Task name -> deliverable.
// ---------------------------------------------------------------------------

/** Strip a leading client code: "AC Google Ads" -> "google ads". */
function stripPrefix(taskName) {
  let s = String(taskName || '').trim();
  s = s.replace(/\\+$/, '');                       // stray trailing backslash in some names
  s = s.replace(/^\d{3,4}\s+/, '');                 // numeric codes like "848 Google Ads"
  s = s.replace(/^[A-Z][A-Za-z0-9]{0,5}\s+(?=[A-Z])/, ''); // client code
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Built-in synonyms, seeded into task_map so they can be edited later. */
const SYNONYMS = {
  'General Management': ['general management', 'management', 'prep calls and reporting'],
  'Google Ads — management': ['google ads', 'ppc', 'campaign management', 'budgets'],
  'Google Ads — campaign build': ['campaign set up', 'campaign setup'],
  'Paid Social Media Marketing': [
    'paid social media marketing', 'paid soical media marketing', 'psmm',
    'meta ads', 'tiktok ads', 'paid social',
  ],
  'Organic Social Media': [
    'organic media marketing', 'organic social media marketing', 'smm', 'organic social',
  ],
  'Email Marketing': ['email marketing'],
  'SEO / On-Page Optimisation': [
    'search engine optimisation', 'seo', 'seo optimisation', 'on page optimisation',
  ],
  'Backlinks': ['backlinks', 'backlink building', 'found links'],
  'AI Optimisation': ['ai optimisation', 'ai search', 'aeo', 'geo'],
  'Design Work': ['design work', 'design', 'banners design', 'ammendments', 'amendments'],
  'Asset Creation': ['asset creation'],
  'Automations': ['automations', 'automation'],
  'Blog / Content Creation': ['blog creation', 'blog', 'content creation', 'articles'],
  'Reporting & Client Calls': ['reporting', 'calls', 'client call'],
};

function resolveDeliverable(taskName) {
  const norm = stripPrefix(taskName);
  if (!norm) return null;

  const exact = db.prepare('SELECT deliverable_id FROM task_map WHERE pattern = ?').get(norm);
  if (exact) return exact.deliverable_id;

  // longest-pattern-wins substring match, so "seo optimisation" beats "seo"
  const rows = db.prepare('SELECT pattern, deliverable_id FROM task_map ORDER BY length(pattern) DESC').all();
  for (const r of rows) if (norm.includes(r.pattern)) return r.deliverable_id;
  return null;
}

function seedTaskMap() {
  const findD = db.prepare('SELECT id FROM deliverables WHERE name = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO task_map (pattern, deliverable_id) VALUES (?, ?)');
  for (const [name, patterns] of Object.entries(SYNONYMS)) {
    const d = findD.get(name);
    if (!d) continue;
    for (const p of patterns) ins.run(p, d.id);
  }
}

// ---------------------------------------------------------------------------
// Sync.
// ---------------------------------------------------------------------------

/** Pull the team, matching on harvest_user_id. New people arrive inactive. */
async function syncPeople() {
  const users = await all('users', 'users', { is_active: true });
  const find = db.prepare('SELECT * FROM people WHERE harvest_user_id = ?');
  const upd = db.prepare('UPDATE people SET name = ?, weekly_hours = ? WHERE id = ?');
  const ins = db.prepare(`INSERT INTO people
      (harvest_user_id, name, initials, weekly_hours, rate, utilisation, active, sort_order)
      VALUES (?, ?, ?, ?, 100, 0.87, 0, 99)`);

  let added = 0, updated = 0;
  for (const u of users) {
    const weekly = Number(u.weekly_capacity_hours) || 37.5;
    const existing = find.get(u.id);
    if (existing) { upd.run(u.full_name, weekly, existing.id); updated += 1; }
    else {
      const initials = `${(u.first_name || '?')[0]}${(u.last_name || '?')[0]}`.toUpperCase();
      ins.run(u.id, u.full_name, initials, weekly);
      added += 1;
    }
  }
  return { added, updated, total: users.length };
}

/**
 * Pull a month of time entries and fold them into `actuals`, mapped onto
 * contracts (by Harvest project id) and deliverables (by task name).
 */
async function syncActuals(period) {
  const { year, month } = cap.parsePeriod(period);
  const from = `${period}-01`;
  const to = `${period}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;

  const entries = await all('time_entries', 'time_entries', { from, to });

  // Harvest project id -> contract id
  const projectToContract = new Map();
  for (const c of db.prepare("SELECT id, harvest_ids FROM contracts WHERE harvest_ids != ''").all()) {
    for (const raw of c.harvest_ids.split(',')) {
      const id = raw.trim();
      if (id) projectToContract.set(id, c.id);
    }
  }
  const peopleByHarvest = new Map(
    db.prepare('SELECT id, harvest_user_id FROM people WHERE harvest_user_id IS NOT NULL').all()
      .map((p) => [String(p.harvest_user_id), p.id]));

  db.prepare('DELETE FROM actuals WHERE period = ?').run(period);
  const ins = db.prepare(`INSERT INTO actuals
      (period, person_id, contract_id, deliverable_id, harvest_project, harvest_task, hours)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);

  // fold to person × contract × deliverable so the table stays small
  const bucket = new Map();
  let unmappedProject = 0, unmappedTask = 0;

  for (const e of entries) {
    const personId = peopleByHarvest.get(String(e.user?.id)) || null;
    const contractId = projectToContract.get(String(e.project?.id)) || null;
    const deliverableId = resolveDeliverable(e.task?.name);
    if (!contractId) unmappedProject += 1;
    if (!deliverableId) unmappedTask += 1;

    const hours = Number(e.rounded_hours ?? e.hours) || 0;
    const key = [personId, contractId, deliverableId, e.project?.name || '', e.task?.name || ''].join('|');
    const cur = bucket.get(key);
    if (cur) cur.hours += hours;
    else {
      bucket.set(key, {
        personId, contractId, deliverableId,
        project: e.project?.name || '', task: e.task?.name || '', hours,
      });
    }
  }

  for (const b of bucket.values()) {
    ins.run(period, b.personId, b.contractId, b.deliverableId, b.project, b.task, cap.round2(b.hours));
  }

  set('last_sync', new Date().toISOString());
  set('last_sync_period', period);

  return {
    period,
    entries: entries.length,
    rows: bucket.size,
    hours: cap.round2([...bucket.values()].reduce((s, b) => s + b.hours, 0)),
    unmapped_project_entries: unmappedProject,
    unmapped_task_entries: unmappedTask,
  };
}

/** Harvest projects, for wiring contracts up to project ids in the UI. */
async function listProjects() {
  const projects = await all('projects', 'projects', { is_active: true });
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    client: p.client?.name || '',
    label: `${p.client?.name || '—'} · ${p.name}`,
  })).sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = {
  configured, syncPeople, syncActuals, listProjects,
  resolveDeliverable, stripPrefix, seedTaskMap, SYNONYMS,
};
