# EmotioHours

Replaces the Marketing Time Allocation Sheet. Contracted units in, team hours
out, headroom you can hire against, and per-person calendars that know a weekly
email is four two-hour blocks rather than one eight-hour one.

Stack matches EmotioGantt: Node 24 + Express, `node:sqlite`, vanilla frontend,
one Docker container behind Traefik.

```bash
npm install
npm start           # http://localhost:3400
```

First boot seeds the deliverable library and recipes; see **Seeding** for the
book of business. `DATA_DIR` controls where `ledger.db` lives (`/data` in
Docker).

---

## The two denominations

A director's hour and an offshore specialist's hour are not the same thing. The
ledger holds both currencies and is strict about which appears where.

- **A unit is £100 of contract value** — one hour at standard rate.
- Each person has an **hourly rate**; units = `hours × rate ÷ 100`.
- **Nobody types units.** Allocations are entered in hours, exactly as on the
  old sheet. The ledger converts and reconciles.

| Surface | Leads with | Why |
|---|---|---|
| Person view | Hours | The team thinks in their own day |
| Contract view | Hours entered, units checked | You allocate the way you always have |
| Agency grid | Units | Contracts are written in units |
| Headroom tiles | Both, paired | Value and clock time answer different questions |
| Calendar export | Hours | A block in a diary is clock time |

**Two questions, two denominations.** Units answer "can we sell another
contract?" — what the team can deliver in contract value. Hours answer "has
anyone actually got room?" — clock time available. They diverge wherever rates
do: a director is few hours but many units, an offshore specialist the reverse.
The headline tiles show both side by side so that tension stays visible.

Summing hours across people is legitimate as a *capacity* figure. It is only
meaningless as a measure of *value* — so the balance rule runs on units alone,
and a contract's worth is never expressed in hours.

## The balance rule

```
contracted units + carried-over units = Σ(people hours × rate ÷ 100) + Σ(third-party units)
```

Enforced, not observed. Retainers that don't balance go red on every screen.
Fixed pots are exempt and tracked against the pot instead.

- **Retainer** — fixed units monthly. Carry-over is allowed but must be
  *declared*, with a source month and a reason.
- **Pot** — a total drawn down across a window rather than reset monthly.
  Shows drawdown, months left, and a projected overrun warning.
- **Internal** — the internal/training budget. Each person's budget is
  `available hours × (1 − utilisation)`, so the target and the Internal /
  Training / Management line items are one mechanism, never counted twice.

## Scheduling

Each deliverable carries a recipe, editable in Settings:

- **cadence** — weekly / fortnightly / monthly / one-off
- **distribution** — spread / frontload / deadline / anchored
- **block** — minutes in one sitting
- **splittable** — can it break across days?

The packer respects each person's daily capacity, their fixed commitments, a
ceiling on how much of one client lands in a day, and the lunch break. Weeks are
weighted by working days, and an item that can't fit its own week slides to the
nearest week that has room rather than vanishing. Anything still unplaceable is
reported rather than silently dropped.

Export is one `.ics` per person per month (`Europe/London`, with a VTIMEZONE so
BST resolves). Nothing writes to anyone's calendar — they import or subscribe.

## Working patterns

Settings → Working patterns. By default everyone works the agency-standard week
(`weekly_hours / 5` a day, Monday to Friday). A pattern replaces that for one
person: a row per working day with its own start and end, blank for a day off —
so 3.5 days is three full days, one morning, and a blank Friday. Lunch is
deducted the same way as everywhere else.

A pattern flows through everything: capacity is summed date by date (a person
off every Friday loses five days in a five-Friday month), the scheduler places
nothing on their days off and caps each day at that day's hours, fixed
commitments cost what the person can actually attend, and saving a pattern
re-derives their hours/week. The audit checks all of it.

## Slack status sync

