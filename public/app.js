/* EmotioHours — client.
   Rule that shapes every screen: hours lead where a person is looking at their
   own month; units lead where the business is looking at contracts.

   Both denominations appear together on the headline tiles, because they answer
   different questions — units say what the team can deliver in contract value,
   hours say whether anyone actually has room. They diverge wherever rates do.
   Summing hours across people is legitimate as a capacity figure; it is only
   meaningless as a measure of value, so the balance rule stays units-only. */

const S = { period: null, boot: null, view: 'agency', personId: null, contractId: null, plan: null };

const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const h = (n, d = 2) => (Number(n) || 0).toFixed(d).replace(/\.00$/, '');
const NB = '\u00a0';                                                 // keeps "12.5 h" unbreakable
const hrs = (n) => `${h(Math.round((Number(n) || 0) * 4) / 4)}${NB}h`; // display rounds to 0.25
const units = (n) => `${h(n)}${NB}u`;
const pct = (n) => `${Math.round(Number(n) || 0)}%`;

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
  sel.innerHTML = S.boot.periods.map((p) =>
    `<option value="${p}"${p === S.period ? ' selected' : ''}>${esc(monthName(p))}</option>`).join('');

  await render();
}

async function render() {
  $('#tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  try {
    if (S.view === 'agency') await renderAgency();
    else if (S.view === 'people') await renderPerson();
    else if (S.view === 'contracts') await renderContracts();
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

$('#syncBtn').addEventListener('click', async () => {
  const btn = $('#syncBtn');
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const r = await api(`/api/harvest/sync-actuals${P()}`, { method: 'POST' });
    toast(`Pulled ${r.entries} entries (${h(r.hours)} h). ${r.unmapped_task_entries} could not be matched to a deliverable.`);
    await render();
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = 'Sync Harvest';
});

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

async function renderAgency() {
  const a = await api(`/api/agency${P()}`);
  const t = a.totals;
  const people = S.boot.people;
  const execName = (id) => people.find((p) => p.id === id)?.name || 'Unassigned';

  const live = a.contracts.filter((c) => c.type !== 'internal' && c.status === 'live');
  const pipeline = a.contracts.filter((c) => c.status === 'pipeline');
  const internal = a.contracts.find((c) => c.type === 'internal');

  const byExec = new Map();
  for (const c of live) {
    const contract = S.boot.contracts.find((x) => x.id === c.contract_id);
    const key = contract?.exec_person_id ?? 0;
    if (!byExec.has(key)) byExec.set(key, []);
    byExec.get(key).push(c);
  }

  const contractRow = (c) => {
    const bad = !c.balanced;
    const pot = c.type === 'pot';
    return `<tr>
      <td><button class="linky" data-contract="${c.contract_id}">${esc(c.name)}</button>
        ${pot ? `<span class="sub">pot ${units(c.pot_units)} · ${c.pot_start} to ${c.pot_end}</span>` : ''}</td>
      <td>${pot ? '<span class="pill info">Pot</span>' : '<span class="pill mute">Retainer</span>'}</td>
      <td class="num">${pot ? units(c.pot_units) : units(c.contracted_units)}</td>
      <td class="num">${c.carryover.units ? units(c.carryover.units) : '—'}</td>
      <td class="num">${units(c.people_units)}</td>
      <td class="num">${c.third_party_units ? units(c.third_party_units) : '—'}</td>
      <td class="num">${units(c.allocated_units)}</td>
      <td class="num">${pot
        ? `${units(c.pot_remaining)} left`
        : `<span class="pill ${bad ? 'bad' : 'ok'}">${bad ? (c.variance > 0 ? `${h(c.variance)} under` : `${h(-c.variance)} over`) : 'balanced'}</span>`}</td>
    </tr>`;
  };

  // A contract is out of balance in either direction. Over-allocating burns
  // margin; under-allocating means work you have been paid for is unplanned.
  const overrun = live.filter((c) => c.variance < -0.005);
  const underrun = live.filter((c) => c.variance > 0.005);
  const overrunUnits = overrun.reduce((s, c) => s - c.variance, 0);
  const underrunUnits = underrun.reduce((s, c) => s + c.variance, 0);
  const offBalance = overrun.length + underrun.length;
  const potWarn = a.contracts.filter((c) => c.type === 'pot' && (c.pot_overrun || c.pot_exhausted));
  const inactiveOwned = S.boot.contracts.filter((c) => {
    const ex = people.find((p) => p.id === c.exec_person_id);
    return c.status === 'live' && c.type !== 'internal' && ex && !ex.active;
  });

  // Every tile carries both denominations: units answer "can we sell more?",
  // hours answer "has anyone got room?". They diverge when rates differ.
  const pair = (u, hh) => `${units(u)}<span class="sep">/</span><span class="alt">${hrs(hh)}</span>`;

  view().innerHTML = `
    <div class="stats">
      <div class="stat ${t.headroom_units > 40 ? 'good' : t.headroom_units < 0 ? 'bad' : 'warn'}">
        <span class="k">Delivery headroom</span>
        <span class="v">${pair(t.headroom_units, t.headroom_hours)}</span>
        <span class="s">of ${units(t.capacity_units)} / ${hrs(t.capacity_hours)} capacity</span>
      </div>
      <div class="stat">
        <span class="k">Allocated</span>
        <span class="v">${pair(t.allocated_units, t.allocated_hours)}</span>
        <span class="s">${pct(t.capacity_units ? (t.allocated_units / t.capacity_units) * 100 : 0)} of capacity by value</span>
      </div>
      <div class="stat">
        <span class="k">Contracted</span>
        <span class="v">${pair(t.contracted_units, t.contracted_hours)}</span>
        <span class="s">${live.length} live contracts · hours committed to deliver them</span>
      </div>
      <div class="stat ${offBalance ? 'bad' : 'good'}">
        <span class="k">Out of balance</span>
        <span class="v">${offBalance}<span class="sep">/</span><span class="alt">${live.length} contracts</span></span>
        <span class="s">${offBalance
          ? [overrun.length ? `${units(overrunUnits)} over` : null,
             underrun.length ? `${units(underrunUnits)} unplanned` : null].filter(Boolean).join(' · ')
          : 'every contract reconciles'}</span>
      </div>
      <div class="stat ${t.constraint ? 'bad' : 'good'}">
        <span class="k">Binding constraint</span>
        <span class="v" style="font-size:1.15rem">${t.constraint ? esc(t.constraint.name) : 'None'}</span>
        <span class="s">${t.constraint ? `over by ${hrs(t.constraint.over_by_hours)}` : 'nobody is overbooked'}</span>
      </div>
    </div>

    ${overrun.length ? `<div class="banner bad"><div>
      <b>${overrun.length} contracts are allocated beyond what they're contracted for — ${units(overrunUnits)} in total.</b><br>
      Re-costed at real rates, senior time consumes more contract value than the old sheet assumed.
      Either trim the allocation, or declare the extra as carry-over on the contract.
    </div></div>` : ''}

    ${underrun.length ? `<div class="banner"><div>
      <b>${underrun.length} contracts have ${units(underrunUnits)} of contracted work with nobody on it.</b><br>
      ${t.allocated_units < 0.005
        ? `Nothing is allocated for ${esc(monthName(S.period))} yet — plan the month on each contract.`
        : 'Either allocate the remaining value, or reduce what the client is billed for.'}
    </div></div>` : ''}

    ${inactiveOwned.length ? `<div class="banner"><div>
      <b>${inactiveOwned.length} live contracts belong to someone no longer active</b>
      (${esc(inactiveOwned.map((c) => c.name).join(', '))}). Reassign them in Contracts.
    </div></div>` : ''}

    ${potWarn.length ? `<div class="banner"><div>
      <b>Pot warning.</b> ${potWarn.map((c) =>
        `${esc(c.name)} — ${c.pot_exhausted ? 'exhausted' : `on pace for ${units(c.pot_projected)} against a ${units(c.pot_units)} pot`}`).join('; ')}
    </div></div>` : ''}

    <div class="card">
      <header><h2>Capacity by person</h2><p>Clock hours each, with what those hours are worth</p></header>
      <div class="scroll"><table>
        <thead><tr>
          <th>Person</th><th class="num">Rate</th><th class="num">Available</th>
          <th class="num">Client capacity</th><th class="num">Allocated</th><th class="num">Spare</th>
          <th style="width:130px">Load</th><th class="num">Internal</th><th class="num">Logged</th>
        </tr></thead>
        <tbody>${a.staff.map((p) => `<tr>
          <td><button class="linky" data-person="${p.person_id}">${esc(p.name)}</button>
            <span class="sub">${pct(p.utilisation * 100)} target</span></td>
          <td class="num">£${h(p.rate)}</td>
          <td class="num">${hrs(p.available_hours)}</td>
          <td class="num">${hrs(p.client_hours)}</td>
          <td class="num">${hrs(p.allocated_client_hours)}<span class="sub">${units(p.allocated_client_units)}</span></td>
          <td class="num" style="color:${p.spare_hours < 0 ? 'var(--over)' : 'inherit'}">${hrs(p.spare_hours)}</td>
          <td>${capBar(p.allocated_client_hours, p.client_hours)}<span class="sub">${pct(p.load_pct)}</span></td>
          <td class="num">${hrs(p.allocated_internal_hours)} <span class="sub">of ${hrs(p.internal_hours)}</span></td>
          <td class="num">${p.actual_hours ? hrs(p.actual_hours) : '—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <header><h2>Contracts</h2><p>Units — the currency contracts are written in</p></header>
      <div class="scroll"><table>
        <thead><tr>
          <th>Contract</th><th>Type</th><th class="num">Contracted</th><th class="num">Carried</th>
          <th class="num">People</th><th class="num">Third party</th><th class="num">Allocated</th><th class="num">Balance</th>
        </tr></thead>
        <tbody>
        ${[...byExec.entries()].map(([execId, list]) => `
          <tr class="group"><td colspan="8">${esc(execName(execId))}</td></tr>
          ${list.map(contractRow).join('')}`).join('')}
        <tr class="total">
          <td colspan="2">Live total</td>
          <td class="num">${units(t.contracted_units)}</td><td class="num"></td>
          <td class="num">${units(live.reduce((s, c) => s + c.people_units, 0))}</td>
          <td class="num">${units(live.reduce((s, c) => s + c.third_party_units, 0))}</td>
          <td class="num">${units(live.reduce((s, c) => s + c.allocated_units, 0))}</td>
          <td class="num"></td>
        </tr>
        ${internal ? `<tr class="group"><td colspan="8">Internal</td></tr>
          <tr><td><button class="linky" data-contract="${internal.contract_id}">${esc(internal.name)}</button>
            <span class="sub">budget derived from each person's utilisation target</span></td>
          <td><span class="pill mute">Internal</span></td>
          <td class="num">${units(internal.contracted_units)}</td><td class="num">—</td>
          <td class="num">${units(internal.people_units)}</td><td class="num">—</td>
          <td class="num">${units(internal.allocated_units)}</td>
          <td class="num"><span class="pill ${Math.abs(internal.variance) < 5 ? 'ok' : 'warn'}">${
            internal.variance < 0 ? `${h(-internal.variance)} over budget` : `${h(internal.variance)} spare`}</span></td></tr>` : ''}
        ${pipeline.length ? `<tr class="group"><td colspan="8">Pipeline — not counted in headroom</td></tr>
          ${pipeline.map((c) => `<tr><td><button class="linky" data-contract="${c.contract_id}">${esc(c.name)}</button></td>
            <td><span class="pill warn">Pipeline</span></td><td class="num">${units(c.contracted_units)}</td>
            <td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>`).join('')}` : ''}
        </tbody>
      </table></div>
    </div>`;
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
  const q = (hh) => Math.round((Number(hh) || 0) * 4) / 4;
  const asUnits = (hh) => q(hh) * v.person.rate / S.boot.settings.standard_rate;
  const pairH = (hh) => `${hrs(hh)}<span class="sep">/</span><span class="alt">${units(asUnits(hh))}</span>`;
  const clientLines = v.lines.filter((l) => l.type !== 'internal');
  const internalLines = v.lines.filter((l) => l.type === 'internal');

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
      <header><h2>Client work</h2><p>Hours lead · units shown for reference</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Contract</th><th>Deliverable</th><th class="num">Hours</th><th class="num">Units</th><th class="num">Logged</th></tr></thead>
        <tbody>${clientLines.length ? clientLines.map((l) => `<tr>
          <td><button class="linky" data-contract="${l.contract_id}">${esc(l.contract_name)}</button></td>
          <td>${esc(l.deliverable_name)}</td>
          <td class="num">${hrs(l.hours)}</td>
          <td class="num">${units(l.units)}</td>
          <td class="num">${v.actual_by_contract[l.contract_id] != null ? hrs(v.actual_by_contract[l.contract_id]) : '—'}</td>
        </tr>`).join('') : '<tr><td colspan="5" class="muted">Nothing allocated this month.</td></tr>'}
        <tr class="total"><td colspan="2">Total</td><td class="num">${hrs(t.client_hours)}</td>
          <td class="num">${units(t.client_units)}</td><td class="num"></td></tr></tbody>
      </table></div>
    </div>

    <div class="card">
      <header><h2>Internal &amp; training</h2>
        <p>Budget ${hrs(t.internal_budget_hours)} — the ${pct(100 - v.person.utilisation * 100)} not sold to clients</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Deliverable</th><th class="num">Hours</th></tr></thead>
        <tbody>${internalLines.map((l) => `<tr><td>${esc(l.deliverable_name)}</td>
          <td class="num">${hrs(l.hours)}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td class="num">${hrs(t.internal_hours)}</td></tr>
        <tr><td class="muted">Budget remaining</td>
          <td class="num" style="color:${t.internal_budget_hours - t.internal_hours < 0 ? 'var(--over)' : 'inherit'}">
          ${hrs(t.internal_budget_hours - t.internal_hours)}</td></tr></tbody>
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
      <div class="rowline"><h2>Contracts</h2><span class="spacer"></span>
        <button class="btn small" id="newContract">New contract</button></div>
      <div class="card"><div class="scroll"><table>
        <thead><tr><th>Contract</th><th>Owner</th><th>Type</th><th>Status</th>
          <th class="num">Contracted</th><th class="num">Allocated</th><th class="num">Balance</th></tr></thead>
        <tbody>${a.contracts.map((c) => {
          const cc = S.boot.contracts.find((x) => x.id === c.contract_id) || {};
          const ex = S.boot.people.find((p) => p.id === cc.exec_person_id);
          return `<tr>
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
    return;
  }
  await renderContractDetail(S.contractId);
}

async function renderContractDetail(id) {
  const d = await api(`/api/contract/${id}${P()}`);
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
// 4 — Schedule. Hours only; units never appear.
// ---------------------------------------------------------------------------

async function renderSchedule() {
  const people = S.boot.people.filter((p) => p.active);
  if (!S.personId || !people.some((p) => p.id === S.personId)) S.personId = people[0]?.id;
  if (!S.personId) { view().innerHTML = '<p class="muted">No active people.</p>'; return; }

  const plan = await api(`/api/schedule/${S.personId}${P()}`);
  const byDate = new Map();
  for (const b of plan.blocks) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }
  const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  view().innerHTML = `
    <div class="rowline">
      <label for="schedPick">Person</label>
      <select id="schedPick">${people.map((p) =>
        `<option value="${p.id}"${p.id === S.personId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span class="spacer"></span>
      <a class="btn primary small" href="/api/schedule/${S.personId}/ics${P()}">Download .ics</a>
    </div>

    <div class="stats">
      <div class="stat"><span class="k">Scheduled</span><span class="v">${hrs(plan.totals.scheduled_hours)}</span>
        <span class="s">${plan.totals.blocks} blocks across ${byDate.size} days</span></div>
      <div class="stat ${plan.totals.unplaced_hours > 0 ? 'warn' : 'good'}">
        <span class="k">Couldn't place</span><span class="v">${hrs(plan.totals.unplaced_hours)}</span>
        <span class="s">${plan.totals.unplaced_hours > 0 ? 'no room left in the month' : 'everything fits'}</span></div>
    </div>

    ${plan.unplaced.length ? `<div class="banner"><div>
      <b>${plan.unplaced.length} sessions wouldn't fit.</b>
      ${esc([...new Set(plan.unplaced.map((u) => u.label))].slice(0, 6).join('; '))}.
      Either this person is overbooked, or a block is too long for a single day.</div></div>` : ''}

    <div class="banner info"><div>Blocks follow each deliverable's recipe — a weekly email lands once a week,
      a campaign build gets one long sitting, fixed calls keep their slot. Change the recipes in Settings.</div></div>

    <div class="weekgrid">${[...byDate.entries()].map(([date, blocks]) => `
      <div class="day">
        <h4><span>${esc(dayLabel(date))}</span>
          <span>${hrs(blocks.reduce((s, b) => s + b.minutes, 0) / 60)}</span></h4>
        ${blocks.map((b) => `<div class="blk${b.anchored ? ' fixed' : ''}">
          <span class="t">${esc(b.start)}–${esc(b.end)}</span>
          <span>${esc(b.label)}${b.anchored ? ' <span class="pill info">fixed</span>' : ''}</span>
          <span class="m">${Math.round(b.minutes)}m</span></div>`).join('')}
      </div>`).join('')}</div>`;

  $('#schedPick').addEventListener('change', (e) => { S.personId = Number(e.target.value); renderSchedule(); });
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
      <header><h2>People &amp; rates</h2><p>Rate sets the unit conversion · utilisation is the client share, the rest is internal &amp; training</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Name</th><th>Initials</th><th class="num">Hours/week</th><th class="num">Rate £/h</th>
          <th class="num">Utilisation</th><th class="num">Units per hour</th><th>Active</th><th></th></tr></thead>
        <tbody>${S.boot.people.map((p) => `<tr data-p="${p.id}">
          <td><input type="text" class="pn" value="${esc(p.name)}" style="width:150px"></td>
          <td><input type="text" class="pi" value="${esc(p.initials)}" style="width:56px"></td>
          <td class="num"><input type="number" class="pw" step="0.5" min="0" value="${h(p.weekly_hours)}"></td>
          <td class="num"><input type="number" class="pr" step="0.1" min="0" value="${h(p.rate)}"></td>
          <td class="num"><input type="number" class="pu" step="1" min="0" max="100" value="${Math.round(p.utilisation * 100)}"></td>
          <td class="num">${h(p.rate / st.standard_rate)}</td>
          <td><input type="checkbox" class="pa"${p.active ? ' checked' : ''}></td>
          <td class="num"><button class="btn small primary savep">Save</button></td>
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
      <header><h2>Scheduling recipes</h2><p>How each deliverable's hours are shaped into calendar blocks</p></header>
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
          <td><select class="ra">${[1, 2, 3, 4, 5].map((d) =>
            `<option value="${d}"${r.anchor_dow === d ? ' selected' : ''}>${DOW[d]}</option>`).join('')}</select>
            <input type="time" class="rt" value="${esc(r.anchor_time || '10:00')}" style="width:96px"></td>
          <td class="num"><button class="btn small primary saver">Save</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <header><h2>Fixed commitments</h2><p>Weekly calls and standing meetings — the packer works around these</p></header>
      <div class="scroll"><table>
        <thead><tr><th>Person</th><th>What</th><th>When</th><th class="num">Minutes</th><th></th></tr></thead>
        <tbody>${anchors.length ? anchors.map((a) => `<tr>
          <td>${esc(a.person_name)}</td>
          <td>${esc(a.label)}${a.contract_name ? ` <span class="muted">· ${esc(a.contract_name)}</span>` : ''}</td>
          <td>${DOW[a.dow]} ${esc(a.time)}</td>
          <td class="num">${a.minutes}</td>
          <td class="num"><button class="btn small danger dela" data-a="${a.id}">Remove</button></td>
        </tr>`).join('') : '<tr><td colspan="5" class="muted">None yet.</td></tr>'}</tbody>
      </table></div>
      <div class="body" style="border-top:1px solid var(--rule)">
        <div class="rowline"><label>Add</label>
          <select id="naP">${S.boot.people.filter((p) => p.active).map((p) =>
            `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
          <select id="naC"><option value="">No contract</option>${S.boot.contracts.map((c) =>
            `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          <input type="text" id="naLabel" placeholder="e.g. Weekly call" style="width:170px">
          <select id="naDow">${[1, 2, 3, 4, 5].map((d) => `<option value="${d}">${DOW[d]}</option>`).join('')}</select>
          <input type="time" id="naTime" value="10:00" style="width:96px">
          <input type="number" id="naMin" value="60" step="15" min="15">
          <button class="btn small primary" id="addAnchor">Add</button></div>
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

  view().querySelectorAll('.dela').forEach((btn) => btn.addEventListener('click', async () => {
    await api(`/api/anchors/${btn.dataset.a}`, { method: 'DELETE' });
    renderSettings();
  }));

  $('#addAnchor').addEventListener('click', async () => {
    const label = $('#naLabel').value.trim();
    if (!label) return toast('What is the commitment?', true);
    await api('/api/anchors', { body: {
      person_id: Number($('#naP').value), contract_id: Number($('#naC').value) || null,
      label, dow: Number($('#naDow').value), time: $('#naTime').value, minutes: Number($('#naMin').value) } });
    toast('Commitment added.'); renderSettings();
  });

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
