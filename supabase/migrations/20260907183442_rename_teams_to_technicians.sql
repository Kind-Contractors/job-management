-- Renames the team-based assignment model to an individual-technician model,
-- per Luke's own explicit correction (reference/Luke_manager_app_version_1.txt):
-- he does not use "teams" as a real concept — assignment is to one person,
-- optionally left unassigned and set later (sometimes not until the day
-- before/of). See the reviewed architecture plan for the full rationale.
--
-- Pure rename + one additive column. No data is inserted, updated (other than
-- the single cosmetic label below), or deleted by this migration. Every
-- existing FK relationship, RLS policy, and trigger carries over unchanged —
-- Postgres tracks all three by OID, not by name.

-- 1. Rename the table itself
ALTER TABLE teams RENAME TO technicians;

-- 2. Rename the table's own PK constraint/unique index to match
ALTER TABLE technicians RENAME CONSTRAINT teams_pkey TO technicians_pkey;
ALTER INDEX teams_name_key RENAME TO technicians_name_key;

-- 3. Rename the two FK columns
ALTER TABLE visits RENAME COLUMN team_id TO technician_id;
ALTER TABLE jobs RENAME COLUMN default_team_id TO default_technician_id;

-- 4. Rename the FK constraints and their supporting indexes to match
ALTER TABLE visits RENAME CONSTRAINT visits_team_id_fkey TO visits_technician_id_fkey;
ALTER INDEX visits_team_id_idx RENAME TO visits_technician_id_idx;

ALTER TABLE jobs RENAME CONSTRAINT jobs_default_team_id_fkey TO jobs_default_technician_id_fkey;
ALTER INDEX jobs_default_team_id_idx RENAME TO jobs_default_technician_id_idx;

-- 5. Add the new technician-login link — additive, nullable, unique.
-- Most technicians.rows will likely never have a login at all (Luke's
-- casual/local people) — that is a correct, permanent state, not a gap.
-- Technician-scoped RLS is explicitly NOT added by this migration — this
-- column only prepares for it; a technician login has zero data access
-- today, exactly as before this migration.
ALTER TABLE technicians
  ADD COLUMN app_user_id uuid UNIQUE REFERENCES app_users(id) ON DELETE SET NULL;

-- 6. Cosmetic-only rename of the existing Xero test fixture's display name,
-- so no "Team" terminology is left in live test data. Does not touch its id
-- or any other column — every other row/id in the ZZZ TEST fixture chain
-- (client/building/job/visit/report/invoice) is untouched by this migration.
UPDATE technicians SET name = 'ZZZ TEST TECHNICIAN' WHERE name = 'ZZZ TEST TEAM';
