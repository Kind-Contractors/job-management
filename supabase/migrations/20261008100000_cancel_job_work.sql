-- Cancelling work without losing history: "this visit only", "this and all future visits", "the entire job".
--
-- Additive. One new nullable column, two new functions, and the small visibility conditions below. Nothing is
-- deleted and no existing row is rewritten: cancelling only ever sets visits.status = 'cancelled' (rows kept) and, for
-- the whole job, jobs.lifecycle_status = 'cancelled' (the job moves to Historical Jobs). Completed and missed visits,
-- reports, photos, invoices and activities are never touched.
--
-- 1. jobs.service_ends_on - the first date a recurring job no longer asks for work ("cancel this and all future").
--    Read by the app to stop deriving "due" / "needs booking" from that month onward.
-- 2. cancel_job_work(job, scope, from_visit, reason) - ONE atomic, manager-only operation for all three scopes.
-- 3. jobs_with_open_report_work() - ids of NON-ACTIVE jobs that still have report/accounting work needing a manager,
--    so cancelling a job never makes such work vanish from Report review / Ready for client / Ready for accounts.
-- 4. Technician Today / Upcoming / Past / day-items / shared-visit lists stop showing an OPEN (due/booked) visit whose
--    job is cancelled (a "kept" visit: it has a report or invoice so it could not be cancelled). Completed and missed
--    visits stay in Past as history. Needs Correction, visit detail, submit and resubmit are NOT changed, so a
--    returned report on such a visit is still correctable.
-- 5. set_day_order counts only visits of ACTIVE jobs, matching what the schedule now shows.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. jobs.service_ends_on
-- ---------------------------------------------------------------------------------------------------------------
alter table public.jobs add column if not exists service_ends_on date;

comment on column public.jobs.service_ends_on is
  'First date this job no longer asks for work (set by "cancel this and all future visits" to the selected visit''s date). NULL = no end. The job itself stays active; visits and history are untouched.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. cancel_job_work
