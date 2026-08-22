/* EmotioHours — client.
   Rule that shapes every screen: hours lead where a person is looking at their
   own month; units lead where the business is looking at contracts.

   Both denominations appear together on the headline tiles, because they answer
   different questions — units say what the team can deliver in contract value,
   hours say whether anyone actually has room. They diverge wherever rates do.
   Summing hours across people is legitimate as a capacity figure; it is only
   meaningless as a measure of value, so the balance rule stays units-only. */

const S = { period: null, boot: null, view: 'agency', personId: null, contractId: null, plan: null,
  showArchived: false, showRecipes: false };

const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const h = (n, d = 2) => (Number(n) || 0).toFixed(d).replace(/\.?0+$/, '');
const NB = '\u00a0';                                                 // keeps "12.5 h" unbreakable
// Show hours as they really are. Forcing derived capacity onto a quarter grain
// understated it — 4 h/week across 21 working days is 16.8 h, and snapping
// displayed 16.75. Allocations and schedule blocks are already on quarters, so
// they still read cleanly.
const hrs = (n) => `${h(n)}${NB}h`;
const units = (n) => `${h(n)}${NB}u`;
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

async function boot() {
  S.boot = await api(`/api/bootstrap${S.period ? P() : ''}`);
  S.period = S.boot.period;

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
    else await renderSettings();
  } catch (e) {
    view().innerHTML = `<div class="banner bad"><div><b>Something went wrong.</b><br>${esc(e.message)}</div></div>`;
  }
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  S.view = b.dataset.view;
  render();
});

$('#period').addEventListener('change', async (e) => {
  S.period = e.target.value;
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
    S.boot = await api(`/api/bootstrap${P()}`);
    await boot();
  } catch (e) { toast(e.message, true); }
});

