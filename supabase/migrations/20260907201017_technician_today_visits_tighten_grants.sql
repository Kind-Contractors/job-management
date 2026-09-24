-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation (this repo previously had no file for
-- this version at all; the dev branch's reconstruction had folded this
-- statement inline into 20260907201009_technician_today_visits_add_job_type.sql
-- instead of filing it as its own migration — split back out here to match
-- production's real, separately-recorded version).
--
-- DROP+CREATE in the preceding migration is a fresh object as far as
-- Supabase's default-privileges automation is concerned, so it re-grants
-- EXECUTE to anon on creation — stripped here, immediately after.

revoke execute on function public.technician_today_visits() from anon;
