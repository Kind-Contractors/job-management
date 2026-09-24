-- Implements Luke's confirmed requirement: "Something not done" as a real
-- structured report state (not text in a textarea), so the office can see
-- during Manager review that the technician indicated the job
-- specification wasn't fully completed. Client/site signature is
-- explicitly NOT implemented — Luke confirmed it isn't required.
--
-- spec_met: true = specification completed/met (the default — matches
-- technician_flow.pdf's Manager-review mockup, which shows this exact
-- concept as "Spec met: Yes/No"). false = technician selected "Something
-- not done". Never blocks submission either way — both values are
-- equally valid, submittable states; this column carries no gate logic.
--
-- No RLS/grant change: reports already has zero direct technician
-- policies (all technician access is through the three SECURITY DEFINER
-- functions below, whose existing ownership checks are unchanged) and
-- Manager's existing manager_full_access policy already covers the new
-- column with no broadening needed.

alter table public.reports
  add column spec_met boolean not null default true;

comment on column public.reports.spec_met is
  'False means the technician indicated the job specification was not '
  'fully completed ("Something not done") -- must be visible to the '
  'Manager during review. True (default) is the normal/completed state. '
  'Only ever set via technician_submit_report()/technician_resubmit_report() '
  'or a Manager''s own report edit -- never written directly by a client.';

-- technician_submit_report(): add p_spec_met, included in the INSERT.
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
set search_path = public
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
    select 1 from visits where id = p_visit_id and technician_id = v_technician_id
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

  insert into photos (report_id, phase, storage_path, upload_status, uploaded_at)
  select v_report_id, (p->>'phase')::photo_phase, p->>'storage_path', 'uploaded', now()
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

revoke all on function public.technician_submit_report(uuid, text, text, text, timestamp with time zone, timestamp with time zone, jsonb, boolean) from public;
grant execute on function public.technician_submit_report(uuid, text, text, text, timestamp with time zone, timestamp with time zone, jsonb, boolean) to authenticated;
revoke execute on function public.technician_submit_report(uuid, text, text, text, timestamp with time zone, timestamp with time zone, jsonb, boolean) from anon;

-- technician_resubmit_report(): add p_spec_met, included in the UPDATE.
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
    spec_met = coalesce(p_spec_met, true),
    review_status = 'awaiting_review',
    return_reason = null
  where id = p_report_id;

  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  select 'report', p_report_id, 'report_resubmitted', name, now() from technicians where id = v_technician_id;
end;
$$;

revoke all on function public.technician_resubmit_report(uuid, text, text, text, jsonb, boolean) from public;
grant execute on function public.technician_resubmit_report(uuid, text, text, text, jsonb, boolean) to authenticated;
revoke execute on function public.technician_resubmit_report(uuid, text, text, text, jsonb, boolean) from anon;

-- Old signatures (without p_spec_met) are dropped so no stale overload is
-- left callable with a different arity.
drop function if exists public.technician_submit_report(uuid, text, text, text, timestamp with time zone, timestamp with time zone, jsonb);
drop function if exists public.technician_resubmit_report(uuid, text, text, text, jsonb);

-- technician_visit_detail(): expose the existing report's spec_met so a
-- resubmission can rehydrate the technician's previously-chosen state.
-- Structurally identical to the current function, one extra column.
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
  report_photo_count int,
  report_spec_met boolean
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
    (select count(*)::int from photos p where p.report_id = r.id),
    r.spec_met
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
  'ownership across reassignment first -- otherwise a newly assigned '
  'technician can read the previous technician''s already-submitted report '
  'and photos for the same visit. See Phase 1-3 audit, 2026-09-07. '
  'report_spec_met added 2026-09-10 for the "Something not done" feature.';
