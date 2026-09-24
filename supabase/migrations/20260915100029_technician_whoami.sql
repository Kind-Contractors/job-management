-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation. This repo previously had no file for
-- this version at all.

-- Technician app header: lets the signed-in technician see their own name.
-- Follows the exact same pattern as every other technician RPC (see
-- 20260907195322_technician_read_rpcs.sql): SECURITY DEFINER, independently
-- re-checks the caller is an active technician, resolves exactly one
-- identity via the existing current_technician_id() helper. Returns only
-- the technician's own id/name — no email, no app_user_id, no other
-- technician's row, nothing manager-only.

create or replace function public.technician_whoami()
returns table (
  technician_id uuid,
  technician_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.name
  from technicians t
  where private.current_app_role() = 'technician'
    and t.id = private.current_technician_id()
$$;

revoke all on function public.technician_whoami() from public;
grant execute on function public.technician_whoami() to authenticated;
