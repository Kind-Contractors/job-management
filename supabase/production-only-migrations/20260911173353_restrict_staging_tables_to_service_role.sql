-- P0 security fix (demo-readiness audit): the four legacy staging
-- reconciliation tables (owned by the separate Data Manager app per
-- CLAUDE.md section 1 -- this Manager app never reads or writes them,
-- confirmed by grep: zero references anywhere in src/ or
-- supabase/functions/) each had 4 policies (SELECT/INSERT/UPDATE/DELETE)
-- granting unconditional (`true`) access to ANY `authenticated` role.
-- Now that technician accounts are real authenticated Supabase users,
-- this let any technician's own JWT read/write these tables directly via
-- the REST API -- an unintended widening, not a deliberate grant.
--
-- Fix: drop all 16 `authenticated`-role policies. RLS stays enabled on
-- all four tables with zero remaining policies, so `authenticated`/`anon`
-- get default-deny (no access at all) -- the same shape already used by
-- `_data_migration_runs` (RLS on, no policy, service_role only).
-- `service_role` bypasses RLS entirely regardless of policies, so this
-- does not remove access for any service-role-based tooling (e.g. the
-- separate Data Manager app, if it uses service_role) -- only for the
-- anon/authenticated keys this app's own Manager/Technician sessions use.
-- No business-table data touched; no staging table ROWS altered.
--
-- Applied directly via the Supabase MCP (version 20260911173353); this
-- file mirrors that applied migration for the repo's own history.

drop policy if exists "authenticated can read staging_contractx" on public.staging_contractx;
drop policy if exists "authenticated can insert staging_contractx" on public.staging_contractx;
drop policy if exists "authenticated can update staging_contractx" on public.staging_contractx;
drop policy if exists "authenticated can delete staging_contractx" on public.staging_contractx;

drop policy if exists "authenticated can read staging_gen_details" on public.staging_gen_details;
drop policy if exists "authenticated can insert staging_gen_details" on public.staging_gen_details;
drop policy if exists "authenticated can update staging_gen_details" on public.staging_gen_details;
drop policy if exists "authenticated can delete staging_gen_details" on public.staging_gen_details;

drop policy if exists "authenticated can read staging_gen_schedule" on public.staging_gen_schedule;
drop policy if exists "authenticated can insert staging_gen_schedule" on public.staging_gen_schedule;
drop policy if exists "authenticated can update staging_gen_schedule" on public.staging_gen_schedule;
drop policy if exists "authenticated can delete staging_gen_schedule" on public.staging_gen_schedule;

drop policy if exists "authenticated can read staging_spec_details" on public.staging_spec_details;
drop policy if exists "authenticated can insert staging_spec_details" on public.staging_spec_details;
drop policy if exists "authenticated can update staging_spec_details" on public.staging_spec_details;
drop policy if exists "authenticated can delete staging_spec_details" on public.staging_spec_details;

comment on table public.staging_contractx is
  'Legacy Data Manager reconciliation staging table -- not read/written by '
  'this Manager app. RLS enabled, no authenticated/anon policies (removed '
  '2026-09-11 security fix) -- service_role only.';
comment on table public.staging_gen_details is
  'Legacy Data Manager reconciliation staging table -- not read/written by '
  'this Manager app. RLS enabled, no authenticated/anon policies (removed '
  '2026-09-11 security fix) -- service_role only.';
comment on table public.staging_gen_schedule is
  'Legacy Data Manager reconciliation staging table -- not read/written by '
  'this Manager app. RLS enabled, no authenticated/anon policies (removed '
  '2026-09-11 security fix) -- service_role only.';
comment on table public.staging_spec_details is
  'Legacy Data Manager reconciliation staging table -- not read/written by '
  'this Manager app. RLS enabled, no authenticated/anon policies (removed '
  '2026-09-11 security fix) -- service_role only.';