Settings → Slack status sync. During the agency working window, anyone whose
pattern says they are off gets a Slack status (default 🚫 **Not working**) with
an expiry, so Slack clears it by itself. Evenings, weekends and bank holidays
get nothing, and an existing status — holiday, illness, anything set by hand —
is never replaced unless the override is ticked.

It needs each person's Slack member ID (People card; Slack profile → ⋮ → Copy
member ID) and a **user token** (`xoxp-`) from a private Slack app with
`users.profile:read` + `users.profile:write` user scopes, installed by a
workspace owner or admin — Slack only lets an admin on a paid plan set someone
else's status. The token can live in Settings or in a `SLACK_TOKEN` env var.
The sync runs every five minutes inside the app; no cron needed.

## Harvest

Settings → Harvest. Account id and personal access token from
id.getharvest.com → Developers.

- **Pull team** upserts people (new arrivals land inactive on purpose).
- **Sync Harvest** pulls the month's time entries into `actuals`, mapping
  Harvest project → contract (via the contract's project ids) and Harvest task →
  deliverable (via `task_map`, which strips client prefixes: `AC Google Ads` →
  `google ads`).
- Anything unmatched is listed at the bottom of Settings with a dropdown to map
  it. Mapping is remembered; re-sync to apply it.

---

## Seeding

Seeding is split so that nothing commercially sensitive reaches a public repo.

**Structure — ships in this repo.** The deliverable library and its scheduling
recipes, the channel list, and a generic third-party rate card with placeholder
costs. Enough to boot a structurally complete, empty instance.

**The book of business — `seed-data.json`, gitignored.** People, rates,
utilisation targets, clients, contract values, allocations and Harvest project
ids. Drop the file in the app root and run `npm run seed`, or set `SEED_DATA` to
a path elsewhere. Without it the app starts empty and is filled in through the
UI.

Re-running only inserts what is missing, so it is safe against a live database.

To produce a `seed-data.json` from an instance you already populated, export
`people`, `contracts`, `third_parties`, `allocations`, `tp_allocations`,
`anchors` and `contract_channels`, keyed by name/initials rather than by id.

### Reading the first month

Whatever you seed, treat the first month as a migration to review rather than
a source of truth:

- Figures carried over from a flat-rate spreadsheet will show contracts
  **over-allocated** once they are re-costed at real per-person rates. That is
  the point of the exercise, not a fault in the import.
- People who appear in an old sheet but log nothing in the time tracker should
  be seeded **inactive**, so the contracts they own surface for reassignment
  instead of quietly vanishing from capacity.
- If the source had no deliverable-level detail, allocations import as a single
  catch-all line per contract. Splitting them on the contract screen is what
  gives the scheduler something to shape.
- Utilisation targets are best derived from each person's existing internal
  allocation against their real tracker capacity, not set to a round number —
  a generic 80% quietly rewrites how much internal time everyone gets.

## Deploying

`docker-compose.yml` targets `capacity.emotioflow.com` behind Traefik, same
shape as EmotioGantt. Set `APP_PASSCODE` in the Hostinger Docker Manager, not in
the file. Without a passcode the app is open — fine locally, not on a domain.

Data lives in the `emotio-ledger-data` volume; back that up, not the container.

**A deployed instance has no book of business.** `seed-data.json` is gitignored,
so a container built from this repo starts structurally complete and empty. Load
the real data afterwards, either through the UI or by posting it to the running
instance over HTTPS.

**Hostinger note:** the Docker Manager's Deploy button writes
`/docker/<name>/docker-compose.yml` but does not reliably bring the project up —
it can sit at "Created, 0 containers". If that happens, open the VPS terminal and
run `cd /docker/<name> && docker compose up -d`.

## Layout

```
db.js         schema, migrations, settings
capacity.js   periods, working days, units, balance, headroom
schedule.js   recipe expansion, the packer, .ics
harvest.js    Harvest v2 client, task→deliverable mapping, sync
seed.js       structure, plus the book of business if present
server.js     API + passcode gate
public/       vanilla SPA
```
