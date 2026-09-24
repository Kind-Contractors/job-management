# Supabase migrations — directory structure

Reconciled 2026-09-24 against production's own `supabase_migrations.schema_migrations`
table (the permanent, ground-truth record of what was actually applied and when).
Before this reconciliation, `main`'s `supabase/migrations/` contained only one file
(the newest, not-yet-applied migration) — none of the other ~35 already-applied
production migrations had any SQL anywhere in this repository, and a separate `dev`
branch had independently reconstructed most of that history under invented version
numbers that do not match what production actually recorded. Every filename below now
matches its migration's real, already-applied version number in production, recovered
either by porting the `dev` branch's reconstruction (after independently verifying it
against production's live schema/policies/functions) or, where no reconstruction
existed at all, by reading the exact historical SQL back out of
`supabase_migrations.schema_migrations.statements` — Supabase's own permanent record
of what was executed, not a guess.

Three directories, each meant for a different, non-overlapping target. Which folder a
file lives in is what determines whether a tool can ever apply it somewhere — there is
no other Supabase-native way to scope a migration to one environment, so **file
location is the actual safety mechanism** here, not just organization.

## `supabase/migrations/` (this folder) — shared, canonical, used for BOTH dev and production

The normal migration folder. A future migration is created and applied here exactly
the standard Supabase way — add a new timestamped `.sql` file, then `supabase db push`
(once linked/authenticated) against whichever project you're deploying to, dev or
production.

Every file's version prefix now matches the version already recorded as applied in
production's `schema_migrations` table — `supabase db push` only ever applies a local
file whose version is *not yet* recorded remotely, so this makes every migration below
a safe no-op against production (nothing here gets replayed) while leaving room for
genuinely new migrations to apply normally.

One migration was split during this reconciliation because the `dev` branch's own
reconstruction had folded two real, separately-applied production migrations into one
file: `20260907201009_technician_today_visits_add_job_type.sql` (the function change)
and `20260907201017_technician_today_visits_tighten_grants.sql` (a one-line anon-grant
revoke) are production's two real, separate versions — do not re-merge them.

Files whose header says "PRODUCTION MIGRATION — recovered verbatim from ... " had no
SQL anywhere in this repository (`main` or `dev`) before this reconciliation; their
body is the exact text Supabase executed, pulled from `schema_migrations.statements`,
not reconstructed from current schema state.

**Not represented here, intentionally:** the five earliest production migrations
(`0001 create_staging_tables`, `0002 create_application_tables`,
`0003 staging_rls_policies`, `0005 staging_authenticated_only`,
`0006 add_display_order`) predate this repository and belong to the separate Data
Manager / Data Cleanup app (see root `CLAUDE.md` §1/§12) — their SQL is equally
recoverable from `schema_migrations.statements` if ever genuinely needed, but keeping
them out of this repo preserves that ownership boundary.

## `supabase/production-only-migrations/` — historical, already applied to production, never replay anywhere

Eight files' worth of history, never placed in `supabase/migrations/` because they
must never run against any other project — but only **one** of the eight is actually
tracked in git:

- **Seven data-migration files** (`20260828173541` through `20260828175941`) — the
  one-time real-data import (70 real clients, 342 real buildings, 474 real jobs, 145
  real contacts, reconciled from the legacy GEN/SPEC/CONTRACTX spreadsheets), applied
  to production across seven separate, granular migrations on 2026-08-28. *Correction
  to this repo's own prior documentation:* an earlier version of this README described
  a single consolidated `20260829091500_data_migration.sql` as having been "prepared"
  — that file never existed in this repository's git history at any point, and
  production's own `schema_migrations` table confirms the real history is these seven
  separate files, applied a day earlier than that phantom file's timestamp implied.

  **These seven contain real customer/business data and are excluded from git
  entirely** — see `.gitignore`'s `supabase/production-only-migrations/*` block. They
  exist as local files on disk (for whoever is doing this reconciliation work) purely
  for historical reference; they are never committed, never pushed to any git remote,
  and never read by `supabase db push` (which only ever scans `supabase/migrations/`,
  regardless of git status — the gitignore rule is about version-control hygiene, not
  migration-tool behavior). Losing the local copies is not data loss: production's own
  `supabase_migrations.schema_migrations` table is the permanent source of truth, and
  every one of these files can be regenerated byte-for-byte at any time. To regenerate
  one, run this read-only query against production (e.g. via the Supabase MCP
  `execute_sql` tool, or `psql`/the SQL editor) for the version in question:

  ```sql
  select version, name, statements
  from supabase_migrations.schema_migrations
  where version = '<version>';
  ```

  `statements` is a `text[]`; join its elements in order (blank line between, if more
  than one) to reconstruct the exact body Supabase executed. Do not reformat, reword,
  or "clean up" the recovered text — it is a historical record, not new authorship.
  Query each version separately rather than with an `IN (...)` list — the seven
  combined can return a very large result.

