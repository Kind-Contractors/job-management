-- Authentication + RLS design for the Manager app.
-- See the reviewed design: C:\Users\Mou\.claude\plans\rustling-crunching-gadget.md (Part 1).
--
-- THIS FILE HAS NOT BEEN APPLIED. Written for review before execution, matching
-- this project's established pattern for every prior schema/data migration.
--
-- What this does:
--   1. Creates public.app_users -- one row per Supabase Auth user, carrying a role
--      ('manager' today; 'technician' is a seam for the future, separate technician
--      app pass -- no technician policies are written yet, since no technician role
--      is populated and no technician-team-assignment data model exists yet).
--   2. Creates a SECURITY DEFINER helper function, public.current_app_role(), so RLS
--      policies can check role without recursive-RLS issues.
--   3. Enables RLS on clients/buildings/jobs (currently disabled -- confirmed live via
--      the Supabase advisor immediately before writing this) and adds a manager-only
--      full-CRUD policy to them and to every other business table that has RLS
--      enabled but no policy yet (contacts, schedules, teams, visits, reports,
--      photos, activity_events).
--   4. building_access gets the SAME manager-only policy shape as every other table
--      here, but this one is called out as a PERMANENT restriction, not a
--      placeholder -- per CLAUDE.md section 8 and the technician-flow reference doc,
--      site access codes must never leave the office, so no technician policy will
--      ever be added to this table, even once that role exists for real.
--   5. _data_migration_runs gets no policy from either role, and its default
--      anon/authenticated table grants are explicitly revoked -- it is an internal
--      one-off idempotency marker for a migration script, not a business object the
--      app should ever query. RLS-enabled-with-no-policy already default-denies it;
--      revoking the grants too means it stays invisible to PostgREST even if a
--      future policy were accidentally added elsewhere.
--
-- What this deliberately does NOT do (out of scope for this pass, noted so it isn't
-- mistaken for an oversight):
--   - No app_users rows are inserted here. The one existing Supabase Auth user
--     (ai@kindcontractors.co.uk) is NOT auto-assigned a role by this migration --
--     provisioning app_users rows is a deliberate, manual step per the "no
--     self-signup, roles assigned on purpose" decision in the reviewed design.
--   - No technician-role policies. Only the 'manager' role is used by any policy
--     below; 'technician' exists only as an allowed value in app_users.role for a
--     future migration to add policies against.
--   - Does not touch staging_gen_details/staging_spec_details/staging_contractx/
--     staging_gen_schedule -- those belong to the sibling Data Manager project and
--     are out of scope for this repo (CLAUDE.md section 12).
--   - Does not disable Supabase Auth public signup or enable leaked-password
--     protection -- those are Auth-provider dashboard settings, not SQL, and are
--     called out separately in the reviewed design document.

-- 1. Role table.
create table public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('manager', 'technician')),
  display_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.app_users is
  'One row per Supabase Auth user, carrying their app role. Rows are created deliberately (no self-signup) -- see docs/plan for the auth design. Read by current_app_role() for RLS policy checks.';

-- app_users itself must not be left wide open (it would otherwise inherit the same
-- default anon/authenticated grants every table gets, and RLS is off by default on a
-- newly created table) -- a user may read only their own row, and no INSERT/UPDATE/
-- DELETE policy is added at all, so provisioning a new user's role stays a deliberate
-- dashboard/service-role action, never something the app's own anon/authenticated
-- client can do to itself.
alter table public.app_users enable row level security;

create policy self_select on public.app_users
  for select
  using (id = auth.uid());

-- 2. Role-check helper (SECURITY DEFINER so RLS on app_users itself, if ever added,
-- can''t create a recursive lookup loop).
create or replace function public.current_app_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.app_users where id = auth.uid() and is_active
$$;

comment on function public.current_app_role() is
  'Returns the calling user''s app_users.role, or NULL if unauthenticated/inactive/unassigned. Used by RLS policies across the schema.';

-- 3. Enable RLS where it is currently disabled.
alter table public.clients enable row level security;
alter table public.buildings enable row level security;
alter table public.jobs enable row level security;

-- 4. Manager-only full-CRUD policy, applied identically to every table that should
-- currently be readable/writable by the Manager app (clients/buildings/jobs newly
-- RLS-enabled above; the rest already had RLS enabled with no policy).
do $$
declare
  t text;
begin
  foreach t in array array[
    'clients', 'buildings', 'jobs', 'contacts', 'building_access',
    'schedules', 'teams', 'visits', 'reports', 'photos', 'activity_events'
  ]
  loop
    execute format(
      'create policy manager_full_access on public.%I for all using (public.current_app_role() = ''manager'') with check (public.current_app_role() = ''manager'')',
      t
    );
  end loop;
end $$;

-- 5. _data_migration_runs: no policy from any role, and revoke its default grants.
-- It currently has RLS disabled (same as clients/buildings/jobs before step 3 above),
-- so enable it here too, but add no policy at all, so it stays fully denied to both
-- anon and authenticated regardless of role.
alter table public._data_migration_runs enable row level security;

revoke all on public._data_migration_runs from anon, authenticated;
