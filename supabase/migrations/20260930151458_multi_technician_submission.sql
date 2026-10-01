-- Multi-technician report submission (database/RPC layer only).
--
-- Builds on visit_technicians (extra technicians per visit) and
-- report_contributions (one row per technician per report). Every function
-- below keeps its existing signature (CREATE OR REPLACE, no drops), so
-- grants are preserved and the frontend is unaffected.
--
-- MODES. A visit is in "contribution mode" when it has any extra technician
-- (visit_technicians row) or its report already has contribution rows.
-- Otherwise it is the ordinary single-technician visit and every function
-- takes exactly the path it always did: no contribution row is written, and
-- a manager returning the whole report still lets the technician resubmit.
--
-- In contribution mode:
--  * Each assigned technician (primary or extra) submits their OWN
--    contribution; the first submission creates the single reports row.
--  * reports stays the one combined report. While a report has contribution
--    rows, its text/spec/times/submitted_by are DERIVED from them by
--    private.recompose_report(): text joined in first-submission order with
--    no technician names, spec_met = all met, on-site = earliest arrival to
--    latest departure. submitted_by lists names (manager-facing only; it is
--    not part of the client report model).
--  * The fixed-price auto-complete still runs only when the report is
--    CREATED, and still only for due/booked visits, so a later technician
--    can never overwrite a completed/missed/cancelled/invoiced visit.
--  * Corrections are per technician (report_contributions.needs_correction).
--    The report is 'returned_for_correction' while any contribution is
--    flagged and returns to 'awaiting_review' when none are.

-- 1. Photo attribution (internal only; never read by the client report model).
alter table public.photos
  add column technician_id uuid references public.technicians (id) on delete restrict;

create index photos_technician_id_idx on public.photos (technician_id);

comment on column public.photos.technician_id is
  'The technician who submitted this photo (set by the technician RPCs). Null for photos from before this column existed. Internal only.';

