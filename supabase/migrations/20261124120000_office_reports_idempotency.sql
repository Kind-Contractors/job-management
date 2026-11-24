-- Office-written reports, follow-up 2: saving is IDEMPOTENT. Approved Nov 2026.
--
-- Why: public.manager_complete_visit_with_report (20261124100000, future-time rule 20261124110000) did its work and returned the ids, but
-- if that reply was lost on the way back (connection dropped, gateway timeout) the office app could not tell whether anything had been
-- saved. Pressing Save again was harmless for an existing visit (one report per visit: reports.visit_id is UNIQUE), but "work already
-- done" inserts a NEW visit on every call, so a retry after a lost success recorded the work twice - two completed visits, two approved
-- reports, both in Ready for client and Ready for accounts.
--
-- What this adds:
--   1. private.office_report_requests - one row per office save that carried a request id: who made it (auth.uid()), and the visit and
--      report it produced. In the private schema (not served by the API), row-level security on: a manager can read and add ONLY their
--      own rows, nobody can change or delete them (no grant, no policy). A row goes when its report or visit is deleted (cascade).
--   2. The function takes p_request_id uuid (optional, LAST, default null - an older caller that doesn't send one behaves exactly as
--      before). With an id:
--        * it takes a transaction lock on that id FIRST, so two calls with the same id never run side by side: the second waits until
--          the first has committed (or rolled back) and then sees its row;
--        * if a row exists for the id, it returns THAT visit and report (replayed: true) and changes nothing - provided the row is the
--          caller's own and is for the same visit / job; otherwise it refuses, without saying what the id belongs to;
--        * otherwise it does exactly what it did before and records the id with the result IN THE SAME TRANSACTION, so the record exists
--          if and only if the visit/report were saved. The primary key on request_id is the last line of defence: a duplicate can't be
--          written even if the lock were somehow bypassed (it fails the whole call, so nothing is saved twice).
--      Everything else - the manager-only check, validation, the future-time rule, the cancelled / multi-technician / invoiced / closed
--      job guards, automatic approval and attribution - is unchanged. A replay returns before those checks: they were met when the
--      request was first saved, and nothing is written again.
--   The old 11-argument function is dropped and replaced by the 12-argument one (keeping both would make a call ambiguous).
--
-- Rollback: supabase/rollbacks/20261124120000_office_reports_idempotency.rollback.sql

-- 1. The request record ------------------------------------------------------------------------------------------------------------------
create table if not exists private.office_report_requests (
  request_id uuid primary key,
  created_by uuid not null,
  visit_id uuid not null references public.visits(id) on delete cascade,
  report_id uuid not null unique references public.reports(id) on delete cascade,
  visit_created boolean not null,
  created_at timestamptz not null default now()
);
comment on table private.office_report_requests is
  'Idempotency record for public.manager_complete_visit_with_report: the visit and report one office save (request_id, made by the app per submission) produced, so a retry of the same save returns them instead of saving again. Written only by that function, in the same transaction as the report.';

alter table private.office_report_requests enable row level security;
revoke all on table private.office_report_requests from public, anon, authenticated;
grant select, insert on table private.office_report_requests to authenticated;

drop policy if exists office_report_requests_own_select on private.office_report_requests;
create policy office_report_requests_own_select on private.office_report_requests
  for select to authenticated
  using (private.current_app_role() = 'manager' and created_by = auth.uid());

drop policy if exists office_report_requests_own_insert on private.office_report_requests;
create policy office_report_requests_own_insert on private.office_report_requests
  for insert to authenticated
  with check (private.current_app_role() = 'manager' and created_by = auth.uid());

-- 2. The function, now with p_request_id ---------------------------------------------------------------------------------------------------
drop function if exists public.manager_complete_visit_with_report(uuid, uuid, date, timestamptz, numeric, text, text, text, boolean, timestamptz, timestamptz);

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
  p_on_site_end timestamptz,
  p_request_id uuid default null
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
  v_prior record;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
  v_actor := private.current_manager_label();

  if (p_visit_id is null) = (p_job_id is null) then
    raise exception 'Choose either an existing visit, or the job to record the work for.' using errcode = '22023';
  end if;

  -- The same save sent again (its reply was lost): hand back what it saved, change nothing.
  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('office-report-request:' || p_request_id::text, 0));
    select r.created_by, r.visit_id, r.report_id, r.visit_created, v.job_id
      into v_prior
      from private.office_report_requests r
      join visits v on v.id = r.visit_id
     where r.request_id = p_request_id;
    if found then
      if v_prior.created_by is distinct from auth.uid()
         or (p_visit_id is not null and v_prior.visit_id is distinct from p_visit_id)
         or (p_job_id is not null and v_prior.job_id is distinct from p_job_id) then
        raise exception 'This save was already used for a different report. Close the form and start again.' using errcode = '22023';
      end if;
      return jsonb_build_object('visit_id', v_prior.visit_id, 'report_id', v_prior.report_id, 'visit_created', v_prior.visit_created,
                                'replayed', true);
    end if;
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

  -- Recorded in the same transaction as the report: it exists if and only if this save was. The primary key refuses a second one.
  if p_request_id is not null then
    begin
      insert into private.office_report_requests (request_id, created_by, visit_id, report_id, visit_created)
      values (p_request_id, auth.uid(), v_visit_id, v_report_id, v_created);
    exception when unique_violation then
      raise exception 'This save was already used for a different report. Close the form and start again.' using errcode = '22023';
    end;
  end if;

  return jsonb_build_object('visit_id', v_visit_id, 'report_id', v_report_id, 'visit_created', v_created, 'replayed', false);
end;
$$;

comment on function public.manager_complete_visit_with_report(uuid, uuid, date, timestamptz, numeric, text, text, text, boolean, timestamptz, timestamptz, uuid) is
  'Office: complete a visit (or record work already done as a new completed visit) and write its report, approved, in one transaction. Idempotent per p_request_id: the same id returns the original visit/report (replayed: true) and saves nothing again.';

revoke all on function public.manager_complete_visit_with_report(uuid, uuid, date, timestamptz, numeric, text, text, text, boolean, timestamptz, timestamptz, uuid)
  from public, anon;
grant execute on function public.manager_complete_visit_with_report(uuid, uuid, date, timestamptz, numeric, text, text, text, boolean, timestamptz, timestamptz, uuid)
  to authenticated;
