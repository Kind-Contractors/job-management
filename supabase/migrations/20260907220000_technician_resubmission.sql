-- Phase 4: Returned-for-correction workflow.
--
-- No new status, no new schema field — reuses reports.review_status /
-- return_reason exactly as they already exist, and mirrors the Manager's
-- own existing resubmitReport() semantics precisely: only review_status and
-- return_reason are touched on a successful resubmission; reviewed_by/
-- reviewed_at are left untouched, same as the Manager path.
--
-- No new on-site timing is introduced — resubmission corrects the existing
-- report (text/photos/issues), never re-captures on_site_start/on_site_end.
-- Verified against technician_flow.pdf and CLAUDE.md section 7 before this
-- was written: neither source describes or implies a second physical visit
-- for a correction.

-- 1. Read RPC: the technician's own reports currently returned for
-- correction, regardless of date (a return can be from any earlier visit).
create or replace function public.technician_needs_correction()
returns table (
  visit_id uuid,
  report_id uuid,
  scheduled_date date,
  job_id uuid,
  job_summary text,
  job_type text,
  building_name text,
  building_address text,
  building_postcode text,
  return_reason text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id, r.id, v.scheduled_date, j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode, r.return_reason
  from reports r
  join visits v on v.id = r.visit_id
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and v.technician_id = private.current_technician_id()
    and r.review_status = 'returned_for_correction'
  order by v.scheduled_date desc nulls last
$$;

revoke all on function public.technician_needs_correction() from public;
grant execute on function public.technician_needs_correction() to authenticated;
revoke execute on function public.technician_needs_correction() from anon;

-- 2. technician_visit_detail() extended with report_photo_count — a
-- computed value (existing photos row count), not a new schema field —
-- so the resubmission form can honestly show "N photos already added"
-- without a separate photo-listing RPC.
drop function if exists public.technician_visit_detail(uuid);

create function public.technician_visit_detail(p_visit_id uuid)
returns table (
  visit_id uuid,
  scheduled_date date,
  visit_status visit_status,
  job_id uuid,
  job_summary text,
  job_type text,
  job_notes text,
  building_name text,
  building_address text,
  building_postcode text,
  site_instructions text,
  key_safe_code text,
  keyholder_name text,
  keyholder_phone text,
  parking_notes text,
  access_notes text,
  report_id uuid,
  report_review_status report_review_status,
  report_return_reason text,
  report_work_carried_out text,
  report_technician_notes text,
  report_issues text,
  report_photo_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text, j.job_notes,
    b.name, b.address, b.postcode, b.extra_requirements,
    ba.key_safe_code, ba.keyholder_name, ba.keyholder_phone, ba.parking_notes, ba.access_notes,
    r.id, r.review_status, r.return_reason, r.work_carried_out, r.technician_notes, r.issues,
    (select count(*)::int from photos p where p.report_id = r.id)
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  left join building_access ba on ba.building_id = b.id
  left join reports r on r.visit_id = v.id
  where private.current_app_role() = 'technician'
    and v.technician_id = private.current_technician_id()
    and v.id = p_visit_id
$$;

revoke all on function public.technician_visit_detail(uuid) from public;
grant execute on function public.technician_visit_detail(uuid) to authenticated;
revoke execute on function public.technician_visit_detail(uuid) from anon;

comment on function public.technician_visit_detail(uuid) is
  'Ownership check is CURRENT visits.technician_id only, no reassignment history. '
  'If an existing-visit reassignment feature is built, redesign report/photo '
  'ownership across reassignment first — otherwise a newly assigned '
  'technician can read the previous technician''s already-submitted report '
  'and photos for the same visit. See Phase 1-3 audit, 2026-09-07.';

-- 3. Write RPC: resubmission. Requires the report to currently be
-- returned_for_correction; never re-collects on_site_start/on_site_end;
-- allows zero additional photos; never touches reviewed_by/reviewed_at
-- (matching the Manager's own resubmitReport() exactly).
create or replace function public.technician_resubmit_report(
  p_report_id uuid,
  p_work_carried_out text,
  p_technician_notes text,
  p_issues text,
  p_additional_photos jsonb
)
returns void
language plpgsql
security definer
set search_path = public
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
  where r.id = p_report_id and v.technician_id = v_technician_id;

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

    insert into photos (report_id, phase, storage_path, upload_status, uploaded_at)
    select p_report_id, (p->>'phase')::photo_phase, p->>'storage_path', 'uploaded', now()
    from jsonb_array_elements(p_additional_photos) p;
  end if;

  update reports set
    work_carried_out = p_work_carried_out,
    technician_notes = p_technician_notes,
    issues = p_issues,
    review_status = 'awaiting_review',
    return_reason = null
  where id = p_report_id;

  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  select 'report', p_report_id, 'report_resubmitted', name, now() from technicians where id = v_technician_id;
end;
$$;

revoke all on function public.technician_resubmit_report(uuid, text, text, text, jsonb) from public;
grant execute on function public.technician_resubmit_report(uuid, text, text, text, jsonb) to authenticated;
revoke execute on function public.technician_resubmit_report(uuid, text, text, text, jsonb) from anon;

comment on function public.technician_resubmit_report(uuid, text, text, text, jsonb) is
  'Ownership check is CURRENT visits.technician_id only, no reassignment '
  'history. Same caveat as technician_visit_detail() — see that function''s '
  'comment and the Phase 1-3 audit, 2026-09-07.';