-- 2. Helpers (private schema; only ever called from SECURITY DEFINER code).
create function private.is_visit_participant(p_visit_id uuid, p_technician_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_technician_id is not null and exists (
    select 1 from visits v
    where v.id = p_visit_id
      and (
        v.technician_id = p_technician_id
        or exists (
          select 1 from visit_technicians vt
          where vt.visit_id = v.id and vt.technician_id = p_technician_id
        )
      )
  )
$$;

-- "Has this technician done their part?" For the technician's own Today/
-- Upcoming/Past lists. Ordinary visits: does any report exist (unchanged).
-- Contribution-mode visits: does THIS technician have a contribution (or
-- waiver); the primary technician of a report that pre-dates contributions
-- counts as done.
create function private.report_submitted_for(p_visit_id uuid, p_technician_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when exists (select 1 from visit_technicians vt where vt.visit_id = p_visit_id)
      or exists (
        select 1 from reports r join report_contributions rc on rc.report_id = r.id
        where r.visit_id = p_visit_id
      )
    then
      exists (
        select 1 from report_contributions rc join reports r on r.id = rc.report_id
        where r.visit_id = p_visit_id and rc.technician_id = p_technician_id
      )
      or (
        exists (select 1 from visits v where v.id = p_visit_id and v.technician_id = p_technician_id)
        and exists (select 1 from reports r where r.visit_id = p_visit_id)
        and not exists (
          select 1 from report_contributions rc join reports r on r.id = rc.report_id
          where r.visit_id = p_visit_id
        )
      )
    else exists (select 1 from reports r where r.visit_id = p_visit_id)
  end
$$;

-- Derives the combined report fields from its submitted contributions.
-- Deterministic: contributions in first-submission order (created_at, id).
create function private.recompose_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count int;
  v_work text;
  v_notes text;
  v_issues text;
  v_spec boolean;
  v_start timestamptz;
  v_end timestamptz;
  v_by text;
begin
  select
    count(*),
    string_agg(case when btrim(rc.work_carried_out) <> '' then rc.work_carried_out end, E'\n\n' order by rc.created_at, rc.id),
    string_agg(case when btrim(rc.technician_notes) <> '' then rc.technician_notes end, E'\n\n' order by rc.created_at, rc.id),
    string_agg(case when btrim(rc.issues) <> '' then rc.issues end, E'\n\n' order by rc.created_at, rc.id),
    bool_and(rc.spec_met),
    min(rc.on_site_start),
    max(rc.on_site_end),
    string_agg(t.name, ', ' order by rc.created_at, rc.id)
  into v_count, v_work, v_notes, v_issues, v_spec, v_start, v_end, v_by
  from report_contributions rc
  join technicians t on t.id = rc.technician_id
  where rc.report_id = p_report_id and rc.submitted_at is not null;

  if v_count = 0 then
    return;
  end if;

  update reports set
    work_carried_out = v_work,
    technician_notes = v_notes,
    issues = v_issues,
    spec_met = v_spec,
    on_site_start = v_start,
    on_site_end = v_end,
    submitted_by = v_by
  where id = p_report_id;
end;
$$;

revoke execute on function private.is_visit_participant(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.report_submitted_for(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.recompose_report(uuid) from public, anon, authenticated;

-- 3. Keep the report's review state in step with per-technician corrections.
create function public.sync_report_state_from_contributions()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_flagged int;
  v_reason text;
begin
  select count(*), string_agg(distinct correction_reason, E'\n')
  into v_flagged, v_reason
  from report_contributions
  where report_id = new.report_id and needs_correction;

  if v_flagged > 0 then
    update reports
    set review_status = 'returned_for_correction', return_reason = v_reason
    where id = new.report_id
      and (review_status is distinct from 'returned_for_correction' or return_reason is distinct from v_reason);
  else
    update reports
    set review_status = 'awaiting_review', return_reason = null
    where id = new.report_id and review_status = 'returned_for_correction';
  end if;

  return null;
end;
$$;

revoke execute on function public.sync_report_state_from_contributions() from public, anon, authenticated;

create trigger sync_report_state_from_contributions
  after insert or update of needs_correction, correction_reason on public.report_contributions
  for each row execute function public.sync_report_state_from_contributions();

-- The existing manager UI returns a WHOLE report. For a contribution-mode
-- report that returns every submitted contribution, so each technician can
-- resubmit. Approving while a contribution is awaiting correction is refused.
-- Reports with no contribution rows are unaffected.
create function public.check_report_review_transition()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.review_status is distinct from old.review_status then
    if new.review_status = 'approved'
       and exists (select 1 from report_contributions where report_id = new.id and needs_correction)
    then
      raise exception 'Cannot approve this report: one or more technician contributions are awaiting correction.'
        using errcode = 'P0001';
    end if;

    if new.review_status = 'returned_for_correction'
       and exists (select 1 from report_contributions where report_id = new.id and submitted_at is not null)
       and not exists (select 1 from report_contributions where report_id = new.id and needs_correction)
    then
      update report_contributions
      set needs_correction = true, correction_reason = new.return_reason
      where report_id = new.id and submitted_at is not null;
    end if;
  end if;
  return null;
end;
$$;

revoke execute on function public.check_report_review_transition() from public, anon, authenticated;

create trigger check_report_review_transition
  after update of review_status on public.reports
  for each row execute function public.check_report_review_transition();

-- 4. Storage policies' ownership helper: any technician assigned to the visit.
create or replace function private.visit_belongs_to_current_technician(p_visit_id_text text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from visits v
    where v.id::text = p_visit_id_text
      and private.is_visit_participant(v.id, private.current_technician_id())
  )
$$;

-- 5. Visit lists: any assigned technician sees the visit; "done" is per technician.
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
  order by v.created_at
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
  order by v.scheduled_date asc, v.created_at asc
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
  order by v.scheduled_date desc, v.created_at desc
  limit 200
$$;

-- 6. Visit detail. Ordinary visits: unchanged. Contribution-mode visits: the
--    report_* columns describe THIS technician's own contribution only (a
--    technician never sees a colleague's text, counts or correction), and
--    report_id is null until they have contributed so the app offers
--    "Add report" rather than "Report submitted".
create or replace function public.technician_visit_detail(p_visit_id uuid)
returns table(visit_id uuid, scheduled_date date, visit_status visit_status, job_id uuid, job_summary text, job_type text, job_notes text, building_name text, building_address text, building_postcode text, site_instructions text, key_safe_code text, keyholder_name text, keyholder_phone text, parking_notes text, access_notes text, report_id uuid, report_review_status report_review_status, report_return_reason text, report_work_carried_out text, report_technician_notes text, report_issues text, report_photo_count integer, report_spec_met boolean)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text, j.job_notes,
    b.name, b.address, b.postcode, b.extra_requirements,
    ba.key_safe_code, ba.keyholder_name, ba.keyholder_phone, ba.parking_notes, ba.access_notes,
    case when f.legacy_view then r.id when mine.id is not null then r.id else null end,
    case
      when f.legacy_view then r.review_status
      when mine.id is null then null
      when mine.needs_correction then 'returned_for_correction'::report_review_status
      when r.review_status = 'approved' then r.review_status
      else 'awaiting_review'::report_review_status
    end,
    case when f.legacy_view then r.return_reason when mine.needs_correction then mine.correction_reason else null end,
    case when f.legacy_view then r.work_carried_out else mine.work_carried_out end,
    case when f.legacy_view then r.technician_notes else mine.technician_notes end,
    case when f.legacy_view then r.issues else mine.issues end,
    case
      when f.legacy_view then (select count(*)::int from photos p where p.report_id = r.id)
      else (select count(*)::int from photos p where p.report_id = r.id and p.technician_id = private.current_technician_id())
    end,
    case when f.legacy_view then r.spec_met else mine.spec_met end
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  left join building_access ba on ba.building_id = b.id
  left join reports r on r.visit_id = v.id
  cross join lateral (
    select
      (
        not (
          exists (select 1 from visit_technicians vt where vt.visit_id = v.id)
          or exists (select 1 from report_contributions x where x.report_id = r.id)
        )
      )
      or (
        not exists (select 1 from report_contributions x where x.report_id = r.id)
        and v.technician_id = private.current_technician_id()
      ) as legacy_view
  ) f
  left join lateral (
    select rc.*
    from report_contributions rc
    where rc.report_id = r.id
      and rc.technician_id = private.current_technician_id()
      and rc.submitted_at is not null
  ) mine on true
  where private.current_app_role() = 'technician'
    and private.is_visit_participant(v.id, private.current_technician_id())
    and v.id = p_visit_id
$$;

-- 7. Reports returned for correction, for this technician only.
create or replace function public.technician_needs_correction()
returns table(visit_id uuid, report_id uuid, scheduled_date date, job_id uuid, job_summary text, job_type text, building_name text, building_address text, building_postcode text, return_reason text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    v.id, r.id, v.scheduled_date, j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode,
    coalesce(
      (select x.correction_reason from report_contributions x
        where x.report_id = r.id and x.technician_id = private.current_technician_id() and x.needs_correction),
      r.return_reason
    )
  from reports r
  join visits v on v.id = r.visit_id
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and (
      (
        v.technician_id = private.current_technician_id()
        and not exists (select 1 from report_contributions x where x.report_id = r.id)
        and r.review_status = 'returned_for_correction'
      )
      or exists (
        select 1 from report_contributions x
        where x.report_id = r.id and x.technician_id = private.current_technician_id() and x.needs_correction
      )
    )
  order by v.scheduled_date desc nulls last
$$;

-- 8. Submission.
create or replace function public.technician_submit_report(
  p_visit_id uuid,
  p_work_carried_out text,
  p_technician_notes text,
  p_issues text,
  p_on_site_start timestamp with time zone,
  p_on_site_end timestamp with time zone,
  p_photos jsonb,
  p_spec_met boolean
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_technician_id uuid;
  v_technician_name text;
  v_pricing_type job_pricing_type;
  v_price_per_visit numeric;
  v_report_id uuid;
  v_review_status report_review_status;
  v_primary uuid;
  v_has_contrib boolean;
  v_multi boolean;
  v_new boolean := false;
  v_mine report_contributions%rowtype;
  v_photo jsonb;
  v_storage_path text;
  v_phase text;
begin
  v_technician_id := private.current_technician_id();
  if private.current_app_role() <> 'technician' or v_technician_id is null then
    raise exception 'Not authorized.';
  end if;

  if p_visit_id is null or not private.is_visit_participant(p_visit_id, v_technician_id) then
    raise exception 'This visit is not assigned to you.';
  end if;

  -- Two technicians submitting at the same moment must not both try to create the report.
  perform pg_advisory_xact_lock(hashtextextended('report:' || p_visit_id::text, 0));

  select id, review_status into v_report_id, v_review_status from reports where visit_id = p_visit_id;
  select technician_id into v_primary from visits where id = p_visit_id;
  v_has_contrib := v_report_id is not null
    and exists (select 1 from report_contributions where report_id = v_report_id);
  v_multi := v_has_contrib or exists (select 1 from visit_technicians where visit_id = p_visit_id);

  if v_report_id is not null then
    if not v_multi then
      raise exception 'A report already exists for this visit.';
    end if;
    if not v_has_contrib then
      -- A report from before extra technicians were assigned (no contribution rows).
      if v_primary = v_technician_id then
        raise exception 'A report already exists for this visit.';
      end if;
      raise exception 'This visit''s report was submitted before additional technicians were added to it; please ask the office.';
    end if;

    select * into v_mine from report_contributions
    where report_id = v_report_id and technician_id = v_technician_id;
    if found and v_mine.submitted_at is not null then
      raise exception 'A report already exists for this visit.';
    end if;
    if v_review_status = 'approved' then
      raise exception 'This report has already been approved; please ask the office if something needs adding.';
    end if;
  end if;

  if p_on_site_start is null or p_on_site_end is null then
    raise exception 'Arrival and departure times are required.';
  end if;
  if p_on_site_end < p_on_site_start then
    raise exception 'Departure time cannot be before arrival time.';
  end if;

  if p_photos is null or jsonb_typeof(p_photos) <> 'array' or jsonb_array_length(p_photos) < 1 then
    raise exception 'At least one photo is required to submit this report.';
  end if;

  for v_photo in select * from jsonb_array_elements(p_photos) loop
    v_storage_path := v_photo->>'storage_path';
    v_phase := v_photo->>'phase';

    if v_storage_path is null or length(trim(v_storage_path)) = 0 then
      raise exception 'Every photo must have a storage path.';
    end if;
    if v_phase is null or v_phase not in ('before', 'during', 'after') then
      raise exception 'Every photo must have a valid phase (before, during, or after).';
    end if;
    if (storage.foldername(v_storage_path))[1] is distinct from p_visit_id::text then
      raise exception 'Photo % does not belong to this visit.', v_storage_path;
    end if;
    if not exists (
      select 1 from storage.objects where bucket_id = 'visit-photos' and name = v_storage_path
    ) then
      raise exception 'Photo % was not found in storage.', v_storage_path;
    end if;
    if v_multi then
      -- Several technicians share the visit's photo folder: a photo may only be
      -- claimed by the login that uploaded it, and only once.
      if not exists (
        select 1 from storage.objects
        where bucket_id = 'visit-photos' and name = v_storage_path and owner_id = auth.uid()::text
      ) then
        raise exception 'Photo % was not uploaded by you.', v_storage_path;
      end if;
      if exists (select 1 from photos where storage_path = v_storage_path) then
        raise exception 'Photo % has already been submitted.', v_storage_path;
      end if;
    end if;
  end loop;

  select name into v_technician_name from technicians where id = v_technician_id;

  select j.pricing_type, j.price_per_visit into v_pricing_type, v_price_per_visit
  from jobs j join visits v on v.job_id = j.id where v.id = p_visit_id;

  if v_report_id is null then
    insert into reports (
      visit_id, submitted_by, submitted_at, on_site_start, on_site_end,
      work_carried_out, technician_notes, issues, spec_met,
      include_photos, include_notes, include_issues, include_price
    ) values (
      p_visit_id, v_technician_name, now(), p_on_site_start, p_on_site_end,
      p_work_carried_out, p_technician_notes, p_issues, coalesce(p_spec_met, true),
      true, true, true, false
    ) returning id into v_report_id;
    v_new := true;
  end if;

  insert into photos (report_id, phase, storage_path, upload_status, uploaded_at, technician_id)
  select v_report_id, (p->>'phase')::photo_phase, p->>'storage_path', 'uploaded', now(), v_technician_id
  from jsonb_array_elements(p_photos) p;

  if v_multi then
    if v_mine.id is not null then
      -- This technician had been waived by the office; submitting lifts the waiver.
      update report_contributions set
        work_carried_out = p_work_carried_out, technician_notes = p_technician_notes, issues = p_issues,
        spec_met = coalesce(p_spec_met, true), on_site_start = p_on_site_start, on_site_end = p_on_site_end,
        submitted_at = now(), waived_at = null, waived_by = null
      where id = v_mine.id;
    else
      insert into report_contributions (
        report_id, technician_id, work_carried_out, technician_notes, issues, spec_met,
        on_site_start, on_site_end, submitted_at
      ) values (
        v_report_id, v_technician_id, p_work_carried_out, p_technician_notes, p_issues, coalesce(p_spec_met, true),
        p_on_site_start, p_on_site_end, now()
      );
    end if;
    perform private.recompose_report(v_report_id);
  end if;

  -- Only when the report is CREATED, and only for a still due/booked visit:
  -- a later technician's contribution never touches visit status, price or
  -- completion time (see 20260929100100_technician_submit_report_preserve_visit_state).
  if v_new and v_pricing_type = 'fixed' then
    update visits set status = 'completed', price_charged = v_price_per_visit, completed_at = p_on_site_end
    where id = p_visit_id and status in ('due', 'booked');
  end if;

  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  values ('report', v_report_id, case when v_new then 'report_submitted' else 'report_contribution_added' end, v_technician_name, now());

  return v_report_id;
end;
$$;

-- 9. Resubmission of a contribution (or, for ordinary visits, the whole report).
create or replace function public.technician_resubmit_report(
  p_report_id uuid,
  p_work_carried_out text,
  p_technician_notes text,
  p_issues text,
  p_additional_photos jsonb,
  p_spec_met boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_technician_id uuid;
  v_visit_id uuid;
  v_review_status report_review_status;
  v_primary uuid;
  v_has_contrib boolean;
  v_mine report_contributions%rowtype;
  v_photo jsonb;
  v_storage_path text;
  v_phase text;
begin
  v_technician_id := private.current_technician_id();
  if private.current_app_role() <> 'technician' or v_technician_id is null then
    raise exception 'Not authorized.';
  end if;

  select r.visit_id, r.review_status, v.technician_id
  into v_visit_id, v_review_status, v_primary
  from reports r
  join visits v on v.id = r.visit_id
  where r.id = p_report_id;

  if v_visit_id is null or not private.is_visit_participant(v_visit_id, v_technician_id) then
    raise exception 'This report is not available to you.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('report:' || v_visit_id::text, 0));

  v_has_contrib := exists (select 1 from report_contributions where report_id = p_report_id);

  if v_has_contrib then
    select * into v_mine from report_contributions
    where report_id = p_report_id and technician_id = v_technician_id;
    if not found or v_mine.submitted_at is null then
      raise exception 'This report is not available to you.';
    end if;
    if not v_mine.needs_correction then
      raise exception 'This report is not awaiting correction.';
    end if;
  else
    if v_primary is distinct from v_technician_id then
      raise exception 'This report is not available to you.';
    end if;
    if v_review_status <> 'returned_for_correction' then
      raise exception 'This report is not awaiting correction.';
    end if;
  end if;

  if p_additional_photos is not null and jsonb_typeof(p_additional_photos) = 'array' and jsonb_array_length(p_additional_photos) > 0 then
    for v_photo in select * from jsonb_array_elements(p_additional_photos) loop
      v_storage_path := v_photo->>'storage_path';
      v_phase := v_photo->>'phase';

      if v_storage_path is null or length(trim(v_storage_path)) = 0 then
        raise exception 'Every photo must have a storage path.';
      end if;
      if v_phase is null or v_phase not in ('before', 'during', 'after') then
        raise exception 'Every photo must have a valid phase (before, during, or after).';
      end if;
      if (storage.foldername(v_storage_path))[1] is distinct from v_visit_id::text then
        raise exception 'Photo % does not belong to this visit.', v_storage_path;
      end if;
      if not exists (
        select 1 from storage.objects where bucket_id = 'visit-photos' and name = v_storage_path
      ) then
        raise exception 'Photo % was not found in storage.', v_storage_path;
      end if;
      if v_has_contrib then
        if not exists (
          select 1 from storage.objects
          where bucket_id = 'visit-photos' and name = v_storage_path and owner_id = auth.uid()::text
        ) then
          raise exception 'Photo % was not uploaded by you.', v_storage_path;
        end if;
        if exists (select 1 from photos where storage_path = v_storage_path) then
          raise exception 'Photo % has already been submitted.', v_storage_path;
        end if;
      end if;
    end loop;

    insert into photos (report_id, phase, storage_path, upload_status, uploaded_at, technician_id)
    select p_report_id, (p->>'phase')::photo_phase, p->>'storage_path', 'uploaded', now(), v_technician_id
    from jsonb_array_elements(p_additional_photos) p;
  end if;

  if v_has_contrib then
    update report_contributions set
      work_carried_out = p_work_carried_out,
      technician_notes = p_technician_notes,
      issues = p_issues,
      spec_met = coalesce(p_spec_met, true),
      submitted_at = now(),
      needs_correction = false,
      correction_reason = null
    where id = v_mine.id;
    perform private.recompose_report(p_report_id);
  else
    update reports set
      work_carried_out = p_work_carried_out,
      technician_notes = p_technician_notes,
      issues = p_issues,
      spec_met = coalesce(p_spec_met, true),
      review_status = 'awaiting_review',
      return_reason = null
    where id = p_report_id;
  end if;

  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  select 'report', p_report_id, 'report_resubmitted', name, now() from technicians where id = v_technician_id;
end;
$$;