-- ---------------------------------------------------------------------------------------------------------------
-- Scopes:
--   'visit'           cancel p_from_visit_id only.
--   'this_and_future' cancel p_from_visit_id and every later due/booked visit of the job (a later date, or no date), and
--                     set jobs.service_ends_on to the selected visit's date. The job stays active.
--   'job'             cancel every due/booked visit of the job and set lifecycle_status = 'cancelled' (+ reason).
-- Only due/booked visits are ever cancelled. A visit that already has a report or an invoice line is NEVER cancelled:
-- it is returned in kept_visits with the reason ('has_report' / 'has_invoice') and keeps its status.
-- Everything happens in one transaction; any error rolls it all back. Repeating a finished request changes nothing.
create or replace function public.cancel_job_work(
  p_job_id uuid,
  p_scope text,
  p_from_visit_id uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jobs%rowtype;
  v_from visits%rowtype;
  v_target record;
  v_actor text;
  v_now timestamptz := now();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_cancelled uuid[] := '{}';
  v_kept jsonb := '[]'::jsonb;
  v_ends date;
  v_already boolean := false;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.' using errcode = 'P0001';
  end if;
  if p_scope is null or p_scope not in ('visit', 'this_and_future', 'job') then
    raise exception 'Unknown cancellation scope.' using errcode = 'P0001';
  end if;

  -- The signed-in manager's email, from their own session token (the same value the app records as the actor elsewhere).
  v_actor := coalesce(nullif(auth.jwt() ->> 'email', ''), 'unknown');

  select * into v_job from jobs where id = p_job_id for update;
  if not found then
    raise exception 'This job no longer exists.' using errcode = 'P0001';
  end if;

  if p_scope = 'job' then
    if v_job.lifecycle_status = 'cancelled' then
      return jsonb_build_object(
        'scope', p_scope, 'already_done', true, 'cancelled_visit_ids', '[]'::jsonb, 'kept_visits', '[]'::jsonb,
        'service_ends_on', v_job.service_ends_on, 'lifecycle_status', v_job.lifecycle_status
      );
    end if;
    if v_job.lifecycle_status not in ('active', 'on_hold') then
      raise exception 'This job is already closed (%).', v_job.lifecycle_status using errcode = 'P0001';
    end if;
  else
    if v_job.lifecycle_status <> 'active' then
      raise exception 'This job is no longer active.' using errcode = 'P0001';
    end if;
    if p_from_visit_id is null then
      raise exception 'Choose the visit to cancel from.' using errcode = 'P0001';
    end if;
    select * into v_from from visits where id = p_from_visit_id and job_id = p_job_id for update;
    if not found then
      raise exception 'That visit does not belong to this job.' using errcode = 'P0001';
    end if;
    if v_from.status = 'cancelled' and p_scope = 'visit' then
      v_already := true;
    elsif v_from.status not in ('due', 'booked', 'cancelled') then
      raise exception 'Only a due or booked visit can be cancelled.' using errcode = 'P0001';
    end if;
    if p_scope = 'this_and_future' and v_from.scheduled_date is null then
      raise exception 'This visit has no date, so "this and all future visits" cannot be used. Cancel this visit only.' using errcode = 'P0001';
    end if;
  end if;

  -- Visits to consider, locked in a fixed order. Each is checked under the same advisory lock the technician report
  -- submission takes, so a report being submitted at this moment is either seen here (visit kept) or accepted after.
  if not v_already then
    for v_target in
      select v.id, v.scheduled_date
      from visits v
      where v.job_id = p_job_id
        and v.status in ('due', 'booked')
        and (
          (p_scope = 'visit' and v.id = p_from_visit_id)
          or (p_scope = 'this_and_future' and (v.id = p_from_visit_id or v.scheduled_date is null or v.scheduled_date > v_from.scheduled_date))
          or p_scope = 'job'
        )
      order by v.id
      for update
    loop
      perform pg_advisory_xact_lock(hashtextextended('report:' || v_target.id::text, 0));

      if exists (select 1 from reports r where r.visit_id = v_target.id) then
        v_kept := v_kept || jsonb_build_object('id', v_target.id, 'scheduled_date', v_target.scheduled_date, 'reason', 'has_report');
      elsif exists (select 1 from invoice_line_items li where li.visit_id = v_target.id) then
        v_kept := v_kept || jsonb_build_object('id', v_target.id, 'scheduled_date', v_target.scheduled_date, 'reason', 'has_invoice');
      else
        update visits set status = 'cancelled' where id = v_target.id and status in ('due', 'booked');
        v_cancelled := v_cancelled || v_target.id;
        insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
        values ('visit', v_target.id, 'visit_cancelled', v_reason, v_actor, v_now);
      end if;
    end loop;
  end if;

  v_ends := v_job.service_ends_on;

  if p_scope = 'this_and_future' then
    -- Never push an earlier end date later.
    if v_ends is null or v_ends > v_from.scheduled_date then
      v_ends := v_from.scheduled_date;
      update jobs set service_ends_on = v_ends where id = p_job_id;
      insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
      values ('job', p_job_id, 'job_service_ended', 'Service ends ' || to_char(v_ends, 'DD/MM/YYYY'), v_actor, v_now);
    end if;
  elsif p_scope = 'job' then
    update jobs set lifecycle_status = 'cancelled', lost_reason = v_reason where id = p_job_id;
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values ('job', p_job_id, 'job_lifecycle_changed', 'Status changed to cancelled', v_actor, v_now);
  end if;

  return jsonb_build_object(
    'scope', p_scope,
    'already_done', v_already,
    'cancelled_visit_ids', to_jsonb(v_cancelled),
    'kept_visits', v_kept,
    'service_ends_on', v_ends,
    'lifecycle_status', case when p_scope = 'job' then 'cancelled' else v_job.lifecycle_status end
  );
end;
$$;

comment on function public.cancel_job_work(uuid, text, uuid, text) is
  'Manager-only, atomic. Scopes: visit | this_and_future | job. Cancels only due/booked visits that have no report and no invoice line (those are returned in kept_visits). Sets jobs.service_ends_on (this_and_future) or jobs.lifecycle_status = cancelled (job). Never deletes anything; completed/missed visits, reports, photos, invoices and activities are untouched.';

revoke execute on function public.cancel_job_work(uuid, text, uuid, text) from public, anon;
grant execute on function public.cancel_job_work(uuid, text, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. jobs_with_open_report_work
-- ---------------------------------------------------------------------------------------------------------------
-- Ids of jobs that are NOT active (completed, lost, cancelled, on hold) but still have a report needing a manager:
--   * awaiting review, or returned for correction;
--   * approved and not yet marked Completed (Ready for client);
--   * approved and with no invoice, or an invoice not yet sent (Ready for accounts) - even when the report is Completed.
-- A pre-filter only: the app applies the exact queue rules again to the visits it loads. SECURITY INVOKER, so row-level
-- security still applies; managers only.
create or replace function public.jobs_with_open_report_work()
returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  select distinct j.id
  from jobs j
  join visits v on v.job_id = j.id
  join reports r on r.visit_id = v.id
  where private.current_app_role() = 'manager'
    and j.lifecycle_status <> 'active'
    and (
      r.review_status in ('awaiting_review', 'returned_for_correction')
      or (
        r.review_status = 'approved'
        and (
          r.completed_at is null
          or not exists (
            select 1 from invoice_line_items li join invoices i on i.id = li.invoice_id
            where li.visit_id = v.id and i.status = 'sent'
          )
        )
      )
    )
$$;

comment on function public.jobs_with_open_report_work() is
  'Ids of non-active jobs that still have report or accounting work a manager must act on (awaiting review, returned, approved and not completed, or approved with no sent invoice). Manager-only; read-only.';

revoke execute on function public.jobs_with_open_report_work() from public, anon;
grant execute on function public.jobs_with_open_report_work() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Technician lists: hide an OPEN visit of a CANCELLED job
-- ---------------------------------------------------------------------------------------------------------------
-- Same signatures and columns as before; each gains one condition:
--     and not (j.lifecycle_status = 'cancelled' and v.status in ('due', 'booked'))
-- Completed and missed visits are unaffected (history stays in Past). Not changed on purpose: technician_needs_correction,
-- technician_visit_detail, technician_submit_report, technician_resubmit_report.
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
    and not (j.lifecycle_status = 'cancelled' and v.status in ('due', 'booked'))
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
    and not (j.lifecycle_status = 'cancelled' and v.status in ('due', 'booked'))
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
    and not (j.lifecycle_status = 'cancelled' and v.status in ('due', 'booked'))
  order by v.scheduled_date desc, v.sort_order asc nulls last, v.created_at desc
  limit 200
$$;

create or replace function public.technician_shared_visits()
returns table(visit_id uuid, assigned_count integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  select v.id, n.c
  from visits v
  join jobs j on j.id = v.job_id
  cross join lateral (
    select count(*)::int as c
    from (
      select v.technician_id as technician_id where v.technician_id is not null
      union
      select vt.technician_id from visit_technicians vt where vt.visit_id = v.id
    ) assigned
  ) n
  where private.current_app_role() = 'technician'
    and private.is_visit_participant(v.id, private.current_technician_id())
    and v.status <> 'cancelled'
    and not (j.lifecycle_status = 'cancelled' and v.status in ('due', 'booked'))
    and n.c > 1
$$;

create or replace function public.technician_day_items()
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
      and not (j.lifecycle_status = 'cancelled' and v.status in ('due', 'booked'))
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

-- ---------------------------------------------------------------------------------------------------------------
-- 5. set_day_order: the day's live visits are those of ACTIVE jobs (what the schedule shows)
-- ---------------------------------------------------------------------------------------------------------------
-- Identical to the previous definition except that a visit only counts when its job is active. Without this, a kept visit
-- (hidden from the schedule because its job is cancelled) would make every save of that day fail as "the day has changed".
create or replace function public.set_day_order(p_date date, p_items jsonb)
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

  select (select count(*) from visits v join jobs j on j.id = v.job_id
          where v.scheduled_date = p_date and v.status <> 'cancelled' and j.lifecycle_status = 'active')
       + (select count(*) from activities a where a.scheduled_date = p_date and a.cancelled_at is null)
  into v_live;

  select count(*) into v_matched
  from jsonb_array_elements(p_items) as e
  where (e ->> 'kind' = 'visit' and exists (
          select 1 from visits v join jobs j on j.id = v.job_id
          where v.id = (e ->> 'id')::uuid and v.scheduled_date = p_date and v.status <> 'cancelled' and j.lifecycle_status = 'active'))
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

-- CREATE OR REPLACE keeps the existing privileges; stated again so this file is self-explanatory.
revoke execute on function public.set_day_order(date, jsonb) from public, anon;
grant execute on function public.set_day_order(date, jsonb) to authenticated, service_role;
