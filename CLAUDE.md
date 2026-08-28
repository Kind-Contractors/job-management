# Kind Contractors — Job Management System (Manager App)

This file is the durable project context for Claude Code sessions working in
this repository. Read `agents.md` too — it has the coding/review standards.

---

## 1. Project purpose

An internal, desktop-first job management system for Kind Contractors,
replacing a fragmented workflow currently spread across spreadsheets and other
tools. The first user is Luke / the office manager. A technician-facing
application will be built later, in a separate pass.

This repository is **only** the Manager application. It is separate from,
and must not depend on, the Data Manager / Data Cleanup application
(`../Data Manager app`), which was used to reconcile the legacy GEN, SPEC and
CONTRACTX spreadsheets. Do not copy that project's code into this one.

## 2. Product / business context

The approved design uses a "one master database, several views" concept:
different screens are perspectives over the same underlying records, not
separate datasets. The app should feel like an operational tool built for
how Luke actually works, not a generic SaaS analytics dashboard.

## 3. Manager application requirements

Luke must be able to:

- View, search, filter, create and edit jobs.
- View clients and buildings, including the jobs at a building.
- Schedule and reschedule visits.
- Review, approve, and return reports for correction.
- Track completed, missed, and unscheduled work.
- Send approved reports — to the client and to accounts, as two independent
  actions.
- Retain historical/lost jobs and one-off jobs (never delete).

Luke is the final reviewer for reports. A returned report can be corrected by
the technician/team and resubmitted, or corrected directly by Luke.

## 4. Approved information architecture

The approved design does **not** use a conventional Dashboard page. Per the
design's own stated rationale: *"Not Dashboard / Jobs / Schedule / Reports.
There is one grid of jobs and a permanent left rail that answers 'what needs
me today'. Everything else — calendar, month matrix, building file, report
review — is a different lens on the same rows... A dashboard of tiles would
just be a third place the same numbers live, which is the problem we are
solving."*

