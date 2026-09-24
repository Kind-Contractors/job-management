-- Implements the technician app's existing "Upcoming" tab (previously a
-- stub — "This view isn't available yet") — discovered during manual demo
-- testing: two real future-dated bookings (assigned correctly, confirmed
-- live) never appeared anywhere in the technician app because
-- technician_today_visits() only ever returns scheduled_date = current_date,
-- by design, and no other read path existed for a technician's own
-- future-scheduled work.
--
-- A NEW function, not a parameterized version of technician_today_visits(),
-- for two reasons: (1) Today's exact behavior — office-order via
-- created_at, single-day scope — must stay completely unchanged, and a
-- second, separate function makes that a structural guarantee rather than
-- a branch to keep correct inside one function; (2) Upcoming's sort is
-- semantically different (chronological across many days, not the
-- office's per-day ordering), so it deserves its own ORDER BY, not a
-- parameter toggling between two unrelated orderings. This exactly mirrors
-- the existing precedent of technician_needs_correction() living alongside
-- technician_today_visits() as its own small, purpose-specific read RPC —
-- same SECURITY DEFINER pattern, same technician-safe column set, same
-- ownership check via private.current_technician_id().
--
-- No schema change: reuses visits/jobs/buildings/reports exactly as
-- technician_today_visits() already does.

create or replace function public.technician_upcoming_visits()
returns table (
  visit_id uuid,
  scheduled_date date,
  visit_status visit_status,
  job_id uuid,
  job_summary text,
  job_type text,
  building_name text,
  building_address text,
  building_postcode text,
  report_submitted boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode,
    exists (select 1 from reports r where r.visit_id = v.id)
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and v.technician_id = private.current_technician_id()
    and v.scheduled_date > current_date
    and v.status <> 'cancelled'
  order by v.scheduled_date asc, v.created_at asc
$$;

revoke all on function public.technician_upcoming_visits() from public;
grant execute on function public.technician_upcoming_visits() to authenticated;
revoke execute on function public.technician_upcoming_visits() from anon;

comment on function public.technician_upcoming_visits() is
  'Same ownership/security model as technician_today_visits() — only the '
  'date condition and sort differ (scheduled_date > current_date, '
  'chronological). See this migration file header for why this is a '
  'separate function rather than a parameterized version of '
  'technician_today_visits().';
