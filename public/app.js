/* EmotioHours — client.
   Rule that shapes every screen: hours lead where a person is looking at their
   own month; units lead where the business is looking at contracts.

   Both denominations appear together on the headline tiles, because they answer
   different questions — units say what the team can deliver in contract value,
   hours say whether anyone actually has room. They diverge wherever rates do.
   Summing hours across people is legitimate as a capacity figure; it is only
   meaningless as a measure of value, so the balance rule stays units-only. */

const S = { period: null, boot: null, view: 'agency', personId: null, contractId: null, plan: null,
  showArchived: false, showRecipes: false, me: null };

const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Trim only the fractional tail. The strip used to run on the whole string, so
// h(150, 0) -> '15': with no decimal point the regex ate a significant zero,
// and every round number in the month picker was rendered a digit short.
const h = (n, d = 2) => {
  const s = (Number(n) || 0).toFixed(d);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
const NB = '\u00a0';                                                 // keeps "12.5 h" unbreakable
// Show hours as they really are. Forcing derived capacity onto a quarter grain
// understated it — 4 h/week across 21 working days is 16.8 h, and snapping
// displayed 16.75. Allocations and schedule blocks are already on quarters, so
// they still read cleanly.
const hrs = (n) => `${h(n)}${NB}h`;
// A member never sees units: units divided by hours would give the rate away.
// A member is never shown a rate or a unit: units divided by hours would give
// them everyone's charge-out rate. Blanking the cells left an empty column and
// a "£0/h" chip, so drop the column and the chip outright instead.
const showsMoney = () => !S.me || S.me.role === 'admin';
const units = (n) => (showsMoney() ? `${h(n)}${NB}u` : '');
const uTh = (label = 'Units') => (showsMoney() ? `<th class="num">${label}</th>` : '');
const uTd = (n) => (showsMoney() ? `<td class="num">${units(n)}</td>` : '');
const pct = (n) => `${Math.round(Number(n) || 0)}%`;
const DOW_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

async function api(path, opts) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    method: opts?.method || (opts?.body ? 'POST' : 'GET'),
  });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

const P = (extra = '') => `?period=${encodeURIComponent(S.period)}${extra}`;

function toast(msg, bad) {
  const el = document.createElement('div');
  el.className = 'banner' + (bad ? ' bad' : ' info');
  el.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:99;box-shadow:var(--shadow);max-width:min(560px,92vw)';
  el.innerHTML = esc(msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

const monthName = (p) => {
  const [y, m] = p.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

// Which month you are looking at is a personal preference, not agency config:
// storing it per browser means a refresh keeps you where you were, and one
// person changing month never moves anybody else.
const REMEMBERED = 'emotiohours.period';
const rememberPeriod = (p) => { try { localStorage.setItem(REMEMBERED, p); } catch (e) { /* private mode */ } };
const recallPeriod = () => { try { return localStorage.getItem(REMEMBERED); } catch (e) { return null; } };

async function boot() {
  // landing back from the Slack OAuth round-trip
  const slackBack = new URLSearchParams(window.location.search).get('slack');
  if (slackBack) {
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => toast(slackBack === 'connected'
      ? 'Slack connected — the token is stored. Try Test connection in Settings.'
      : `Slack connection failed (${slackBack}). Check the Client ID, Secret and redirect URL.`,
    slackBack !== 'connected'), 400);
  }
  if (!S.period) S.period = recallPeriod();
  S.boot = await api(`/api/bootstrap${S.period ? P() : ''}`);

  // the remembered month may have been deleted since
  if (S.period && !S.boot.periods.includes(S.period)) {
    S.period = null;
    S.boot = await api('/api/bootstrap');
  }
  S.period = S.boot.period;
  rememberPeriod(S.period);
  S.me = S.boot.me || { role: 'admin', person_id: null };

  // A member sees only their own month, so the agency-wide tabs are removed
  // rather than shown and refused.
  const memberViews = ['time', 'people', 'schedule', 'contracts', 'reports'];
  $('#tabs').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('hidden', S.me.role !== 'admin' && !memberViews.includes(b.dataset.view));
  });
  if (S.me.role !== 'admin') {
    S.personId = S.me.person_id;
    if (!memberViews.includes(S.view)) S.view = 'time';
    // adding and deleting months is an agency-wide act; the buttons were on
    // show for members and every click came back refused
    ['#addMonth', '#delMonth'].forEach((sel) => $(sel)?.classList.add('hidden'));
  }
  $('#whoami').textContent = S.me.name ? `${S.me.name}${S.me.role === 'admin' ? '' : ''}` : '';
  if (S.boot.settings.staging && !document.querySelector('.staging-pill')) {
    const pill = document.createElement('span');
    pill.className = 'pill warn staging-pill';
    pill.textContent = 'STAGING — not the live system';
    document.querySelector('header.top').appendChild(pill);
  }

  const sel = $('#period');
  const size = new Map((S.boot.months || []).map((m) => [m.period, m]));
  sel.innerHTML = S.boot.periods.map((p) => {
    const m = size.get(p);
    return `<option value="${p}"${p === S.period ? ' selected' : ''}>${
      esc(monthName(p))}${m ? ` — ${h(m.hours, 0)} h` : ''}</option>`;
  }).join('');

  await render();
}

async function render() {
  $('#tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  try {
    if (S.view === 'agency') await renderAgency();
    else if (S.view === 'people') await renderPerson();
    else if (S.view === 'contracts') await renderContracts();
    else if (S.view === 'internal') await renderInternal();
    else if (S.view === 'schedule') await renderSchedule();
    else if (S.view === 'time') await renderTime();
    else if (S.view === 'reports') await renderReports();
    else await renderSettings();
  } catch (e) {
    view().innerHTML = `<div class="banner bad"><div><b>Something went wrong.</b><br>${esc(e.message)}</div></div>`;
  }
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  S.view = b.dataset.view;
  S.showRecipes = false;      // the recipes panel is a detour, not a mode
  render();
});

$('#signOut').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  location.href = '/login.html';
});

$('#period').addEventListener('change', async (e) => {
  S.period = e.target.value;
  rememberPeriod(S.period);
  S.boot = await api(`/api/bootstrap${P()}`);
  render();
});

$('#addMonth').addEventListener('click', async () => {
  const last = S.boot.periods[S.boot.periods.length - 1] || S.period;
  const next = shiftPeriodClient(last, 1);
  if (!confirm(`Add ${monthName(next)}?\n\nIt starts as a copy of ${monthName(last)} — same contracts, same allocations — for you to edit.`)) return;
  try {
    const r = await api('/api/months', { body: { period: next, copy_from: last } });
    toast(`${monthName(next)} added — ${r.copied.allocations} allocations copied forward.`);
    S.period = next;
    rememberPeriod(next);
    S.boot = await api(`/api/bootstrap${P()}`);
    await boot();
  } catch (e) { toast(e.message, true); }
});

$('#delMonth').addEventListener('click', async () => {
  if (S.boot.periods.length <= 1) return toast('That is the only month — add another before deleting this one.', true);
  if (!confirm(`Delete ${monthName(S.period)}?\n\nEvery allocation, third-party line, carry-over and planned block in it goes too. This cannot be undone.`)) return;
  try {
    let r;
    try {
      r = await api(`/api/months/${S.period}`, { method: 'DELETE' });
    } catch (e) {
      // the month holds logged time — the record of work done, not a plan
      if (!/logged time/.test(e.message)) throw e;
      if (!confirm(`${e.message}\n\nDelete it anyway, losing that time for good?`)) return;
      r = await api(`/api/months/${S.period}?force=1`, { method: 'DELETE' });
    }
    toast(`${monthName(S.period)} deleted.`);
    S.period = r.months[r.months.length - 1];
    rememberPeriod(S.period);
    await boot();
  } catch (e) { toast(e.message, true); }
});

