-- Reverts 20260921123804_multi_technician_visits.sql in full.
--
-- Reason: the multi-technician feature introduced an implicit PostgREST
-- many-to-many bridge between `visits` and `technicians` (via the new
-- `visit_technicians` junction table) that made every existing
-- `visits(...technicians...)` embed ambiguous — breaking job-loading
-- everywhere in the Manager app. Reverting the whole feature rather than
-- debugging further, per explicit instruction.
--
-- Confirmed via read-only queries before writing this file:
--   - `visit_technicians` has 0 rows — nothing has ever been written to it.
--   - `photos.technician_id` is non-null on 0 rows (in fact `photos` has
--     0 rows total right now) — nothing depends on it.
-- So this is a pure schema rollback: no business/production data is
-- touched, and nothing here can silently discard real data. The two
-- assertions in the DO block below re-verify this at execution time and
-- abort (rolling back everything) if that's no longer true.
--
-- Restores the exact pre-migration bodies of every function this changed
-- (private.visit_belongs_to_current_technician, technician_today_visits,
-- technician_upcoming_visits, technician_visit_detail,
-- technician_needs_correction, technician_submit_report,
-- technician_resubmit_report) — copied verbatim from the live
-- pg_get_functiondef() output captured immediately before the original
-- migration was applied.

BEGIN;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM visit_technicians;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Aborting rollback: visit_technicians has % row(s) — stop and investigate before dropping it.', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM photos WHERE technician_id IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Aborting rollback: % photo(s) have a non-null technician_id — stop and investigate before dropping the column.', v_count;
  END IF;
END $$;

-- ---- 1. Restore the 7 functions the migration modified, to their exact
-- ---- pre-migration bodies. ----

CREATE OR REPLACE FUNCTION private.visit_belongs_to_current_technician(p_visit_id_text text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from visits v
    where v.id::text = p_visit_id_text
      and v.technician_id = private.current_technician_id()
  )
$function$;

CREATE OR REPLACE FUNCTION public.technician_today_visits()
 RETURNS TABLE(visit_id uuid, scheduled_date date, visit_status visit_status, job_id uuid, job_summary text, job_type text, building_name text, building_address text, building_postcode text, report_submitted boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode,
    exists (select 1 from reports r where r.visit_id = v.id)
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and v.technician_id = private.current_technician_id()
    and v.scheduled_date = current_date
    and v.status <> 'cancelled'
  order by v.created_at
$function$;

CREATE OR REPLACE FUNCTION public.technician_upcoming_visits()
 RETURNS TABLE(visit_id uuid, scheduled_date date, visit_status visit_status, job_id uuid, job_summary text, job_type text, building_name text, building_address text, building_postcode text, report_submitted boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_type::text,
    b.name, b.address, b.postcode,
    exists (select 1 from reports r where r.visit_id = v.id)
  from visits v
  join jobs j on j.id = v.job_id
  join buildings b on b.id = j.building_id
  where private.current_app_role() = 'technician'
    and v.technician_id = private.current_technician_id()
    and v.scheduled_date > current_date
    and v.status <> 'cancelled'
  order by v.scheduled_date asc, v.created_at asc
$function$;

CREATE OR REPLACE FUNCTION public.technician_visit_detail(p_visit_id uuid)
 RETURNS TABLE(visit_id uuid, scheduled_date date, visit_status visit_status, job_id uuid, job_summary text, job_type text, job_notes text, building_name text, building_address text, building_postcode text, site_instructions text, key_safe_code text, keyholder_name text, keyholder_phone text, parking_notes text, access_notes text, report_id uuid, report_review_status report_review_status, report_return_reason text, report_work_carried_out text, report_technician_notes text, report_issues text, report_photo_count integer, report_spec_met boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.technician_needs_correction()
 RETURNS TABLE(visit_id uuid, report_id uuid, scheduled_date date, job_id uuid, job_summary text, job_type text, building_name text, building_address text, building_postcode text, return_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.technician_submit_report(p_visit_id uuid, p_work_carried_out text, p_technician_notes text, p_issues text, p_on_site_start timestamp with time zone, p_on_site_end timestamp with time zone, p_photos jsonb, p_spec_met boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.technician_resubmit_report(p_report_id uuid, p_work_carried_out text, p_technician_notes text, p_issues text, p_additional_photos jsonb, p_spec_met boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- ---- 2. Drop the two new triggers + their trigger functions ----
DROP TRIGGER IF EXISTS prevent_inactive_technician_in_visit_technicians ON visit_technicians;
DROP TRIGGER IF EXISTS prevent_visit_technician_removal_after_report ON visit_technicians;
DROP FUNCTION IF EXISTS prevent_inactive_technician_in_visit_technicians();
DROP FUNCTION IF EXISTS prevent_visit_technician_removal_after_report();

-- ---- 3. Drop the join table (cascades its own RLS policy/indexes/constraints) ----
DROP TABLE IF EXISTS visit_technicians;

-- ---- 4. Drop the photo-attribution column (cascades its own index) ----
ALTER TABLE photos DROP COLUMN IF EXISTS technician_id;

COMMIT;