- **`20260911173353_restrict_staging_tables_to_service_role.sql`** — the one file in
  this directory that **is** tracked in git (explicitly allowlisted in `.gitignore`).
  Contains no customer data, only `DROP POLICY`/`COMMENT ON` statements. Manages RLS
  policies on four `staging_*` tables that belong entirely to the separate Data
  Manager / Data Cleanup app (see the root `CLAUDE.md` §1/§12). Those tables were
  never part of this Manager app's own schema and don't exist in a fresh/dev-style
  project — running this migration there fails immediately (`relation
  "public.staging_contractx" does not exist`).

All eight are already recorded as applied in production's own
`supabase_migrations.schema_migrations` table. Neither their absence from
`supabase/migrations/` nor the seven's absence from git affects that record or
requires any change to production — `db push` only ever applies versions a target
database doesn't yet have recorded; it never re-examines or reverts versions that are
already recorded but whose local file is absent (or untracked, or missing entirely).

## `supabase/dev-bootstrap/` — one-time-only, initializing a genuinely empty project

One file: **`00000000000000_dev_bootstrap_base_tables.sql`**. Recreates
`public.clients`, `public.buildings`, `public.jobs` and the `public.job_type` enum
exactly as they existed immediately before `20260828135041_production_domain_model.sql`
first ran — because in production, those three tables (and that enum) were created by
the separate Data Manager app, outside this repo's migration history entirely. Every
migration in `supabase/migrations/` has always assumed they already exist; a genuinely
empty project doesn't have them, hence this file.

**Must never run against production** — production already has these tables (with
more columns than this minimal reconstruction) and this file has no `IF NOT EXISTS`
guards, so it would fail immediately and block that deploy attempt.

Only needed once per environment: after a project's first successful initialization,
its own `schema_migrations` table permanently records this as applied, and every later
new migration goes through `supabase/migrations/` exactly like production. It's only
needed again if a dev-style project is ever rebuilt from scratch or `supabase db
reset` is run against one.

## Known outstanding gap (not resolved by this reconciliation)

The separate `dev` Supabase project's own `schema_migrations` table was confirmed
(2026-09-24) to still record the **old, invented** version numbers from `dev`'s prior
reconstruction attempt, not the real production version numbers now used throughout
`supabase/migrations/` above. Pushing this reconciled directory at the `dev` project
as-is would look like a large batch of brand-new migrations and attempt to replay
already-applied DDL there. This must be resolved on the database side (via `supabase
migration repair` against the dev project, or reseeding it) before `supabase db push`
is ever run against `dev` with this directory — deliberately out of scope for this
purely repository-level reconciliation.

---

# Historical: initial data migration execution guide (2026-08-29)

Kept for the record — this is what was actually run to populate production
originally. Not something to repeat elsewhere; see
`supabase/production-only-migrations/` above.

Status at the time: **prepared, not executed.** The schema-change file referenced
below existed only as a local, unapplied migration file before this was carried out.

## Files, in required execution order

1. **`20260828172426_jobs_frequency_type_nullable.sql`** — schema change. Drops
   `NOT NULL` on `jobs.frequency_type`. Ran **first** — the data migration inserts 42
   jobs with `frequency_type = NULL`, which the schema would otherwise reject.
2. **The seven data-migration files** (now in `supabase/production-only-migrations/`,
   versions `20260828173541` through `20260828175941`) — the data migration itself,
   run as seven separate steps: clients/buildings (`data_migration_gen_spec_contractx`)
   → jobs in four parts → contacts. Depended on step 1 already being applied.
3. **`docs/migration-review/post_migration_validation.sql`** — read-only checks run
   immediately after step 2. Not a migration; nothing in it writes anything.

## Idempotency

The first data-migration file begins with `CREATE TABLE IF NOT EXISTS
public._data_migration_runs` (a small marker table, not one of the 11 domain tables)
and an `INSERT INTO public._data_migration_runs (id) VALUES (...)` as one of its first
statements. Re-running any step that depends on this marker hits that table's primary
key and fails — aborting before business data is touched twice.

## What the data migration does NOT do (by design, per that round's review)

- Creates **zero** rows in `teams`/`technicians`, `schedules`, `visits`, `reports`,
  `photos`, or `activity_events`.
- Sets `jobs.default_team_id = NULL` for every row (no team rows exist to reference).
- Does not touch any `staging_*` table.
- Does not insert the 12 rows listed in `docs/migration-review/excluded_records.csv`.
- Does not set `source_contractx_row` for Bentley Priory (GEN-010/GEN-074 are inserted
  as two independent job rows, cross-reference left NULL).
- Does not merge K&M First/Property with K&M Property, or Dutch & Dutch with
  Dutch&Dutch.
- Does not invent `is_primary` / `is_accounts_contact` on any contact.

## Rollback

Each production-only file is ordinary transactional SQL. If applied via a tool that
already wraps each call in its own transaction, an explicit `BEGIN`/`COMMIT` inside a
file is harmless (Postgres emits a warning on the redundant `BEGIN` and continues in
the same transaction) — these files were written so each is also directly runnable via
`psql` on its own.
