-- Past visits for the technician app: lets a technician open an earlier
-- visit assigned to them (e.g. to add photos/a report the day after the
-- job) through the same Job File -> Report flow Today's visits use.
--
-- A NEW function, exactly like technician_upcoming_visits() was added
-- alongside technician_today_visits() rather than parameterising it:
-- Today's exact behaviour (single-day scope, office order) must stay
-- unchanged, and Past has its own sort (newest first) and cap. Same
-- SECURITY DEFINER pattern, same technician-safe column set, same
-- ownership check (the visit's CURRENT technician_id — see the documented
-- no-reassignment-history caveat on technician_visit_detail()).
--
-- Today (= current_date), Past (< current_date) and the existing Upcoming
-- (> current_date) partition cleanly on the same server date. Cancelled
-- visits are excluded, as in every other technician list. Capped at the
-- 200 most recent so the payload can't grow without bound as history
-- accumulates.
--
-- No schema change: reuses visits/jobs/buildings/reports exactly as the
-- sibling functions do. technician_visit_detail() already returns any
-- owned visit regardless of date, so no change is needed there.

create or replace function public.technician_past_visits()
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
    and v.scheduled_date < current_date
    and v.status <> 'cancelled'
  order by v.scheduled_date desc, v.created_at desc
  limit 200
$$;

revoke all on function public.technician_past_visits() from public;
grant execute on function public.technician_past_visits() to authenticated;
revoke execute on function public.technician_past_visits() from anon;

comment on function public.technician_past_visits() is
  'Same ownership/security model as technician_today_visits() — only the '
  'date condition (scheduled_date < current_date), sort (newest first) and '
  'cap (200) differ.';
