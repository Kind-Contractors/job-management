-- Activities: non-job items in someone's working day (going to a quote, picking up keys,
-- meeting a client). Deliberately a SEPARATE table from visits: an activity has no job, price,
-- report, invoice or visit status, so it can never appear in "needs booking", the month matrix,
-- report review, invoicing or any client-facing output. Jobs and the report workflow are untouched.
--
-- Ordering: sort_order has the same meaning as visits.sort_order (lower = earlier within
-- scheduled_date, null = unordered and sorted last). Jobs and activities share ONE sequence per day
-- (see set_day_order). start_time / end_time are optional display values and NEVER decide the order.
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  scheduled_date date not null,
  technician_id uuid references public.technicians (id) on delete restrict,
  location text,
  notes text,
  start_time time without time zone,
  end_time time without time zone,
  sort_order numeric,
  done_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activities_description_check check (char_length(btrim(description)) between 1 and 120),
  constraint activities_location_check check (location is null or char_length(location) <= 200),
  constraint activities_notes_check check (notes is null or char_length(notes) <= 2000),
  -- No time, a start only, or a start with a later end on the same day. An end without a start is meaningless.
  constraint activities_time_range_check check (end_time is null or (start_time is not null and end_time > start_time))
);

comment on table public.activities is
  'A non-job item in a technician''s day (quote visit, key pick-up, client meeting). Internal only: never joined to reports or client output. Never hard-deleted: cancelled_at marks a cancelled one. technician_id is nullable (unassigned). Not part of the job/visit/report/invoice workflow.';
comment on column public.activities.start_time is 'Optional local wall-clock start time on scheduled_date. Display only; never used for ordering.';
comment on column public.activities.end_time is 'Optional local wall-clock end time (same day, after start_time). Requires start_time.';
comment on column public.activities.sort_order is 'Running order within scheduled_date, shared with visits.sort_order (one sequence per day). Lower = earlier; null = unordered, sorted after ordered items by created_at. Reset to null when scheduled_date changes. Not a time.';
comment on column public.activities.done_at is 'Set by the assigned technician (technician_set_activity_done). Reset when the activity is reassigned.';

create index activities_scheduled_date_sort_order_idx on public.activities (scheduled_date, sort_order);
create index activities_technician_date_idx on public.activities (technician_id, scheduled_date);

-- Same security shape as every other business table: manager-only via RLS. Technicians have NO table
-- policy; they reach their own activities only through the SECURITY DEFINER functions in the next migrations.
alter table public.activities enable row level security;

create policy manager_full_access on public.activities
  for all
  using (private.current_app_role() = 'manager')
  with check (private.current_app_role() = 'manager');

revoke all on public.activities from anon;
grant select, insert, update, delete on public.activities to authenticated, service_role;

create trigger jms_set_updated_at before update on public.activities
  for each row execute function public.jms_set_updated_at();

-- Mirrors prevent_visit_assignment_to_inactive_technician: only blocks NEWLY assigning an inactive technician;
-- an activity already assigned to someone who is later deactivated is never touched.
create function public.prevent_activity_assignment_to_inactive_technician()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_is_active boolean;
begin
  if new.technician_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.technician_id is not distinct from old.technician_id then
    return new;
  end if;
  select is_active into v_is_active from public.technicians where id = new.technician_id;
  if v_is_active is not true then
    raise exception 'Cannot assign this activity to an inactive technician.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger prevent_activity_assignment_to_inactive_technician
  before insert or update of technician_id on public.activities
  for each row execute function public.prevent_activity_assignment_to_inactive_technician();

-- Same rule as visits: a stale order number from another day must never carry over. The times are KEPT.
create function public.reset_activity_sort_order_on_date_change()
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

create trigger reset_activity_sort_order_on_date_change
  before update of scheduled_date on public.activities
  for each row execute function public.reset_activity_sort_order_on_date_change();

-- "Done" belongs to the person who did it: reassigning the activity clears it (unless the same statement sets done_at deliberately).
create function public.reset_activity_done_on_reassignment()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.technician_id is distinct from old.technician_id
     and new.done_at is not distinct from old.done_at then
    new.done_at := null;
  end if;
  return new;
end;
$$;

create trigger reset_activity_done_on_reassignment
  before update of technician_id on public.activities
  for each row execute function public.reset_activity_done_on_reassignment();

-- Trigger functions never need to be callable through the API.
revoke execute on function public.prevent_activity_assignment_to_inactive_technician() from public, anon, authenticated;
revoke execute on function public.reset_activity_sort_order_on_date_change() from public, anon, authenticated;
revoke execute on function public.reset_activity_done_on_reassignment() from public, anon, authenticated;
