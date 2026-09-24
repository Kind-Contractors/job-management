-- Multi-technician visits: additive support for 3+ technicians per visit,
-- photo-level technician attribution, and shared-report review, per Luke's
-- confirmed requirements (2026-09-21). See CLAUDE.md's multi-technician
-- decision note.
--
-- Deliberately additive only:
--   - `visits.technician_id` is UNCHANGED in meaning — it remains the
--     visit's "primary" technician exactly as today, and every existing
--     single-technician visit, RPC caller, and UI is unaffected (zero
--     rows in the new join table below).
--   - `reports.visit_id` stays UNIQUE (already enforces "one combined
--     report per visit" — no schema change needed for that part).
--   - No new maximum: `visit_technicians` is a plain join table, so a
--     visit can have any number of additional technicians.

-- 1. Additional technicians per visit (beyond the existing primary
--    `visits.technician_id`). A visit's full technician set = its
--    `technician_id` (if any) plus every row here for that visit.
create table if not exists visit_technicians (
  visit_id uuid not null references visits(id) on delete restrict,
  technician_id uuid not null references technicians(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (visit_id, technician_id)
);

create index if not exists visit_technicians_technician_id_idx on visit_technicians(technician_id);

alter table visit_technicians enable row level security;

drop policy if exists manager_full_access on visit_technicians;
create policy manager_full_access on visit_technicians
  for all
  using (private.current_app_role() = 'manager')
  with check (private.current_app_role() = 'manager');
-- No technician-facing policy, by the same design already used for
-- visits/reports/photos/technicians: technician access is enforced
-- entirely inside the SECURITY DEFINER functions below, never via RLS.

-- Mirrors prevent_visit_assignment_to_inactive_technician (visits) for
-- the same reason: an additional technician must be active too.
create or replace function prevent_inactive_technician_in_visit_technicians()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_is_active boolean;
begin
  select is_active into v_is_active from public.technicians where id = new.technician_id;
  if v_is_active is not true then
    raise exception 'Cannot assign this visit to an inactive technician.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_inactive_technician_in_visit_technicians on visit_technicians;
create trigger prevent_inactive_technician_in_visit_technicians
  before insert on visit_technicians
  for each row execute function prevent_inactive_technician_in_visit_technicians();

-- Mirrors prevent_technician_reassignment_after_report (visits) for the
-- same reason: removing an additional technician after they may have
-- contributed a report/photos would strand that attribution/authorization
-- history.
create or replace function prevent_visit_technician_removal_after_report()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if exists (select 1 from public.reports where visit_id = old.visit_id) then
    raise exception
      'Cannot remove this technician from the visit: a report has already been submitted for it.'
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists prevent_visit_technician_removal_after_report on visit_technicians;
create trigger prevent_visit_technician_removal_after_report
  before delete on visit_technicians
  for each row execute function prevent_visit_technician_removal_after_report();

-- 2. Per-photo technician attribution (internal only — never exposed to
--    the client-facing report/PDF/send pipeline, which reads only
--    ClientReportModel and has no technician field at all).
--    Nullable: existing photos are left exactly as they are (no backfill
--    — this migration never writes to existing business data), and get
--    populated going forward by the RPCs below.
alter table photos add column if not exists technician_id uuid references technicians(id) on delete restrict;
create index if not exists photos_technician_id_idx on photos(technician_id);

-- 3. Widen the Storage-policy ownership helper (used by both
--    technician_own_visit_photos_insert/select) to also recognise an
--    additional technician, not just the visit's primary technician_id.
--    Same SECURITY DEFINER pattern as before — required because Storage
--    policies run under the caller's own privileges, which have no RLS
--    grant on `visits`/`visit_technicians` at all.
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
      and (
        v.technician_id = private.current_technician_id()
        or exists (
          select 1 from visit_technicians vt
          where vt.visit_id = v.id and vt.technician_id = private.current_technician_id()
        )
      )
  )
$$;

-- 4. Widen every technician-facing read RPC's ownership check the same
--    way — ANY technician on the visit (primary or additional) sees it,
--    exactly like the primary technician already does today.
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
    exists (select 1 from reports r where r.visit_id = v.id)
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and (
      v.technician_id = private.current_technician_id()
      or exists (select 1 from visit_technicians vt where vt.visit_id = v.id and vt.technician_id = private.current_technician_id())
    )
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
    exists (select 1 from reports r where r.visit_id = v.id)
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and (
      v.technician_id = private.current_technician_id()
      or exists (select 1 from visit_technicians vt where vt.visit_id = v.id and vt.technician_id = private.current_technician_id())
    )
    and v.scheduled_date > current_date
    and v.status <> 'cancelled'
  order by v.scheduled_date asc, v.created_at asc
$$;

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
    r.id, r.review_status, r.return_reason, r.work_carried_out, r.technician_notes, r.issues,
    (select count(*)::int from photos p where p.report_id = r.id),
    r.spec_met
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  left join building_access ba on ba.building_id = b.id
  left join reports r on r.visit_id = v.id
  where private.current_app_role() = 'technician'
    and (
      v.technician_id = private.current_technician_id()
      or exists (select 1 from visit_technicians vt where vt.visit_id = v.id and vt.technician_id = private.current_technician_id())
    )
    and v.id = p_visit_id
$$;

create or replace function public.technician_needs_correction()
returns table(visit_id uuid, report_id uuid, scheduled_date date, job_id uuid, job_summary text, job_type text, building_name text, building_address text, building_postcode text, return_reason text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    v.id, r.id, v.scheduled_date, j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode, r.return_reason
  from reports r
  join visits v on v.id = r.visit_id
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and (
      v.technician_id = private.current_technician_id()
      or exists (select 1 from visit_technicians vt where vt.visit_id = v.id and vt.technician_id = private.current_technician_id())
    )
    and r.review_status = 'returned_for_correction'
  order by v.scheduled_date desc nulls last
$$;

-- 5. technician_submit_report: widen the ownership check the same way,
--    and attribute every photo in this submission to the submitting
--    technician (the one whose authenticated session made this call —
--    the only technician identity this RPC can ever honestly know,
--    whether they're the visit's primary or an additional technician).
create or replace function public.technician_submit_report(p_visit_id uuid, p_work_carried_out text, p_technician_notes text, p_issues text, p_on_site_start timestamp with time zone, p_on_site_end timestamp with time zone, p_photos jsonb, p_spec_met boolean)
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
  v_photo jsonb;
  v_storage_path text;
  v_phase text;
begin
  v_technician_id := private.current_technician_id();
  if private.current_app_role() <> 'technician' or v_technician_id is null then
    raise exception 'Not authorized.';
  end if;

  if p_visit_id is null or not exists (
    select 1 from visits v
    where v.id = p_visit_id
      and (
        v.technician_id = v_technician_id
        or exists (select 1 from visit_technicians vt where vt.visit_id = v.id and vt.technician_id = v_technician_id)
      )
  ) then
    raise exception 'This visit is not assigned to you.';
  end if;

  if exists (select 1 from reports where visit_id = p_visit_id) then
    raise exception 'A report already exists for this visit.';
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
  end loop;

  select name into v_technician_name from technicians where id = v_technician_id;

  select j.pricing_type, j.price_per_visit into v_pricing_type, v_price_per_visit
  from jobs j join visits v on v.job_id = j.id where v.id = p_visit_id;

  insert into reports (
    visit_id, submitted_by, submitted_at, on_site_start, on_site_end,
    work_carried_out, technician_notes, issues, spec_met,
    include_photos, include_notes, include_issues, include_price
  ) values (
    p_visit_id, v_technician_name, now(), p_on_site_start, p_on_site_end,
    p_work_carried_out, p_technician_notes, p_issues, coalesce(p_spec_met, true),
    true, true, true, false
  ) returning id into v_report_id;

  insert into photos (report_id, phase, storage_path, upload_status, uploaded_at, technician_id)
  select v_report_id, (p->>'phase')::photo_phase, p->>'storage_path', 'uploaded', now(), v_technician_id
  from jsonb_array_elements(p_photos) p;

  if v_pricing_type = 'fixed' then
    update visits set status = 'completed', price_charged = v_price_per_visit, completed_at = p_on_site_end
    where id = p_visit_id;
  end if;

  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  values ('report', v_report_id, 'report_submitted', v_technician_name, now());

  return v_report_id;
end;
$$;

-- 6. technician_resubmit_report: same ownership widening, and attribute
--    any additional photos added during resubmission to whichever
--    technician is resubmitting (same reasoning as above).
create or replace function public.technician_resubmit_report(p_report_id uuid, p_work_carried_out text, p_technician_notes text, p_issues text, p_additional_photos jsonb, p_spec_met boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_technician_id uuid;
  v_visit_id uuid;
  v_review_status report_review_status;
  v_photo jsonb;
  v_storage_path text;
  v_phase text;
begin
  v_technician_id := private.current_technician_id();
  if private.current_app_role() <> 'technician' or v_technician_id is null then
    raise exception 'Not authorized.';
  end if;

  select r.visit_id, r.review_status into v_visit_id, v_review_status
  from reports r
  join visits v on v.id = r.visit_id
  where r.id = p_report_id
    and (
      v.technician_id = v_technician_id
      or exists (select 1 from visit_technicians vt where vt.visit_id = v.id and vt.technician_id = v_technician_id)
    );

  if v_visit_id is null then
    raise exception 'This report is not available to you.';
  end if;

  if v_review_status <> 'returned_for_correction' then
    raise exception 'This report is not awaiting correction.';
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
    end loop;

    insert into photos (report_id, phase, storage_path, upload_status, uploaded_at, technician_id)
    select p_report_id, (p->>'phase')::photo_phase, p->>'storage_path', 'uploaded', now(), v_technician_id
    from jsonb_array_elements(p_additional_photos) p;
  end if;

  update reports set
    work_carried_out = p_work_carried_out,
    technician_notes = p_technician_notes,
    issues = p_issues,
    spec_met = coalesce(p_spec_met, true),
    review_status = 'awaiting_review',
    return_reason = null
  where id = p_report_id;

  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  select 'report', p_report_id, 'report_resubmitted', name, now() from technicians where id = v_technician_id;
end;
$$;