**Top bar** (46px): Kind Contractors mark + wordmark + "OPERATIONS" label on
the left; a centered global search ("Search clients, buildings, jobs,
reports", with a ⌘K affordance); current date and the signed-in manager's
initials/name on the right.

**Left rail** (236px, fixed): from top to bottom —

1. **NEEDS YOU · TODAY** — each item is a colored-dot row with a count badge,
   clicking both navigates and applies the matching filter:
   - Reports to review
   - Due, not scheduled
   - Missed visits
   - Ready for accounts
   - Photos uploading
2. **VIEWS OF THE SAME DATA** — each with a live count:
   - All live jobs
   - By frequency
   - Month matrix
   - This week
   - Buildings
   - Report review
3. A **Division** filter pinned to the bottom (General / Specialist / Both,
   3-way segmented control) with the caption *"One master record per job.
   Every view above reads the same row."*

Views are filters/perspectives over one dataset — never duplicated data per
view. An individual job opens in a **right-hand inspector drawer** (344px,
wide viewports only) from any row, showing job facts, a contextual banner
when it needs review/booking, a reveal-gated internal-access box, sibling
jobs at the same building, recent visit history, and links out to the
building file / edit job / month matrix.

> **Current state vs. approved IA (resolved 2026-08-28):** the scaffold in
> this repo as first inspected used a conventional top nav (Dashboard / Jobs
> / Schedule / Reports) built before the approved design existed, and a
> different color system. Per the user's decision, that scaffold is being
> removed and rebuilt against the design below — see section 13.

### Design source

The approved deliverable is a Claude Design canvas, project
`16b3f5ce-9390-43d5-8039-fc0b58935419` ("Deliverable format and IA
decision"), file `Kind Contractors Manager.dc.html`, read via the
`DesignSync` tool (`get_file`/`list_files` with that `projectId`) — not
fetchable as a plain URL. It's a working interactive prototype (React-like
component with real mock state/behavior), not a static mockup. Sibling files
in the same project: `Manager - Directions.dc.html` (the rejected
alternatives + rationale — see callouts below) and `Manager App Deck.dc.html`
(slide deck, not separately reviewed in depth — the canvas itself is the
source of truth).

**Design rationale callouts (from `Manager - Directions.dc.html`), still
load-bearing:**

- *"Client → Building → Job → Visit → Report. The building is the
  operational record... A row in the grid is a **job**; a cell in the matrix
  or a block in the calendar is a **visit**. Yearly total is derived from
  price × frequency, never typed twice."*
- *"The [base] system is deliberately mono — steel on paper. An ops tool
  still needs four states to be legible at a glance, so [the design] added
  three desaturated functional tones... ochre needs booking, brick missed,
  green done. Steel stays 'booked / normal'. Nothing else is coloured."*
  → In this repo, "steel" (the base system's generic blue-grey accent) is
  replaced by the Kind Contractors brand palette (section 10) — the
  restraint principle (only 3-4 functional colors, everything else neutral)
  carries over, the specific hue doesn't.
- *"The logo is standing in as a mark until I have the files... Client-facing
  report output already exists in the technician deck and is reused
  unchanged."* — confirms `reference/technician_flow.pdf`'s client report is
  the one true client-report layout; don't redesign it.

### Structural/visual details worth preserving exactly

- **Visual language:** square corners throughout (no border-radius) —
  intentionally a "blueprint/schematic" aesthetic, hairline 1px borders, not
  a soft rounded SaaS look. Small "+" registration-mark glyphs decorate the
  corners of a few key panels (job facts, internal-access box, include-in-
  report panel).
- **Type:** Barlow (body) + Barlow Condensed (headings and all uppercase
  micro-labels, letter-spacing ~0.1–0.16em, 10–11px). Numeric values use
  tabular figures throughout (prices, counts, dates).
- **Grid ("All live jobs"):** header row (title, live subtitle summary,
  Columns/Export/+New job actions) → status chips (All statuses / Needs
  booking / Missed / To review / Ask-ad-hoc) + a Client⇄Frequency group
  toggle → a grouped table: band rows (client name + invoice address, or
  frequency name + visits/year) containing job rows (caret, building ·
  postcode, job, frequency, price, per-year, next-due (color by state),
  status pill (dot + label), team) → footer bar (row count, visible total
  value, "Yearly total is derived from price × frequency").
- **Month Matrix:** year switcher, a legend (Done & approved / Booked, date
  set / Due, no date yet / Missed / Not due), grouped by client, one row per
  job with 12 month cells; due-but-unbooked cells are clickable to book.
- **This Week:** rows are **teams** (name, members, a weekly-load bar), not
  hours; columns are the 6 working days; cells hold visit chips colored by
  done/on-site/booked, or a "free" hint. Explicitly: *"Rows are teams, not
  hours — the technician app sets no arrival times."*
- **Buildings list:** Building · street, Client, Postcode, Jobs (count), Per
  year, Next visit, Last visit, Flags (colored chips: Missed visit / Needs
  booking / Report to review / Clear).
- **Building file:** breadcrumb back to Buildings; header (ref, name,
  address, client, Print site sheet / +Add job here); tabs **Site file** /
  **History**. Site file: site instructions + reference photos + jobs-at-
  this-building list (left column); an "at a glance" fact panel + a
  reveal-gated internal-access box (key safe, access notes, parking, with
  the note *"Excluded from every client-facing report by the system, not by
  the sender"*) + documents list (right column). History: a dated vertical
  timeline (colored dot, title, detail, who).
- **Report review:** left queue (268px: "Awaiting review" count + report
  cards with building/client·technician/flag); right detail (ref/submitted,
  building — job title, address·client·price, state label, "Open building
  file" link; a blocking error banner when photos failed to upload, with
  Request re-upload / Return to team actions; a 4-stat row — Photos, On
  site, Issues flagged, Spec met; works-carried-out + technician notes +
  before/during/after photo grid on the left; an include-in-client-report
  checklist (photos/notes/issues/price toggles, each independently
  togglable) + an Approve → Send to client / Send to accounts panel (send
  buttons disabled until approved, each shows its own sent state) + "last
  time at this building" mini-history on the right). Empty states: "Queue
  clear" (nothing awaiting review) and "Nothing waiting on you" (no report
  selected).
- **Edge states already modeled in the canvas:** a genuine loading
  transition (skeleton title/subtitle/10 rows + "Loading {view}…", ~400ms,
  triggered on every navigation), a search-empty state ("Nothing matches
  '{q}'" with a clear-filters action), and the blocked-report state above.
  These are the concrete edge-state behaviors to replicate, not just the
  general principles in section 9.

## 5. Core domain model

```
CLIENT (1) ──── (many) BUILDING ──── (many) JOB ──── (many) VISIT ──── (many) REPORT
```

- **Client** — who is invoiced. Name, invoice address, contacts. Can have
  many buildings.
- **Building** — where work happens. Access info, parking, keys,
  instructions, photos, documents, full history. Jobs inherit site context.
- **Job** — what is contracted: division, frequency, price, team. One
  building can have several jobs (e.g. general cleaning, window cleaning,
  gutter cleaning), each with its own price/frequency/team/schedule.
- **Visit** — a dated occurrence of work: due, booked, completed, or missed.
- **Report** — evidence from a visit: times, work carried out, issues,
  photos, signature, review state, sending state.

These are separate concepts. Do not collapse visits into jobs, or reports
into jobs, even where legacy spreadsheets didn't separate them.

## 6. Scheduling rules

Four distinct scheduling types — do not flatten into one generic recurring
rule:

1. **Fixed weekday** — e.g. 3rd Wednesday every quarter.
2. **Fixed date** — e.g. 15th every quarter; rolls to the next working day if
   it falls on a weekend.
3. **Due month, date unknown** — due within a month but not yet booked. Feeds
   a scheduling backlog.
4. **Ask / ad-hoc** — a live/priced job booked on client request. Must never
   be automatically treated as late just because it has no date.

**Month Matrix** shows what's due through the year, distinguishing: done &
approved / booked (date set) / due, no date yet / missed / not due.

**This Week / By Team** rows are teams, not hours — there is no precise
technician arrival-time workflow to build an hourly calendar against.
Time-off/availability should be accommodated architecturally without being
over-built ahead of backend support.

Calendar should eventually support month/week/day views.

## 7. Report workflow

```
Technician submits → Manager review → Approve → Send to client / Send to accounts
                                    ↘ Return → Technician/team corrects → Resubmit → Manager reviews again
```

- Approval is a gate: a report cannot be sent before it's approved.
- **Send to client** and **send to accounts** are separate concepts with
  separate states — never a single combined "sent" status. A report can be
  approved with neither, either, or both sent.
- Luke may correct a report himself where appropriate, instead of returning
  it.
- Manager review layout: report queue on the left, selected report detail on
  the right.

## 8. Data / privacy boundaries

Strict separation between internal and client-facing data, enforced at the
**data/application boundary**, not just visually hidden in the UI.

Never expose to clients: key safe codes, keyholder information, fob/gate
rules, parking permits, internal flags, internal pricing notes, or other
internal operational/access information.

Client-facing reports may contain: arrival/departure, work carried out,
issues, photos, signature, and other approved client-safe information.

## 9. UI/UX principles (from the approved design)

- Desktop-first, clean, operational, information-dense but readable.
- Strong hierarchy, restrained visual decoration — not a generic admin
  dashboard.
- AG Grid for data-heavy operational tables (Community edition unless a
  concrete requirement justifies Enterprise).
- Clear status indicators, inspector/detail panels, clear actions,
  consistent spacing.
- Intentional edge states:
  - **Loading** — skeletons that preserve the structure of the real content.
  - **Empty** — explain what was searched/filtered.
  - **Blocked** — explain why an action can't proceed and what to do next.
  - Don't rely solely on generic toast notifications.

The approved visual reference is a Claude Design canvas:
`https://claude.ai/design/p/16b3f5ce-9390-43d5-8039-fc0b58935419` (file:
`Kind Contractors Manager.dc.html`). This link is **not fetchable by Claude
Code** (`claude.ai/design/...` is an authenticated product surface, distinct
from published Code artifacts) — implementation must work from this
document's written spec plus screenshots/exports the user provides directly.

`reference/technician_flow.pdf` documents the (separate, later-scope)
technician flow and its five design rules — useful for staying consistent
with decisions already made there (e.g. access codes never leave the office,
client/accounts sent separately with the status always saying which).

## 10. Brand palette

| Name | Hex | Use |
|---|---|---|
| Dark Teal | `#1E544B` | Navigation, header, headings, major structural elements |
| Near-Black Green | `#1C281C` | Dark backgrounds, strong contrast sections |
| Medium Green | `#73C17F` | Primary CTAs, important actions |
| Light Green | `#E4F0C3` | Highlighted/introductory areas, soft backgrounds |
| Light Grey | `#E7E8E4` | Secondary/neutral sections |
| White | `#FFFFFF` | Main content, cards, panels |

Semantic status colours (success/warning/error) may be used where necessary,
kept restrained and consistent with the brand — not a bolted-on generic
palette.

> The scaffold's current `src/styles/tokens.css` uses a different, warm
> neutral palette (`oklch` blue/green/orange/red on a beige background) from
> an earlier pass. This is being replaced with the brand palette above.

## 11. Technology stack

Confirmed / already in this repo:

- React 18 + TypeScript, built with **Vite** (not Next.js — this is an
  internal, authenticated, desktop-first SPA with no SEO/SSR requirement;
  react-router-dom handles routing).
- `react-router-dom` for routing.
- `ag-grid-community` / `ag-grid-react` for data-heavy operational tables.
- **Tailwind CSS** (decided 2026-08-28) — the earlier CSS Modules + token
  scaffold is being fully removed since the approved design is a different
  UI built from scratch; Tailwind is the styling system going forward. MUI
  is not being added unless a specific component genuinely needs it later.

Backend:

- **Supabase** — a project is already connected (shared with the Data
  Manager cleanup project): `clients`, `buildings`, `jobs` tables exist,
  built from the reconciled spreadsheet data, but are currently **empty**
  (population from staging is a separate, not-yet-done step). There are no
  `visits`, `reports`, or `contacts` tables yet — those are new schema this
  project must propose (see section 13).
- ⚠️ **`clients`, `buildings`, `jobs` currently have Row Level Security
  disabled** — fully exposed to the anon/authenticated Supabase client keys.
  This must be resolved (RLS + policies, informed by how auth ends up
  working for the Manager app) before the UI is wired to real data. Do not
  silently enable RLS without policies — that would lock out all access.

- **TanStack Query** (`@tanstack/react-query`) — added in the shell/All Live
  Jobs pass to wrap the mock repository layer (`useQuery({queryKey:
  ['jobRows'], queryFn: listJobRows})`), so the data-fetching shape is
  already in its final form when `listJobRows` starts hitting Supabase.

Not yet decided / open for this repo:

- Authentication is not configured anywhere in this repo yet.

## 12. Architecture principles

- Keep the **data-access layer separate from presentation**. Views read
  through a repository/data-source abstraction (see
  `src/lib/dataSource.ts`'s `fetchPage`/`createInfiniteDatasource` pattern)
  so a mock in-memory implementation can be swapped for a real Supabase
  query later without rewriting UI components.
- Design for data growth from the start: AG Grid usage should assume
  server-side pagination/filtering is coming, even while backed by mock data.
- Keep orchestration (state transitions, API mutations, async flow) in
  parent/container components; keep presentational components focused (see
  `agents.md`).
- Avoid `useEffect` by default; when genuinely required for a true side
  effect, comment why.
- The staging/reconciliation layer (`staging_*` tables, owned by the Data
  Manager project) and this application's clean domain model are
  conceptually different layers. Do not treat staging tables as production
  data, and do not modify them from this repo.
- If a UI requirement needs a backend field/entity that doesn't exist yet:
  identify the gap, explain it, propose a schema, and wait for approval
  before applying any migration.

## 13. Current scope

Decided 2026-08-28: this pass covers **only**

- The Manager application shell: top bar, left rail ("Needs you · today" +
  "Views of the same data" + Division filter), main content layout, and the
  inspector drawer pattern — built with Tailwind, matching section 4/10
  exactly.
- **All Live Jobs** — the only fully-built view — using AG Grid, backed by
  an isolated mock data/repository layer that mirrors the real domain model
  (client → building → job → visit → report) so it can be swapped for real
  Supabase queries later without a UI rewrite.

Everything else in "Views of the same data" (By frequency, Month matrix,
This week, Buildings, Report review) is **not stubbed** in this pass — no
placeholder "coming soon" routes. The rail can still show them (matching the
design), but only All Live Jobs needs to be reachable/working; wire the rest
up in later passes. The prior scaffold's report-review flow is being
rebuilt from the approved design later, not carried forward as-is — it was
removed along with the rest of the old scaffold per the decision to start
the UI fresh from the Claude Design canvas.

Still open, tracked here rather than decided silently:

- RLS policies for `clients`/`buildings`/`jobs` — depends on how auth ends
  up working for this app.
- Whether/when to wire the mock repository layer to the real Supabase
  `clients`/`buildings`/`jobs` tables (visits/reports have no schema yet).

## 14. Explicit non-goals for now

Do not build yet:

- Technician application, client portal.
- Full Xero API integration — represent the accounts handoff in the UI/data
  model only (`Approved → Ready for accounts → Sent to accounts`).
- Advanced automated scheduling engine, complex sales/recontact automation.
- Fabricated historical events (building history must only reflect real
  data — never invent events to fill the timeline).
- Migration of unresolved legacy spreadsheet data, or deletion of any
  legacy/staging records.
- Unnecessary database abstractions beyond what's specified above.

## 15. Development / testing expectations

- Follow `agents.md` for component structure and `useEffect` discipline.
- Run lint/type-check/build (`tsc -b && vite build`) after meaningful
  implementation milestones.
- No test runner is configured yet in this repo.
- For UI changes, run the dev server and check the feature in a browser
  before reporting done; if that isn't possible in-session, say so
  explicitly rather than claiming success from type-checks alone.
- Never fabricate permanent "production" mock data — mock data must be
  clearly fictional/isolated, matching the existing `mockJobRoster.ts` /
  `mockReports.ts` convention of a header comment stating it's fictional.
