-- Manual visit order within a day, without times.
--
-- visits.sort_order is one number per BOOKING (a shared multi-technician visit
-- has exactly one), meaningful only among visits on the same scheduled_date.
-- Each technician's list is simply their own visits sorted by it, so a shared
-- visit appears once per technician and keeps the same position for everyone.
-- Visits with no order (every existing visit, and new bookings) sort after the
-- ordered ones, then by created_at - exactly the previous behaviour.
alter table public.visits add column sort_order numeric;

comment on column public.visits.sort_order is
  'Manual running order within scheduled_date (lower = earlier); null = unordered, sorted after ordered visits by created_at. One value per booking, shared by every assigned technician. Reset to null when scheduled_date changes. Not a time.';

create index visits_scheduled_date_sort_order_idx on public.visits (scheduled_date, sort_order);

-- A stale number from another day must never carry over: any change of date
-- (drag-reschedule, the date field in the visit row, anything else) clears the
-- order unless the same statement is deliberately setting a new one.
create function public.reset_visit_sort_order_on_date_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.scheduled_date is distinct from old.scheduled_date
     and new.sort_order is not distinct from old.sort_order then
    new.sort_order := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.reset_visit_sort_order_on_date_change() from public, anon, authenticated;

create trigger reset_visit_sort_order_on_date_change
  before update of scheduled_date on public.visits
  for each row execute function public.reset_visit_sort_order_on_date_change();

-- Saves one day's running order for a list of visits in a single transaction:
-- the first id becomes 1, the next 2, and so on. SECURITY INVOKER (like
-- create_visit_with_technicians), so only a manager's row-level security lets
-- it write. Refuses anything that is not one clean, same-day, existing set, so
-- it can never half-apply.
create function public.set_visit_order(p_visit_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count int;
  v_updated int;
  v_dates int;
begin
  v_count := coalesce(cardinality(p_visit_ids), 0);
  if v_count = 0 then
    raise exception 'No visits to order.' using errcode = 'P0001';
  end if;

  if (select count(distinct x) from unnest(p_visit_ids) as x) <> v_count then
    raise exception 'A visit appears more than once in the order.' using errcode = 'P0001';
  end if;

  select count(distinct v.scheduled_date) into v_dates from visits v where v.id = any(p_visit_ids);
  if v_dates > 1 then
    raise exception 'Visits on different days cannot be ordered together.' using errcode = 'P0001';
  end if;

  update visits v
  set sort_order = o.ord
  from unnest(p_visit_ids) with ordinality as o(id, ord)
  where v.id = o.id;

  get diagnostics v_updated = row_count;
  if v_updated <> v_count then
    raise exception 'Could not update every visit in the order.' using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.set_visit_order(uuid[]) from public, anon;
grant execute on function public.set_visit_order(uuid[]) to authenticated, service_role;

-- Technician lists: same signatures and columns as before; only the ordering
-- gains sort_order (nulls last) ahead of the previous created_at fallback.
create or replace function public.technician_today_visits()
returns table(visit_id uuid, scheduled_date date, visit_status visit_status, job_id uuid, job_summary text, job_type text, building_name text, building_address text, building_postcode text, report_submitted boolean)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode,
    private.report_submitted_for(v.id, private.current_technician_id())
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and private.is_visit_participant(v.id, private.current_technician_id())
    and v.scheduled_date = current_date
    and v.status <> 'cancelled'
  order by v.sort_order asc nulls last, v.created_at
$$;

create or replace function public.technician_upcoming_visits()
returns table(visit_id uuid, scheduled_date date, visit_status visit_status, job_id uuid, job_summary text, job_type text, building_name text, building_address text, building_postcode text, report_submitted boolean)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode,
    private.report_submitted_for(v.id, private.current_technician_id())
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and private.is_visit_participant(v.id, private.current_technician_id())
    and v.scheduled_date > current_date
    and v.status <> 'cancelled'
  order by v.scheduled_date asc, v.sort_order asc nulls last, v.created_at asc
$$;

create or replace function public.technician_past_visits()
returns table(visit_id uuid, scheduled_date date, visit_status visit_status, job_id uuid, job_summary text, job_type text, building_name text, building_address text, building_postcode text, report_submitted boolean)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode,
    private.report_submitted_for(v.id, private.current_technician_id())
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and private.is_visit_participant(v.id, private.current_technician_id())
    and v.scheduled_date < current_date
    and v.status <> 'cancelled'
  order by v.scheduled_date desc, v.sort_order asc nulls last, v.created_at desc
  limit 200
$$;
