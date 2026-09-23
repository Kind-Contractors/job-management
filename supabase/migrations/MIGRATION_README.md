# Supabase migrations — directory structure

Three directories, each meant for a different, non-overlapping target.
Which folder a file lives in is what determines whether a tool can ever
apply it somewhere — there is no other Supabase-native way to scope a
migration to one environment, so **file location is the actual safety
mechanism** here, not just organization.

## `supabase/migrations/` (this folder) — shared, canonical, used for BOTH dev and production

The normal migration folder. A future migration is created and applied
here exactly the standard Supabase way — add a new timestamped `.sql`
file, then `supabase db push` (once linked/authenticated) against
whichever project you're deploying to, dev or production. Nothing special
is required for ordinary day-to-day schema changes.

Contains every migration both the production project (`rgcxybsnoqjnbywzycfx`)
and the development project (`kind-contractors-dev` /
`oewjoxttcxrgwhqcstqc`) already have applied, and every migration written
from here on.

## `supabase/production-only-migrations/` — historical, already applied to production, never replay anywhere

Two files, moved out of this folder on 2026-09-23 (content and filenames
unchanged, only relocated):

- **`20260829091500_data_migration.sql`** — the one-time real-data import
  (70 real clients, 342 real buildings, 474 real jobs, 145 real contacts,
  reconciled from the legacy GEN/SPEC/CONTRACTX spreadsheets). Already
  applied to production, exactly once. **Must never run against dev or
  any other project** — it would silently insert real customer data into
  a database meant to hold none, and its own CSV source artifacts
  (`docs/migration-review/proposed_*.csv`) are deliberately kept out of
  Git for the same reason.
- **`20260911173353_restrict_staging_tables_to_service_role.sql`** —
  manages RLS policies on four `staging_*` tables that belong entirely to
  the separate Data Manager / Data Cleanup app (see the root `CLAUDE.md`
  §1/§12). Those tables were never part of this Manager app's own schema
  and don't exist in a fresh/dev-style project — running this migration
  there fails immediately (`relation "public.staging_contractx" does not
  exist`).

Both are already recorded as applied in production's own
`supabase_migrations.schema_migrations` table. Removing them from this
folder does not affect that record or require any change to production —
`db push` only ever applies versions a target database doesn't yet have
recorded; it never re-examines or reverts versions that are already
recorded but whose local file is absent.

## `supabase/dev-bootstrap/` — one-time-only, initializing a genuinely empty project

One file: **`00000000000000_dev_bootstrap_base_tables.sql`**. Recreates
`public.clients`, `public.buildings`, `public.jobs` and the `public.job_type`
enum exactly as they existed immediately before
`20260828120000_production_domain_model.sql` first ran — because in
production, those three tables (and that enum) were created by the
separate Data Manager app, outside this repo's migration history entirely.
Every migration in this folder has always assumed they already exist; a
genuinely empty project doesn't have them, hence this file.

**Must never run against production** — production already has these
tables (with more columns than this minimal reconstruction) and this file
has no `IF NOT EXISTS` guards, so it would fail immediately and block that
deploy attempt.

Only needed once per environment: after a project's first successful
initialization, its own `schema_migrations` table permanently records
this as applied, and every later new migration goes through this folder
exactly like production. It's only needed again if a dev-style project is
ever rebuilt from scratch or `supabase db reset` is run against one.

### Initializing a fresh dev-style project

```
scripts/init-fresh-dev-migrations.sh <output-dir>
supabase db push --dry-run --db-url "<target-db-url>" --workdir <output-dir>
# review the printed list, confirm it's the bootstrap + the shared
# migrations only, then re-run without --dry-run
```

Never point this at production. Always verify `--db-url` before running,
and always `--dry-run` first.

---

# Historical: initial data migration execution guide (2026-08-29)

Kept for the record — this is what was actually run to populate
production originally. Not something to repeat elsewhere; see
`supabase/production-only-migrations/` above.

Status at the time: **prepared, not executed.** All three files
referenced below existed only as local, unapplied migration files before
this was carried out.

## Files, in required execution order

1. **`20260829090000_jobs_frequency_type_nullable.sql`** — schema change.
   Drops `NOT NULL` on `jobs.frequency_type`. Ran **first** — the data
   migration inserts 42 jobs with `frequency_type = NULL`, which the
   schema would otherwise reject.
2. **`20260829091500_data_migration.sql`** (now in
   `supabase/production-only-migrations/`) — the data migration itself.
   Inserted, in one transaction: clients (70) → buildings (342) →
   building_access (17) → jobs (474) → contacts (145). Depended on step 1
   already being applied.
3. **`docs/migration-review/post_migration_validation.sql`** — read-only
   checks run immediately after step 2. Not a migration; nothing in it
   writes anything.

## Idempotency

Step 2 begins with `CREATE TABLE IF NOT EXISTS public._data_migration_runs`
(a small marker table, not one of the 11 domain tables) and an `INSERT INTO
public._data_migration_runs (id) VALUES ('gen_spec_contractx_initial_load_2026_08_29')`
as its very first statement inside the transaction. Re-running it hits
that marker table's primary key and fails — aborting the whole
transaction before any client/building/job/contact row is touched.
**Running step 2 twice fails loudly; it does not silently duplicate
data.** No uniqueness constraint was added to any business table to
achieve this.

## What step 2 does NOT do (by design, per that round's review)

- Creates **zero** rows in `teams`, `schedules`, `visits`, `reports`,
  `photos`, or `activity_events`.
- Sets `jobs.default_team_id = NULL` for every row (no team rows exist to
  reference).
- Does not touch any `staging_*` table.
- Does not insert the 12 rows listed in `docs/migration-review/excluded_records.csv`.
- Does not set `source_contractx_row` for Bentley Priory (GEN-010/GEN-074
  are inserted as two independent job rows, cross-reference left NULL).
- Does not merge K&M First/Property with K&M Property, or Dutch & Dutch
  with Dutch&Dutch.
- Does not invent `is_primary` / `is_accounts_contact` on any contact.

## Rollback

Both files are ordinary transactional SQL (`BEGIN`/`COMMIT` in the data
migration; a single `ALTER TABLE` in the schema change). If applied via a
tool that already wraps each call in its own transaction, the explicit
`BEGIN`/`COMMIT` in the data migration is harmless (Postgres emits a
warning on the redundant `BEGIN` and continues in the same transaction) —
this was written so the file is also directly runnable via `psql` on its
own.
