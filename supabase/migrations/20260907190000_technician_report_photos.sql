-- Phase 3: Job Report + Photos + Technician Completion.
--
-- Adds: a private Storage bucket + technician/manager policies; a
-- report_submitted flag on technician_today_visits() (technician-facing
-- presentation only — does not change visit completion semantics); and the
-- one write RPC a technician ever gets, technician_submit_report(), which
-- performs every check server-side (ownership, no double-submit, required
-- timestamps with end >= start, at least one real, visit-owned photo) and
-- preserves the established fixed/variable-price completion split exactly.

-- 1. Storage bucket (private — not readable via a public URL)
insert into storage.buckets (id, name, public)
values ('visit-photos', 'visit-photos', false)
on conflict (id) do nothing;

-- 2. Storage policies — path convention {visit_id}/{phase}/{filename}
create policy technician_own_visit_photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'visit-photos'
    and private.current_app_role() = 'technician'
    and exists (
      select 1 from visits v
      where v.id::text = (storage.foldername(name))[1]
        and v.technician_id = private.current_technician_id()
    )
  );

create policy technician_own_visit_photos_select on storage.objects for select to authenticated
  using (
    bucket_id = 'visit-photos'
    and private.current_app_role() = 'technician'
    and exists (
      select 1 from visits v
      where v.id::text = (storage.foldername(name))[1]
        and v.technician_id = private.current_technician_id()
    )
  );

create policy manager_visit_photos_all on storage.objects for all to authenticated
  using (bucket_id = 'visit-photos' and private.current_app_role() = 'manager')
  with check (bucket_id = 'visit-photos' and private.current_app_role() = 'manager');

-- 3. technician_today_visits() extended with report_submitted — a
-- technician-facing presentation flag only (Day View's done/next-stop
-- logic). Does not read or imply anything about visits.status itself.
drop function if exists public.technician_today_visits();

create function public.technician_today_visits()
returns table (
  visit_id uuid,
  scheduled_date date,
  visit_status visit_status,
  job_id uuid,
  job_summary text,
  job_type text,
  building_name text,
  building_address text,
  building_postcode text,
  report_submitted boolean
)
language sql
stable
security definer
set search_path = public
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
    and v.technician_id = private.current_technician_id()
    and v.scheduled_date = current_date
    and v.status <> 'cancelled'
  order by v.created_at
$$;

revoke all on function public.technician_today_visits() from public;
grant execute on function public.technician_today_visits() to authenticated;
revoke execute on function public.technician_today_visits() from anon;

-- 4. The one write RPC: first (and only, this phase) report submission.
create or replace function public.technician_submit_report(
  p_visit_id uuid,
  p_work_carried_out text,
  p_technician_notes text,
  p_issues text,
  p_on_site_start timestamptz,
  p_on_site_end timestamptz,
  p_photos jsonb  -- [{ "storage_path": text, "phase": "before"|"during"|"after" }, ...]
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
  -- Authorization first, before anything else can be inferred from the request.
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

  -- Timestamps: both required, server never trusts a claimed submitted_at.
  if p_on_site_start is null or p_on_site_end is null then
    raise exception 'Arrival and departure times are required.';
  end if;
  if p_on_site_end < p_on_site_start then
    raise exception 'Departure time cannot be before arrival time.';
  end if;

  -- Photos: at least one, each structurally valid, each verified against
  -- the actual uploaded object for THIS visit specifically.
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
    work_carried_out, technician_notes, issues,
    include_photos, include_notes, include_issues, include_price
  ) values (
    p_visit_id, v_technician_name, now(), p_on_site_start, p_on_site_end,
    p_work_carried_out, p_technician_notes, p_issues,
    true, true, true, false
  ) returning id into v_report_id;

  insert into photos (report_id, phase, storage_path, upload_status, uploaded_at)
  select v_report_id, (p->>'phase')::photo_phase, p->>'storage_path', 'uploaded', now()
  from jsonb_array_elements(p_photos) p;

  -- Preserves the established split exactly: fixed-price completes the
  -- visit server-side using the job's own stored price (never disclosed to
  -- the technician); variable-price leaves the visit untouched for the
  -- office to complete later via the existing, unmodified completeVisit().
  if v_pricing_type = 'fixed' then
    update visits set status = 'completed', price_charged = v_price_per_visit, completed_at = p_on_site_end
    where id = p_visit_id;
  end if;

  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  values ('report', v_report_id, 'report_submitted', v_technician_name, now());

  return v_report_id;
end;
$$;

revoke all on function public.technician_submit_report(uuid, text, text, text, timestamptz, timestamptz, jsonb) from public;
grant execute on function public.technician_submit_report(uuid, text, text, text, timestamptz, timestamptz, jsonb) to authenticated;
revoke execute on function public.technician_submit_report(uuid, text, text, text, timestamptz, timestamptz, jsonb) from anon;
