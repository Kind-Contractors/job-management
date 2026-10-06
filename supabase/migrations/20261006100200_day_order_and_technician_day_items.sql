-- One running order per day for jobs (visits) AND activities, the technician's merged Today list,
-- and the technician's "Mark done" for their own activities.
--
-- Purely additive: set_visit_order and the three existing technician visit lists are NOT changed, so an
-- older open browser or app keeps working exactly as before.

-- Saves one day's running order for visits and activities together in a single transaction: the first
-- item becomes 1, the next 2, and so on. SECURITY INVOKER (like set_visit_order), so only a manager's
-- row-level security lets it write. The list must be EXACTLY the day's live items (visits that are not
-- cancelled + activities that are not cancelled): no missing, extra, duplicate or other-day items, so it
-- can never leave two items on the same number or half-apply. A concurrent change surfaces as an error
-- asking the manager to refresh. Time is irrelevant here.
create function public.set_day_order(p_date date, p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count int;
  v_valid int;
  v_distinct int;
  v_live int;
  v_matched int;
  v_upd_visits int;
  v_upd_activities int;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.' using errcode = 'P0001';
  end if;
  if p_date is null then
    raise exception 'A date is required.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No items to order.' using errcode = 'P0001';
  end if;

  -- Two managers saving the same day cannot interleave; the later one re-checks against the new state.
  perform pg_advisory_xact_lock(hashtextextended('day-order:' || p_date::text, 0));

  v_count := jsonb_array_length(p_items);

  select count(*) into v_valid
  from jsonb_array_elements(p_items) as e
  where jsonb_typeof(e) = 'object'
    and e ->> 'kind' in ('visit', 'activity')
    and (e ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  if v_valid <> v_count then
    raise exception 'Each item needs a kind (visit or activity) and an id.' using errcode = 'P0001';
  end if;

  select count(distinct (e ->> 'kind') || ':' || lower(e ->> 'id')) into v_distinct
  from jsonb_array_elements(p_items) as e;
  if v_distinct <> v_count then
    raise exception 'An item appears more than once in the order.' using errcode = 'P0001';
  end if;

  select (select count(*) from visits v where v.scheduled_date = p_date and v.status <> 'cancelled')
       + (select count(*) from activities a where a.scheduled_date = p_date and a.cancelled_at is null)
  into v_live;

  select count(*) into v_matched
  from jsonb_array_elements(p_items) as e
  where (e ->> 'kind' = 'visit' and exists (
          select 1 from visits v where v.id = (e ->> 'id')::uuid and v.scheduled_date = p_date and v.status <> 'cancelled'))
     or (e ->> 'kind' = 'activity' and exists (
          select 1 from activities a where a.id = (e ->> 'id')::uuid and a.scheduled_date = p_date and a.cancelled_at is null));

  if v_matched <> v_count or v_live <> v_count then
    raise exception 'The day has changed since it was loaded. Refresh and try again.' using errcode = 'P0001';
  end if;

  update visits v
  set sort_order = o.ord
  from (select (t.item ->> 'id')::uuid as id, t.ord
        from jsonb_array_elements(p_items) with ordinality as t(item, ord)
        where t.item ->> 'kind' = 'visit') o
  where v.id = o.id;
  get diagnostics v_upd_visits = row_count;

  update activities a
  set sort_order = o.ord
  from (select (t.item ->> 'id')::uuid as id, t.ord
        from jsonb_array_elements(p_items) with ordinality as t(item, ord)
        where t.item ->> 'kind' = 'activity') o
  where a.id = o.id;
  get diagnostics v_upd_activities = row_count;

  if v_upd_visits + v_upd_activities <> v_count then
    raise exception 'Could not update every item in the order.' using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.set_day_order(date, jsonb) from public, anon;
grant execute on function public.set_day_order(date, jsonb) to authenticated, service_role;

-- The signed-in technician's TODAY, jobs and activities merged in ONE order. The database does the
-- ordering (so the app only renders what it is given): manually ordered items first by sort_order,
-- then unordered ones by created_at, with a job before an activity and then id as final tie-breaks.
-- Time is returned for display only. A technician sees only their own: visits they are on (primary or
-- additional) and activities assigned to them; cancelled items are excluded; a done activity stays in
-- the list. Job columns are NULL for an activity and activity columns are NULL for a job.
create function public.technician_day_items()
returns table(
  item_kind text,
  item_id uuid,
  day_position integer,
  scheduled_date date,
  start_time time without time zone,
  end_time time without time zone,
  visit_status visit_status,
  job_id uuid,
  job_summary text,
  job_type text,
  building_name text,
  building_address text,
  building_postcode text,
  report_submitted boolean,
  description text,
  location text,
  notes text,
  done boolean
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with me as (select private.current_technician_id() as id),
  items as (
    select
      'visit'::text as kind, v.id as item_id, v.scheduled_date, v.start_time, v.end_time, v.sort_order, v.created_at,
      v.status as visit_status, j.id as job_id, coalesce(j.job_summary, j.job_notes, '—') as job_summary, j.job_type::text as job_type,
      b.name as building_name, b.address as building_address, b.postcode as building_postcode,
      private.report_submitted_for(v.id, (select id from me)) as report_submitted,
      null::text as description, null::text as location, null::text as notes, null::boolean as done
    from visits v
    join jobs j on j.id = v.job_id
    join buildings b on b.id = j.building_id
    where private.current_app_role() = 'technician'
      and private.is_visit_participant(v.id, (select id from me))
      and v.scheduled_date = current_date
      and v.status <> 'cancelled'
    union all
    select
      'activity'::text, a.id, a.scheduled_date, a.start_time, a.end_time, a.sort_order, a.created_at,
      null::visit_status, null::uuid, null::text, null::text,
      null::text, null::text, null::text,
      null::boolean,
      a.description, a.location, a.notes, a.done_at is not null
    from activities a
    where private.current_app_role() = 'technician'
      and (select id from me) is not null
      and a.technician_id = (select id from me)
      and a.scheduled_date = current_date
      and a.cancelled_at is null
  )
  select
    i.kind, i.item_id,
    (row_number() over (order by i.sort_order asc nulls last, i.created_at asc, case i.kind when 'visit' then 0 else 1 end, i.item_id))::int,
    i.scheduled_date, i.start_time, i.end_time,
    i.visit_status, i.job_id, i.job_summary, i.job_type,
    i.building_name, i.building_address, i.building_postcode,
    i.report_submitted,
    i.description, i.location, i.notes, i.done
  from items i
  order by 3
$$;

revoke execute on function public.technician_day_items() from public, anon;
grant execute on function public.technician_day_items() to authenticated, service_role;

-- "Mark done" (and undo) for the technician's OWN activity only. Touches nothing else: not the
-- description, date, order or assignment, and nothing in the job/report workflow. Not allowed for an
-- activity that is not yet due, or one that was cancelled. Same "not found" answer for someone else's
-- activity as for a missing one, so existence is not revealed.
create function public.technician_set_activity_done(p_activity_id uuid, p_done boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me uuid;
  v_activity activities%rowtype;
begin
  v_me := private.current_technician_id();
  if private.current_app_role() is distinct from 'technician' or v_me is null then
    raise exception 'Not authorized.' using errcode = 'P0001';
  end if;
  if p_done is null then
    raise exception 'Say whether the activity is done.' using errcode = 'P0001';
  end if;

  select * into v_activity from activities where id = p_activity_id for update;
  if not found or v_activity.technician_id is distinct from v_me then
    raise exception 'Activity not found.' using errcode = 'P0001';
  end if;
  if v_activity.cancelled_at is not null then
    raise exception 'This activity has been cancelled.' using errcode = 'P0001';
  end if;
  if p_done and v_activity.scheduled_date > current_date then
    raise exception 'This activity is not due yet.' using errcode = 'P0001';
  end if;

  update activities
  set done_at = case when p_done then coalesce(v_activity.done_at, now()) else null end
  where id = p_activity_id;
end;
$$;

revoke execute on function public.technician_set_activity_done(uuid, boolean) from public, anon;
grant execute on function public.technician_set_activity_done(uuid, boolean) to authenticated, service_role;
