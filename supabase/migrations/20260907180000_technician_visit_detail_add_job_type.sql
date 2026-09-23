-- Extends technician_visit_detail() to also return the existing jobs.job_type
-- value (cast to text), so the Job File's header is consistent with the Day
-- View's meta line for the same job. No new field, mapping, or "division"
-- concept — the raw DB value only, same treatment as
-- technician_today_visits()'s own job_type addition.

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
  report_issues text
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
    r.id, r.review_status, r.return_reason, r.work_carried_out, r.technician_notes, r.issues
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
