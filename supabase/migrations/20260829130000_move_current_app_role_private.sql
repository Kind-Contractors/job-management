-- Fix: current_app_role() was unintentionally exposed as a public PostgREST RPC
-- endpoint (Supabase advisor: anon_security_definer_function_executable /
-- authenticated_security_definer_function_executable). Root cause: it lived in
-- `public`, which Supabase exposes via PostgREST by default, and a newly created
-- function grants EXECUTE to PUBLIC unless revoked.
--
-- Fix approach: move it into a new `private` schema, which is never in Supabase's
-- exposed-schema list unless someone explicitly adds it via the dashboard (default
-- exposed schemas: just `public`) -- so this removes the RPC route entirely, without
-- touching the EXECUTE grants that RLS policy evaluation itself depends on. Schema
-- exposure (PostgREST routing) and grants (who may call it) are independent; this
-- migration only changes the former.
--
-- THIS FILE HAS NOT BEEN APPLIED. Written for review before execution.
--
-- Scope, exactly as requested -- nothing else changes:
--   - No table, RLS-enabled state, grant on any business table, or data is touched.
--   - self_select on app_users and the _data_migration_runs lockdown are untouched.
--   - Behavior/security properties preserved: the function's body, SECURITY DEFINER,
--     STABLE, and search_path are identical to the current public.current_app_role();
--     only its schema location changes. All 11 manager_full_access policies
--     (activity_events, building_access, buildings, clients, contacts, jobs, photos,
--     reports, schedules, teams, visits -- confirmed live, this is the complete set
--     that references current_app_role()) are repointed to the new location so RLS
--     evaluation keeps working identically for anon/authenticated callers.

-- 1. Non-exposed schema for internal-only helper functions.
create schema if not exists private;

-- 2. Recreate the function there, identical body/attributes to the current one.
create function private.current_app_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.app_users where id = auth.uid() and is_active
$$;

comment on function private.current_app_role() is
  'Returns the calling user''s app_users.role, or NULL if unauthenticated/inactive/unassigned. Used by RLS policies across the schema. Lives in a non-PostgREST-exposed schema so it cannot be invoked as a public RPC endpoint -- policies reference it by its full private.current_app_role() path.';

-- 3. Explicit grants: schema exposure (not grants) is what removes the RPC route,
-- so anon/authenticated still need USAGE+EXECUTE for RLS policy evaluation to keep
-- working for them, exactly as it did when the function lived in public.
revoke execute on function private.current_app_role() from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.current_app_role() to anon, authenticated;

-- 4. Repoint every policy that referenced the old function (all 11, confirmed live
-- via pg_policy immediately before writing this -- no others exist).
alter policy manager_full_access on public.clients using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.buildings using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.jobs using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.contacts using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.building_access using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.schedules using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.teams using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.visits using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.reports using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.photos using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
alter policy manager_full_access on public.activity_events using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');

-- 5. Drop the old public-schema function -- safe now, since no policy references it
-- any more (step 4 removed the last dependencies).
drop function public.current_app_role();
