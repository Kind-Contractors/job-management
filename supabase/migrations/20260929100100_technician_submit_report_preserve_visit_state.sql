-- Makes technician_submit_report() safe for late submissions (e.g. a
-- report uploaded the day after the visit, or on an older visit opened from
-- the technician app's new Past list).
--
-- The ONLY change from the previous definition
-- (20260910083937_report_spec_met.sql): the fixed-price auto-complete
-- UPDATE at the end now carries `and status in ('due', 'booked')`.
-- Previously it ran unconditionally for every fixed-price visit, which for
-- a visit that was NOT still due/booked meant:
--   * completed  -> price_charged and completed_at were silently overwritten
--                   with the job's CURRENT price and the technician's
--                   device time, even if the manager had already completed
--                   it (possibly at a different amount) or it was already
--                   invoiced — price_charged feeds invoice line amounts
--                   (visit.priceCharged ?? job.pricePerVisit).
--   * missed     -> silently flipped to completed and billable, with no
--                   manager UI to reverse it (Mark complete is only offered
--                   for due/booked visits).
--   * cancelled  -> silently un-cancelled to completed.
-- Now a due/booked visit auto-completes exactly as before (same-day and
-- next-day submissions are unchanged); a completed/missed/cancelled visit
-- keeps its status, price and completion time untouched — the report is
-- still recorded and goes through the normal manager review, and the
-- office decides what, if anything, to change on the visit itself.
--
-- Signature, ownership checks, validation, photo checks, report/photo/
-- activity inserts and grants are all unchanged (CREATE OR REPLACE keeps
-- the existing privileges). Variable-price behaviour is unchanged: the
-- visit is never auto-completed for those, before or after.

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
    where id = p_visit_id and status in ('due', 'booked');
  end if;

  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  values ('report', v_report_id, 'report_submitted', v_technician_name, now());

  return v_report_id;
end;
$$;
