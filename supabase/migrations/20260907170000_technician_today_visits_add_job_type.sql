-- Extends technician_today_visits() to also return the existing jobs.job_type
-- value (cast to text) — needed for the Day View's metadata line per the
-- technician flow PDF. No new concept: the raw DB value only ('general' /
-- 'specialist'), no derived "division" label or mapping introduced.
--
-- Requires DROP+CREATE (not CREATE OR REPLACE) because adding a column to a
-- RETURNS TABLE changes the function's return type, which Postgres does not
-- allow REPLACE to do. Zero blast radius: no frontend had consumed the old
-- signature yet (Phase 2 is the first caller).

drop function if exists public.technician_today_visits();

create function public.technician_today_visits()
returns table (
  visit_id uuid,
  scheduled_date date,
  visit_status visit_status,
  job_id uuid,
  job_summary text,
  job_type text,
  building_name text,
  building_address text,
  building_postcode text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and v.technician_id = private.current_technician_id()
    and v.scheduled_date = current_date
    and v.status <> 'cancelled'
  order by v.created_at
$$;

-- DROP+CREATE is a fresh object as far as Supabase's default-privileges
-- automation is concerned, so it re-grants EXECUTE to anon on creation —
-- stripped immediately after, exactly as Phase 1's own grants were tightened.
revoke all on function public.technician_today_visits() from public;
grant execute on function public.technician_today_visits() to authenticated;
revoke execute on function public.technician_today_visits() from anon;