$('#delMonth').addEventListener('click', async () => {
  if (S.boot.periods.length <= 1) return toast('That is the only month — add another before deleting this one.', true);
  if (!confirm(`Delete ${monthName(S.period)}?\n\nEvery allocation, third-party line and carry-over in it goes too. This cannot be undone.`)) return;
  try {
    const r = await api(`/api/months/${S.period}`, { method: 'DELETE' });
    toast(`${monthName(S.period)} deleted.`);
    S.period = r.months[r.months.length - 1];
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
  return `<div class="bar" title="${hrs(usedH)} of ${hrs(capH)}">
    <i class="used" style="width:${w(used)}"></i><i class="over" style="width:${w(over)}"></i></div>`;
}

/** Hours lead on every headline figure; units ride alongside. */
const pairHU = (hh, u) => `${hrs(hh)}<span class="sep">/</span><span class="alt">${units(u)}</span>`;

async function renderAgency() {
  const a = await api(`/api/agency${P()}`);
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

  // Columns are everyone who can carry client work, plus anyone still holding
  // allocations this month — otherwise a departed person's hours vanish from
  // the row and the numbers stop adding up.
  const allocated = new Set(a.contracts.flatMap((c) => c.lines.map((l) => l.person_id)));
  const cols = people.filter((p) => (p.active && !p.archived) || allocated.has(p.id));
  const hoursFor = (c, pid) => c.lines.filter((l) => l.person_id === pid).reduce((s, l) => s + l.hours, 0);

  const gridRow = (c) => {
    const contract = S.boot.contracts.find((x) => x.id === c.contract_id) || {};
    const pot = c.type === 'pot';
    return `<tr>
      <td class="ini">${esc(execIni(contract.exec_person_id))}</td>
      <td class="name"><button class="linky" data-contract="${c.contract_id}">${esc(c.name)}</button>
        ${pot ? `<span class="sub">pot ${units(c.pot_units)} · to ${c.pot_end}</span>` : ''}</td>
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
          <th>Person</th><th class="num">Rate</th><th class="num">Available</th>
          <th class="num">Client capacity</th><th class="num">Allocated</th><th class="num">Spare</th>
          <th style="width:140px">Load</th><th class="num">Internal</th>
        </tr></thead>
        <tbody>${a.staff.map((p) => `<tr>
          <td><button class="linky" data-person="${p.person_id}">${esc(p.name)}</button>
            <span class="sub">${pct(p.utilisation * 100)} target</span></td>
          <td class="num">£${h(p.rate)}</td>
          <td class="num">${hrs(p.available_hours)}</td>
          <td class="num">${hrs(p.client_hours)}</td>
          <td class="num">${hrs(p.allocated_client_hours)}<span class="sub">${units(p.allocated_client_units)}</span></td>
          <td class="num spare ${p.spare_hours < 0 ? 'neg' : 'pos'}">${hrs(p.spare_hours)}</td>
          <td>${capBar(p.allocated_client_hours, p.client_hours)}<span class="sub">${pct(p.load_pct)}</span></td>
          <td class="num">${p.allocated_internal_hours ? hrs(p.allocated_internal_hours) : '<span class="nil">—</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>

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
  const people = S.boot.people.filter((p) => p.active);
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
  const pairH = (hh) => `${hrs(hh)}<span class="sep">/</span><span class="alt">${units(asUnits(hh))}</span>`;
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
      <span class="pill mute">£${h(v.person.rate)}/h · ${pct(v.person.utilisation * 100)} target</span>
      <span class="spacer"></span>
      <button class="btn small" data-goto-schedule="${S.personId}">View schedule</button>
    </div>

    <div class="stats">
      <div class="stat"><span class="k">Client capacity</span>
        <span class="v">${pairH(c.client_hours)}</span>
        <span class="s">of ${hrs(c.available_hours)} available after leave</span></div>
      <div class="stat"><span class="k">Allocated</span>
        <span class="v">${pairH(t.client_hours)}</span>
        <span class="s">${pct(t.load_pct)} of their client capacity</span></div>
      <div class="stat ${t.spare_hours < 0 ? 'bad' : 'good'}"><span class="k">Spare</span>
        <span class="v">${pairH(t.spare_hours)}</span>
        <span class="s">${t.spare_hours < 0 ? 'overbooked' : 'room for more work'}</span></div>
      <div class="stat"><span class="k">Logged in Harvest</span>
        <span class="v">${t.actual_hours ? pairH(t.actual_hours) : '—'}</span>
        <span class="s">${t.actual_hours ? `${h(t.actual_vs_allocated)} h vs allocated` : 'not synced yet'}</span></div>
    </div>

    ${t.spare_hours < 0 ? `<div class="banner bad"><div><b>${esc(v.person.name)} is overbooked by ${hrs(-t.spare_hours)}.</b>
      Move work to someone with room, or reduce what's committed this month.</div></div>` : ''}

    <div class="card">
      <header><h2>Client work</h2><p>One row per contract — click to see the deliverables inside</p></header>
      <div class="scroll"><table>
        <thead><tr><th></th><th>Contract</th><th class="num">Hours</th><th class="num">Units</th><th class="num">Deliverables</th></tr></thead>
        <tbody>${byContract.length ? byContract.map((g) => `
          <tr class="ct" data-grp="${g.contract_id}">
            <td class="tw"><span class="caret">▸</span></td>
            <td><button class="linky" data-contract="${g.contract_id}">${esc(g.name)}</button></td>
            <td class="num"><b>${hrs(g.hours)}</b></td>
            <td class="num">${units(g.units)}</td>
            <td class="num">${g.lines.length}</td>
          </tr>
          ${g.lines.map((l) => `<tr class="sub-row hidden" data-of="${g.contract_id}">
            <td></td><td class="indent">${esc(l.deliverable_name)}</td>
            <td class="num">${hrs(l.hours)}</td><td class="num">${units(l.units)}</td><td></td>
          </tr>`).join('')}`).join('')
          : '<tr><td colspan="5" class="muted">Nothing allocated this month.</td></tr>'}
        <tr class="total"><td></td><td>Total</td><td class="num">${hrs(t.client_hours)}</td>
          <td class="num">${units(t.client_units)}</td><td></td></tr></tbody>
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
    const a = await api(`/api/agency${P()}`);
    view().innerHTML = `
      <div class="rowline"><h2>Contracts</h2>
        <input type="search" id="cSearch" placeholder="Find a contract…" style="width:200px">
        <label class="tick"><input type="checkbox" id="cArch"${S.showArchived ? ' checked' : ''}> show archived</label>
        <span class="spacer"></span>
        <button class="btn small primary" id="newContract">New contract</button></div>
      <div class="card"><div class="scroll"><table>
        <thead><tr><th>Contract</th><th>Owner</th><th>Type</th><th>Status</th>
          <th class="num">Contracted</th><th class="num">Allocated</th><th class="num">Balance</th></tr></thead>
        <tbody id="cBody">${a.contracts.map((c) => {
          const cc = S.boot.contracts.find((x) => x.id === c.contract_id) || {};
          const ex = S.boot.people.find((p) => p.id === cc.exec_person_id);
          return `<tr class="${cc.archived ? 'archived' : ''}">
            <td><button class="linky" data-contract="${c.contract_id}">${esc(c.name)}</button></td>
            <td>${ex ? esc(ex.name) + (ex.active ? '' : ' <span class="pill warn">inactive</span>') : '<span class="muted">—</span>'}</td>
            <td><span class="pill ${c.type === 'pot' ? 'info' : 'mute'}">${esc(c.type)}</span></td>
            <td>${c.status === 'live' ? '<span class="pill ok">Live</span>'
              : c.status === 'pipeline' ? '<span class="pill warn">Pipeline</span>' : '<span class="pill mute">Hold</span>'}</td>
            <td class="num">${units(c.type === 'pot' ? c.pot_units : c.contracted_units)}</td>
            <td class="num">${units(c.allocated_units)}</td>
            <td class="num">${c.type === 'pot' ? `${units(c.pot_remaining)} left`
              : `<span class="pill ${c.balanced ? 'ok' : 'bad'}">${c.balanced ? 'balanced' : h(-c.variance) + ' over'}</span>`}</td>
          </tr>`;
        }).join('')}</tbody></table></div></div>`;
    $('#newContract').addEventListener('click', () => openContractEditor(null));
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

async function renderContractDetail(id) {
  const d = await api(`/api/contract/${id}${P()}`);
  const anchors = (await api('/api/anchors')).filter((x) => x.contract_id === id);
  const c = d.contract, s = d.summary;
  const people = S.boot.people.filter((p) => p.active || s.lines.some((l) => l.person_id === p.id));
  const deliverables = S.boot.deliverables.filter((x) => (c.type === 'internal') === !!x.internal);
  const inScope = new Set(s.lines.map((l) => l.deliverable_id));
  const tpUsed = new Map(s.third_parties.map((t) => [t.id, t.units]));
  const isPot = c.type === 'pot';

  const lineRow = (l) => `<tr data-line="${l.deliverable_id}:${l.person_id}">
    <td>${esc(l.deliverable_name)}</td>
    <td><select class="lp" data-d="${l.deliverable_id}" data-old="${l.person_id}">
      ${people.map((p) => `<option value="${p.id}"${p.id === l.person_id ? ' selected' : ''}>${esc(p.name)}${p.active ? '' : ' (inactive)'}</option>`).join('')}
    </select></td>
    <td class="num"><input type="number" class="lh" step="0.25" min="0" value="${h(l.hours)}"
      data-d="${l.deliverable_id}" data-p="${l.person_id}"></td>
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
           <div class="item"><span class="k">Projected</span>
             <span class="v ${s.pot_overrun ? 'bad' : 'ok'}">${units(s.pot_projected)}</span></div>`
        : `<div class="item"><span class="k">Balance</span>
             <span class="v ${s.balanced ? 'ok' : 'bad'}">${s.balanced ? 'balanced' : (s.variance > 0 ? `${h(s.variance)} under` : `${h(-s.variance)} over`)}</span></div>`}
      <div class="item"><span class="k">Clock hours</span><span class="v">${hrs(s.people_hours)}</span></div>
      <div class="item"><span class="k">Logged</span><span class="v">${d.actual_hours ? hrs(d.actual_hours) : '—'}</span></div>
    </div>

    ${!isPot && !s.balanced && s.variance < 0 ? `<div class="banner bad"><div>
      <b>Allocated ${units(-s.variance)} beyond contract.</b> Reduce hours, or declare the excess as carry-over below
      if you under-delivered last month.</div></div>` : ''}
    ${isPot && s.pot_overrun ? `<div class="banner bad"><div>
      <b>On pace to overrun this pot.</b> ${units(s.pot_drawn)} drawn with ${s.months_left} month(s) left —
      projected ${units(s.pot_projected)} against ${units(s.pot_units)}.</div></div>` : ''}

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
        <thead><tr><th>Deliverable</th><th>Who</th><th class="num">Hours</th><th class="num">Rate</th>
          <th class="num">Units</th><th class="num"></th></tr></thead>
        <tbody id="lineBody">${s.lines.length ? s.lines.map(lineRow).join('')
          : '<tr><td colspan="6" class="muted">Tick a deliverable above to start allocating.</td></tr>'}
        <tr class="total"><td colspan="2">Total</td><td class="num">${hrs(s.people_hours)}</td>
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
          <td>${DOW_NAMES[x.dow]} ${esc(x.time)}</td>
          <td class="num">${hrs(x.minutes / 60)}</td>
          <td class="num"><button class="btn small danger dela" data-a="${x.id}">Remove</button></td>
        </tr>`).join('') : '<tr><td colspan="5" class="muted">None on this contract.</td></tr>'}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <div class="rowline"><label>Add</label>
          <select id="naP">${people.filter((p) => p.active).map((p) =>
            `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
          <input type="text" id="naLabel" placeholder="e.g. Weekly call" style="width:170px">
          <select id="naDow">${[1, 2, 3, 4, 5].map((x) => `<option value="${x}">${DOW_NAMES[x]}</option>`).join('')}</select>
          <input type="time" id="naTime" value="10:00" style="width:100px">
          <input type="number" id="naMin" value="60" step="15" min="15"><span class="muted">min</span>
          <button class="btn small primary" id="addAnchor">Add</button></div>
      </div>
    </div>

    <div class="card">
      <header><h2>Channels in scope</h2><p>Recorded on the contract — hours stay under Paid Social</p></header>
      <div class="body" style="flex-direction:row;flex-wrap:wrap;gap:14px">
        ${S.boot.channels.map((ch) => `<label class="tick">
          <input type="checkbox" class="chtick" value="${ch.id}"${d.channels.includes(ch.id) ? ' checked' : ''}>
          ${esc(ch.name)}</label>`).join('')}
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

  const addA = $('#addAnchor');
  if (addA) addA.addEventListener('click', async () => {
    const label = $('#naLabel').value.trim();
    if (!label) return toast('What is the commitment?', true);
    await api('/api/anchors', { body: {
      person_id: Number($('#naP').value), contract_id: id, label,
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

  const chSave = async () => {
    const on = [...view().querySelectorAll('.chtick')].filter((x) => x.checked).map((x) => Number(x.value));
    await api(`/api/contract/${id}/channels`, { body: { channels: on } });
  };
  view().querySelectorAll('.chtick').forEach((el) => el.addEventListener('change', chSave));
}

function openContractEditor(c) {
  const people = S.boot.people;
  const f = (k, d = '') => esc(c?.[k] ?? d);
  view().innerHTML = `
    <div class="rowline"><button class="btn small" id="backE">← Back</button>
      <h2 style="margin-left:8px">${c ? 'Edit' : 'New'} contract</h2></div>
    <div class="card"><div class="body">
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
        <label style="min-width:auto">from</label><input type="text" id="cPotS" value="${f('pot_start')}" placeholder="YYYY-MM" style="width:100px">
        <label style="min-width:auto">to</label><input type="text" id="cPotE" value="${f('pot_end')}" placeholder="YYYY-MM" style="width:100px"></div>
      <div class="rowline"><label>Harvest projects</label>
        <input type="text" id="cHarvest" value="${f('harvest_ids')}" placeholder="comma-separated project ids" style="flex:1;min-width:220px"></div>
      <div class="rowline"><span class="spacer"></span>
        ${c ? '<button class="btn danger small" id="cDel">Archive</button>' : ''}
        <button class="btn primary" id="cSave">Save</button></div>
    </div></div>`;

  $('#backE').addEventListener('click', () => { if (c) renderContractDetail(c.id); else { S.contractId = null; renderContracts(); } });
  $('#cSave').addEventListener('click', async () => {
    const body = {
      id: c?.id, name: $('#cName').value.trim(), exec_person_id: Number($('#cExec').value) || null,
      type: $('#cType').value, status: $('#cStatus').value,
      monthly_units: Number($('#cUnits').value), pot_units: Number($('#cPot').value),
      pot_start: $('#cPotS').value.trim() || null, pot_end: $('#cPotE').value.trim() || null,
      harvest_ids: $('#cHarvest').value.trim(),
    };
    if (!body.name) return toast('Give the contract a name.', true);
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
        Client capacity is governed separately by each person's utilisation target on the Settings page.</p>
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
  const people = S.boot.people.filter((p) => p.active && !p.archived);
  if (!S.personId || !people.some((p) => p.id === S.personId)) S.personId = people[0]?.id;
  if (!S.personId) { view().innerHTML = '<p class="muted">No active people.</p>'; return; }

  const plan = await api(`/api/schedule/${S.personId}${P()}`);
  const pv = await api(`/api/person/${S.personId}${P()}`);
  const dates = await api(`/api/workdays${P()}`);
  const recipes = S.showRecipes ? await api(`/api/person-recipes/${S.personId}`) : [];

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

  view().innerHTML = `
    <div class="rowline">
      <label for="schedPick">Person</label>
      <select id="schedPick">${people.map((p) =>
        `<option value="${p.id}"${p.id === S.personId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span class="pill ${plan.committed ? 'ok' : 'warn'}">${plan.committed ? 'Saved plan' : 'Draft'}</span>
      <span class="spacer"></span>
      <button class="btn small" id="toggleRecipes">${
        S.showRecipes ? 'Hide how work is shaped' : 'How this person\'s work is shaped'}</button>
      <button class="btn small ${plan.committed ? '' : 'primary'}" id="genPlan">
        ${plan.committed ? 'Rebuild from allocations' : 'Edit this plan'}</button>
      ${plan.committed ? '<button class="btn small danger" id="clearPlan">Discard plan</button>' : ''}
      <a class="btn small primary" href="/api/schedule/${S.personId}/ics${P()}">Download .ics</a>
    </div>

    <div class="stats">
      <div class="stat"><span class="k">Scheduled</span><span class="v">${hrs(plan.totals.scheduled_hours)}</span>
        <span class="s">${plan.totals.blocks} blocks across ${byDate.size} days</span></div>
      <div class="stat ${pv.totals.spare_hours < 0 ? 'bad' : 'good'}">
        <span class="k">Headroom</span><span class="v">${hrs(pv.totals.spare_hours)}</span>
        <span class="s">of ${hrs(pv.capacity.client_hours)} client capacity · ${pct(pv.totals.load_pct)} loaded</span></div>
      <div class="stat ${plan.totals.unplaced_hours > 0 ? 'warn' : 'good'}">
        <span class="k">Couldn't place</span><span class="v">${hrs(plan.totals.unplaced_hours)}</span>
        <span class="s">${plan.totals.unplaced_hours > 0 ? 'no room left in the month' : 'everything fits'}</span></div>
    </div>

    ${plan.unplaced.length ? `<div class="banner"><div>
      <b>${plan.unplaced.length} sessions wouldn't fit.</b>
      ${esc([...new Set(plan.unplaced.map((u) => u.label))].slice(0, 6).join('; '))}.
    </div></div>` : ''}

    <div class="banner ${plan.committed ? 'info' : ''}"><div>
      ${plan.committed
        ? 'This is a saved plan — move blocks between days, change their hours, or delete them and they stay put. Rebuilding from allocations discards these edits.'
        : 'This is a draft from the scheduling recipes. Save it to start moving blocks around by hand.'}
    </div></div>

    ${S.showRecipes ? `<div class="card">
      <header><h2>How this person's work is shaped</h2>
        <p>Their own recipes. Blank rows follow the agency default in Settings</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Deliverable</th><th>Cadence</th><th>Distribution</th><th class="num">Block (min)</th>
          <th>Splittable</th><th class="num">Max sittings</th><th>Anchor</th><th></th></tr></thead>
        <tbody>${recipes.map((r) => `<tr data-d="${r.id}" class="${r.overridden ? 'own' : ''}">
          <td>${esc(r.name)}${r.internal ? ' <span class="pill mute">internal</span>' : ''}
            ${r.overridden ? ' <span class="pill info">theirs</span>' : ''}</td>
          <td><select class="prc">${['weekly', 'fortnightly', 'monthly', 'oneoff'].map((x) =>
            `<option${r.cadence === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
          <td><select class="prd">${['spread', 'frontload', 'deadline', 'anchored'].map((x) =>
            `<option${r.distribution === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
          <td class="num"><input type="number" class="prb" step="15" min="15" value="${r.block_minutes ?? 60}"></td>
          <td><input type="checkbox" class="prs"${r.splittable ? ' checked' : ''}></td>
          <td class="num"><input type="number" class="prm" step="1" min="0" value="${r.max_sittings ?? 0}"
            title="0 = let the block size decide. A daily ceiling overrides this either way."></td>
          <td class="anchorCell">
            <select class="pra"${r.distribution === 'anchored' ? '' : ' disabled'}>${[1, 2, 3, 4, 5].map((dd) =>
              `<option value="${dd}"${r.anchor_dow === dd ? ' selected' : ''}>${DOW_NAMES[dd]}</option>`).join('')}</select>
            <input type="time" class="prt" value="${esc(r.anchor_time || '10:00')}" style="width:100px"
              ${r.distribution === 'anchored' ? '' : 'disabled'}></td>
          <td class="num" style="white-space:nowrap">
            <button class="btn small primary prSave">Save</button>
            ${r.overridden ? '<button class="btn small prReset">Default</button>' : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <p class="muted"><b>Max sittings</b> caps how many separate blocks one allocation is broken
        into. Leave it 0 and the block size decides. It is a preference either way: if a block would
        not physically fit a day, the daily ceiling wins and it splits further — which is why a 12h
        build lands as 3 x 4h however this is set.
        <b>Anchor</b> only applies when Distribution is <span class="mono">anchored</span>; it is
        greyed out otherwise because it has no effect.</p>
      </div>
    </div>` : ''}

    ${plan.committed ? `<div class="card">
      <header><h2>Add a block</h2><p>Work the recipes knew nothing about</p></header>
      <div class="body"><div class="rowline">
        <select id="nbC"><option value="">No contract</option>${contractOptions}</select>
        <select id="nbD"><option value="">No deliverable</option>${deliverableOptions}</select>
        <select id="nbDate">${dayOptions(dates[0])}</select>
        <input type="time" id="nbStart" value="09:00" style="width:104px">
        <input type="number" id="nbH" step="0.25" min="0.25" value="1"><span class="muted">h</span>
        <button class="btn small primary" id="addBlock">Add</button>
      </div></div>
    </div>` : ''}

    <div class="weekgrid">${[...byDate.entries()].map(([date, blocks]) => `
      <div class="day">
        <h4><span>${esc(dayLabel(date))}</span>
          <span>${hrs(blocks.reduce((s, b) => s + b.minutes, 0) / 60)}</span></h4>
        ${blocks.map((b) => plan.committed ? `
          <div class="blk${b.anchored ? ' fixed' : ''}${b.manual ? ' manual' : ''}">
            <select class="bDate" data-b="${b.id}">${dayOptions(b.date)}</select>
            <input type="time" class="bStart" data-b="${b.id}" value="${esc(b.start)}">
            <input type="number" class="bH" data-b="${b.id}" step="0.25" min="0.25"
              value="${h(b.minutes / 60)}"><span class="muted">h</span>
            <span class="lbl">${esc(b.label)}${b.anchored ? ' <span class="pill info">fixed</span>' : ''}${
              b.manual ? ' <span class="pill warn">moved</span>' : ''}</span>
            <button class="btn small danger bDel" data-b="${b.id}">Remove</button>
          </div>` : `
          <div class="blk${b.anchored ? ' fixed' : ''}">
            <span class="t">${esc(b.start)}–${esc(b.end)}</span>
            <span>${esc(b.label)}${b.anchored ? ' <span class="pill info">fixed</span>' : ''}</span>
            <span class="m">${hrs(b.minutes / 60)}</span>
          </div>`).join('')}
      </div>`).join('') || '<p class="muted">Nothing scheduled this month.</p>'}</div>`;

  $('#schedPick').addEventListener('change', (e) => { S.personId = Number(e.target.value); renderSchedule(); });

  $('#toggleRecipes').addEventListener('click', () => {
    S.showRecipes = !S.showRecipes;
    renderSchedule();
  });

  // anchor controls follow the distribution, so they never look live when idle
  view().querySelectorAll('.prd').forEach((el) => el.addEventListener('change', () => {
    const tr = el.closest('tr'), on = el.value === 'anchored';
    $('.pra', tr).disabled = !on;
    $('.prt', tr).disabled = !on;
  }));

  view().querySelectorAll('.prSave').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    await api(`/api/person-recipes/${S.personId}`, { body: {
      deliverable_id: Number(tr.dataset.d),
      cadence: $('.prc', tr).value, distribution: $('.prd', tr).value,
      block_minutes: Number($('.prb', tr).value), splittable: $('.prs', tr).checked,
      max_sittings: Number($('.prm', tr).value),
      anchor_dow: Number($('.pra', tr).value), anchor_time: $('.prt', tr).value } });
    toast('Recipe saved for this person.');
    renderSchedule();
  }));

  view().querySelectorAll('.prReset').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    await api(`/api/person-recipes/${S.personId}/${tr.dataset.d}`, { method: 'DELETE' });
    toast('Back to the agency default.');
    renderSchedule();
  }));

  $('#genPlan').addEventListener('click', async () => {
    if (plan.committed && !confirm('Rebuild from the allocations?\n\nEvery block you have moved, resized or added by hand will be replaced.')) return;
    const r = await api(`/api/schedule/${S.personId}/generate${P()}`, { method: 'POST' });
    toast(`Plan saved — ${r.saved} blocks${r.unplaced ? `, ${r.unplaced} could not be placed` : ''}.`);
    renderSchedule();
  });

  const clear = $('#clearPlan');
  if (clear) clear.addEventListener('click', async () => {
    if (!confirm('Discard this plan and go back to the live draft?')) return;
    await api(`/api/schedule/${S.personId}/plan${P()}`, { method: 'DELETE' });
    toast('Plan discarded.');
    renderSchedule();
  });

  const patch = async (id, body) => {
    await api(`/api/schedule/block/${id}`, { method: 'PATCH', body });
    renderSchedule();
  };
  view().querySelectorAll('.bDate').forEach((el) => el.addEventListener('change',
    () => patch(el.dataset.b, { date: el.value })));
  view().querySelectorAll('.bStart').forEach((el) => el.addEventListener('change',
    () => patch(el.dataset.b, { start: el.value })));
  view().querySelectorAll('.bH').forEach((el) => el.addEventListener('change',
    () => patch(el.dataset.b, { hours: Number(el.value) })));
  view().querySelectorAll('.bDel').forEach((el) => el.addEventListener('click', async () => {
    await api(`/api/schedule/block/${el.dataset.b}`, { method: 'DELETE' });
    renderSchedule();
  }));

  const add = $('#addBlock');
  if (add) add.addEventListener('click', async () => {
    await api('/api/schedule/block', { body: {
      person_id: S.personId, period: S.period,
      contract_id: Number($('#nbC').value) || null,
      deliverable_id: Number($('#nbD').value) || null,
      date: $('#nbDate').value, start: $('#nbStart').value, hours: Number($('#nbH').value) } });
    toast('Block added.');
    renderSchedule();
  });
}

// ---------------------------------------------------------------------------
// 5 — Settings.
// ---------------------------------------------------------------------------

async function renderSettings() {
  const recipes = await api('/api/recipes');
  const anchors = await api('/api/anchors');
  const st = S.boot.settings;
  const DOW = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  view().innerHTML = `
    <div class="card">
      <header><h2>People &amp; rates</h2>
        <label class="tick"><input type="checkbox" id="showArch"${S.showArchived ? ' checked' : ''}> show archived</label>
      </header>
      <div class="scroll"><table>
        <thead><tr><th>Name</th><th>Initials</th><th class="num">Hours/week</th><th class="num">Rate £/h</th>
          <th class="num">Utilisation</th><th class="num">Units/h</th><th>Active</th><th></th></tr></thead>
        <tbody>${S.boot.people.map((p) => `<tr data-p="${p.id}" class="${p.archived ? 'archived' : ''}">
          <td><input type="text" class="pn" value="${esc(p.name)}" style="width:150px"></td>
          <td><input type="text" class="pi" value="${esc(p.initials)}" style="width:56px"></td>
          <td class="num"><input type="number" class="pw" step="0.5" min="0" value="${h(p.weekly_hours)}"></td>
          <td class="num"><input type="number" class="pr" step="0.1" min="0" value="${h(p.rate)}"></td>
          <td class="num"><input type="number" class="pu" step="1" min="0" max="100" value="${Math.round(p.utilisation * 100)}"></td>
          <td class="num">${h(p.rate / st.standard_rate)}</td>
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
      <div class="scroll"><table>
        <thead><tr><th>Deliverable</th><th>Cadence</th><th>Distribution</th><th class="num">Block (min)</th>
          <th>Splittable</th><th class="num">Max sittings</th><th>Anchor</th><th></th></tr></thead>
        <tbody>${recipes.map((r) => `<tr data-d="${r.id}">
          <td>${esc(r.name)}${r.internal ? ' <span class="pill mute">internal</span>' : ''}</td>
          <td><select class="rc">${['weekly', 'fortnightly', 'monthly', 'oneoff'].map((x) =>
            `<option${r.cadence === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
          <td><select class="rd">${['spread', 'frontload', 'deadline', 'anchored'].map((x) =>
            `<option${r.distribution === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td>
          <td class="num"><input type="number" class="rb" step="15" min="15" value="${r.block_minutes ?? 60}"></td>
          <td><input type="checkbox" class="rs"${r.splittable ? ' checked' : ''}></td>
          <td class="num"><input type="number" class="rm" step="1" min="0" value="${r.max_sittings ?? 0}"></td>
          <td><select class="ra"${r.distribution === 'anchored' ? '' : ' disabled'}>${[1, 2, 3, 4, 5].map((d) =>
            `<option value="${d}"${r.anchor_dow === d ? ' selected' : ''}>${DOW[d]}</option>`).join('')}</select>
            <input type="time" class="rt" value="${esc(r.anchor_time || '10:00')}" style="width:96px"
              ${r.distribution === 'anchored' ? '' : 'disabled'}></td>
          <td class="num"><button class="btn small primary saver">Save</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
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
      utilisation: Number($('.pu', tr).value) / 100, active: $('.pa', tr).checked } });
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

  view().querySelectorAll('.rd').forEach((el) => el.addEventListener('change', () => {
    const tr = el.closest('tr'), on = el.value === 'anchored';
    $('.ra', tr).disabled = !on;
    $('.rt', tr).disabled = !on;
  }));

  view().querySelectorAll('.saver').forEach((btn) => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    await api('/api/deliverables', { body: {
      id: Number(tr.dataset.d), name: tr.cells[0].textContent.replace(/\s*internal\s*$/i, '').trim(),
      recipe: {
        cadence: $('.rc', tr).value, distribution: $('.rd', tr).value,
        block_minutes: Number($('.rb', tr).value), splittable: $('.rs', tr).checked,
        max_sittings: Number($('.rm', tr).value),
        anchor_dow: Number($('.ra', tr).value), anchor_time: $('.rt', tr).value } } });
    toast('Recipe saved.');
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
