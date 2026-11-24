-- Office-written reports, follow-up: the work can't be recorded as done in the FUTURE. Redefines
-- public.manager_complete_visit_with_report (from 20261124100000_manager_office_reports.sql) with one added rule: where the function
-- uses the completion time - a new visit (work already done) or an open visit being completed - a completion time more than 2 minutes
-- ahead of the server clock (allowance for clock differences), or a work date after today (UK), is refused. An already completed visit
-- keeps its own recorded time, so nothing changes for it. Everything else is identical.

create or replace function public.manager_complete_visit_with_report(
  p_visit_id uuid,
  p_job_id uuid,
  p_work_date date,
  p_completed_at timestamptz,
  p_price_charged numeric,
  p_work_carried_out text,
  p_technician_notes text,
  p_issues text,
  p_spec_met boolean,
  p_on_site_start timestamptz,
  p_on_site_end timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_actor text;
  v_job_status job_lifecycle_status;
  v_visit_status visit_status;
  v_visit_id uuid;
  v_report_id uuid;
  v_created boolean := false;
  v_was_completed boolean := false;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
  v_actor := private.current_manager_label();

  if (p_visit_id is null) = (p_job_id is null) then
    raise exception 'Choose either an existing visit, or the job to record the work for.' using errcode = '22023';
  end if;
  if p_completed_at is null then
    raise exception 'Enter when the work was done.' using errcode = '22023';
  end if;
  if p_price_charged is null or p_price_charged < 0 then
    raise exception 'Enter the price charged.' using errcode = '22023';
  end if;
  if p_on_site_start is not null and p_on_site_end is not null and p_on_site_end < p_on_site_start then
    raise exception 'The on-site end time is before the start time.' using errcode = '22023';
  end if;

  if p_visit_id is null then
    -- Work already done, with no visit in JMS yet: record it as a new, completed visit of this job.
    select lifecycle_status into v_job_status from jobs where id = p_job_id for update;
    if not found then
      raise exception 'That job no longer exists.' using errcode = 'P0002';
    end if;
    if v_job_status not in ('active', 'on_hold') then
      raise exception 'This job is marked %; work can''t be recorded on it here.', replace(v_job_status::text, '_', ' ') using errcode = 'P0001';
    end if;
    if p_work_date is null then
      raise exception 'Enter the date the work was done.' using errcode = '22023';
    end if;
    if p_completed_at > now() + interval '2 minutes' or p_work_date > (now() at time zone 'Europe/London')::date then
      raise exception 'The work can''t be recorded as done in the future.' using errcode = '22023';
    end if;
    insert into visits (job_id, scheduled_date, status, price_charged, completed_at)
    values (p_job_id, p_work_date, 'completed', p_price_charged, p_completed_at)
    returning id into v_visit_id;
    v_created := true;
  else
    v_visit_id := p_visit_id;
  end if;

  -- The same lock a technician's report submission takes: the two can never interleave.
  perform pg_advisory_xact_lock(hashtextextended('report:' || v_visit_id::text, 0));

  select status into v_visit_status from visits where id = v_visit_id for update;
  if not found then
    raise exception 'That visit no longer exists.' using errcode = 'P0002';
  end if;
  if v_visit_status = 'cancelled' then
    raise exception 'This visit was cancelled, so a report can''t be written for it.' using errcode = 'P0001';
  end if;
  if exists (select 1 from reports r where r.visit_id = v_visit_id) then
    raise exception 'This visit already has a report. Open it in Report review or Ready for client to check or edit it.' using errcode = '23505';
  end if;
  if exists (select 1 from visit_technicians vt where vt.visit_id = v_visit_id) then
    raise exception 'This visit has more than one technician; writing its report in the office isn''t supported for these yet.' using errcode = 'P0001';
  end if;
  if exists (select 1 from invoice_line_items il where il.visit_id = v_visit_id) then
    raise exception 'This visit is already on an invoice, so it can''t be changed here.' using errcode = 'P0001';
  end if;

  v_was_completed := not v_created and v_visit_status = 'completed';
  if not v_created and not v_was_completed and p_completed_at > now() + interval '2 minutes' then
    raise exception 'The work can''t be recorded as done in the future.' using errcode = '22023';
  end if;
  if not v_created and not v_was_completed then
    update visits set status = 'completed', price_charged = p_price_charged, completed_at = p_completed_at where id = v_visit_id;
  end if;
  -- An already completed visit keeps its recorded price and completion time.

  insert into reports (
    visit_id, submitted_by, submitted_at, work_carried_out, technician_notes, issues, spec_met, on_site_start, on_site_end,
    review_status, reviewed_by, reviewed_at
  ) values (
    v_visit_id, v_actor, now(), nullif(btrim(coalesce(p_work_carried_out, '')), ''), nullif(btrim(coalesce(p_technician_notes, '')), ''),
    nullif(btrim(coalesce(p_issues, '')), ''), coalesce(p_spec_met, true), p_on_site_start, p_on_site_end,
    'approved', v_actor, now()
  )
  returning id into v_report_id;

  if not v_was_completed then
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values ('visit', v_visit_id, 'visit_completed', case when v_created then 'Recorded by the office (work already done)' else 'Completed by the office' end,
            v_actor, p_completed_at);
  end if;
  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  values ('report', v_report_id, 'report_written_by_office', v_actor, now()),
         ('report', v_report_id, 'report_approved', v_actor, now());

  return jsonb_build_object('visit_id', v_visit_id, 'report_id', v_report_id, 'visit_created', v_created);
end;
$$;

revoke all on function public.manager_complete_visit_with_report(uuid, uuid, date, timestamptz, numeric, text, text, text, boolean, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.manager_complete_visit_with_report(uuid, uuid, date, timestamptz, numeric, text, text, text, boolean, timestamptz, timestamptz)
  to authenticated;