/** Month arithmetic on the client, mirroring capacity.shiftPeriod. */
function shiftPeriodClient(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 1 — Agency. Units lead.
// ---------------------------------------------------------------------------

function capBar(usedH, capH) {
  const over = Math.max(0, usedH - capH);
  const used = Math.min(usedH, capH);
  const w = (n) => `${capH > 0 ? Math.max(0, Math.min(100, (n / capH) * 100)) : 0}%`;
  return `<div class="bar" data-tip="${hrs(usedH)} of ${hrs(capH)}">
    <i class="used" style="width:${w(used)}"></i><i class="over" style="width:${w(over)}"></i></div>`;
}

/** Hours lead on every headline figure; units ride alongside. */
// Hours with their unit value alongside. A member sees no units, so the
// separator goes too — otherwise every headline figure trailed a bare slash.
const pairHU = (hh, u) => (showsMoney()
  ? `${hrs(hh)}<span class="sep">/</span><span class="alt">${units(u)}</span>`
  : hrs(hh));

async function renderAgency() {
  S.agencyDept = S.agencyDept || 'marketing';
  const a = await api(`/api/agency${P()}&department=${S.agencyDept}`);
  const t = a.totals;
  const people = S.boot.people;
  const execName = (id) => people.find((p) => p.id === id)?.name || 'Unassigned';
  const execIni = (id) => people.find((p) => p.id === id)?.initials || '—';

  const live = a.contracts.filter((c) => c.type !== 'internal' && c.status === 'live');
  const held = a.contracts.filter((c) => c.status === 'hold');
  const pipeline = a.contracts.filter((c) => c.status === 'pipeline');
  const internal = a.contracts.find((c) => c.type === 'internal');

  // Only contracts that reconcile month by month can be over or under it.
  // Pots draw down across their window; internal has no contracted value.
  const reconciles = live.filter((c) => !c.no_balance);
  const overrun = reconciles.filter((c) => c.variance < -0.005);
  const underrun = reconciles.filter((c) => c.variance > 0.005);
  const overrunUnits = overrun.reduce((s, c) => s - c.variance, 0);
  const underrunUnits = underrun.reduce((s, c) => s + c.variance, 0);
  const offBalance = overrun.length + underrun.length;

  const inactiveOwned = S.boot.contracts.filter((c) => {
    const ex = people.find((p) => p.id === c.exec_person_id);
    return !c.archived && c.status === 'live' && c.type !== 'internal' && ex && (!ex.active || ex.archived);
  });

  // Columns are this department's staff, plus anyone else holding allocations
  // on its contracts this month — otherwise a departed (or cross-department)
  // person's hours vanish from the row and the numbers stop adding up.
  const allocated = new Set(a.contracts.flatMap((c) => c.lines.map((l) => l.person_id)));
  const deptIds = new Set(a.staff.map((p) => p.person_id));
  const cols = people.filter((p) => deptIds.has(p.id) || allocated.has(p.id));
  const hoursFor = (c, pid) => c.lines.filter((l) => l.person_id === pid).reduce((s, l) => s + l.hours, 0);

  const gridRow = (c) => {
    const contract = S.boot.contracts.find((x) => x.id === c.contract_id) || {};
    const pot = c.type === 'pot';
    return `<tr>
      <td class="ini">${esc(execIni(contract.exec_person_id))}</td>
      <td class="name"><button class="linky" data-contract="${c.contract_id}">${esc(c.name)}</button>
        ${pot ? `<span class="sub">pot ${units(c.pot_units)}${c.pot_end ? ` · to ${c.pot_end}` : ''}</span>` : ''}</td>
      <td class="num">${pot ? units(c.pot_units) : units(c.contracted_units)}</td>
      ${cols.map((p) => {
        const hh = hoursFor(c, p.id);
        return `<td class="num person">${hh ? `<b>${hrs(hh)}</b>` : '<span class="nil">—</span>'}</td>`;
      }).join('')}
      <td class="num">${c.third_party_units ? units(c.third_party_units) : '<span class="nil">—</span>'}</td>
      <td class="num">${units(c.allocated_units)}<span class="sub"><b>${hrs(c.people_hours)}</b></span></td>
      <td class="num">${pot
        ? `${units(c.pot_remaining)} left`
        : `<span class="pill ${c.balanced ? 'ok' : 'bad'}">${c.balanced ? 'balanced'
            : (c.variance > 0 ? `${h(c.variance)} under` : `${h(-c.variance)} over`)}</span>`}</td>
    </tr>`;
  };

  const colTotal = (pid) => live.reduce((s, c) => s + hoursFor(c, pid), 0);

  view().innerHTML = `
    <div class="steps" style="margin-bottom:14px">
      ${['marketing', 'design'].map((d) => `
        <button class="step agDept ${S.agencyDept === d ? 'on' : ''}" data-dept="${d}">
          ${d === 'design' ? 'Design Department' : 'Marketing Department'}</button>`).join('')}
    </div>
    <div class="stats">
      <div class="stat ${t.headroom_hours > 60 ? 'good' : t.headroom_hours < 0 ? 'bad' : 'warn'}">
        <span class="k">Delivery headroom</span>
        <span class="v">${pairHU(t.headroom_hours, t.headroom_units)}</span>
        <span class="s">of ${hrs(t.capacity_hours)} / ${units(t.capacity_units)} capacity</span>
      </div>
      <div class="stat">
        <span class="k">Allocated</span>
        <span class="v">${pairHU(t.allocated_hours, t.allocated_units)}</span>
        <span class="s">${pct(t.capacity_hours ? (t.allocated_hours / t.capacity_hours) * 100 : 0)} of clock capacity${
          t.orphan_hours ? ` · ${hrs(t.orphan_hours)} more held by people off the team` : ''}</span>
      </div>
      <div class="stat ${Math.abs(t.contracted_units - t.assigned_units) < 0.01 ? '' : 'warn'}">
        <span class="k">Contracted</span>
        <span class="v">${units(t.contracted_units)}</span>
        <span class="s">${live.length} live contracts · ${
          Math.abs(t.contracted_units - t.assigned_units) < 0.01
            ? `${units(t.assigned_units)} assigned, matches`
            : `${units(t.assigned_units)} assigned — ${units(Math.abs(t.contracted_units - t.assigned_units))} ${
                t.assigned_units > t.contracted_units ? 'over' : 'short'}`}</span>
      </div>
      <div class="stat ${offBalance ? 'bad' : 'good'}">
        <span class="k">Out of balance</span>
        <span class="v">${offBalance}<span class="sep">/</span><span class="alt">${reconciles.length} contracts</span></span>
        <span class="s">${offBalance
          ? [overrun.length ? `${units(overrunUnits)} over` : null,
             underrun.length ? `${units(underrunUnits)} unplanned` : null].filter(Boolean).join(' · ')
          : 'every contract reconciles'}</span>
      </div>
    </div>

    ${overrun.length ? `<div class="banner bad"><div>
      <b>${overrun.length} contracts are allocated beyond what they're contracted for — ${units(overrunUnits)} in total.</b><br>
      Trim the allocation, or declare the extra as carry-over on the contract.
      <button class="linky" data-filter="over">Show them</button>
    </div></div>` : ''}

    ${underrun.length ? `<div class="banner"><div>
      <b>${underrun.length} contracts have ${units(underrunUnits)} of contracted work with nobody on it.</b><br>
      ${t.allocated_units < 0.005
        ? `Nothing is allocated for ${esc(monthName(S.period))} yet.`
        : 'Either allocate the remaining value, or reduce what the client is billed for.'}
      <button class="linky" data-filter="under">Show them</button>
    </div></div>` : ''}

    ${t.orphan_hours ? `<div class="banner"><div>
      <b>${hrs(t.orphan_hours)} of live client work is held by people who are not in the capacity list.</b><br>
      It counts against the contracts but adds no capacity, which is why the clock-hours figures differ.
      Reassign it, or bring them back in Settings.
      <button class="linky" data-filter="orphanhours">Show those contracts</button>
    </div></div>` : ''}

    ${inactiveOwned.length ? `<div class="banner"><div>
      <b>${inactiveOwned.length} live contracts belong to someone no longer active.</b>
      <button class="linky" data-filter="orphan">Show them</button>
    </div></div>` : ''}

    <div class="card">
      <header><h2>Capacity by person</h2><p>Clock hours each, with what those hours are worth</p></header>
      <div class="scroll"><table class="big">
        <thead><tr>
          <th>Person</th><th class="num">Rate</th>
          <th class="num" title="Working hours this month, after leave and sick">Available</th>
          <th class="num" title="The share of available hours we sell to clients — available hours x their utilisation target. The rest is internal and training time.">Sellable hours</th>
          <th class="num">Allocated</th>
          <th class="num" title="Hours booked to internal work and training">Internal</th>
          <th class="num" title="Hours genuinely left: available less client work less internal. Internal counts at whichever is larger — booked, or the allowance the utilisation target sets aside.">Spare</th>
          <th style="width:140px">Load</th>
        </tr></thead>
        <tbody>${a.staff.map((p) => `<tr>
          <td><button class="linky" data-person="${p.person_id}">${esc(p.name)}</button>
            <span class="sub">${pct(p.utilisation * 100)} target${p.shared ? ' · shared with both departments' : ''}</span></td>
          <td class="num">£${h(p.rate)}</td>
          <td class="num">${hrs(p.available_hours)}</td>
          <td class="num">${hrs(p.client_hours)}</td>
          <td class="num">${hrs(p.allocated_client_hours)}<span class="sub">${units(p.allocated_client_units)}</span>${
            p.elsewhere_hours ? `<span class="sub warn">${hrs(p.elsewhere_hours)} for the other department</span>` : ''}</td>
          <td class="num">${p.allocated_internal_hours ? hrs(p.allocated_internal_hours) : '<span class="nil">—</span>'}${
            p.allocated_internal_hours > p.internal_hours + 0.005
              ? `<span class="sub warn">${hrs(p.allocated_internal_hours - p.internal_hours)} over allowance</span>` : ''}</td>
          <td class="num spare ${p.spare_hours < 0 ? 'neg' : 'pos'}">${hrs(p.spare_hours)}</td>
          <td>${capBar(p.allocated_client_hours, p.client_hours)}<span class="sub">${pct(p.load_pct)}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>

    ${a.borrowed?.length ? `<div class="card">
      <header><h2>Borrowed hands</h2>
        <p>People homed elsewhere, holding hours on this department's contracts</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Person</th><th>Home</th><th class="num">Hours here</th></tr></thead>
        <tbody>${a.borrowed.map((b) => `<tr>
          <td><button class="linky" data-person="${b.person_id}">${esc(b.name)}</button></td>
          <td><span class="pill mute">${b.home === 'design' ? 'Design' : b.home === 'management' ? 'Management' : 'Marketing'}</span></td>
          <td class="num">${hrs(b.hours)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}

    <div class="card">
      <header>
        <h2>Contracts</h2>
        <div class="rowline" style="gap:8px">
          <input type="search" id="gridSearch" placeholder="Find a contract…" style="width:180px">
          <span class="pill mute" id="gridCount"></span>
        </div>
      </header>
      <div class="scroll"><table class="sheet">
        <thead><tr>
          <th>Own</th><th>Contract</th><th class="num">Contracted</th>
          ${cols.map((p) => `<th class="num person ${p.active && !p.archived ? '' : 'gone'}"
            title="${esc(p.name)}${p.active && !p.archived ? '' : ' — no longer active'}"
            >${esc(p.initials || p.name.slice(0, 2))}</th>`).join('')}
          <th class="num">3P</th><th class="num">Allocated</th><th class="num">Balance</th>
        </tr></thead>
        <tbody id="gridBody">
          ${live.map(gridRow).join('')}
          <tr class="total">
            <td></td><td>Live total</td>
            <td class="num">${units(t.contracted_units)}</td>
            ${cols.map((p) => `<td class="num person"><b>${hrs(colTotal(p.id))}</b></td>`).join('')}
            <td class="num">${units(live.reduce((s, c) => s + c.third_party_units, 0))}</td>
            <td class="num">${units(live.reduce((s, c) => s + c.allocated_units, 0))}
              <span class="sub"><b>${hrs(live.reduce((s, c) => s + c.people_hours, 0))}</b></span></td>
            <td></td>
          </tr>
          ${held.length ? `<tr class="group"><td colspan="${cols.length + 6}">On hold — paused, not counted in capacity</td></tr>
            ${held.map(gridRow).join('')}` : ''}
          ${pipeline.length ? `<tr class="group"><td colspan="${cols.length + 6}">Pipeline — not won yet, not counted in capacity</td></tr>
            ${pipeline.map(gridRow).join('')}` : ''}
        </tbody>
      </table></div>
    </div>`;

  // ---- search + banner filters, both driven off the same row matcher ----
  const rows = () => [...view().querySelectorAll('#gridBody tr')];
  const applyFilter = (fn, label) => {
    let shown = 0;
    for (const tr of rows()) {
      if (tr.classList.contains('total') || tr.classList.contains('group')) { tr.classList.remove('hidden'); continue; }
      const keep = fn(tr);
      tr.classList.toggle('hidden', !keep);
      if (keep) shown++;
    }
    $('#gridCount').textContent = label ? `${shown} shown · ${label}` : '';
  };

  const activeIds = new Set(a.staff.map((p) => p.person_id));
  const idsFor = (kind) => new Set((
    kind === 'over' ? overrun
      : kind === 'under' ? underrun
      : kind === 'orphanhours'
        ? live.filter((c) => c.lines.some((l) => !activeIds.has(l.person_id)))
        : inactiveOwned.map((c) => ({ contract_id: c.id }))
  ).map((c) => c.contract_id));

  view().querySelectorAll('.agDept').forEach((b) => b.addEventListener('click', () => {
    S.agencyDept = b.dataset.dept;
    renderAgency();
  }));
  view().querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    const ids = idsFor(b.dataset.filter);
    const label = { over: 'over contract', under: 'unplanned work',
      orphan: 'owner inactive', orphanhours: 'work held by people off the team' }[b.dataset.filter];
    applyFilter((tr) => ids.has(Number(tr.querySelector('[data-contract]')?.dataset.contract)), label);
    $('#gridSearch').value = '';
    view().querySelector('.sheet').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  $('#gridSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return applyFilter(() => true, '');
    applyFilter((tr) => (tr.querySelector('.name')?.textContent || '').toLowerCase().includes(q), `matching “${q}”`);
  });
}
// ---------------------------------------------------------------------------
// 2 — Person. Hours lead.
// ---------------------------------------------------------------------------

async function renderPerson() {
  const all = S.boot.people.filter((p) => p.active);
  const people = S.me?.role === 'admin' ? all : all.filter((p) => p.id === S.me.person_id);
  if (!S.personId || !people.some((p) => p.id === S.personId)) S.personId = people[0]?.id;
  if (!S.personId) { view().innerHTML = '<p class="muted">No active people yet — add some in Settings.</p>'; return; }

  const v = await api(`/api/person/${S.personId}${P()}`);
  const lv = (await api(`/api/leave${P()}`)).find((l) => l.person_id === S.personId) || { annual_hours: 0, sick_hours: 0 };
  const t = v.totals, c = v.capacity;

  // Person surfaces lead with hours — it's their own diary — with the unit
  // value alongside so the cost of their time stays visible.
  // Convert from the same 0.25-rounded figure the hours display uses, or a
  // £100 person reads "148.50 h / 148.51 u" and looks broken.
  const asUnits = (hh) => (Number(hh) || 0) * v.person.rate / S.boot.settings.standard_rate;
  const pairH = (hh) => (showsMoney()
    ? `${hrs(hh)}<span class="sep">/</span><span class="alt">${units(asUnits(hh))}</span>`
    : hrs(hh));
  const clientLines = v.lines.filter((l) => l.type !== 'internal');
  const internalLines = v.lines.filter((l) => l.type === 'internal');
  const internalDeliverables = S.boot.deliverables.filter((d) => d.internal);
  const internalContract = S.boot.contracts.find((c) => c.type === 'internal');

  // roll the flat line list up per contract so the list stays short
  const byContract = [...clientLines.reduce((m, l) => {
    const g = m.get(l.contract_id) || { contract_id: l.contract_id, name: l.contract_name, hours: 0, units: 0, lines: [] };
    g.hours += l.hours; g.units += l.units; g.lines.push(l);
    return m.set(l.contract_id, g);
  }, new Map()).values()].sort((a, b) => b.hours - a.hours);

  view().innerHTML = `
    <div class="rowline">
      <label for="personPick">Person</label>
      <select id="personPick">${people.map((p) =>
        `<option value="${p.id}"${p.id === S.personId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span class="pill mute">${showsMoney() ? `£${h(v.person.rate)}/h · ` : ''}${pct(v.person.utilisation * 100)} target</span>
      <span class="spacer"></span>
      <button class="btn small" data-goto-schedule="${S.personId}">View schedule</button>
    </div>

    <div class="stats">
      <div class="stat" title="The share of available hours we sell to clients — available hours x their utilisation target. The rest is internal and training time.">
        <span class="k">Sellable hours</span>
        <span class="v">${pairH(c.client_hours)}</span>
        <span class="s">${pct(c.utilisation * 100)} of ${hrs(c.available_hours)} available after leave</span></div>
      <div class="stat"><span class="k">Allocated</span>
        <span class="v">${pairH(t.client_hours)}</span>
        <span class="s">${pct(t.load_pct)} of their sellable hours</span></div>
      <div class="stat ${t.spare_hours < 0 ? 'bad' : 'good'}" title="Available less client work less internal — the hours genuinely left."><span class="k">Spare</span>
        <span class="v">${pairH(t.spare_hours)}</span>
        <span class="s">${t.spare_hours < 0 ? 'overbooked' : 'room for more work'}</span></div>
      <div class="stat"><span class="k">Logged</span>
        <span class="v">${t.logged_hours ? pairH(t.logged_hours) : '—'}</span>
        <span class="s">${t.logged_hours ? `${h(t.logged_hours - t.client_hours - t.internal_hours)} h vs allocated` : 'nothing confirmed yet'}</span></div>
    </div>

    ${t.spare_hours < 0 ? `<div class="banner bad"><div><b>${esc(v.person.name)} is overbooked by ${hrs(-t.spare_hours)}.</b>
      Move work to someone with room, or reduce what's committed this month.</div></div>` : ''}

    <div class="card">
      <header><h2>Client work</h2><p>One row per contract — click to see the deliverables inside</p></header>
      <div class="scroll"><table>
        <thead><tr><th></th><th>Contract</th><th class="num">My hours</th>${uTh()}
          <th style="width:150px" title="The whole contract's month — everyone's logged hours against everyone's allocated hours">Contract progress</th>
          <th title="Everyone working this contract this month">Team</th></tr></thead>
        <tbody>${byContract.length ? byContract.map((g) => {
          const cx = v.contract_context?.[g.contract_id];
          return `
          <tr class="ct" data-grp="${g.contract_id}">
            <td class="tw"><span class="caret">▸</span></td>
            <td><button class="linky" data-contract="${g.contract_id}">${esc(g.name)}</button></td>
            <td class="num"><b>${hrs(g.hours)}</b></td>
            ${uTd(g.units)}
            <td>${cx ? `${capBar(cx.logged_hours, cx.allocated_hours)}
              <span class="sub">${hrs(cx.logged_hours)} of ${hrs(cx.allocated_hours)}</span>` : ''}</td>
            <td>${cx ? cx.people.map((tp) => `<span class="tmate" title="${esc(tp.name)} — ${hrs(tp.hours)}">${esc(tp.initials || tp.name.slice(0, 2))}</span>`).join('') : ''}</td>
          </tr>`;
        }).map((x, i) => x + `
          ${byContract[i].lines.map((l) => `<tr class="sub-row hidden" data-of="${byContract[i].contract_id}">
            <td></td><td class="indent">${esc(l.deliverable_name)}</td>
            <td class="num">${hrs(l.hours)}</td>${uTd(l.units)}<td></td><td></td>
          </tr>`).join('')}`).join('')
          : `<tr><td colspan="${showsMoney() ? 6 : 5}" class="muted">Nothing allocated this month.</td></tr>`}
        <tr class="total"><td></td><td>Total</td><td class="num">${hrs(t.client_hours)}</td>
          ${uTd(t.client_units)}<td></td><td></td></tr></tbody>
      </table></div>
    </div>

    <div class="card">
      <header><h2>Internal &amp; training</h2>
        <p>Hours booked — not measured against a budget</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Deliverable</th><th class="num">Hours</th><th></th></tr></thead>
        <tbody>${internalDeliverables.map((d) => {
          const line = internalLines.find((l) => l.deliverable_id === d.id);
          return `<tr><td>${esc(d.name)}</td>
            <td class="num"><input type="number" class="ih" step="0.25" min="0"
              data-d="${d.id}" value="${h(line ? line.hours : 0)}"></td>
            <td class="num">${line ? units(line.units) : ''}</td></tr>`;
        }).join('')}
        <tr class="total"><td>Total</td><td class="num">${hrs(t.internal_hours)}</td><td></td></tr></tbody>
      </table></div>
    </div>

    <div class="card">
      <header><h2>Leave &amp; sick</h2><p>Typed by hand — the biggest single driver of available hours</p></header>
      <div class="body"><div class="rowline">
        <label>Annual leave</label>
        <input type="number" step="0.5" min="0" id="lvAnnual" value="${h(lv.annual_hours)}"> <span class="muted">hours</span>
        <label style="margin-left:16px">Sick</label>
        <input type="number" step="0.5" min="0" id="lvSick" value="${h(lv.sick_hours)}"> <span class="muted">hours</span>
        <button class="btn primary small" id="lvSave">Save</button>
      </div>
      <p class="muted">${c.working_days} working days this month · gross ${hrs(c.gross_hours)} → available ${hrs(c.available_hours)}</p>
      </div>
    </div>`;

  $('#personPick').addEventListener('change', (e) => { S.personId = Number(e.target.value); renderPerson(); });

  view().querySelectorAll('tr.ct').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('[data-contract]')) return;      // let the link through
    const open = tr.classList.toggle('open');
    tr.querySelector('.caret').textContent = open ? '▾' : '▸';
    view().querySelectorAll(`tr.sub-row[data-of="${tr.dataset.grp}"]`)
      .forEach((r) => r.classList.toggle('hidden', !open));
  }));

  view().querySelectorAll('.ih').forEach((el) => el.addEventListener('change', async () => {
    if (!internalContract) return toast('No internal contract set up.', true);
    await api('/api/allocation', { body: {
      contract_id: internalContract.id, period: S.period, person_id: S.personId,
      deliverable_id: Number(el.dataset.d), hours: Number(el.value) } });
    toast('Internal time updated.');
    renderPerson();
  }));
  $('#lvSave').addEventListener('click', async () => {
    await api('/api/leave', { body: {
      person_id: S.personId, period: S.period,
      annual_hours: Number($('#lvAnnual').value), sick_hours: Number($('#lvSick').value) } });
    toast('Leave updated.');
    renderPerson();
  });
}

// ---------------------------------------------------------------------------
// 3 — Contracts. The checkbox screen.
// ---------------------------------------------------------------------------

async function renderContracts() {
  if (!S.contractId) {
    const a = await api(`/api/contract-summaries${P()}${S.showArchived ? '&archived=1' : ''}`);
    view().innerHTML = `
      <div class="rowline"><h2>Contracts</h2>
        <input type="search" id="cSearch" placeholder="Find a contract…" style="width:200px">
        <label class="tick"><input type="checkbox" id="cArch"${S.showArchived ? ' checked' : ''}> show archived</label>
        <span class="spacer"></span>
        ${showsMoney() ? '<button class="btn small primary" id="newContract">New contract</button>' : ''}</div>
      <div class="card"><div class="scroll"><table>
        <thead><tr><th>Contract</th><th>Owner</th><th>Type</th><th>Status</th>
          ${showsMoney() ? '<th class="num">Contracted</th><th class="num">Allocated</th>' : ''}
          <th style="width:150px" title="Retainers: hours logged against hours allocated, resetting each month. Pots: total drawn against the whole pot, across its window.">Progress</th>
          ${showsMoney() ? '<th class="num">Balance</th>' : ''}</tr></thead>
        <tbody id="cBody">${['marketing', 'design'].map((dept) => {
          const inDept = a.contracts.filter((c) => (S.boot.contracts.find((x) => x.id === c.contract_id)?.department || 'marketing') === dept);
          return `<tr class="dept-row"><td colspan="${showsMoney() ? 9 : 5}">${dept === 'design' ? 'Design Department' : 'Marketing Department'}
            <span class="sub">${inDept.length} contract${inDept.length === 1 ? '' : 's'}</span></td></tr>`
          + (inDept.length ? '' : `<tr><td colspan="${showsMoney() ? 9 : 5}" class="muted" style="padding-left:24px">Nothing here yet.</td></tr>`)
          + inDept.map((c) => {
          const cc = S.boot.contracts.find((x) => x.id === c.contract_id) || {};
          const ex = S.boot.people.find((p) => p.id === cc.exec_person_id);
          return `<tr class="${cc.archived ? 'archived' : ''}">
            <td><button class="linky" data-contract="${c.contract_id}">${esc(c.name)}</button></td>
            <td>${ex ? esc(ex.name) + (ex.active ? '' : ' <span class="pill warn">inactive</span>') : '<span class="muted">—</span>'}</td>
            <td><span class="pill ${c.type === 'pot' ? 'info' : 'mute'}">${esc(c.type)}</span></td>
            <td>${c.status === 'live' ? '<span class="pill ok">Live</span>'
              : c.status === 'pipeline' ? '<span class="pill warn">Pipeline</span>' : '<span class="pill mute">Hold</span>'}</td>
            ${showsMoney() ? `<td class="num">${units(c.type === 'pot' ? c.pot_units : c.contracted_units)}</td>
            <td class="num">${units(c.allocated_units)}</td>` : ''}
            <td class="progress-cell">${c.type === 'pot'
              ? `${capBar(c.window_logged_hours, c.window_allocated_hours)}<span class="sub">${hrs(c.window_logged_hours)} of ${hrs(c.window_allocated_hours)} · whole&nbsp;pot</span>`
              : `${capBar(c.logged_hours, c.people_hours)}<span class="sub">${hrs(c.logged_hours)} of ${hrs(c.people_hours)} · this&nbsp;month</span>`}</td>
            ${showsMoney() ? `<td class="num">${c.type === 'pot' ? `${units(c.pot_remaining)} left`
              : `<span class="pill ${c.balanced ? 'ok' : 'bad'}">${c.balanced ? 'balanced' : h(-c.variance) + ' over'}</span>`}</td>` : ''}
          </tr>`;
        }).join('');
        }).join('')}</tbody></table></div></div>`;
    $('#newContract')?.addEventListener('click', () => openContractEditor(null));
    $('#cSearch').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      for (const tr of view().querySelectorAll('#cBody tr')) {
        tr.classList.toggle('hidden', !!q && !tr.textContent.toLowerCase().includes(q));
      }
    });
    $('#cArch').addEventListener('change', async (e) => {
      S.showArchived = e.target.checked;
      S.boot = await api(`/api/bootstrap${P()}${S.showArchived ? '&archived=1' : ''}`);
      renderContracts();
    });
    return;
  }
  await renderContractDetail(S.contractId);
}

async function renderTimeReport(contractId) {
  const el = document.getElementById('ctrReport');
  if (!el) return;
  const r = await api(`/api/contract/${contractId}/time-report${P()}`);
  const max = Math.max(1, ...r.months.map((m) => Math.max(m.logged_hours, m.allocated_hours)));
  const BAR_H = 130;
  // a readable hours axis: the smallest nice step that needs at most 4 lines
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((st) => max / st <= 4) || 500;
  const ticks = [];
  for (let t2 = step; t2 <= max; t2 += step) ticks.push(t2);
  const px = (v2) => Math.round((v2 / max) * BAR_H);
  el.innerHTML = `
    <header><h2>Time report</h2><p>Hours logged, month by month — grey is the allocation, red is over it</p>
      <a class="btn small" href="/api/export/time.csv?contract_id=${contractId}${P().replace('?', '&')}" download>Export month (.csv)</a>
      <a class="btn small" href="/api/export/time.csv?contract_id=${contractId}" download>Export all (.csv)</a>
    </header>
    <div class="tr-wrap">
      ${ticks.map((t2) => `<div class="tr-grid" style="bottom:${22 + px(t2)}px"></div>
        <span class="tr-tick" style="bottom:${22 + px(t2) - 8}px">${t2}&nbsp;h</span>`).join('')}
      <span class="tr-tick" style="bottom:14px">0</span>
      <div class="tr-chart">
      ${r.months.map((m) => {
        const within = Math.min(m.logged_hours, m.allocated_hours);
        const over = Math.max(0, m.logged_hours - m.allocated_hours);
        return `<div class="tr-col ${m.period === S.period ? 'now' : ''}"
            data-tip="${esc(monthName(m.period))}: ${h(m.logged_hours)} h logged of ${h(m.allocated_hours)} h allocated">
          <div class="tr-bar" style="height:${BAR_H}px">
            <i class="tr-alloc" style="height:${px(m.allocated_hours)}px"></i>
            <i class="tr-within" style="height:${px(within)}px"></i>
            <i class="tr-over" style="height:${px(over)}px;bottom:${px(within)}px"></i>
            ${m.logged_hours > 0 ? `<b class="tr-val" style="bottom:${px(m.logged_hours) + 2}px">${h(m.logged_hours)}</b>` : ''}
          </div>
          <span class="sub">${monthName(m.period).slice(0, 3)}</span>
        </div>`;
      }).join('')}
      </div>
    </div>
    <div class="grid2" style="padding:0 16px 16px">
      <table><thead><tr><th>Deliverable · ${esc(monthName(S.period))}</th><th class="num">Hours</th></tr></thead>
        <tbody>${r.by_deliverable.length ? r.by_deliverable.map((d2) => `<tr>
            <td>${esc(d2.name)}</td><td class="num">${hrs(d2.hours)}</td></tr>`).join('')
          : '<tr><td colspan="2" class="muted">Nothing logged this month yet.</td></tr>'}
        ${r.by_deliverable.length ? `<tr class="total"><td>Total</td><td class="num">${hrs(r.total_hours)}</td></tr>` : ''}</tbody></table>
      <table><thead><tr><th>Person · ${esc(monthName(S.period))}</th><th class="num">Hours</th></tr></thead>
        <tbody>${r.by_person.length ? r.by_person.map((p2) => `<tr>
            <td>${esc(p2.name)}</td><td class="num">${hrs(p2.hours)}</td></tr>`).join('')
          : '<tr><td colspan="2" class="muted">—</td></tr>'}</tbody></table>
    </div>`;
}

async function renderContractDetail(id) {
  const d = await api(`/api/contract/${id}${P()}`);
  const anchors = (await api('/api/anchors')).filter((x) => x.contract_id === id);
  const c = d.contract, s = d.summary;
  const people = S.boot.people.filter((p) => p.active || s.lines.some((l) => l.person_id === p.id));
  const deliverables = S.boot.deliverables.filter((x) => (c.type === 'internal') === !!x.internal);
  const inScope = new Set(s.lines.map((l) => l.deliverable_id));
  const tpUsed = new Map(s.third_parties.map((t) => [t.id, t.units]));
  const isPot = c.type === 'pot';

  const lineRow = (l) => l.anchor ? `<tr class="anchor-line">
    <td>${esc(l.deliverable_name)}</td>
    <td>${esc(l.person_name)}</td>
    <td class="num">${hrs(l.hours)}</td>
    <td class="progress-cell"><span class="muted" style="font-size:12px">from Fixed commitments</span></td>
    <td class="num">£${h(l.rate)}</td>
    <td class="num">${units(l.units)}</td>
    <td class="num"></td>
  </tr>` : `<tr data-line="${l.deliverable_id}:${l.person_id}">
    <td>${esc(l.deliverable_name)}</td>
    <td><select class="lp" data-d="${l.deliverable_id}" data-old="${l.person_id}">
      ${people.map((p) => `<option value="${p.id}"${p.id === l.person_id ? ' selected' : ''}>${esc(p.name)}${p.active ? '' : ' (inactive)'}</option>`).join('')}
    </select></td>
    <td class="num"><input type="number" class="lh" step="0.25" min="0" value="${h(l.hours)}"
      data-d="${l.deliverable_id}" data-p="${l.person_id}"></td>
    <td class="progress-cell">${capBar(l.logged_hours, l.hours)}
      <span class="sub">${hrs(l.logged_hours)} logged</span></td>
    <td class="num">£${h(l.rate)}</td>
    <td class="num">${units(l.units)}</td>
    <td class="num"><button class="btn small danger rm" data-d="${l.deliverable_id}" data-p="${l.person_id}">Remove</button></td>
  </tr>`;

  view().innerHTML = `
    <div class="rowline">
      <button class="btn small" id="backC">← All contracts</button>
      <h2 style="margin-left:8px">${esc(c.name)}</h2>
      <span class="pill ${isPot ? 'info' : 'mute'}">${esc(c.type)}</span>
      <span class="spacer"></span>
      <button class="btn small" id="editC">Edit contract</button>
      <button class="btn small" id="archC">${c.archived ? 'Restore' : 'Archive'}</button>
      <button class="btn small danger" id="delC">Delete</button>
    </div>

    <div class="balance ${s.balanced ? '' : 'bad'}">
      <div class="item"><span class="k">${isPot ? 'Pot' : 'Contracted'}</span>
        <span class="v">${units(isPot ? s.pot_units : s.contracted_units)}</span></div>
      ${!isPot ? `<div class="item"><span class="k">Carried in</span><span class="v">${units(s.carryover.units)}</span></div>` : ''}
      <div class="item"><span class="k">People</span><span class="v">${units(s.people_units)}</span></div>
      <div class="item"><span class="k">Third party</span><span class="v">${units(s.third_party_units)}</span></div>
      <div class="item"><span class="k">Allocated</span><span class="v">${units(s.allocated_units)}</span></div>
      ${isPot
        ? `<div class="item"><span class="k">Remaining</span>
             <span class="v ${s.pot_remaining < 0 ? 'bad' : 'ok'}">${units(s.pot_remaining)}</span></div>
           <div class="item"><span class="k">Time left</span>
             <span class="v">${s.months_left} month${s.months_left === 1 ? '' : 's'}</span>
             <span class="sub">runs to ${esc(s.pot_end)}</span></div>`
        : `<div class="item"><span class="k">Balance</span>
             <span class="v ${s.balanced ? 'ok' : 'bad'}">${s.balanced ? 'balanced' : (s.variance > 0 ? `${h(s.variance)} under` : `${h(-s.variance)} over`)}</span></div>`}
      <div class="item"><span class="k">Clock hours</span><span class="v">${hrs(s.people_hours)}</span></div>
      <div class="item"><span class="k">Logged</span><span class="v">${s.logged_hours ? hrs(s.logged_hours) : '—'}</span></div>
    </div>

    ${!isPot && !s.balanced && s.variance < 0 ? `<div class="banner bad"><div>
      <b>Allocated ${units(-s.variance)} beyond contract.</b> Reduce hours, or declare the excess as carry-over below
      if you under-delivered last month.</div></div>` : ''}
    ${isPot ? `<div class="banner ${s.pot_remaining < 0 ? 'bad' : 'info'}"><div>
      <b>${s.pot_remaining < 0 ? 'This pot is overdrawn.' : 'Pot drawdown.'}</b>
      ${units(s.pot_drawn)} of ${units(s.pot_units)} drawn, ${units(Math.abs(s.pot_remaining))}
      ${s.pot_remaining < 0 ? 'past the pot' : 'left'}, with ${s.months_left}
      month${s.months_left === 1 ? '' : 's'} to go (to ${esc(s.pot_end)}).
      A pot is drawn as the work demands, so there is no monthly target to hit.</div></div>` : ''}

    <div class="card" id="ctrReport"></div>

    <div class="grid2">
      <div class="card">
        <header><h2>Deliverables in scope</h2><p>Tick what you're doing this month</p></header>
        <div class="body">${deliverables.map((x) => `<label class="tick">
          <input type="checkbox" class="dtick" value="${x.id}"${inScope.has(x.id) ? ' checked' : ''}>
          ${esc(x.name)}</label>`).join('')}</div>
      </div>

      <div class="card">
        <header><h2>Third-party services</h2><p>Consume contract value, no team hours</p></header>
        <div class="body">${S.boot.third_parties.map((t) => `<div class="tick">
          <input type="checkbox" class="ttick" value="${t.id}" data-def="${t.default_units}"${tpUsed.has(t.id) ? ' checked' : ''}>
          <span style="flex:1">${esc(t.name)}</span>
          <input type="number" class="tu" step="0.25" min="0" data-t="${t.id}"
            value="${h(tpUsed.get(t.id) ?? t.default_units)}"${tpUsed.has(t.id) ? '' : ' disabled'}>
          <span class="muted">u</span></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card">
      <header><h2>Allocation</h2><p>Enter hours — units are worked out from each person's rate</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Deliverable</th><th>Who</th><th class="num">Hours</th>
          <th style="width:130px">Progress</th><th class="num">Rate</th>
          <th class="num">Units</th><th class="num"></th></tr></thead>
        <tbody id="lineBody">${s.lines.length ? s.lines.map(lineRow).join('')
          : '<tr><td colspan="7" class="muted">Tick a deliverable above to start allocating.</td></tr>'}
        <tr class="total"><td colspan="2">Total</td><td class="num">${hrs(s.people_hours)}</td>
          <td>${capBar(s.logged_hours, s.people_hours)}</td>
          <td class="num"></td><td class="num">${units(s.people_units)}</td><td></td></tr></tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <div class="rowline"><label>Add a person</label>
          <select id="addD">${deliverables.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
          <select id="addP">${people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
          <input type="number" id="addH" step="0.25" min="0" value="1">
          <button class="btn small primary" id="addLine">Add</button>
        </div>
      </div>
    </div>

    ${!isPot ? `<div class="card">
      <header><h2>Carry-over</h2><p>Declared, never silent — hours moved forward from another month</p></header>
      <div class="body"><div class="rowline">
        <label>Units carried in</label>
        <input type="number" id="coUnits" step="0.25" value="${h(s.carryover.units)}">
        <label style="min-width:auto">from</label>
        <input type="text" id="coFrom" value="${esc(s.carryover.from_period)}" placeholder="YYYY-MM" style="width:100px">
        <input type="text" id="coNote" value="${esc(s.carryover.note)}" placeholder="Why" style="flex:1;min-width:160px">
        <button class="btn primary small" id="coSave">Save</button>
      </div></div>
    </div>` : ''}

    <div class="card">
      <header><h2>Fixed commitments</h2><p>Standing calls and meetings — the scheduler works around these</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Who</th><th>What</th><th>When</th><th class="num">Length</th><th></th></tr></thead>
        <tbody>${anchors.length ? anchors.map((x) => `<tr>
          <td>${esc(x.person_name)}</td><td>${esc(x.label)}</td>
          <td>${x.cadence === 'daily' ? 'Every day'
            : `${x.cadence === 'fortnightly' ? 'Every other ' : x.cadence === 'monthly' ? 'Monthly, ' : ''}${DOW_NAMES[x.dow]}`} ${esc(x.time)}</td>
          <td class="num">${hrs(x.minutes / 60)}</td>
          <td class="num"><button class="btn small danger dela" data-a="${x.id}">Remove</button></td>
        </tr>`).join('') : '<tr><td colspan="5" class="muted">None on this contract.</td></tr>'}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <div class="rowline"><label>Add</label>
          <select id="naP">${people.filter((p) => p.active).map((p) =>
            `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
          <input type="text" id="naLabel" placeholder="e.g. Weekly call" style="width:150px">
          <select id="naCad">
            <option value="daily">Daily</option>
            <option value="weekly" selected>Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="monthly">Monthly</option></select>
          <select id="naDow">${[1, 2, 3, 4, 5].map((x) => `<option value="${x}">${DOW_NAMES[x]}</option>`).join('')}</select>
          <input type="time" id="naTime" value="10:00" style="width:100px">
          <input type="number" id="naMin" value="60" step="15" min="15"><span class="muted">min</span>
          <button class="btn small primary" id="addAnchor">Add</button></div>
      </div>
    </div>



    ${d.actuals.length ? `<div class="card">
      <header><h2>Logged in Harvest</h2><p>${monthName(S.period)}</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Who</th><th>Deliverable</th><th class="num">Hours</th></tr></thead>
        <tbody>${d.actuals.map((r) => `<tr><td>${esc(r.person_name || '—')}</td>
          <td>${esc(r.deliverable_name || '<unmapped>')}</td>
          <td class="num">${hrs(r.hours)}</td></tr>`).join('')}</tbody>
      </table></div></div>` : ''}`;

  wireContractDetail(id, deliverables);
}

function wireContractDetail(id, deliverables) {
  const reload = () => renderContractDetail(id);

  $('#backC').addEventListener('click', () => { S.contractId = null; renderContracts(); });
  renderTimeReport(id);      // fills in behind the fold while the page is live
  $('#editC').addEventListener('click', () => openContractEditor(S.boot.contracts.find((c) => c.id === id)));

  const saveLine = async (deliverable_id, person_id, hours) => {
    await api('/api/allocation', { body: { contract_id: id, period: S.period, person_id, deliverable_id, hours } });
  };

  view().querySelectorAll('.lh').forEach((el) => el.addEventListener('change', async () => {
    await saveLine(Number(el.dataset.d), Number(el.dataset.p), Number(el.value));
    reload();
  }));

  view().querySelectorAll('.rm').forEach((el) => el.addEventListener('click', async () => {
    await saveLine(Number(el.dataset.d), Number(el.dataset.p), 0);
    reload();
  }));

  // moving a line to a different person: zero the old, write the new
  view().querySelectorAll('.lp').forEach((el) => el.addEventListener('change', async () => {
    const d = Number(el.dataset.d), oldP = Number(el.dataset.old), newP = Number(el.value);
    const hoursEl = view().querySelector(`.lh[data-d="${d}"][data-p="${oldP}"]`);
    const hours = Number(hoursEl?.value || 0);
    await saveLine(d, oldP, 0);
    await saveLine(d, newP, hours);
    reload();
  }));

  $('#addLine').addEventListener('click', async () => {
    await saveLine(Number($('#addD').value), Number($('#addP').value), Number($('#addH').value));
    reload();
  });

  view().querySelectorAll('.dtick').forEach((el) => el.addEventListener('change', async () => {
    const did = Number(el.value);
    if (el.checked) {
      const c = S.boot.contracts.find((x) => x.id === id);
      const owner = c?.exec_person_id || S.boot.people.find((p) => p.active)?.id;
      await saveLine(did, owner, 1);
    } else {
      for (const inp of view().querySelectorAll(`.lh[data-d="${did}"]`)) {
        await saveLine(did, Number(inp.dataset.p), 0);
      }
    }
    reload();
  }));

  view().querySelectorAll('.ttick').forEach((el) => el.addEventListener('change', async () => {
    const tid = Number(el.value);
    const unitsIn = view().querySelector(`.tu[data-t="${tid}"]`);
    const val = el.checked ? Number(unitsIn.value || el.dataset.def || 1) : 0;
    await api('/api/tp-allocation', { body: { contract_id: id, period: S.period, third_party_id: tid, units: val } });
    reload();
  }));

  view().querySelectorAll('.tu').forEach((el) => el.addEventListener('change', async () => {
    await api('/api/tp-allocation', { body: {
      contract_id: id, period: S.period, third_party_id: Number(el.dataset.t), units: Number(el.value) } });
    reload();
  }));

  const co = $('#coSave');
  if (co) co.addEventListener('click', async () => {
    await api('/api/carryover', { body: { contract_id: id, period: S.period,
      units: Number($('#coUnits').value), from_period: $('#coFrom').value, note: $('#coNote').value } });
    toast('Carry-over recorded.');
    reload();
  });

  view().querySelectorAll('.dela').forEach((el) => el.addEventListener('click', async () => {
    await api(`/api/anchors/${el.dataset.a}`, { method: 'DELETE' });
    reload();
  }));

  $('#naCad')?.addEventListener('change', (e) => {
    $('#naDow').style.display = e.target.value === 'daily' ? 'none' : '';
  });
  const addA = $('#addAnchor');
  if (addA) addA.addEventListener('click', async () => {
    const label = $('#naLabel').value.trim();
    if (!label) return toast('What is the commitment?', true);
    await api('/api/anchors', { body: {
      person_id: Number($('#naP').value), contract_id: id, label,
      cadence: $('#naCad').value,
      dow: Number($('#naDow').value), time: $('#naTime').value, minutes: Number($('#naMin').value) } });
    toast('Commitment added.');
    reload();
  });

  $('#archC').addEventListener('click', async () => {
    const cur = S.boot.contracts.find((x) => x.id === id);
    if (cur?.archived) {
      await api('/api/restore', { body: { contract_id: id } });
      toast('Contract restored.');
    } else {
      if (!confirm('Archive this contract? Its history stays, but it drops off every view unless you tick "show archived".')) return;
      await api(`/api/contracts/${id}`, { method: 'DELETE' });
      toast('Contract archived.');
    }
    S.boot = await api(`/api/bootstrap${P()}${S.showArchived ? '&archived=1' : ''}`);
    S.contractId = null;
    renderContracts();
  });

  $('#delC').addEventListener('click', async () => {
    const cur = S.boot.contracts.find((x) => x.id === id);
    if (!confirm(`Permanently delete ${cur?.name || 'this contract'}?\n\nEvery allocation against it, in every month, is deleted too. This cannot be undone — archive instead if you just want it out of the way.`)) return;
    await api(`/api/contracts/${id}?hard=1`, { method: 'DELETE' });
    toast('Contract deleted.');
    S.boot = await api(`/api/bootstrap${P()}`);
    S.contractId = null;
    renderContracts();
  });


}

/** Safari types months as text — accept 09-2026 or 2026-09, hand back YYYY-MM. */
function normMonth(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[2]}-${String(m[1]).padStart(2, '0')}`;
  return t;
}

function openContractEditor(c) {
  const people = S.boot.people;
  const f = (k, d = '') => esc(c?.[k] ?? d);
  view().innerHTML = `
    <div class="rowline"><button class="btn small" id="backE">← Back</button>
      <h2 style="margin-left:8px">${c ? 'Edit' : 'New'} contract</h2></div>
    <div class="card"><div class="body">
      ${showsMoney() ? `
      <div class="rowline"><label>Name</label>
        <input type="text" id="cName" value="${f('name')}" style="flex:1;min-width:220px"></div>
      <div class="rowline"><label>Owner</label>
        <select id="cExec"><option value="">Unassigned</option>
          ${people.map((p) => `<option value="${p.id}"${c?.exec_person_id === p.id ? ' selected' : ''}>${esc(p.name)}${p.active ? '' : ' (inactive)'}</option>`).join('')}
        </select></div>
      <div class="rowline"><label>Type</label>
        <select id="cType">
          <option value="retainer"${c?.type === 'retainer' ? ' selected' : ''}>Retainer — balances monthly</option>
          <option value="pot"${c?.type === 'pot' ? ' selected' : ''}>Fixed pot — drawn down over a period</option>
          <option value="internal"${c?.type === 'internal' ? ' selected' : ''}>Internal</option>
        </select>
        <label style="margin-left:14px">Status</label>
        <select id="cStatus">
          ${['live', 'hold', 'pipeline'].map((s) => `<option value="${s}"${c?.status === s ? ' selected' : ''}>${s}</option>`).join('')}
        </select></div>
      <div class="rowline"><label>Monthly units</label>
        <input type="number" id="cUnits" step="0.5" min="0" value="${f('monthly_units', 0)}">
        <span class="muted">1 unit = £${h(S.boot.settings.standard_rate)} of contract value</span></div>
      <div class="rowline"><label>Pot units</label>
        <input type="number" id="cPot" step="0.5" min="0" value="${f('pot_units', 0)}">
        <span class="muted">Drawn over the contract's run dates below.</span></div>
      <div class="rowline"><label>Department</label>
        <select id="cDept">
          <option value="marketing"${(c?.department || 'marketing') === 'marketing' ? ' selected' : ''}>Marketing</option>
          <option value="design"${c?.department === 'design' ? ' selected' : ''}>Design</option>
        </select></div>
      <div class="rowline"><label>Runs from</label>
        <input type="date" id="cFrom" value="${f('starts_on')}" style="width:160px">
        <label style="min-width:auto">to</label>
        <input type="date" id="cTo" value="${f('ends_on')}" style="width:160px">
        <span class="muted">Optional. Work is only scheduled between these dates.</span></div>
      ` : `<p class="muted" style="padding:0 16px 4px">The commercial terms — value, type, status, dates and owner —
        are set by an administrator. You can update the notes and the Harvest mapping here, and run
        delivery on the tabs below.</p>`}
      <div class="rowline"><label>Harvest projects</label>
        <input type="text" id="cHarvest" value="${f('harvest_ids')}" placeholder="comma-separated project ids" style="flex:1;min-width:220px"></div>
      <div class="rowline"><label>Notes</label>
        <input type="text" id="cNotes" value="${f('notes')}" style="flex:1;min-width:220px"></div>
      <div class="rowline"><span class="spacer"></span>
        ${c && showsMoney() ? '<button class="btn danger small" id="cDel">Archive</button>' : ''}
        <button class="btn primary" id="cSave">Save</button></div>
    </div></div>`;

  $('#backE').addEventListener('click', () => { if (c) renderContractDetail(c.id); else { S.contractId = null; renderContracts(); } });

  $('#cSave').addEventListener('click', async () => {
    const body = showsMoney() ? {
      id: c?.id, name: $('#cName').value.trim(), exec_person_id: Number($('#cExec').value) || null,
      type: $('#cType').value, status: $('#cStatus').value,
      monthly_units: Number($('#cUnits').value), pot_units: Number($('#cPot').value),
      starts_on: $('#cFrom').value || null, ends_on: $('#cTo').value || null,
      department: $('#cDept').value,
      harvest_ids: $('#cHarvest').value.trim(),
      notes: $('#cNotes').value.trim(),
    } : {
      id: c?.id,
      harvest_ids: $('#cHarvest').value.trim(),
      notes: $('#cNotes').value.trim(),
    };
    if (showsMoney() && !body.name) return toast('Give the contract a name.', true);
    if (showsMoney() && body.starts_on && body.ends_on && body.ends_on < body.starts_on) {
      return toast('The end date is before the start date.', true);
    }
    S.boot.contracts = await api('/api/contracts', { body });
    toast('Contract saved.');
    S.contractId = c?.id || S.boot.contracts.find((x) => x.name === body.name)?.id || null;
    renderContracts();
  });
  const del = $('#cDel');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Archive ${c.name}? Its allocations stay in the database but it drops off every view.`)) return;
    S.boot.contracts = await api(`/api/contracts/${c.id}`, { method: 'DELETE' });
    S.contractId = null; renderContracts();
  });
}

// ---------------------------------------------------------------------------
// Internal & training. Hours lead throughout — this is capacity we have chosen
// not to sell, so clock time is the meaningful measure. Units are shown only
// because a senior hour still costs more than a junior one.
// ---------------------------------------------------------------------------

async function renderInternal() {
  const a = await api(`/api/agency${P()}`);
  const contract = S.boot.contracts.find((c) => c.type === 'internal');
  if (!contract) { view().innerHTML = '<p class="muted">No internal contract set up.</p>'; return; }
  const summary = a.contracts.find((c) => c.type === 'internal');

  const kinds = S.boot.deliverables.filter((d) => d.internal);
  const hoursOf = (pid, did) => summary.lines
    .filter((l) => l.person_id === pid && l.deliverable_id === did)
    .reduce((s, l) => s + l.hours, 0);

  // everyone on the team, plus anyone who has left but still holds hours here
  const withHours = new Set(summary.lines.map((l) => l.person_id));
  const extra = S.boot.people
    .filter((p) => withHours.has(p.id) && !a.staff.some((s) => s.person_id === p.id))
    .map((p) => ({ person_id: p.id, name: p.name, available_hours: 0, gone: true }));

  const rows = [...a.staff, ...extra].map((p) => ({
    ...p, alloc: kinds.reduce((s, d) => s + hoursOf(p.person_id, d.id), 0),
  }));

  const total = rows.reduce((s, r) => s + r.alloc, 0);
  const stale = rows.filter((r) => r.gone && r.alloc > 0);
  const busiest = [...rows].filter((r) => !r.gone).sort((x, y) => y.alloc - x.alloc)[0];

  view().innerHTML = `
    <div class="stats">
      <div class="stat"><span class="k">Internal hours</span><span class="v">${hrs(total)}</span>
        <span class="s">recorded this month across ${rows.filter((r) => r.alloc > 0).length} people</span></div>
      ${kinds.map((d) => {
        const dh = rows.reduce((s, r) => s + hoursOf(r.person_id, d.id), 0);
        return `<div class="stat"><span class="k">${esc(d.name)}</span><span class="v">${hrs(dh)}</span>
          <span class="s">${pct(total ? (dh / total) * 100 : 0)} of internal time</span></div>`;
      }).join('')}
    </div>

    ${stale.length ? `<div class="banner"><div>
      <b>${esc(stale.map((r) => r.name).join(', '))} still ${stale.length > 1 ? 'hold' : 'holds'}
      ${hrs(stale.reduce((s, r) => s + r.alloc, 0))} of internal time but ${stale.length > 1 ? 'are' : 'is'} no longer active.</b><br>
      Clear the hours below, or archive them in Settings.
    </div></div>` : ''}

    <div class="card">
      <header><h2>Internal &amp; training</h2><p>Hours recorded — there is nothing to reconcile this against</p></header>
      <div class="scroll"><table class="big">
        <thead><tr>
          <th>Person</th>
          ${kinds.map((d) => `<th class="num person">${esc(d.name)}</th>`).join('')}
          <th class="num">Total</th><th class="num">Share of their month</th>
        </tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.gone ? 'archived' : ''}">
          <td><button class="linky" data-person="${r.person_id}">${esc(r.name)}</button></td>
          ${kinds.map((d) => `<td class="num person"><input type="number" class="inh" step="0.25" min="0"
            data-p="${r.person_id}" data-d="${d.id}" value="${h(hoursOf(r.person_id, d.id))}"></td>`).join('')}
          <td class="num"><b>${hrs(r.alloc)}</b></td>
          <td class="num">${r.gone || !r.available_hours ? '—'
            : pct((r.alloc / r.available_hours) * 100)}</td>
        </tr>`).join('')}
        <tr class="total">
          <td>Total</td>
          ${kinds.map((d) => `<td class="num person">${hrs(rows.reduce((s, r) => s + hoursOf(r.person_id, d.id), 0))}</td>`).join('')}
          <td class="num">${hrs(total)}</td><td class="num"></td>
        </tr></tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <p class="muted">Internal time is not sold, so it has no contracted value and nothing to
        balance against — these are simply the hours booked.
        ${busiest && busiest.alloc ? `${esc(busiest.name)} carries the most at ${hrs(busiest.alloc)}.` : ''}
        Sellable hours are governed separately by each person's utilisation target on the Settings page.</p>
      </div>
    </div>`;

  view().querySelectorAll('.inh').forEach((el) => el.addEventListener('change', async () => {
    await api('/api/allocation', { body: {
      contract_id: contract.id, period: S.period, person_id: Number(el.dataset.p),
      deliverable_id: Number(el.dataset.d), hours: Number(el.value) } });
    renderInternal();
  }));
}

const cap2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// 4 — Schedule. Hours only; units never appear.
// ---------------------------------------------------------------------------

async function renderSchedule() {
  const everyone = S.boot.people.filter((p) => p.active && !p.archived);
  const people = S.me?.role === 'admin' ? everyone : everyone.filter((p) => p.id === S.me.person_id);
  if (!S.personId || !people.some((p) => p.id === S.personId)) S.personId = people[0]?.id;
  if (!S.personId) { view().innerHTML = '<p class="muted">No active people.</p>'; return; }

  const plan = await api(`/api/schedule/${S.personId}${P()}`);
  const pv = await api(`/api/person/${S.personId}${P()}`);
  const dates = await api(`/api/workdays${P()}`);
  const recipes = S.showRecipes ? await api(`/api/person-recipes/${S.personId}`) : [];
  const state = plan.state || (plan.committed ? 'committed' : 'none');
  const editing = state === 'draft' || (state === 'committed' && S.schedEdit);

  const byDate = new Map();
  for (const b of plan.blocks) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }
  const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const dayOptions = (sel) => dates.map((d) =>
    `<option value="${d}"${d === sel ? ' selected' : ''}>${esc(dayLabel(d))}</option>`).join('');
  const contractOptions = S.boot.contracts.filter((c) => !c.archived)
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const deliverableOptions = S.boot.deliverables
    .map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');

  // The journey, spelled out. One current step, always visible, so nobody has
  // to deduce the state from which buttons happen to exist.
  const stepNo = S.showRecipes ? 1 : state === 'draft' ? 2 : state === 'committed' ? 3 : 0;
  const isSelf = S.me?.person_id === S.personId;   // your own schedule vs someone else's
  const steps = `
    <div class="steps">
      <button class="step ${stepNo === 1 ? 'on' : ''}" id="stepRecipes">
        <b>1</b> How you work</button>
      <span class="step-arrow">›</span>
      <div class="step ${stepNo === 2 ? 'on' : ''} ${stepNo < 2 && !S.showRecipes ? 'todo' : ''}">
        <b>2</b> Review the suggestion</div>
      <span class="step-arrow">›</span>
      <div class="step ${stepNo === 3 ? 'on' : ''} ${stepNo < 3 ? 'todo' : ''}">
        <b>3</b> On the time sheet</div>
    </div>`;

  const toolbar = S.showRecipes ? `
      <button class="btn small" id="toggleRecipes">Cancel</button>
      <button class="btn small primary" id="prSaveAll">Save</button>`
    : state === 'none' ? `
      <button class="btn small primary" id="genPlan"
        title="Build a schedule from this month's allocations and the recipes in step 1">Suggest a schedule</button>`
    : state === 'draft' ? `
      <button class="btn small" id="genPlan" title="Throw this suggestion away and build a fresh one">Suggest again</button>
      <button class="btn small danger" id="dropDraft">Discard suggestion</button>
      <button class="btn small primary" id="commitPlan"
        title="Happy with it? Put it on the time sheet — the team manages it from there">Send to time sheet</button>`
    : S.schedEdit ? `
      <button class="btn small primary" id="seDone">Done editing</button>`
    : `
      <button class="btn small primary" id="schedEdit"
        title="Drag blocks around the week, resize them, or click one for exact times">Edit Schedule</button>
      <button class="btn small" id="genPlan"
        title="Build a fresh suggestion to review — the time sheet keeps this plan until you send the new one">Rebuild from allocations</button>
      <button class="btn small danger" id="clearPlan"
        title="Clears what is still pending — committed time stays">Discard pending plan</button>
      <button class="btn small" id="schedCal" title="Keep a calendar app in step with this schedule">📅 Sync</button>`;

  view().innerHTML = `
    <div class="rowline">
      <label for="schedPick">Person</label>
      <select id="schedPick">${people.map((p) =>
        `<option value="${p.id}"${p.id === S.personId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      ${state === 'draft' ? '<span class="pill warn">Suggestion — not on the time sheet yet</span>'
        : state === 'committed' ? '<span class="pill ok">On the time sheet</span>' : ''}
      <span class="spacer"></span>
      ${toolbar}
    </div>
    ${steps}
    ${S.me?.role === 'admin' ? '<div id="schedTeam"></div>' : ''}

    <div class="stats">
      <div class="stat"><span class="k">Scheduled</span><span class="v">${hrs(plan.totals.scheduled_hours)}</span>
        <span class="s">${plan.totals.blocks} blocks</span></div>
      <div class="stat ${pv.totals.spare_hours < 0 ? 'bad' : 'good'}">
        <span class="k">Headroom</span><span class="v">${hrs(pv.totals.spare_hours)}</span>
        <span class="s">of ${hrs(pv.capacity.client_hours)} sellable · ${pct(pv.totals.load_pct)} loaded</span></div>
      <div class="stat ${plan.totals.unplaced_hours > 0 ? 'warn' : 'good'}">
        <span class="k">Couldn't place</span><span class="v">${hrs(plan.totals.unplaced_hours)}</span>
        <span class="s">${plan.totals.unplaced_hours > 0 ? 'not even weekend room for this' : 'everything has a slot'}</span></div>
    </div>

    ${(() => {
      const wknd = plan.blocks.filter((b) => [0, 6].includes(new Date(`${b.date}T00:00Z`).getUTCDay()));
      const wkndH = wknd.reduce((s2, b) => s2 + b.minutes, 0) / 60;
      return wknd.length ? `<div class="banner"><div>
        <b>${hrs(wkndH)} sits on weekends — the working weeks were full.</b>
        The month is oversold for ${esc(pv.person.name)}; drag the weekend blocks wherever suits,
        move work to someone with room, or trim the allocations.
      </div></div>` : '';
    })()}
    ${plan.unplaced?.length ? `<div class="banner bad"><div>
      <b>${plan.unplaced.length} sessions had nowhere at all — even the weekends are full.</b>
      ${esc([...new Set(plan.unplaced.map((u) => u.label))].slice(0, 6).join('; '))}.
    </div></div>` : ''}

    ${S.showRecipes ? `<div class="card">
      <header><h2>How you work</h2>
        <p>These recipes shape the plan. Blank rows follow the agency default in Settings</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Deliverable</th><th>Cadence</th><th>Distribution</th><th class="num">Block (min)</th>
          <th>Splittable</th><th class="num">Max sittings</th><th></th></tr></thead>
        <tbody>${recipes.map((r) => `<tr data-d="${r.id}" class="${r.overridden ? 'own' : ''}"
            data-orig="${esc(JSON.stringify([r.cadence, r.distribution, r.block_minutes ?? 60, r.splittable ? 1 : 0, r.max_sittings ?? 0]))}">
          <td>${esc(r.name)}${r.internal ? ' <span class="pill mute">internal</span>' : ''}
            ${r.overridden ? ' <span class="pill info">theirs</span>' : ''}</td>
          <td><select class="prc">${['daily', 'weekly', 'fortnightly', 'monthly', 'oneoff'].map((x) =>
            `<option${r.cadence === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
          <td><select class="prd">${['spread', 'frontload', 'deadline'].map((x) =>
            `<option${r.distribution === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
          <td class="num"><input type="number" class="prb" step="15" min="15" value="${r.block_minutes ?? 60}"></td>
          <td><input type="checkbox" class="prs"${r.splittable ? ' checked' : ''}></td>
          <td class="num"><input type="number" class="prm" step="1" min="0" value="${r.max_sittings ?? 0}"
            title="0 = let the block size decide. A daily ceiling overrides this either way."></td>
          <td class="num" style="white-space:nowrap">
            ${r.overridden ? '<button class="btn small prReset">Default</button>' : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <p class="muted"><b>Max sittings</b> caps how many separate blocks one allocation is broken
        into. Leave it 0 and the block size decides. If a block would not physically fit a day,
        the daily ceiling wins and it splits further. To pin something to a fixed day and time,
        add it as a <b>Fixed commitment</b> on the contract.</p>
      </div>
    </div>` : ''}

    ${!S.showRecipes && state === 'none' ? `<div class="card">
      <div class="body" style="text-align:center;padding:40px 20px">
        <h2 style="margin-bottom:8px">No schedule for ${esc(monthName(S.period))} yet</h2>
        <p class="muted" style="max-width:52ch;margin:0 auto 6px">Step 1 shapes how ${esc(pv.person.name)} likes to work;
        <b>Suggest a schedule</b> then lays their allocated hours out for review. Nothing touches the
        time sheet until you send it there.</p>
      </div>
    </div>` : ''}

    ${!S.showRecipes && editing ? `<div id="seCal"></div>

    <div class="card">
      <header><h2>Add a block</h2><p>Work the recipes knew nothing about</p></header>
      <div class="body"><div class="rowline">
        <select id="nbC"><option value="">No contract</option>${contractOptions}</select>
        <select id="nbD"><option value="">No deliverable</option>${deliverableOptions}</select>
        <select id="nbDate">${dayOptions(dates[0])}</select>
        <input type="time" id="nbStart" value="09:00" style="width:110px">
        <input type="number" id="nbH" step="0.25" min="0.25" value="1"><span class="muted">h</span>
        <button class="btn small primary" id="addBlock">Add</button>
      </div></div>
    </div>` : ''}

    ${!S.showRecipes && state === 'committed' && !S.schedEdit ? `
    <div class="weekgrid">${[...byDate.entries()].map(([date, blocks]) => `
      <div class="day">
        <h4><span>${esc(dayLabel(date))}</span>
          <span>${hrs(blocks.reduce((s, b) => s + b.minutes, 0) / 60)}</span></h4>
        ${blocks.map((b) => `
          <div class="blk${b.anchored ? ' fixed' : ''}${b.manual ? ' manual' : ''}${b.accounted ? ' done' : ''}">
            <span class="t">${esc(b.start || '')}${b.end ? `–${esc(b.end)}` : ''}</span>
            <span>${esc(b.label)}${b.anchored ? ' <span class="pill info">fixed</span>' : ''}${
              b.accounted ? ' <span class="pill ok">✓ done</span>' : ''}</span>
            <span class="m">${hrs(b.minutes / 60)}</span>
          </div>`).join('')}
      </div>`).join('') || '<p class="muted">Nothing scheduled this month.</p>'}</div>` : ''}`;

  // ---- wiring ---------------------------------------------------------------
  $('#schedPick').addEventListener('change', (e) => { S.personId = Number(e.target.value); S.schedWeek = 0; renderSchedule(); });
  $('#stepRecipes')?.addEventListener('click', () => { S.showRecipes = true; renderSchedule(); });
  $('#toggleRecipes')?.addEventListener('click', () => { S.showRecipes = false; renderSchedule(); });
  $('#schedCal')?.addEventListener('click', () => openCalendarPanel(false));
  $('#schedEdit')?.addEventListener('click', () => { S.schedEdit = true; S.schedWeek = S.schedWeek || 0; renderSchedule(); });
  $('#seDone')?.addEventListener('click', () => { S.schedEdit = false; renderSchedule(); });

  $('#prSaveAll')?.addEventListener('click', async () => {
    let saved = 0;
    for (const tr of view().querySelectorAll('tr[data-orig]')) {
      const now = [$('.prc', tr).value, $('.prd', tr).value, Number($('.prb', tr).value),
        $('.prs', tr).checked ? 1 : 0, Number($('.prm', tr).value)];
      if (JSON.stringify(now) === tr.dataset.orig) continue;
      await api(`/api/person-recipes/${S.personId}`, { body: {
        deliverable_id: Number(tr.dataset.d),
        cadence: now[0], distribution: now[1], block_minutes: now[2],
        splittable: !!now[3], max_sittings: now[4],
        anchor_dow: 2, anchor_time: '10:00' } });
      saved += 1;
    }
    S.showRecipes = false;
    toast(saved ? `${saved} recipe${saved === 1 ? '' : 's'} saved for this person.` : 'Nothing changed.');
    renderSchedule();
  });
  view().querySelectorAll('.prReset').forEach((btn) => btn.addEventListener('click', async () => {
    await api(`/api/person-recipes/${S.personId}/${btn.closest('tr').dataset.d}`, { method: 'DELETE' });
    toast('Back to the agency default.');
    renderSchedule();
  }));

  $('#genPlan')?.addEventListener('click', async () => {
    if (state === 'committed'
      && !confirm('Build a fresh suggestion? The pending plan is replaced by it once you review and send it — committed time stays either way.')) return;
    const r = await api(`/api/schedule/${S.personId}/generate${P()}`, { method: 'POST', body: {} });
    S.schedWeek = 0;
    toast(`Suggested ${r.saved} blocks${r.kept ? ` around ${r.kept} committed` : ''}`
      + `${r.weekend ? ` — ${h(r.weekend_hours)} h parked on weekends, the weeks were full` : ''}`
      + `${r.unplaced ? ` — ${r.unplaced} sessions had nowhere at all` : ''}.`);
    renderSchedule();
  });
  $('#commitPlan')?.addEventListener('click', async () => {
    const r = await api(`/api/schedule/${S.personId}/commit${P()}`, { method: 'POST', body: {} });
    S.schedEdit = false;
    toast(`On the time sheet — ${r.committed} blocks. The team confirms them day by day.`);
    renderSchedule();
  });
  $('#dropDraft')?.addEventListener('click', async () => {
    if (!confirm('Throw this suggestion away? The time sheet never saw it.')) return;
    await api(`/api/schedule/${S.personId}/draft${P()}`, { method: 'DELETE' });
    renderSchedule();
  });
  const clear = $('#clearPlan');
  if (clear) clear.addEventListener('click', async () => {
    if (!confirm('Discard the pending plan? Committed time stays.')) return;
    await api(`/api/schedule/${S.personId}/plan${P()}`, { method: 'DELETE' });
    toast('Pending plan discarded.');
    renderSchedule();
  });

  $('#addBlock')?.addEventListener('click', async () => {
    const contractId = Number($('#nbC').value) || null;
    await api('/api/schedule/block', { body: {
      person_id: S.personId, period: S.period,
      contract_id: contractId,
      deliverable_id: Number($('#nbD').value) || null,
      date: $('#nbDate').value, start: $('#nbStart').value,
      minutes: Math.round(Number($('#nbH').value) * 4) * 15,
      draft: state === 'draft',
    } });
    toast('Block added.');
    await renderSchedule();
    maybePlanCheck(contractId, null);
  });

  if (editing) renderSchedEditor(plan, dates);
  if (S.me?.role === 'admin') renderSchedTeam();
}

/**
 * The month at a glance for whoever runs it: whose plan is live, whose is a
 * suggestion nobody sent, who has none — and what is still unconfirmed. The
 * answer used to require opening every person in turn.
 */
async function renderSchedTeam() {
  const el = document.getElementById('schedTeam');
  if (!el) return;
  const o = await api(`/api/schedule-overview${P()}`);
  const none = o.rows.filter((r) => r.state === 'none');
  const draft = o.rows.filter((r) => r.state === 'draft');
  const badge = (r) => (r.state === 'committed' ? '<span class="pill ok">on the time sheet</span>'
    : r.state === 'draft' ? '<span class="pill warn">suggestion — not sent</span>'
      : '<span class="pill mute">no plan</span>');
  el.innerHTML = `
    ${none.length || draft.length ? `<div class="banner"><div>
      <b>${esc(monthName(S.period))}:</b>
      ${none.length ? `${none.length} ${none.length === 1 ? 'person has' : 'people have'} no plan on the time sheet
        (${esc(none.map((r) => r.name.split(' ')[0]).join(', '))})` : ''}
      ${none.length && draft.length ? ' · ' : ''}
      ${draft.length ? `${draft.length} still a suggestion nobody sent
        (${esc(draft.map((r) => r.name.split(' ')[0]).join(', '))})` : ''}.
      Their team can't confirm work that never reached the time sheet.
    </div></div>` : ''}
    <div class="card"><header><h2>The team this month</h2>
      <p>Click a name to open their schedule</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Person</th><th>Status</th><th class="num">Planned</th>
          <th class="num" title="How the plan compares with what the allocations call for: hours still to schedule, or hours planned beyond them">vs allocated</th>
          <th class="num">Logged</th>
          <th class="num" title="Blocks in the past nobody has confirmed or skipped">Unconfirmed</th></tr></thead>
        <tbody>${o.rows.map((r) => `<tr class="${r.person_id === S.personId ? 'on' : ''}">
          <td><button class="linky schedWho" data-p="${r.person_id}">${esc(r.name)}</button></td>
          <td>${badge(r)}</td>
          <td class="num">${hrs(r.planned_hours)}</td>
          <td class="num">${r.unscheduled_hours
            ? `<span class="pill warn" title="allocated but not yet on the calendar">${hrs(r.unscheduled_hours)} to plan</span>`
            : r.overplanned_hours
              ? `<span class="pill bad" title="planned beyond what the allocations call for">${hrs(r.overplanned_hours)} over</span>`
              : '<span class="nil">—</span>'}</td>
          <td class="num">${r.logged_hours ? hrs(r.logged_hours) : '<span class="nil">—</span>'}</td>
          <td class="num">${r.unconfirmed_blocks ? `<span class="pill warn">${r.unconfirmed_blocks}</span>` : '<span class="nil">—</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  el.querySelectorAll('.schedWho').forEach((b) => b.addEventListener('click', () => {
    S.personId = Number(b.dataset.p); S.schedEdit = false; S.showRecipes = false; renderSchedule();
  }));
}

// ---------------------------------------------------------------------------
// 5 — Settings.
// ---------------------------------------------------------------------------

async function renderSettings() {
  const recipes = await api('/api/recipes');
  const anchors = await api('/api/anchors');
  const patterns = await api('/api/person-days');
  const st = S.boot.settings;
  const DOW = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  // one cell per weekday: "09:00-17:30", or blank for a day off
  const patternCell = (p, dow) => {
    const own = (patterns[p.id] || []).find((d) => d.dow === dow);
    const std = `${st.work_start}-${st.work_end}`;
    const val = patterns[p.id] ? (own ? `${own.start}-${own.end}` : '') : std;
    return `<td><input type="text" class="wpd" data-dow="${dow}" value="${esc(val)}"
      placeholder="off" style="width:96px;text-align:center"></td>`;
  };

  view().innerHTML = `
    <div class="card">
      <header><h2>People &amp; rates</h2>
        <label class="tick"><input type="checkbox" id="showArch"${S.showArchived ? ' checked' : ''}> show archived</label>
      </header>
      <div class="scroll"><table>
        <thead><tr><th>Name</th><th>Initials</th><th>Department</th><th class="num">Hours/week</th><th class="num">Rate £/h</th>
          <th class="num">Utilisation</th><th class="num">Units/h</th><th>Slack ID</th><th>Active</th><th></th></tr></thead>
        <tbody>${S.boot.people.map((p) => `<tr data-p="${p.id}" class="${p.archived ? 'archived' : ''}">
          <td><input type="text" class="pn" value="${esc(p.name)}" style="width:150px"></td>
          <td><input type="text" class="pi" value="${esc(p.initials)}" style="width:56px"></td>
          <td><select class="pd">
            <option value="marketing"${(p.department || 'marketing') === 'marketing' ? ' selected' : ''}>Marketing</option>
            <option value="design"${p.department === 'design' ? ' selected' : ''}>Design</option>
            <option value="management"${p.department === 'management' ? ' selected' : ''}>Management — shared</option></select></td>
          <td class="num"><input type="number" class="pw" step="0.5" min="0" value="${h(p.weekly_hours)}"></td>
          <td class="num"><input type="number" class="pr" step="0.1" min="0" value="${h(p.rate)}"></td>
          <td class="num"><input type="number" class="pu" step="1" min="0" max="100" value="${Math.round(p.utilisation * 100)}"></td>
          <td class="num">${h(p.rate / st.standard_rate)}</td>
          <td><input type="text" class="psl" value="${esc(p.slack_user_id || '')}" placeholder="U012ABCDEF"
            title="Slack profile → ⋮ → Copy member ID" style="width:110px"></td>
          <td><input type="checkbox" class="pa"${p.active ? ' checked' : ''}></td>
          <td class="num" style="white-space:nowrap">
            <button class="btn small primary savep">Save</button>
            ${p.archived
              ? '<button class="btn small restp">Restore</button>'
              : '<button class="btn small archp">Archive</button>'}
            <button class="btn small danger delp">Delete</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <div class="rowline"><label>Add person</label>
          <input type="text" id="npName" placeholder="Name" style="width:170px">
          <input type="text" id="npIni" placeholder="Ini" style="width:56px">
          <input type="number" id="npWk" value="37.5" step="0.5" title="hours/week">
          <input type="number" id="npRate" value="100" step="0.1" title="£/hour">
          <input type="number" id="npUtil" value="87" step="1" title="utilisation %">
          <button class="btn small primary" id="addPerson">Add</button></div>
      </div>
    </div>

    <div class="card">
      <header><h2>Working patterns</h2>
        <p>Who works when. Capacity, the scheduler and the Slack status all follow this</p></header>
      <div class="body" style="border-bottom:1px solid var(--rule)">
        <p class="muted">Each cell is a day's hours as <span class="mono">09:00-17:30</span>; blank
        means a day off. Lunch comes out automatically, the same as everywhere else. Saving a pattern
        re-derives the person's hours/week; <b>Reset</b> returns them to the standard week (then set
        their hours/week above yourself — it keeps the pattern's figure). Someone on
        3.5 days might be <span class="mono">09:00-17:30</span> Monday to Wednesday and
        <span class="mono">09:00-13:00</span> on Thursday, with Friday blank.</p>
      </div>
      <div class="scroll"><table>
        <thead><tr><th>Person</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th>
          <th class="num">Hours/wk</th><th></th></tr></thead>
        <tbody>${S.boot.people.filter((p) => !p.archived && p.active).map((p) => `<tr data-wp="${p.id}">
          <td class="name">${esc(p.name)}
            ${patterns[p.id] ? '<span class="pill ok">custom</span>' : '<span class="pill mute">standard</span>'}</td>
          ${[1, 2, 3, 4, 5].map((d) => patternCell(p, d)).join('')}
          <td class="num">${h(p.weekly_hours)}</td>
          <td class="num" style="white-space:nowrap">
            <button class="btn small primary wpSave">Save</button>
            ${patterns[p.id] ? '<button class="btn small wpReset">Reset</button>' : ''}
          </td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <header><h2>Third-party rate card</h2><p>Each service consumes contract units without consuming anyone's hours</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Service</th><th class="num">Default units</th><th class="num"></th></tr></thead>
        <tbody>${S.boot.third_parties.map((t) => `<tr data-t="${t.id}">
          <td><input type="text" class="tn" value="${esc(t.name)}" style="width:250px"></td>
          <td class="num"><input type="number" class="td" step="0.25" min="0" value="${h(t.default_units)}"></td>
          <td class="num"><button class="btn small primary savet">Save</button>
            <button class="btn small danger delt">Remove</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <div class="rowline"><label>Add service</label>
          <input type="text" id="ntName" placeholder="e.g. SE Ranking — list management" style="flex:1;min-width:220px">
          <input type="number" id="ntUnits" value="1" step="0.25" min="0">
          <span class="muted">units</span>
          <button class="btn small primary" id="addTp">Add</button></div>
      </div>
    </div>

    <div class="card">
      <header><h2>Scheduling recipes</h2>
        <p>Agency defaults · a person can override these on their Schedule tab</p></header>
      <div class="body" style="border-bottom:1px solid var(--rule)">
        <p class="muted"><b>Cadence</b> is how often the work recurs — daily, weekly, fortnightly,
        monthly, or a one-off. <b>Distribution</b> is where in the month it lands: spread evenly,
        front-loaded, or against the deadline. <b>Block</b> is how long one sitting runs and
        <b>Max sittings</b> caps how many sittings one allocation becomes — leave it 0 and the block
        size decides. Both are preferences: if a block would not fit a day, the per-client daily
        ceiling splits it further regardless, which is why a 12h build always lands as 3 x 4h.
        To pin work to a fixed day and time, use <b>Fixed commitments</b> on the contract itself.</p>
      </div>
      <div class="scroll"><table>
        <thead><tr><th>Deliverable</th><th>Cadence</th><th>Distribution</th><th class="num">Block (min)</th>
          <th>Splittable</th><th class="num">Max sittings</th><th></th></tr></thead>
        <tbody>${recipes.map((r) => `<tr data-d="${r.id}">
          <td><input type="text" class="dn" value="${esc(r.name)}" style="width:210px">${r.internal ? ' <span class="pill mute">internal</span>' : ''}</td>
          <td><select class="rc">${['daily', 'weekly', 'fortnightly', 'monthly', 'oneoff'].map((x) =>
            `<option${r.cadence === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
          <td><select class="rd">${['spread', 'frontload', 'deadline'].map((x) =>
            `<option${r.distribution === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
          <td class="num"><input type="number" class="rb" step="15" min="15" value="${r.block_minutes ?? 60}"></td>
          <td><input type="checkbox" class="rs"${r.splittable ? ' checked' : ''}></td>
          <td class="num"><input type="number" class="rm" step="1" min="0" value="${r.max_sittings ?? 0}"></td>
          <td class="num"><button class="btn small primary saver">Save</button>
            <button class="btn small danger deld">Remove</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <div class="rowline"><label>Add deliverable</label>
          <input type="text" id="ndName" placeholder="e.g. Email marketing" style="flex:1;min-width:220px">
          <label class="muted"><input type="checkbox" id="ndInternal"> internal</label>
          <button class="btn small primary" id="addDeliv">Add</button></div>
      </div>
    </div>

    <div class="grid2">
      <div class="card">
        <header><h2>Working day</h2><p>The window the scheduler packs into</p></header>
        <div class="body">
          <div class="rowline"><label>Day starts</label><input type="time" id="sWs" value="${esc(st.work_start)}"></div>
          <div class="rowline"><label>Day ends</label><input type="time" id="sWe" value="${esc(st.work_end)}"></div>
          <div class="rowline"><label>Lunch</label><input type="time" id="sLs" value="${esc(st.lunch_start)}">
            <input type="number" id="sLm" value="${st.lunch_minutes}" step="15" min="0"><span class="muted">min</span></div>
          <div class="rowline"><label>Max per client/day</label>
            <input type="number" id="sMax" value="${st.max_client_minutes_per_day}" step="30" min="30"><span class="muted">min</span></div>
          <div class="rowline"><label>Standard rate</label>
            <input type="number" id="sRate" value="${h(st.standard_rate)}" step="1" min="1"><span class="muted">£ = 1 unit</span></div>
          <div class="rowline"><label>Bank holidays</label>
            <input type="text" id="sHols" value="${esc(st.holidays)}" placeholder="2026-08-31, 2026-12-25" style="flex:1;min-width:180px"></div>
          <div class="rowline"><span class="spacer"></span><button class="btn primary small" id="saveSettings">Save</button></div>
        </div>
      </div>

      <div class="card" style="grid-column:1/-1">
        <header><h2>Who can sign in</h2>
          <p>A member sees only their own month, in hours. Rates and units never reach them</p></header>
        <div class="scroll"><table>
          <thead><tr><th>Person</th><th>Email</th><th>Role</th><th>Sign-in</th><th></th></tr></thead>
          <tbody>${S.boot.people.filter((p) => !p.archived).map((p) => `<tr data-l="${p.id}">
            <td class="name">${esc(p.name)}</td>
            <td><input type="email" class="lgEmail" value="${esc(p.email || '')}"
              placeholder="none set" style="width:190px"></td>
            <td><select class="lgRole">
              <option value="member"${p.role !== 'admin' ? ' selected' : ''}>Member</option>
              <option value="admin"${p.role === 'admin' ? ' selected' : ''}>Admin</option>
            </select></td>
            <td>${p.has_login
              ? '<span class="pill ok">Can sign in</span>'
              : '<span class="pill mute">No password</span>'}</td>
            <td class="num" style="white-space:nowrap">
              <input type="password" class="lgPass" placeholder="Set a password" style="width:150px">
              <button class="btn small primary lgSave">Save</button>
              ${p.has_login ? '<button class="btn small danger lgRevoke">Revoke</button>' : ''}
            </td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="body" style="border-top:1px solid var(--rule)">
          <p class="muted">Give someone an email and a password and they can sign in as themselves.
          <b>Admin</b> sees everything you see. <b>Member</b> sees their own month and schedule only —
          no agency view, no contracts, no settings, and no money of any kind. Revoking clears their
          password and signs out every device they are on.</p>
        </div>
      </div>

      <div class="card">
        <header><h2>Access</h2>
          <p>${st.gate_on
            ? (st.passcode_set ? '<span class="pill ok">Passcode set here</span>'
                               : '<span class="pill warn">Still using the deploy setting</span>')
            : '<span class="pill bad">No passcode — anyone with the link is in</span>'}</p></header>
        <div class="body">
          ${st.gate_on ? `<div class="rowline">
            <label>Current</label>
            <input type="password" id="pcCur" autocomplete="current-password" style="flex:1;min-width:150px">
          </div>` : ''}
          <div class="rowline"><label>New passcode</label>
            <input type="password" id="pcNew" autocomplete="new-password" style="flex:1;min-width:150px"></div>
          <div class="rowline"><label>Repeat it</label>
            <input type="password" id="pcConf" autocomplete="new-password" style="flex:1;min-width:150px"></div>
          <div class="rowline"><span class="spacer"></span>
            <button class="btn primary small" id="pcSave">Change passcode</button></div>
          <p class="muted">At least 8 characters. Everyone shares this one passcode, so changing it
          signs out every other device — you will stay signed in here. It is stored hashed, never in
          plain text, and it takes effect immediately without a redeploy.</p>
          ${st.passcode_set ? '' : `<p class="muted">Right now the passcode still comes from the
          <span class="mono">APP_PASSCODE</span> deploy setting. Setting one here takes over from it.</p>`}
        </div>
      </div>

      <div class="card">
        <header><h2>Harvest</h2>
          <p>${st.harvest_connected ? '<span class="pill ok">Connected</span>' : '<span class="pill warn">Not connected</span>'}</p></header>
        <div class="body">
          <div class="rowline"><label>Account ID</label>
            <input type="text" id="hAcc" value="${esc(st.harvest_account_id)}" style="width:150px"></div>
          <div class="rowline"><label>Token</label>
            <input type="password" id="hTok" placeholder="${st.harvest_connected ? '•••••• stored' : 'personal access token'}" style="flex:1;min-width:180px"></div>
          <p class="muted">Create both at id.getharvest.com → Developers → Personal Access Tokens.</p>
          <div class="rowline">
            <button class="btn primary small" id="saveHarvest">Save</button>
            <button class="btn small" id="syncPeople">Pull team</button>
          </div>
          ${st.last_sync ? `<p class="muted">Last actuals sync: ${esc(new Date(st.last_sync).toLocaleString('en-GB'))}</p>` : ''}
        </div>
      </div>

      <div class="card" style="grid-column:1/-1">
        <header><h2>Slack status sync</h2>
          <p>${st.slack_connected
            ? (st.slack_enabled ? '<span class="pill ok">On</span>' : '<span class="pill warn">Connected, not enabled</span>')
            : '<span class="pill mute">Not connected</span>'}</p></header>
        <div class="body">
          <p class="muted">During the agency working day, anyone whose pattern says they are off gets a
          Slack status — ${esc(st.slack_status_emoji)} <b>${esc(st.slack_status_text)}</b> — with an expiry,
          so Slack clears it by itself when they are back. Evenings, weekends and bank holidays are left
          alone, and an existing status (holiday, illness) is never replaced unless you say so below.
          Needs each person's Slack member ID on the People card, and a working pattern.</p>
          <div class="rowline"><label>Client ID</label>
            <input type="text" id="skCid" value="${esc(st.slack_client_id || '')}" placeholder="from the app's Basic Information page" style="flex:1;min-width:220px"></div>
          <div class="rowline"><label>Client Secret</label>
            <input type="password" id="skCsec" placeholder="${st.slack_oauth_ready ? '•••••• stored' : 'Basic Information → Client Secret → Show'}" style="flex:1;min-width:220px"></div>
          <div class="rowline"><span class="spacer"></span>
            <button class="btn primary small" id="skConnect"${st.slack_oauth_ready ? '' : ' disabled title="Save the Client ID and Secret first"'}>Connect to Slack</button></div>
          <p class="muted">Save the Client ID and Secret, then <b>Connect to Slack</b> — you approve on
          Slack's screen and land back here with the token stored server-side; it is never shown to
          anyone. If you have a token from elsewhere you can still paste it below instead.</p>
          <div class="rowline"><label>Token</label>
            <input type="password" id="skTok" placeholder="${st.slack_connected ? '•••••• stored' : 'or paste an xoxp- user token'}" style="flex:1;min-width:220px"></div>
          <div class="rowline"><label>Status</label>
            <input type="text" id="skText" value="${esc(st.slack_status_text)}" maxlength="100" style="width:180px">
            <input type="text" id="skEmoji" value="${esc(st.slack_status_emoji)}" style="width:140px" title="an emoji name like :no_entry_sign:"></div>
          <div class="rowline">
            <label class="tick"><input type="checkbox" id="skOn"${st.slack_enabled ? ' checked' : ''}> Sync every five minutes</label>
            <label class="tick"><input type="checkbox" id="skOver"${st.slack_override ? ' checked' : ''}> Replace an existing status</label></div>
          <div class="rowline">
            <button class="btn primary small" id="skSave">Save</button>
            <button class="btn small" id="skTest">Test connection</button>
            <button class="btn small" id="skRun">Apply now</button></div>
          <p class="muted">The token is a <b>user token</b> (<span class="mono">xoxp-</span>) from a private
          Slack app with <span class="mono">users.profile:read</span> and
          <span class="mono">users.profile:write</span> user scopes, installed by a workspace owner or
          admin — Slack only lets an admin on a paid plan set someone else's status.</p>
          ${(st.slack_log || []).length ? `<div class="scroll"><table>
            <thead><tr><th>When</th><th>What</th></tr></thead>
            <tbody>${st.slack_log.map((l) => `<tr>
              <td style="white-space:nowrap">${esc(new Date(l.time).toLocaleString('en-GB'))}</td>
              <td>${l.level === 'error' ? '<span class="pill bad">error</span> ' : ''}${esc(l.message)}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : ''}
        </div>
      </div>
    </div>

    <div class="card">
      <header><h2>Unmatched Harvest tasks</h2><p>Time logged this month that didn't map to a deliverable</p></header>
      <div class="body" id="unmapped"><p class="muted">Loading…</p></div>
    </div>`;

  wireSettings();
  loadUnmapped();
}

function wireSettings() {
  view().querySelectorAll('.savep').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    S.boot.people = await api('/api/people', { body: {
      id: Number(tr.dataset.p),
      name: $('.pn', tr).value, initials: $('.pi', tr).value,
      weekly_hours: Number($('.pw', tr).value), rate: Number($('.pr', tr).value),
      utilisation: Number($('.pu', tr).value) / 100, active: $('.pa', tr).checked,
      department: $('.pd', tr).value, slack_user_id: $('.psl', tr).value.trim() } });
    toast('Person saved.'); renderSettings();
  }));

  $('#showArch').addEventListener('change', async (e) => {
    S.showArchived = e.target.checked;
    S.boot = await api(`/api/bootstrap${P()}${S.showArchived ? '&archived=1' : ''}`);
    renderSettings();
  });

  const reloadPeople = async () => {
    S.boot = await api(`/api/bootstrap${P()}${S.showArchived ? '&archived=1' : ''}`);
    renderSettings();
  };

  view().querySelectorAll('.archp').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr'); const name = $('.pn', tr).value;
    if (!confirm(`Archive ${name}?\n\nThey drop out of capacity and every grid, but their history stays.`)) return;
    await api(`/api/people/${tr.dataset.p}`, { method: 'DELETE' });
    toast(`${name} archived.`); reloadPeople();
  }));

  view().querySelectorAll('.restp').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    await api('/api/restore', { body: { person_id: Number(tr.dataset.p) } });
    toast(`${$('.pn', tr).value} restored.`); reloadPeople();
  }));

  view().querySelectorAll('.delp').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr'); const name = $('.pn', tr).value;
    if (!confirm(`Permanently delete ${name}?\n\nEvery allocation of theirs, in every month, goes too. Archive instead if you only want them out of the way.`)) return;
    await api(`/api/people/${tr.dataset.p}?hard=1`, { method: 'DELETE' });
    toast(`${name} deleted.`); reloadPeople();
  }));

  $('#addPerson').addEventListener('click', async () => {
    const name = $('#npName').value.trim();
    if (!name) return toast('Name required.', true);
    S.boot.people = await api('/api/people', { body: {
      name, initials: $('#npIni').value.trim(), weekly_hours: Number($('#npWk').value),
      rate: Number($('#npRate').value), utilisation: Number($('#npUtil').value) / 100, active: true } });
    toast('Person added.'); renderSettings();
  });

  // working patterns: each cell "HH:MM-HH:MM" or blank for a day off
  view().querySelectorAll('.wpSave').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    const days = [];
    for (const inp of tr.querySelectorAll('.wpd')) {
      const v = inp.value.trim();
      if (!v) continue;
      const m = v.match(/^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/);
      if (!m) return toast(`Use 09:00-17:30 or leave the day blank (${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][inp.dataset.dow]}).`, true);
      days.push({ dow: Number(inp.dataset.dow), start: m[1], end: m[2] });
    }
    const r = await api(`/api/person-days/${tr.dataset.wp}`, { body: { days } });
    S.boot.people = r.people;
    toast(`Pattern saved — ${r.weekly_hours}h/week.`); renderSettings();
  }));
  view().querySelectorAll('.wpReset').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    const r = await api(`/api/person-days/${tr.dataset.wp}`, { body: { clear: true } });
    S.boot.people = r.people;
    toast('Back to the standard week.'); renderSettings();
  }));

  // slack sync
  const skSave = $('#skSave');
  if (skSave) {
    skSave.addEventListener('click', async () => {
      const body = {
        slack_enabled: $('#skOn').checked ? '1' : '0',
        slack_override: $('#skOver').checked ? '1' : '0',
        slack_status_text: $('#skText').value.trim() || 'Not working',
        slack_status_emoji: $('#skEmoji').value.trim() || ':no_entry_sign:',
      };
      const tok = $('#skTok').value.trim();
      if (tok) body.slack_token = tok;      // blank keeps the stored token
      const cid = $('#skCid').value.trim();
      if (cid) body.slack_client_id = cid;
      const csec = $('#skCsec').value.trim();
      if (csec) body.slack_client_secret = csec;   // blank keeps the stored secret
      await api('/api/settings', { body });
      S.boot = await api(`/api/bootstrap${P()}`);
      toast('Slack settings saved.'); renderSettings();
    });
    $('#skConnect').addEventListener('click', () => { window.location.href = '/api/slack/connect'; });
    $('#skTest').addEventListener('click', async () => {
      const r = await api('/api/slack/test', { body: {} });
      if (r.ok) toast(`Connected to ${r.team} as ${r.user}.`);
      else toast(r.error || 'Slack rejected the connection.', true);
    });
    $('#skRun').addEventListener('click', async () => {
      const r = await api('/api/slack/run', { body: {} });
      if (r.skipped && !r.checked) toast(`Nothing to do: ${r.skipped}.`);
      else toast(`Checked ${r.checked || 0} — set ${r.applied || 0}, skipped ${r.skipped || 0}.`);
      S.boot = await api(`/api/bootstrap${P()}`);
      renderSettings();
    });
  }

  view().querySelectorAll('.savet').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    S.boot.third_parties = await api('/api/third-parties', { body: {
      id: Number(tr.dataset.t), name: $('.tn', tr).value, default_units: Number($('.td', tr).value) } });
    toast('Service saved.'); renderSettings();
  }));

  view().querySelectorAll('.delt').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    if (!confirm('Remove this service from the rate card?')) return;
    S.boot.third_parties = await api(`/api/third-parties/${tr.dataset.t}`, { method: 'DELETE' });
    renderSettings();
  }));

  $('#addTp').addEventListener('click', async () => {
    const name = $('#ntName').value.trim();
    if (!name) return toast('Name the service.', true);
    S.boot.third_parties = await api('/api/third-parties', { body: { name, default_units: Number($('#ntUnits').value) } });
    toast('Service added.'); renderSettings();
  });

  view().querySelectorAll('.saver').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    await api('/api/deliverables', { body: {
      id: Number(tr.dataset.d), name: $('.dn', tr).value.trim(),
      recipe: {
        cadence: $('.rc', tr).value, distribution: $('.rd', tr).value,
        block_minutes: Number($('.rb', tr).value), splittable: $('.rs', tr).checked,
        max_sittings: Number($('.rm', tr).value),
        anchor_dow: 2, anchor_time: '10:00' } } });
    toast('Recipe saved.');
  }));

  $('#addDeliv')?.addEventListener('click', async () => {
    const name = $('#ndName').value.trim();
    if (!name) return toast('Give the deliverable a name.');
    await api('/api/deliverables', { body: { name, internal: $('#ndInternal').checked } });
    S.boot = await api(`/api/bootstrap${P()}`);
    toast('Deliverable added.'); renderSettings();
  });

  view().querySelectorAll('.deld').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    if (!confirm(`Remove "${$('.dn', tr).value.trim()}"? If it has history it is archived instead.`)) return;
    const r = await api(`/api/deliverables/${tr.dataset.d}`, { method: 'DELETE' });
    S.boot = await api(`/api/bootstrap${P()}`);
    toast(r.archived ? 'Archived — it had logged history, so it keeps its past but leaves the lists.'
      : 'Deliverable removed.');
    renderSettings();
  }));

  $('#saveSettings').addEventListener('click', async () => {
    await api('/api/settings', { body: {
      work_start: $('#sWs').value, work_end: $('#sWe').value,
      lunch_start: $('#sLs').value, lunch_minutes: $('#sLm').value,
      max_client_minutes_per_day: $('#sMax').value, standard_rate: $('#sRate').value,
      holidays: $('#sHols').value } });
    S.boot = await api(`/api/bootstrap${P()}`);
    toast('Settings saved.'); renderSettings();
  });

  const loginAction = async (btn, body) => {
    const tr = btn.closest('tr');
    try {
      S.boot.people = await api(`/api/people/${tr.dataset.l}/login`, { body });
      toast('Sign-in updated.');
      renderSettings();
    } catch (e) { toast(e.message, true); }
  };

  view().querySelectorAll('.lgSave').forEach((b) => b.addEventListener('click', () => {
    const tr = b.closest('tr');
    const body = { email: $('.lgEmail', tr).value, role: $('.lgRole', tr).value };
    const pw = $('.lgPass', tr).value;
    if (pw) body.password = pw;
    if (!body.email && pw) return toast('Give them an email address to sign in with.', true);
    loginAction(b, body);
  }));

  view().querySelectorAll('.lgRevoke').forEach((b) => b.addEventListener('click', () => {
    const tr = b.closest('tr');
    if (!confirm(`Revoke sign-in for ${$('.name', tr).textContent}?\n\nTheir password is cleared and every device they are signed in on is signed out.`)) return;
    loginAction(b, { revoke: true });
  }));

  $('#pcSave').addEventListener('click', async () => {
    const body = {
      current: $('#pcCur') ? $('#pcCur').value : '',
      next: $('#pcNew').value,
      confirm: $('#pcConf').value,
    };
    if (!body.next) return toast('Enter a new passcode.', true);
    try {
      await api('/api/passcode', { body });
      toast('Passcode changed. Other devices will need to sign in again.');
      S.boot = await api(`/api/bootstrap${P()}`);
      renderSettings();
    } catch (e) { toast(e.message, true); }
  });

  $('#saveHarvest').addEventListener('click', async () => {
    const body = { harvest_account_id: $('#hAcc').value.trim() };
    const tok = $('#hTok').value.trim();
    if (tok) body.harvest_token = tok;
    await api('/api/settings', { body });
    S.boot = await api(`/api/bootstrap${P()}`);
    toast('Harvest credentials saved.'); renderSettings();
  });

  $('#syncPeople').addEventListener('click', async () => {
    try {
      const r = await api('/api/harvest/sync-people', { method: 'POST' });
      toast(`${r.updated} matched, ${r.added} new (added inactive — switch them on above).`);
      S.boot = await api(`/api/bootstrap${P()}`);
      renderSettings();
    } catch (e) { toast(e.message, true); }
  });
}

async function loadUnmapped() {
  const box = $('#unmapped');
  if (!box) return;
  try {
    const rows = await api(`/api/harvest/unmapped${P()}`);
    if (!rows.length) { box.innerHTML = '<p class="muted">Nothing unmatched — every logged hour maps to a deliverable.</p>'; return; }
    box.innerHTML = `<div class="scroll"><table>
      <thead><tr><th>Harvest task</th><th>Project</th><th class="num">Hours</th><th>Map to</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.harvest_task)}</td><td class="muted">${esc(r.harvest_project)}</td>
        <td class="num">${hrs(r.hours)}</td>
        <td><select class="mapd" data-task="${esc(r.harvest_task)}">
          <option value="">—</option>
          ${S.boot.deliverables.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
        </select></td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('.mapd').forEach((el) => el.addEventListener('change', async () => {
      if (!el.value) return;
      await api('/api/harvest/map-task', { body: { task: el.dataset.task, deliverable_id: Number(el.value) } });
      toast('Mapped. Re-sync to apply it to logged time.');
    }));
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// ---------------------------------------------------------------------------
// cross-view navigation
// ---------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const person = e.target.closest('[data-person]');
  if (person) { S.personId = Number(person.dataset.person); S.view = 'people'; return render(); }
  const contract = e.target.closest('[data-contract]');
  if (contract) { S.contractId = Number(contract.dataset.contract); S.view = 'contracts'; return render(); }
  const sched = e.target.closest('[data-goto-schedule]');
  if (sched) { S.personId = Number(sched.dataset.gotoSchedule); S.view = 'schedule'; return render(); }
});

// clear the contract selection whenever the Contracts tab is clicked directly
$('#tabs').addEventListener('click', (e) => {
  if (e.target.dataset?.view === 'contracts') S.contractId = null;
}, true);

boot().catch((e) => { view().innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; });

// ===========================================================================
// Time — the daily loop. The plan (schedule blocks) is laid out; you confirm
// what happened, adjust what didn't, and only ever type the exceptions.
// All figures here are hours and minutes; there is deliberately no money on
// this screen for anyone.
// ===========================================================================

const hm = (m) => `${Math.floor((m || 0) / 60)}:${String((m || 0) % 60).padStart(2, '0')}`;
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mondayOf = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const timeShiftDay = (iso, n) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const niceDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short' });
const toMinOfDay = (t) => { const [h2, m2] = String(t).split(':').map(Number); return h2 * 60 + m2; };
const fromMinOfDay = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const SRC_LABEL = { confirm: 'as planned', adjust: 'adjusted', timer: 'timer', manual: 'added', skip: 'skipped' };

const timeApi = (path, opts) => api(`/api/time/${S.personId}${path}`, opts);

/**
 * Contract + task pickers built from what this person is actually allocated
 * to — pick a contract and the task list narrows to their work on it.
 */
function assignSelects(assignments, cId, dId) {
  const contracts = assignments.map((a) => `<option value="${a.contract_id}">${esc(a.name)}</option>`).join('');
  const first = assignments[0];
  const delivs = (a) => (a ? a.deliverables.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('') : '');
  return {
    html: `<select id="${cId}"${assignments.length ? '' : ' disabled'}>${contracts || '<option>No allocations this month</option>'}</select>
      <select id="${dId}"${assignments.length ? '' : ' disabled'}>${delivs(first)}</select>`,
    wire() {
      $(`#${cId}`)?.addEventListener('change', () => {
        const a = assignments.find((x) => x.contract_id === Number($(`#${cId}`).value));
        $(`#${dId}`).innerHTML = delivs(a);
      });
    },
  };
}

async function renderTime() {
  const all = S.boot.people.filter((p) => p.active);
  const people = S.me?.role === 'admin' ? all : all.filter((p) => p.id === S.me.person_id);
  if (!S.personId || !people.some((p) => p.id === S.personId)) S.personId = people[0]?.id;
  if (!S.personId) { view().innerHTML = '<p class="muted">No active people yet.</p>'; return; }
  if (!S.timeDate) S.timeDate = todayIso();
  // the page carries one month at a time: showing a day from August under a
  // September variance card put two different months on one screen
  if (S.timeDate.slice(0, 7) !== S.period) {
    S.timeDate = S.period === todayIso().slice(0, 7) ? todayIso() : `${S.period}-01`;
  }
  S.timeMode = S.timeMode || 'day';

  if (S.timeEveryone && S.me?.role === 'admin') {
    view().innerHTML = `
      <div class="tbar">
        <select id="tPick">${people.map((p) =>
          `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          <option disabled>──────</option>
          <option value="all" selected>Everyone — planned vs logged</option></select>
        <b>${esc(monthName(S.period))}</b>
        <span class="spacer"></span>
        <a class="btn small" href="/api/export/time.csv?period=${S.period}" download>Export month (.csv)</a>
      </div>
      <div class="banner info"><div><b>The whole team, ${esc(monthName(S.period))}.</b>
        Pick a person to see and manage their calendar; this is the month's
        planned-vs-logged picture across everyone.</div></div>
      <div id="tVariance"></div>`;
    $('#tPick').addEventListener('change', (e) => {
      if (e.target.value === 'all') return;
      S.timeEveryone = false; S.personId = Number(e.target.value); renderTime();
    });
    renderVariance(null);
    return;
  }
  const mode = S.timeMode;
  const v = await timeApi(`/${mode === 'day' ? 'day' : 'week'}?date=${S.timeDate}`);

  view().innerHTML = `
    <div class="tbar">
      ${people.length > 1 ? `<select id="tPick">${people.map((p) =>
        `<option value="${p.id}"${!S.timeEveryone && p.id === S.personId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        <option disabled>──────</option>
        <option value="all"${S.timeEveryone ? ' selected' : ''}>Everyone — planned vs logged</option></select>`
      : `<b>${esc(people[0].name)}</b>`}
      <div class="seg">
        <button id="tModeDay" class="btn small ${mode === 'day' ? 'primary' : ''}">Day</button>
        <button id="tModeWeek" class="btn small ${mode === 'week' ? 'primary' : ''}">Week</button>
      </div>
      <button class="btn small" id="tPrev">‹</button>
      <button class="btn small" id="tToday">Today</button>
      <button class="btn small" id="tNext">›</button>
      <b>${mode === 'day' ? niceDay(S.timeDate) : `${niceDay(v.start)} – ${niceDay(v.days[6])}`}</b>
      <span class="spacer"></span>
      <button class="btn small" id="tCal" title="Keep your calendar in step with this schedule">📅 Sync to Calendar</button>
      <a class="btn small" href="${S.me?.role === 'admin'
        ? `/api/export/time.csv?period=${S.timeDate.slice(0, 7)}&person_id=${S.personId}`
        : `/api/time/${S.personId}/export.csv?period=${S.timeDate.slice(0, 7)}`}" download
        title="This month's logged time as a spreadsheet">Export</a>
      <span class="pill mute">planned ${hm(v.totals.planned_minutes)}</span>
      <span class="pill ${v.totals.logged_minutes ? '' : 'mute'}">logged ${hm(v.totals.logged_minutes)}</span>
      ${v.totals.pending ? `<span class="pill warn">${v.totals.pending} to confirm</span>` : ''}
    </div>
    <div id="tTimer"></div>
    <div id="tBody"></div>
    ${S.me?.role === 'admin' ? '<div id="tVariance"></div>' : ''}
  `;

  $('#tPick')?.addEventListener('change', (e) => {
    if (e.target.value === 'all') { S.timeEveryone = true; }
    else { S.timeEveryone = false; S.personId = Number(e.target.value); }
    renderTime();
  });
  $('#tModeDay').addEventListener('click', () => { S.timeMode = 'day'; renderTime(); });
  $('#tModeWeek').addEventListener('click', () => { S.timeMode = 'week'; renderTime(); });
  const step = mode === 'day' ? 1 : 7;
  const goto = (d) => {
    S.timeDate = d;
    const m = d.slice(0, 7);
    // walking past a month boundary takes the whole page with you, when that
    // month exists; otherwise the move is refused rather than half-made
    if (m !== S.period) {
      if (!S.boot.periods.includes(m)) return toast(`${monthName(m)} hasn't been added yet.`, true);
      S.period = m; rememberPeriod(m);
      const sel = $('#period'); if (sel) sel.value = m;
    }
    renderTime();
  };
  $('#tPrev').addEventListener('click', () => goto(timeShiftDay(S.timeDate, -step)));
  $('#tNext').addEventListener('click', () => goto(timeShiftDay(S.timeDate, step)));
  $('#tToday').addEventListener('click', () => { S.timeDate = todayIso(); renderTime(); });
  $('#tCal').addEventListener('click', openCalendarPanel);

  S.timeAssignments = v.assignments || [];
  renderTimerBar(v.timer);
  if (mode === 'day') renderTimeDay(v); else renderTimeWeek(v);
  if (S.me?.role === 'admin') renderVariance(S.personId);
}

// --- timer ------------------------------------------------------------------

function renderTimerBar(timer) {
  const el = $('#tTimer');
  if (timer) {
    const what = timer.label || `${esc(timer.contract_name || '')} — ${esc(timer.deliverable_name || '')}`;
    el.innerHTML = `<div class="card timerbar running">
      <span class="dot"></span><b>${esc(what)}</b>
      <span class="pill">${hm(timer.elapsed_minutes)}</span>
      <input type="text" id="tmNote" placeholder="what was done? (optional)" style="flex:1;min-width:160px">
      <button class="btn primary small" id="tmStop">Stop &amp; log</button>
      <button class="btn small" id="tmCancel">Discard</button>
    </div>`;
    $('#tmStop').addEventListener('click', async () => {
      await timeApi('/timer/stop', { body: { note: $('#tmNote').value.trim() } });
      toast('Logged.'); renderTime();
    });
    $('#tmCancel').addEventListener('click', async () => {
      await timeApi('/timer', { method: 'DELETE' }); renderTime();
    });
  } else {
    const picks = assignSelects(S.timeAssignments || [], 'tmC', 'tmD');
    const logDate = S.timeDate <= todayIso() ? S.timeDate : todayIso();
    el.innerHTML = `<div class="card timerbar">
      <span class="k">Timer</span>
      ${picks.html}
      <button class="btn small" id="tmStart">▶ Start</button>
      <span class="sep-v"></span>
      <span class="k">or log</span>
      <input type="date" id="qlDate" value="${logDate}" max="${todayIso()}">
      <input type="time" id="qlFrom" title="start time">
      <span class="muted">to</span>
      <input type="time" id="qlTo" title="end time">
      <span class="pill mute" id="qlDur">0:00</span>
      <input type="text" id="qlNote" placeholder="note" style="width:130px">
      <button class="btn small primary" id="qlGo">Log</button>
    </div>`;
    picks.wire();
    $('#tmStart').addEventListener('click', async () => {
      await timeApi('/timer/start', { body: { contract_id: Number($('#tmC').value), deliverable_id: Number($('#tmD').value) } });
      renderTime();
    });
    const durOf = () => {
      const a = $('#qlFrom').value; const b = $('#qlTo').value;
      if (!a || !b) return 0;
      return Math.max(0, toMinOfDay(b) - toMinOfDay(a));
    };
    ['#qlFrom', '#qlTo'].forEach((sel) => $(sel).addEventListener('input', () => {
      $('#qlDur').textContent = hm(durOf());
    }));
    $('#qlGo').addEventListener('click', async () => {
      const minutes = durOf();
      if (!minutes) return toast('Give it a start and an end time.', true);
      const body = {
        contract_id: Number($('#tmC').value), deliverable_id: Number($('#tmD').value),
        date: $('#qlDate').value, start: $('#qlFrom').value, minutes,
        note: $('#qlNote').value.trim(),
      };
      try {
        const entry = await timeApi('/entries', { body });
        toast('Logged.');
        await renderTime();
        checkConflicts(entry);
      } catch (err) { toast(err.message, true); }
    });
  }
}

// --- day view: the confirm loop ---------------------------------------------

function renderTimeDay(v) {
  const chip = (b) => b.status === 'done'
    ? `<span class="pill ok">✓ ${hm(b.logged_minutes)}</span>`
    : b.status === 'skipped' ? '<span class="pill mute">skipped</span>'
      : '<span class="pill warn">pending</span>';

  $('#tBody').innerHTML = `
    <div class="grid2">
    <div class="card">
      <header><h2>The plan</h2><p>Tick what went to plan; adjust what didn't</p>
        ${v.totals.pending && v.date <= todayIso() ? `<button class="btn primary small" id="tConfirmDay">✓ Confirm all ${v.totals.pending}</button>` : ''}
      </header>
      ${v.blocks.length ? `<table><tbody>
        ${v.blocks.map((b) => `
          <tr class="tblock ${b.status}" data-b="${b.id}">
            <td class="num" style="white-space:nowrap">${b.start || ''}</td>
            <td>${esc(b.label)}<span class="sub">${hm(b.minutes)} planned</span></td>
            <td class="num">${chip(b)}</td>
            <td class="num" style="white-space:nowrap">${b.status === 'pending' ? (v.date <= todayIso() ? `
              <button class="btn small tCf" data-b="${b.id}" title="Happened exactly as planned">✓</button>
              <button class="btn small tAj" data-b="${b.id}" title="Happened, but differently">edit</button>
              <button class="btn small tSk" data-b="${b.id}" title="Didn't happen">✗</button>`
              : `<button class="btn small tSk" data-b="${b.id}" title="Won't happen — skip it">✗</button>`) : ''}</td>
          </tr>
          <tr class="tadjust hidden" data-of="${b.id}"><td></td><td colspan="3">
            <div class="rowline">
              <input type="time" class="ajStart" value="${b.start || '09:00'}">
              <input type="number" class="ajMins" value="${b.minutes}" min="1" step="15" style="width:80px"> min
              <input type="text" class="ajNote" placeholder="what was done?" style="flex:1;min-width:140px">
              <button class="btn primary small ajGo" data-b="${b.id}">Log it</button>
            </div>
          </td></tr>`).join('')}
      </tbody></table>` : '<p class="muted" style="padding:0 16px 16px">Nothing planned today.</p>'}
    </div>

    <div class="card">
      <header><h2>Logged</h2><p>What actually happened — with notes</p></header>
      ${v.entries.length ? `<table><tbody>
        ${v.entries.map((e) => `
          <tr class="tentry ${e.source}" data-e="${e.id}">
            <td class="num" style="white-space:nowrap">${e.start || '—'}</td>
            <td>${esc(e.contract_name || '')}${e.deliverable_name ? ` — ${esc(e.deliverable_name)}` : ''}
              ${e.note ? `<span class="sub">“${esc(e.note)}”</span>` : ''}</td>
            <td class="num">${e.source === 'skip' ? '<span class="pill mute">skipped</span>'
              : `<b>${hm(e.minutes)}</b>`}<span class="sub">${SRC_LABEL[e.source] || ''}</span></td>
            <td class="num"><button class="btn small tEdit" data-e="${e.id}">edit</button>
              <button class="btn small danger tDel" data-e="${e.id}">✕</button></td>
          </tr>`).join('')}
      </tbody></table>` : '<p class="muted" style="padding:0 16px 16px">Nothing logged yet.</p>'}
      <div class="rowline" style="padding:12px 16px" id="teRow">
        ${assignSelects(S.timeAssignments || [], 'teC', 'teD').html}
        <input type="time" id="teStart">
        <input type="number" id="teMins" placeholder="min" min="1" step="15" style="width:80px">
        <input type="text" id="teNote" placeholder="note" style="flex:1;min-width:120px">
        <button class="btn small" id="teAdd">+ Add</button>
      </div>
    </div>
    </div>`;

  $('#tConfirmDay')?.addEventListener('click', async () => {
    const r = await timeApi('/confirm-day', { body: { date: v.date } });
    toast(`${r.confirmed} confirmed.`); renderTime();
  });
  view().querySelectorAll('.tCf').forEach((b) => b.addEventListener('click', async () => {
    await timeApi('/confirm', { body: { block_id: Number(b.dataset.b) } }); renderTime();
  }));
  view().querySelectorAll('.tSk').forEach((b) => b.addEventListener('click', async () => {
    const note = prompt('Why didn\'t it happen? (moved / not needed / client cancelled…)') ?? null;
    if (note === null) return;
    await timeApi('/skip', { body: { block_id: Number(b.dataset.b), note } }); renderTime();
  }));
  view().querySelectorAll('.tAj').forEach((b) => b.addEventListener('click', () => {
    view().querySelector(`.tadjust[data-of="${b.dataset.b}"]`).classList.toggle('hidden');
  }));
  view().querySelectorAll('.ajGo').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    const block = v.blocks.find((x) => x.id === Number(b.dataset.b));
    const minutes = Number(row.querySelector('.ajMins').value);
    await timeApi('/entries', { body: {
      block_id: Number(b.dataset.b), date: v.date,
      start: row.querySelector('.ajStart').value || null,
      minutes,
      note: row.querySelector('.ajNote').value.trim(), source: 'adjust',
    } });
    toast('Logged.'); await renderTime();
    if (block) maybeRebalance(block.contract_id, v.date, minutes - block.minutes, block.id);
  }));
  view().querySelectorAll('.tDel').forEach((b) => b.addEventListener('click', async () => {
    const e = v.entries.find((x) => x.id === Number(b.dataset.e));
    const locked = e && e.date < todayIso() && e.source !== 'skip';
    if (locked && !confirm('This day has passed — its time is fixed. Delete anyway?')) return;
    await timeApi(`/entries/${b.dataset.e}${locked ? '?override=1' : ''}`, { method: 'DELETE' });
    renderTime();
  }));
  view().querySelectorAll('.tEdit').forEach((b) => b.addEventListener('click', () => {
    const e = v.entries.find((x) => x.id === Number(b.dataset.e));
    openEntryEditor(e);
  }));
  assignSelects(S.timeAssignments || [], 'teC', 'teD').wire();
  $('#teAdd').addEventListener('click', async () => {
    const minutes = Number($('#teMins').value);
    if (!minutes) return toast('How many minutes?', true);
    await timeApi('/entries', { body: {
      contract_id: Number($('#teC').value), deliverable_id: Number($('#teD').value),
      date: v.date, start: $('#teStart').value || null, minutes,
      note: $('#teNote').value.trim(),
    } });
    toast('Added.'); renderTime();
  });
}

// --- a small shared editor for one entry -------------------------------------

function openEntryEditor(e) {
  document.querySelector('.tpanel')?.remove();
  // a passed day's committed time is fixed; the editor opens read-only and
  // only an explicit override unlocks it (unskipping is always allowed)
  let locked = e.date < todayIso() && e.source !== 'skip';
  const p = document.createElement('div');
  p.className = 'tpanel card';
  p.innerHTML = `
    <header><h2>${e.source === 'skip' ? 'Skipped block' : locked ? '🔒 Committed time' : 'Edit entry'}</h2>
      <button class="btn small" id="tpX">✕</button></header>
    ${locked ? `<p class="muted" style="padding:0 16px">This day has passed, so its time is part
      of the record. Override only to correct a mistake.</p>` : ''}
    <div class="rowline"><label>Date</label><input type="date" id="tpDate" value="${e.date}"${locked ? ' disabled' : ''}></div>
    ${e.source !== 'skip' ? `
    <div class="rowline"><label>Start</label><input type="time" id="tpStart" value="${e.start || ''}"${locked ? ' disabled' : ''}></div>
    <div class="rowline"><label>Minutes</label><input type="number" id="tpMins" value="${e.minutes}" min="1" step="15"${locked ? ' disabled' : ''}></div>` : ''}
    <div class="rowline"><label>Note</label><input type="text" id="tpNote" value="${esc(e.note || '')}" style="flex:1"${locked ? ' disabled' : ''}></div>
    <div class="rowline"><span class="spacer"></span>
      ${locked ? '<button class="btn small" id="tpUnlock">Override…</button>' : ''}
      <button class="btn danger small hideable${locked ? ' hidden' : ''}" id="tpDel">${e.source === 'skip' ? 'Unskip' : 'Delete'}</button>
      <button class="btn primary small hideable${locked ? ' hidden' : ''}" id="tpSave">Save</button></div>`;
  view().appendChild(p);
  const wasLocked = locked;
  $('#tpX').addEventListener('click', () => p.remove());
  $('#tpUnlock')?.addEventListener('click', () => {
    locked = false;
    p.querySelectorAll('input').forEach((i) => { i.disabled = false; });
    p.querySelectorAll('.hideable').forEach((b) => b.classList.remove('hidden'));
    $('#tpUnlock').remove();
  });
  $('#tpDel').addEventListener('click', async () => {
    await timeApi(`/entries/${e.id}${wasLocked ? '?override=1' : ''}`, { method: 'DELETE' });
    p.remove(); renderTime();
  });
  $('#tpSave').addEventListener('click', async () => {
    const body = { date: $('#tpDate').value, note: $('#tpNote').value.trim() };
    if (e.source !== 'skip') {
      body.start = $('#tpStart').value || null;
      body.minutes = Number($('#tpMins').value);
    }
    if (wasLocked) body.override = true;
    await timeApi(`/entries/${e.id}`, { method: 'PATCH', body });
    p.remove(); toast('Saved.'); await renderTime();
    if (body.minutes && body.minutes !== e.minutes) {
      maybeRebalance(e.contract_id, e.date, body.minutes - e.minutes, e.block_id);
    }
  });
}

// --- send the schedule to a calendar -----------------------------------------

async function openCalendarPanel(isDraft) {
  document.querySelector('.tpanel')?.remove();
  const link = await timeApi('/calendar-link');
  const p = document.createElement('div');
  p.className = 'tpanel card';
  p.innerHTML = `
    <header><h2>📅 Sync to Calendar</h2><button class="btn small" id="tpX">✕</button></header>
    ${isDraft ? `<p class="muted" style="padding:0 16px"><b>This month is still a draft.</b>
      The calendar follows the saved plan, so press “Edit this plan” to save it first —
      the subscription below then picks it up on its next refresh.</p>` : ''}
    <p class="muted" style="padding:0 16px">Subscribe once and the plan stays in step —
      re-planned blocks move in your calendar on its next refresh. Skipped work disappears.</p>
    <div class="rowline">
      <a class="btn primary small" href="${esc(link.webcal)}">Subscribe (Apple / Outlook)</a>
      <button class="btn small" id="tcCopy">Copy link for Google</button></div>
    <div class="rowline"><input type="text" id="tcUrl" readonly value="${esc(link.https)}" style="flex:1;font-size:11px"></div>
    <div class="rowline"><span class="muted" style="font-size:12px">Google Calendar: Settings → Add calendar → From URL, paste the link.</span></div>
    <div class="rowline"><a class="btn small" href="/api/schedule/${S.personId}/ics${P()}" download>Download ${esc(monthName(S.period))} (.ics) instead</a></div>`;
  view().appendChild(p);
  $('#tpX').addEventListener('click', () => p.remove());
  $('#tcCopy').addEventListener('click', () => {
    $('#tcUrl').select();
    navigator.clipboard.writeText(link.https).then(() => toast('Link copied.'));
  });
}

// --- week view: the calendar. Plan underneath, reality on top ---------------
// Drag a solid entry to move it; drag its lower edge to resize; drag a pending
// planned block to log it where it actually happened. Everything snaps to the
// quarter hour, the same grain the schedule is built on.

const T_SNAP = 15;
const T_PPM = 1;                    // 1px per minute -> 60px per hour

function renderTimeWeek(v) {
  const days = v.days;                     // the full week, weekend included

  // window: 07:00–19:00, stretched to fit whatever exists
  let lo = 7 * 60; let hi = 19 * 60;
  const stretch = (start, minutes) => {
    if (start == null) return;
    const s = toMinOfDay(start);
    lo = Math.min(lo, Math.floor(s / 60) * 60);
    hi = Math.max(hi, Math.ceil((s + minutes) / 60) * 60);
  };
  v.blocks.forEach((b) => stretch(b.start, b.minutes));
  v.entries.forEach((e) => stretch(e.start, e.minutes));
  const height = (hi - lo) * T_PPM;

  const hours = [];
  for (let m = lo; m <= hi; m += 60) hours.push(m);

  const dayCol = (d) => {
    const ghosts = v.blocks.filter((b) => b.date === d);
    const solids = v.entries.filter((e) => e.date === d && e.start && e.source !== 'skip');
    const loose = v.entries.filter((e) => e.date === d && !e.start && e.source !== 'skip');
    const pos = (start, minutes) => `top:${(toMinOfDay(start) - lo) * T_PPM}px;height:${Math.max(18, minutes * T_PPM)}px`;
    return `<div class="tw-day" data-date="${d}">
      ${loose.length ? `<div class="tw-loose">${loose.map((e) =>
        `<span class="tw-chip" data-kind="entry" data-id="${e.id}">${hm(e.minutes)} ${esc(e.contract_name || '')}</span>`).join('')}</div>` : ''}
      <div class="tw-grid" style="height:${height}px">
        ${hours.slice(0, -1).map((m) => `<div class="tw-hour" style="top:${(m - lo) * T_PPM}px"></div>`).join('')}
        ${ghosts.map((b) => `<div class="tw-ghost ${b.status}" data-kind="ghost" data-id="${b.id}"
            style="${pos(b.start, b.minutes)}" title="planned: ${esc(b.label)} (${hm(b.minutes)}) — drag to re-plan, tick to commit">
          ${b.status === 'pending' && b.date <= todayIso() ? `<button class="tw-tick" data-kind="tick" data-id="${b.id}" title="Commit: this happened as planned here">✓</button>` : ''}
          <span>${esc(b.label)}</span><em>${hm(b.minutes)}${b.status === 'done' ? ' ✓' : b.status === 'skipped' ? ' ✗' : ''}</em>
          ${b.status === 'pending' ? `<div class="tw-resize" data-kind="gresize" data-id="${b.id}"></div>` : ''}
        </div>`).join('')}
        ${solids.map((e) => { const locked = e.date < todayIso(); return `<div class="tw-entry ${e.source}${locked ? ' locked' : ''}" data-kind="entry" data-id="${e.id}"
            style="${pos(e.start, e.minutes)}" ${locked ? 'title="This day has passed — its time is fixed. Click to override a mistake."' : ''}>
          <span>${locked ? '🔒 ' : ''}${esc(e.contract_name || '')}${e.deliverable_name ? ` — ${esc(e.deliverable_name)}` : ''}</span>
          <em>${hm(e.minutes)}</em>${e.note ? `<i>“${esc(e.note)}”</i>` : ''}
          ${locked ? '' : `<div class="tw-resize" data-kind="resize" data-id="${e.id}"></div>`}
        </div>`; }).join('')}
      </div>
    </div>`;
  };

  $('#tBody').innerHTML = `<div class="card tw-card">
    <div class="tw-head">
      <div class="tw-gutter"></div>
      ${days.map((d, i) => {
        const per = v.totals.per_day[v.days.indexOf(d)];
        return `<div class="tw-col-head ${d === todayIso() ? 'today' : ''}">
          <b>${niceDay(d)}</b><span class="sub">${hm(per.logged_minutes)} / ${hm(per.planned_minutes)}</span>
        </div>`;
      }).join('')}
      <div class="tw-col-head tw-total"><b>Week total</b>
        <span class="sub">${hm(v.totals.logged_minutes)} / ${hm(v.totals.planned_minutes)}</span></div>
    </div>
    <div class="tw-scroll"><div class="tw-body">
      <div class="tw-gutter" style="height:${height}px">
        ${hours.slice(0, -1).map((m) => `<div class="tw-hlabel" style="top:${(m - lo) * T_PPM}px">${fromMinOfDay(m)}</div>`).join('')}
      </div>
      ${days.map(dayCol).join('')}
      <div class="tw-day tw-total-col"></div>
    </div></div>
    <p class="muted" style="padding:8px 16px">Drag a block to move it · drag its lower edge to change its length ·
      click to add a note · faint outlines are the plan.</p>
  </div>`;

  wireWeekDrag(v, lo);
}

function wireWeekDrag(v, lo) {
  const body = view().querySelector('.tw-body');
  let drag = null;

  const slotOf = (ev) => {
    const day = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tw-day');
    if (!day) return null;
    const grid = day.querySelector('.tw-grid');
    const rect = grid.getBoundingClientRect();
    const min = Math.round((ev.clientY - rect.top) / T_PPM / T_SNAP) * T_SNAP + lo;
    return { date: day.dataset.date, min: Math.max(lo, min) };
  };

  body.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest('[data-kind]');
    if (!t) return;
    const kind = t.dataset.kind;
    if (kind === 'tick') {
      // the tick IS the commit — one tap, exactly where the block sits now
      ev.preventDefault();
      timeApi('/confirm', { body: { block_id: Number(t.dataset.id) } })
        .then(() => renderTime()).catch((err) => toast(err.message, true));
      return;
    }
    if (kind === 'entry') {
      const e = v.entries.find((x) => x.id === Number(t.dataset.id));
      if (e && e.date < todayIso()) {
        // the past doesn't drag — it opens, locked, for a deliberate override
        drag = { kind: 'locked', entry: e, startY: ev.clientY, moved: false };
        ev.preventDefault();
        return;
      }
    }
    if (kind === 'resize') {
      const e = v.entries.find((x) => x.id === Number(t.dataset.id));
      drag = { kind, id: e.id, entry: e, minutes: e.minutes,
        el: t.closest('.tw-entry'), startY: ev.clientY, moved: false };
    } else if (kind === 'gresize') {
      const b = v.blocks.find((x) => x.id === Number(t.dataset.id));
      drag = { kind, id: b.id, block: b, minutes: b.minutes,
        el: t.closest('.tw-ghost'), startY: ev.clientY, moved: false };
    } else {
      const box = t.getBoundingClientRect();
      drag = { kind, id: Number(t.dataset.id), el: t, grabOffset: ev.clientY - box.top,
        startX: ev.clientX, startY: ev.clientY, moved: false };
    }
    ev.preventDefault();
    try { body.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointers */ }
  });

  body.addEventListener('pointermove', (ev) => {
    if (!drag || drag.kind === 'locked') return;
    if (Math.abs(ev.clientX - (drag.startX ?? ev.clientX)) + Math.abs(ev.clientY - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === 'resize' || drag.kind === 'gresize') {
      const mins = Math.max(T_SNAP,
        Math.round((drag.minutes * T_PPM + ev.clientY - drag.startY) / T_PPM / T_SNAP) * T_SNAP);
      drag.el.style.height = `${Math.max(18, mins * T_PPM)}px`;
      drag.mins = mins;
    } else {
      const slot = slotOf({ clientX: ev.clientX, clientY: ev.clientY - drag.grabOffset + 1 });
      if (!slot) return;
      drag.slot = slot;
      drag.el.classList.add('dragging');
      drag.el.style.pointerEvents = 'none';   // never occlude the drop target beneath
      const grid = document.querySelector(`.tw-day[data-date="${slot.date}"] .tw-grid`);
      if (drag.el.parentElement !== grid) grid.appendChild(drag.el);
      drag.el.style.top = `${(slot.min - lo) * T_PPM}px`;
    }
  });

  body.addEventListener('pointerup', async () => {
    const d = drag; drag = null;
    if (!d) return;
    try {
      if (d.kind === 'locked') { openEntryEditor(d.entry); return; }
      if (!d.moved) {
        // a click, not a drag
        if (d.kind === 'entry') {
          const e = v.entries.find((x) => x.id === d.id);
          if (e) openEntryEditor(e);
        } else if (d.kind === 'ghost') {
          const b = v.blocks.find((x) => x.id === d.id);
          if (b && b.status === 'pending') openGhostMenu(b);
          else if (b && b.status === 'skipped') {
            const skipId = b.entry_ids[0];
            if (skipId && confirm('Unskip this block?')) {
              await timeApi(`/entries/${skipId}`, { method: 'DELETE' }); renderTime();
            }
          }
        }
        return;
      }
      if (d.kind === 'resize' && d.mins) {
        const delta = d.mins - d.entry.minutes;
        await timeApi(`/entries/${d.id}`, { method: 'PATCH', body: { minutes: d.mins } });
        await renderTime();
        maybeRebalance(d.entry.contract_id, d.entry.date, delta, d.entry.block_id);
      } else if (d.kind === 'gresize' && d.mins) {
        const r = await timeApi('/resize-block', { body: { block_id: d.id, minutes: d.mins } });
        await renderTime();
        maybeRebalance(d.block.contract_id, d.block.date, r.delta, d.block.id);
      } else if (d.kind === 'entry' && d.slot) {
        await timeApi(`/entries/${d.id}`, { method: 'PATCH',
          body: { date: d.slot.date, start: fromMinOfDay(d.slot.min) } });
        renderTime();
      } else if (d.kind === 'ghost' && d.slot) {
        const b = v.blocks.find((x) => x.id === d.id);
        if (b.status !== 'pending') { renderTime(); return; }
        // a drag only re-plans — nothing is committed until the tick
        await timeApi('/move-block', { body: {
          block_id: b.id, date: d.slot.date, start: fromMinOfDay(d.slot.min),
        } });
        toast('Plan moved — tick it when it\'s done.');
        renderTime();
      }
    } catch (err) { toast(err.message, true); renderTime(); }
  });
}

function openGhostMenu(b) {
  document.querySelector('.tpanel')?.remove();
  const p = document.createElement('div');
  p.className = 'tpanel card';
  const future = b.date > todayIso();
  p.innerHTML = `
    <header><h2>${esc(b.label)}</h2><button class="btn small" id="tpX">✕</button></header>
    <div class="tmeta">Planned ${niceDay(b.date)}${b.start ? ` · ${b.start}` : ''} · ${hm(b.minutes)}
      ${future ? '<span class="pill mute">later — tick it once it\'s happened</span>' : ''}</div>
    <div class="rowline"><input type="text" id="tgNote" placeholder="note (optional)" style="flex:1"></div>
    <div class="rowline">
      <button class="btn small danger" id="tgSk">✗ ${future ? "Won't happen" : "Didn't happen"}</button>
      <span class="spacer"></span>
      ${future ? '' : '<button class="btn primary small" id="tgCf">✓ As planned</button>'}</div>`;
  view().appendChild(p);
  $('#tpX').addEventListener('click', () => p.remove());
  $('#tgCf')?.addEventListener('click', async () => {
    await timeApi('/confirm', { body: { block_id: b.id, note: $('#tgNote').value.trim() } });
    p.remove(); renderTime();
  });
  $('#tgSk').addEventListener('click', async () => {
    await timeApi('/skip', { body: { block_id: b.id, note: $('#tgNote').value.trim() } });
    p.remove(); renderTime();
  });
}

// --- variance: the whole point (admin only) ----------------------------------

async function renderVariance(personId) {
  const v = await api(`/api/time-variance?period=${encodeURIComponent(S.period)}`
    + (personId ? `&person_id=${personId}` : ''));
  const dev = (h2) => h2 === 0 ? '<span class="pill mute">—</span>'
    : `<span class="pill ${h2 > 0 ? 'warn' : ''}">${h2 > 0 ? '+' : ''}${h(h2)} h</span>`;
  const table = (rows, label) => `
    <div class="card"><header><h2>${label}</h2><p>Planned vs logged, ${esc(monthName(S.period))}</p></header>
    <div class="scroll"><table>
      <thead><tr><th>${label === 'By contract' ? 'Contract' : 'Person'}</th>
        <th class="num">Planned</th><th class="num">Logged</th><th class="num">Δ</th>
        <th class="num">Skipped</th><th class="num">Unconfirmed</th></tr></thead>
      <tbody>${rows.filter((r) => r.planned_minutes || r.logged_minutes).map((r) => `<tr>
        <td>${esc(r.name)}</td>
        <td class="num">${hrs(r.planned_hours)}</td>
        <td class="num">${r.logged_minutes ? hrs(r.logged_hours) : '<span class="nil">—</span>'}</td>
        <td class="num">${dev(r.variance_hours)}</td>
        <td class="num">${r.skipped || '<span class="nil">—</span>'}</td>
        <td class="num">${r.pending ? `<span class="pill warn">${r.pending}</span>` : '<span class="nil">—</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;
  const el = document.getElementById('tVariance');
  if (!el) return;
  el.innerHTML = `
    ${v.totals.pending_blocks ? `<div class="banner"><div>
      <b>${v.totals.pending_blocks} past blocks still unconfirmed.</b>
      Their time is planned but nobody has said what happened yet.</div></div>` : ''}
    ${personId
      ? `<div class="grid2">${table(v.by_contract, 'By contract')}<div></div></div>`
      : `<div class="grid2">${table(v.by_contract, 'By contract')}${table(v.by_person, 'By person')}</div>`}`;
}


// --- rebalance: a resize changed what one contract takes; offer to put the
// difference back into that contract's upcoming plan. Always a proposal with
// the maths shown — never a silent shuffle of someone's future week.

async function maybeRebalance(contractId, date, delta, excludeBlockId) {
  if (!contractId || !delta) return;
  const c = S.boot.contracts.find((x) => x.id === contractId);
  if (!c || c.type === 'internal') return;      // internal time has no client budget to defend
  let r;
  try {
    r = await timeApi(`/rebalance?contract_id=${contractId}&period=${date.slice(0, 7)}`
      + `&delta=${delta}&exclude=${excludeBlockId || 0}`);
  } catch (e) { return; }
  if (!r.proposal.length) {
    if (r.upcoming_blocks === 0) {
      toast(`${delta > 0 ? '+' : '−'}${hm(Math.abs(delta))} for ${c.name} — no upcoming ${c.name} blocks this month to balance it against; the variance report will carry it.`);
    }
    return;
  }
  openRebalancePanel(r);
}

function openRebalancePanel(r) {
  document.querySelector('.tpanel')?.remove();
  const adding = r.delta > 0;
  const p = document.createElement('div');
  p.className = 'tpanel card';
  p.innerHTML = `
    <header><h2>Balance ${esc(r.contract_name)}?</h2><button class="btn small" id="tpX">✕</button></header>
    <p class="muted" style="padding:0 16px">${adding
      ? `That's <b>${hm(r.delta)} more</b> on ${esc(r.contract_name)} than planned. Take it back out of their upcoming work so the month still fits?`
      : `That freed <b>${hm(-r.delta)}</b> from ${esc(r.contract_name)}. Add it back to their upcoming work?`}</p>
    <div style="padding:0 16px">
      ${r.proposal.map((x, i) => `<label class="rebrow">
        <input type="checkbox" class="rbPick" data-i="${i}" checked>
        <span>${niceDay(x.date)}${x.start ? ` ${x.start}` : ''} — ${esc(x.label)}${x.new_block ? ' <i>(new)</i>' : ''}</span>
        <b>${x.new_block ? `+ ${hm(x.to_minutes)}` : `${hm(x.from_minutes)} → ${x.to_minutes === 0 ? 'removed' : hm(x.to_minutes)}`}</b>
      </label>`).join('')}
    </div>
    ${r.unplaced_minutes ? `<p class="muted" style="padding:0 16px">${hm(r.unplaced_minutes)} has nowhere to go —
      it will show in the variance report.</p>` : ''}
    <div class="rowline"><span class="spacer"></span>
      <button class="btn small" id="rbNo">Leave as is</button>
      <button class="btn primary small" id="rbGo">Apply</button></div>`;
  view().appendChild(p);
  $('#tpX').addEventListener('click', () => p.remove());
  $('#rbNo').addEventListener('click', () => p.remove());
  $('#rbGo').addEventListener('click', async () => {
    const changes = [...p.querySelectorAll('.rbPick')]
      .filter((cb) => cb.checked)
      .map((cb) => {
        const x = r.proposal[Number(cb.dataset.i)];
        return x.new_block
          ? { new_block: true, contract_id: x.contract_id, deliverable_id: x.deliverable_id,
              date: x.date, start: x.start, label: x.label, minutes: x.to_minutes }
          : { block_id: x.block_id, minutes: x.to_minutes };
      });
    if (!changes.length) { p.remove(); return; }
    try {
      await timeApi('/rebalance', { body: { changes } });
      p.remove(); toast('Plan rebalanced.'); renderTime();
    } catch (err) { toast(err.message, true); }
  });
}

// --- conflicts: logged reality landing on top of something else --------------
// The entry is already saved — the work happened, that is not in question.
// The popup is about what it displaced: plan blocks that were sitting in that
// slot, or other logged entries it overlaps. Each gets its own decision.

async function checkConflicts(entry) {
  if (!entry.start) return;
  const day = await timeApi(`/day?date=${entry.date}`);
  const es = toMinOfDay(entry.start);
  const ee = es + entry.minutes;
  const hits = [];
  for (const b of day.blocks) {
    if (b.status !== 'pending' || !b.start) continue;
    const bs = toMinOfDay(b.start);
    if (es < bs + b.minutes && bs < ee) hits.push({ kind: 'block', item: b });
  }
  for (const e of day.entries) {
    if (e.id === entry.id || e.source === 'skip' || !e.start) continue;
    const s2 = toMinOfDay(e.start);
    if (es < s2 + e.minutes && s2 < ee) hits.push({ kind: 'entry', item: e });
  }
  if (hits.length) openConflictPanel(entry, hits);
}

function openConflictPanel(entry, hits) {
  document.querySelector('.tpanel')?.remove();
  const es = toMinOfDay(entry.start);
  const ee = es + entry.minutes;
  const p = document.createElement('div');
  p.className = 'tpanel card';
  p.innerHTML = `
    <header><h2>That slot wasn't empty</h2><button class="btn small" id="tpX">✕</button></header>
    <p class="muted" style="padding:0 16px">Your ${hm(entry.minutes)} at ${entry.start} overlaps
      ${hits.length === 1 ? 'something' : `${hits.length} things`}. The time you logged stands —
      decide what happens to each of these:</p>
    ${hits.map((h2, i) => {
      const it = h2.item;
      const label = h2.kind === 'block' ? it.label
        : `${it.contract_name || ''}${it.deliverable_name ? ` — ${it.deliverable_name}` : ''}`;
      const opts = h2.kind === 'block'
        ? `<option value="leave">Leave it planned</option>
           <option value="bump">Move it to the next free slot</option>
           <option value="skip">It's not happening — skip it</option>`
        : (toMinOfDay(it.start) >= es && toMinOfDay(it.start) + it.minutes <= ee
          ? `<option value="leave">Leave it (overlap stays)</option>
             <option value="delete">Delete it — this replaces it</option>`
          : `<option value="leave">Leave it (overlap stays)</option>
             <option value="trim">Trim it so they don't overlap</option>`);
      return `<div class="rowline conf" data-i="${i}">
        <span style="flex:1">${h2.kind === 'block' ? 'planned' : 'logged'}: <b>${esc(label)}</b>
          <span class="sub">${it.start} · ${hm(it.minutes)}</span></span>
        <select class="confAct">${opts}</select>
      </div>`;
    }).join('')}
    <div class="rowline"><span class="spacer"></span>
      <button class="btn primary small" id="confGo">Done</button></div>`;
  view().appendChild(p);
  $('#tpX').addEventListener('click', () => p.remove());
  $('#confGo').addEventListener('click', async () => {
    try {
      for (const row of p.querySelectorAll('.conf')) {
        const h2 = hits[Number(row.dataset.i)];
        const act = row.querySelector('.confAct').value;
        const it = h2.item;
        if (act === 'leave') continue;
        if (act === 'bump') await timeApi('/bump-block', { body: { block_id: it.id } });
        else if (act === 'skip') await timeApi('/skip', { body: { block_id: it.id, note: 'displaced by logged time' } });
        else if (act === 'delete') await timeApi(`/entries/${it.id}${it.date < todayIso() ? '?override=1' : ''}`, { method: 'DELETE' });
        else if (act === 'trim') {
          const s2 = toMinOfDay(it.start);
          const e2 = s2 + it.minutes;
          const body = s2 < es
            ? { minutes: es - s2 }                                   // ends where the new one starts
            : { start: fromMinOfDay(ee), minutes: e2 - ee };         // starts where the new one ends
          if (it.date < todayIso()) body.override = true;
          await timeApi(`/entries/${it.id}`, { method: 'PATCH', body });
        }
      }
      p.remove(); toast('Sorted.'); renderTime();
    } catch (err) { toast(err.message, true); }
  });
}

// ===========================================================================
// Reports — the client-facing view of the time data. Filter to a client, a
// range, a person, a department; the document below the filters is the
// deliverable: print it (or Save as PDF) and everything else on the page
// stays behind. Hours only, by design.
// ===========================================================================

function repRange(preset) {
  const t = todayIso();
  const som = (p2) => `${p2}-01`;
  const eom = (p2) => { const [y, m2] = p2.split('-').map(Number); return `${p2}-${String(new Date(Date.UTC(y, m2, 0)).getUTCDate()).padStart(2, '0')}`; };
  const thisM = t.slice(0, 7);
  const shift = (p2, n) => { const [y, m2] = p2.split('-').map(Number); const d = new Date(Date.UTC(y, m2 - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  if (preset === 'last') { const lm = shift(thisM, -1); return [som(lm), eom(lm)]; }
  if (preset === 'q') return [som(shift(thisM, -2)), eom(thisM)];
  if (preset === 'year') return [`${t.slice(0, 4)}-01-01`, t];
  return [som(thisM), eom(thisM)];
}

async function renderReports() {
  if (!S.repFrom) [S.repFrom, S.repTo] = repRange('month');
  const contracts = S.boot.contracts.filter((c) => !c.archived);
  const people = S.boot.people.filter((p) => p.active);
  const delivs = S.boot.deliverables;

  view().innerHTML = `
    <div class="tbar no-print">
      <select id="rpPreset">
        <option value="month">This month</option><option value="last">Last month</option>
        <option value="q">Last 3 months</option><option value="year">This year</option>
        <option value="custom">Custom range</option></select>
      <input type="date" id="rpFrom" value="${S.repFrom}">
      <span class="muted">to</span>
      <input type="date" id="rpTo" value="${S.repTo}">
      <select id="rpDept"><option value="">All departments</option>
        <option value="marketing"${S.repDept === 'marketing' ? ' selected' : ''}>Marketing</option>
        <option value="design"${S.repDept === 'design' ? ' selected' : ''}>Design</option></select>
      <select id="rpC"><option value="">All clients</option>${contracts.map((c) =>
        `<option value="${c.id}"${S.repC === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="rpP"><option value="">Whole team</option>${people.map((p) =>
        `<option value="${p.id}"${S.repP === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <select id="rpD"><option value="">All tasks</option>${delivs.map((d) =>
        `<option value="${d.id}"${S.repD === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
      <span class="spacer"></span>
      <button class="btn small" id="rpCsv">Export CSV</button>
      <button class="btn small primary" id="rpPdf">Print / Save as PDF</button>
    </div>
    <div id="reportDoc"><p class="muted">Building the report…</p></div>`;

  const qs = () => {
    const parts = [`from=${S.repFrom}`, `to=${S.repTo}`];
    if (S.repDept) parts.push(`department=${S.repDept}`);
    if (S.repC) parts.push(`contract_id=${S.repC}`);
    if (S.repP) parts.push(`person_id=${S.repP}`);
    if (S.repD) parts.push(`deliverable_id=${S.repD}`);
    return parts.join('&');
  };
  const run = async () => { await drawReport(qs()); };

  $('#rpPreset').addEventListener('change', (e) => {
    if (e.target.value !== 'custom') {
      [S.repFrom, S.repTo] = repRange(e.target.value);
      $('#rpFrom').value = S.repFrom; $('#rpTo').value = S.repTo;
    }
    run();
  });
  $('#rpFrom').addEventListener('change', (e) => { S.repFrom = e.target.value; run(); });
  $('#rpTo').addEventListener('change', (e) => { S.repTo = e.target.value; run(); });
  $('#rpDept').addEventListener('change', (e) => { S.repDept = e.target.value || null; run(); });
  $('#rpC').addEventListener('change', (e) => { S.repC = Number(e.target.value) || null; run(); });
  $('#rpP').addEventListener('change', (e) => { S.repP = Number(e.target.value) || null; run(); });
  $('#rpD').addEventListener('change', (e) => { S.repD = Number(e.target.value) || null; run(); });
  $('#rpCsv').addEventListener('click', () => { location.href = `/api/export/time.csv?${qs()}`; });
  $('#rpPdf').addEventListener('click', () => window.print());
  run();
}

async function drawReport(qs) {
  const el = document.getElementById('reportDoc');
  let r;
  try { r = await api(`/api/report?${qs}`); }
  catch (err) { el.innerHTML = `<div class="banner bad"><div>${esc(err.message)}</div></div>`; return; }

  const subject = [
    S.repC ? S.boot.contracts.find((c) => c.id === S.repC)?.name : null,
    S.repP ? S.boot.people.find((p) => p.id === S.repP)?.name : null,
    S.repDept ? (S.repDept === 'design' ? 'Design department' : 'Marketing department') : null,
    S.repD ? S.boot.deliverables.find((d) => d.id === S.repD)?.name : null,
  ].filter(Boolean).join(' · ') || 'All work';
  const nice = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const shareTable = (rows, label) => `
    <div class="card"><header><h2>${label}</h2></header>
    <table><thead><tr><th>${label.replace('By ', '')}</th><th class="num">Hours</th>
      <th class="num">Share</th><th style="width:120px"></th></tr></thead>
    <tbody>${rows.map((x) => `<tr>
      <td>${esc(x.name)}</td><td class="num">${hrs(x.hours)}</td>
      <td class="num">${h(x.share, 1)}%</td>
      <td><div class="bar"><i class="used" style="width:${Math.min(100, x.share)}%"></i></div></td>
    </tr>`).join('')}
    <tr class="total"><td>Total</td><td class="num">${hrs(r.totals.hours)}</td><td class="num">100%</td><td></td></tr>
    </tbody></table></div>`;

  const maxT = Math.max(1, ...r.timeline.map((t2) => t2.hours));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((st) => maxT / st <= 4) || 500;
  const H2 = 120;
  const px = (v2) => Math.round((v2 / maxT) * H2);
  const ticks = []; for (let t2 = step; t2 <= maxT; t2 += step) ticks.push(t2);
  const bLabel = (b) => (r.grain === 'month' ? monthName(b).slice(0, 3)
    : r.grain === 'week' ? `w/c ${b.slice(8)}/${b.slice(5, 7)}` : b.slice(8));

  // the header tells the story in a sentence before any table does
  const topC = r.by_contract[0]; const topP = r.by_person[0]; const topD = r.by_deliverable[0];
  const narrative = r.totals.entries === 0 ? 'Nothing was logged in this range.'
    : [
      `${r.totals.people === 1 ? (topP ? esc(topP.name) : 'One person') : `${r.totals.people} people`}`
      + ` delivered <b>${h(r.totals.hours)} hours</b> across ${r.totals.days_worked} working day${r.totals.days_worked === 1 ? '' : 's'}`,
      !S.repC && topC ? `the largest share went to <b>${esc(topC.name)}</b> (${h(topC.share, 1)}%)` : null,
      topD && topD.name !== 'Uncategorised' ? `most of the time was <b>${esc(topD.name)}</b>` : null,
    ].filter(Boolean).join(' — ') + '.';

  el.innerHTML = `
    <div class="rep-head card">
      <div class="rep-title">
        <span class="rep-brand">Emotio<b>Hours</b></span>
        <h1>Time report — ${esc(subject)}</h1>
        <p class="muted">${nice(r.from)} to ${nice(r.to)} · prepared ${nice(todayIso())}</p>
        <p class="rep-narrative">${narrative}</p>
      </div>
      <div class="stats rep-tiles">
        <div class="stat"><span class="k">Hours delivered</span><span class="v">${hrs(r.totals.hours)}</span></div>
        <div class="stat"><span class="k">Days worked</span><span class="v">${r.totals.days_worked}</span></div>
        <div class="stat"><span class="k">People</span><span class="v">${r.totals.people}</span></div>
        <div class="stat"><span class="k">Clients</span><span class="v">${r.totals.contracts}</span></div>
        <div class="stat"><span class="k">Entries</span><span class="v">${r.totals.entries}</span></div>
      </div>
    </div>

    <div class="card"><header><h2>Hours over time</h2>
      <p>${r.grain === 'day' ? 'Each working day' : r.grain === 'week' ? 'By week' : 'By month'}</p></header>
      <div class="tr-wrap">
        ${ticks.map((t2) => `<div class="tr-grid" style="bottom:${22 + px(t2)}px"></div>
          <span class="tr-tick" style="bottom:${22 + px(t2) - 8}px">${t2}&nbsp;h</span>`).join('')}
        <div class="tr-chart">
        ${r.timeline.map((t2) => `<div class="tr-col" data-tip="${esc(t2.bucket)}: ${h(t2.hours)} h">
          <div class="tr-bar" style="height:${H2}px">
            <i class="tr-within" style="height:${px(t2.hours)}px"></i>
            ${t2.hours > 0 && r.timeline.length <= 16 ? `<b class="tr-val" style="bottom:${px(t2.hours) + 2}px">${h(t2.hours)}</b>` : ''}
          </div>
          <span class="sub">${esc(bLabel(t2.bucket))}</span>
        </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="grid2">
      ${S.repC ? shareTable(r.by_deliverable, 'By task') : shareTable(r.by_contract, 'By client')}
      ${S.repP ? shareTable(r.by_contract, 'By client') : shareTable(r.by_person, 'By person')}
    </div>
    <div class="grid2">
      ${S.repC ? shareTable(r.by_person, 'By person') : shareTable(r.by_deliverable, 'By task')}
      ${!S.repDept ? shareTable(r.by_department, 'By department') : ''}
    </div>

    <div class="card"><header><h2>Work log</h2>
      <p>${r.totals.entries} entries${r.entries_truncated ? ` — first 500 shown, the CSV export carries all` : ''}</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Date</th><th>Person</th><th>Client</th><th>Task</th>
          <th class="num">Hours</th><th>Note</th></tr></thead>
        <tbody>${r.entries.map((e) => `<tr>
          <td style="white-space:nowrap">${e.date.slice(8)}/${e.date.slice(5, 7)}</td>
          <td>${esc(e.person)}</td><td>${esc(e.contract)}</td><td>${esc(e.deliverable)}</td>
          <td class="num">${h(e.hours)}</td>
          <td class="rep-note">${esc(e.note || '')}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing logged in this range.</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

// ===========================================================================
// The schedule editor — the plan on a calendar you can push around. Drag a
// block to move it, drag its bottom edge to resize, click it for exact times.
// Blocks that are already answered (done or skipped) are the record, not the
// plan: they show, but they don't move.
// ===========================================================================

function renderSchedEditor(plan, dates) {
  // every week of the month, Mon-Sun, stacked — the whole plan on one page,
  // dragging works within a week and between weeks alike
  const period = S.period;
  const mondays = [...new Set(dates.map(mondayOf))].sort();
  if (!mondays.length) { $('#seCal').innerHTML = '<p class="muted">No working days this month.</p>'; return; }
  const inPeriod = (d) => d.slice(0, 7) === period;

  $('#seCal').innerHTML = mondays.map((monday) => {
    const days = Array.from({ length: 7 }, (_, i) => timeShiftDay(monday, i));
    const blocks = plan.blocks.filter((b) => days.includes(b.date));
    let lo = 8 * 60; let hi = 18 * 60;
    for (const b of blocks) {
      if (!b.start) continue;
      const s2 = toMinOfDay(b.start);
      lo = Math.min(lo, Math.floor(s2 / 60) * 60);
      hi = Math.max(hi, Math.ceil((s2 + b.minutes) / 60) * 60);
    }
    const height = (hi - lo) * T_PPM;
    const hours = []; for (let m = lo; m <= hi; m += 60) hours.push(m);
    const pos = (start, minutes) => `top:${(toMinOfDay(start) - lo) * T_PPM}px;height:${Math.max(18, minutes * T_PPM)}px`;

    return `<div class="card tw-card se-week" data-lo="${lo}">
      <div class="tw-head"><div class="tw-gutter"></div>
        ${days.map((d) => {
          const dayMin = blocks.filter((b) => b.date === d).reduce((s2, b) => s2 + b.minutes, 0);
          const off = !inPeriod(d);
          return `<div class="tw-col-head ${d === todayIso() ? 'today' : ''} ${off ? 'off' : ''}">
            <b>${niceDay(d)}</b><span class="sub">${off ? '—' : `${hm(dayMin)} planned`}</span></div>`;
        }).join('')}
      </div>
      <div class="tw-body">
        <div class="tw-gutter" style="height:${height}px">
          ${hours.slice(0, -1).map((m) => `<div class="tw-hlabel" style="top:${(m - lo) * T_PPM}px">${fromMinOfDay(m)}</div>`).join('')}
        </div>
        ${days.map((d) => `<div class="tw-day ${inPeriod(d) ? '' : 'tw-off'}" data-date="${inPeriod(d) ? d : ''}">
          <div class="tw-grid" style="height:${height}px">
            ${hours.slice(0, -1).map((m) => `<div class="tw-hour" style="top:${(m - lo) * T_PPM}px"></div>`).join('')}
            ${blocks.filter((b) => b.date === d && b.start).map((b) => b.accounted ? `
              <div class="tw-ghost done" style="${pos(b.start, b.minutes)}" data-tip="Committed — the record, not the plan">
                <span>${esc(b.label)}</span><em>${hm(b.minutes)} ✓</em></div>` : `
              <div class="tw-entry plan${b.anchored ? ' fixed' : ''}" data-kind="sblock" data-id="${b.id}"
                style="${pos(b.start, b.minutes)}">
                <span>${esc(b.label)}</span><em>${hm(b.minutes)}</em>
                <div class="tw-resize" data-kind="sresize" data-id="${b.id}"></div>
              </div>`).join('')}
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('') + `<p class="muted" style="padding:0 4px 12px">Drag a block anywhere in the month —
    between weeks included. Drag the lower edge to resize, click a block for exact times,
    or <b>click an empty slot to put work there</b>. Committed blocks (✓) are the record and stay put.</p>`;

  wireSchedDrag(plan);
}

function wireSchedDrag(plan) {
  const root = document.getElementById('seCal');
  if (!root) return;
  let drag = null;
  const loOf = (el) => Number(el.closest('.se-week')?.dataset.lo || 480);
  const slotOf = (ev) => {
    const day = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#seCal .tw-day');
    if (!day || day.classList.contains('tw-off') || !day.dataset.date) return null;
    const lo = loOf(day);
    const rect = day.querySelector('.tw-grid').getBoundingClientRect();
    const min = Math.round((ev.clientY - rect.top) / T_PPM / T_SNAP) * T_SNAP + lo;
    return { date: day.dataset.date, min: Math.max(lo, min), lo };
  };

  root.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest('[data-kind]');
    if (!t) return;
    const b = plan.blocks.find((x) => x.id === Number(t.dataset.id));
    if (!b) return;
    if (t.dataset.kind === 'sresize') {
      drag = { kind: 'resize', block: b, el: t.closest('.tw-entry'), startY: ev.clientY, moved: false };
    } else {
      const box = t.getBoundingClientRect();
      drag = { kind: 'move', block: b, el: t, grabOffset: ev.clientY - box.top,
        startX: ev.clientX, startY: ev.clientY, moved: false };
    }
    ev.preventDefault();
    try { root.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointers */ }
  });

  root.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientX - (drag.startX ?? ev.clientX)) + Math.abs(ev.clientY - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    // a stacked month is taller than the screen — carrying a block to the
    // edge scrolls the page under it, like every calendar app
    if (drag.kind === 'move') {
      if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 18);
      else if (ev.clientY < 130) window.scrollBy(0, -18);
    }
    if (drag.kind === 'resize') {
      const mins = Math.max(T_SNAP,
        Math.round((drag.block.minutes * T_PPM + ev.clientY - drag.startY) / T_PPM / T_SNAP) * T_SNAP);
      drag.el.style.height = `${Math.max(18, mins * T_PPM)}px`;
      drag.mins = mins;
    } else {
      const slot = slotOf({ clientX: ev.clientX, clientY: ev.clientY - drag.grabOffset + 1 });
      if (!slot) return;
      drag.slot = slot;
      drag.el.classList.add('dragging');
      drag.el.style.pointerEvents = 'none';   // never occlude the drop target beneath
      const grid = document.querySelector(`#seCal .tw-day[data-date="${slot.date}"] .tw-grid`);
      if (drag.el.parentElement !== grid) grid.appendChild(drag.el);
      drag.el.style.top = `${(slot.min - slot.lo) * T_PPM}px`;
    }
  });

  root.addEventListener('pointerup', async () => {
    const d = drag; drag = null;
    if (!d) return;
    try {
      if (!d.moved) { openBlockEditor(d.block); return; }
      if (d.kind === 'resize' && d.mins && d.mins !== d.block.minutes) {
        await timeApi('/resize-block', { body: { block_id: d.block.id, minutes: d.mins } });
        await renderSchedule();
        if (d.mins > d.block.minutes) maybePlanCheck(d.block.contract_id, d.block.id);
        return;
      } else if (d.kind === 'move' && d.slot) {
        await timeApi('/move-block', { body: { block_id: d.block.id, date: d.slot.date, start: fromMinOfDay(d.slot.min) } });
      }
      renderSchedule();
    } catch (err) { toast(err.message, true); renderSchedule(); }
  });

  // an empty slot is an invitation: click it and say what goes there
  root.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-kind], .tw-ghost')) return;   // blocks have their own click
    const day = ev.target.closest('#seCal .tw-day');
    if (!day || day.classList.contains('tw-off') || !day.dataset.date) return;
    const grid = day.querySelector('.tw-grid');
    if (!grid.contains(ev.target) && ev.target !== grid) return;
    const lo = loOf(day);
    const rect = grid.getBoundingClientRect();
    const min = Math.max(lo, Math.round((ev.clientY - rect.top) / T_PPM / T_SNAP) * T_SNAP + lo);
    openNewBlockPanel(day.dataset.date, fromMinOfDay(min), plan.state === 'draft');
  });
}

/**
 * After the plan grows by hand, ask whether it still fits the allocation.
 * Over budget → a panel names the overage and offers to trim other blocks
 * for that contract; the block just touched is never on the chopping list.
 */
async function maybePlanCheck(contractId, excludeBlockId) {
  if (!contractId) return;
  let c;
  try {
    c = await timeApi(`/plan-check?contract_id=${contractId}&period=${S.period}&exclude=${excludeBlockId || 0}`);
  } catch (e) { return; }
  if (!c.over_minutes) return;
  document.querySelector('.tpanel')?.remove();
  const r = c.proposal || { proposal: [], unplaced_minutes: c.over_minutes };
  const p = document.createElement('div');
  p.className = 'tpanel card';
  p.innerHTML = `
    <header><h2>Over the allocation</h2><button class="btn small" id="tpX">✕</button></header>
    <div class="tmeta">${esc(c.contract_name)}: <b>${hm(Math.round(c.planned_hours * 60))}</b> planned
      of ${hm(Math.round(c.allocated_hours * 60))} allocated — ${hm(c.over_minutes)} over</div>
    ${r.proposal.length ? `<div style="padding:0 16px">
      ${r.proposal.map((x, i) => `<label class="rebrow">
        <input type="checkbox" class="rbPick" data-i="${i}" checked>
        <span>${niceDay(x.date)}${x.start ? ` ${x.start}` : ''} — ${esc(x.label)}</span>
        <b>${hm(x.from_minutes)} → ${x.to_minutes === 0 ? 'removed' : hm(x.to_minutes)}</b>
      </label>`).join('')}</div>` : ''}
    ${r.unplaced_minutes ? `<p class="muted" style="padding:8px 16px 0">${hm(r.unplaced_minutes)} has nothing
      left to trim — leave the plan over, or raise the allocation on the contract page.</p>` : ''}
    <div class="rowline"><span class="spacer"></span>
      <button class="btn small" id="rbNo">Leave it over</button>
      ${r.proposal.length ? '<button class="btn primary small" id="rbGo">Trim to fit</button>' : ''}</div>`;
  view().appendChild(p);
  $('#tpX').addEventListener('click', () => p.remove());
  $('#rbNo').addEventListener('click', () => p.remove());
  $('#rbGo')?.addEventListener('click', async () => {
    const changes = [...p.querySelectorAll('.rbPick')].filter((cb) => cb.checked)
      .map((cb) => { const x = r.proposal[Number(cb.dataset.i)]; return { block_id: x.block_id, minutes: x.to_minutes }; });
    if (!changes.length) { p.remove(); return; }
    try {
      await timeApi('/rebalance', { body: { changes } });
      p.remove(); toast('Trimmed to fit the allocation.'); renderSchedule();
    } catch (err) { toast(err.message, true); }
  });
}

/** New work, born where you clicked: day and time prefilled, you name the rest. */
function openNewBlockPanel(date, start, isDraft) {
  document.querySelector('.tpanel')?.remove();
  const contracts = S.boot.contracts.filter((c) => !c.archived);
  const delivs = S.boot.deliverables;
  const p = document.createElement('div');
  p.className = 'tpanel card';
  p.innerHTML = `
    <header><h2>New block</h2><button class="btn small" id="tpX">✕</button></header>
    <div class="tmeta">${niceDay(date)} · ${start}${isDraft ? '<span class="pill warn">into the suggestion</span>' : ''}</div>
    <div class="rowline"><label>Contract</label>
      <select id="nwC" style="flex:1"><option value="">No contract</option>${contracts.map((c) =>
        `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="rowline"><label>Task</label>
      <select id="nwD" style="flex:1"><option value="">No deliverable</option>${delivs.map((d) =>
        `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
    <div class="rowline"><label>Start</label><input type="time" id="nwStart" value="${start}">
      <label style="min-width:auto">for</label>
      <input type="number" id="nwH" step="0.25" min="0.25" value="1" style="width:80px"><span class="muted">h</span></div>
    <div class="rowline"><span class="spacer"></span>
      <button class="btn primary small" id="nwGo">Add it</button></div>`;
  view().appendChild(p);
  $('#tpX').addEventListener('click', () => p.remove());
  $('#nwGo').addEventListener('click', async () => {
    const contractId = Number($('#nwC').value) || null;
    try {
      await api('/api/schedule/block', { body: {
        person_id: S.personId, period: S.period,
        contract_id: contractId,
        deliverable_id: Number($('#nwD').value) || null,
        date, start: $('#nwStart').value || start,
        minutes: Math.round(Number($('#nwH').value) * 4) * 15,
        draft: isDraft,
      } });
      p.remove(); toast('Added to the plan.'); await renderSchedule();
      maybePlanCheck(contractId, null);
    } catch (err) { toast(err.message, true); }
  });
}

/** Exact control over one planned block: day, start, length — or remove it. */
function openBlockEditor(b) {
  document.querySelector('.tpanel')?.remove();
  const p = document.createElement('div');
  p.className = 'tpanel card';
  p.innerHTML = `
    <header><h2>${esc(b.label)}</h2><button class="btn small" id="tpX">✕</button></header>
    <div class="rowline"><label>Day</label><input type="date" id="sbDate" value="${b.date}"></div>
    <div class="rowline"><label>Start</label><input type="time" id="sbStart" value="${b.start || '09:00'}"></div>
    <div class="rowline"><label>Hours</label><input type="number" id="sbH" step="0.25" min="0.25" value="${h(b.minutes / 60)}"></div>
    <div class="rowline"><span class="spacer"></span>
      ${S.me?.role === 'admin' ? '<button class="btn danger small" id="sbDel">Remove</button>' : ''}
      <button class="btn primary small" id="sbSave">Save</button></div>`;
  view().appendChild(p);
  $('#tpX').addEventListener('click', () => p.remove());
  $('#sbDel')?.addEventListener('click', async () => {
    await api(`/api/schedule/block/${b.id}`, { method: 'DELETE' });
    p.remove(); renderSchedule();
  });
  $('#sbSave').addEventListener('click', async () => {
    try {
      const date = $('#sbDate').value; const start = $('#sbStart').value;
      const minutes = Math.round(Number($('#sbH').value) * 4) * 15;
      // shrink before moving, grow after — the overlap check always sees the
      // size the block will actually have in its destination
      if (minutes < b.minutes) await timeApi('/resize-block', { body: { block_id: b.id, minutes } });
      if (date !== b.date || start !== b.start) {
        await timeApi('/move-block', { body: { block_id: b.id, date, start } });
      }
      if (minutes > b.minutes) await timeApi('/resize-block', { body: { block_id: b.id, minutes } });
      p.remove(); toast('Saved.'); await renderSchedule();
      if (minutes > b.minutes) maybePlanCheck(b.contract_id, b.id);
    } catch (err) { toast(err.message, true); }
  });
}
