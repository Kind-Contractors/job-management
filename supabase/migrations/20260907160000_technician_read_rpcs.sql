-- Phase 1 of the Technician View: auth/data boundary only (read-only).
--
-- No RLS policy is added to any table. Access is enforced entirely inside
-- these SECURITY DEFINER functions: each independently checks the caller is
-- a technician (private.current_app_role() = 'technician') and resolves
-- exactly one technician identity (private.current_technician_id(), via the
-- existing technicians.app_user_id link), then returns only that
-- technician's own rows and only technician-safe columns — never pricing,
-- never client/billing identity, never invoice/Xero data, never another
-- technician's data, never Manager-only report fields (reviewed_by, sent_*).
--
-- A caller who is not a linked technician (including the manager) gets zero
-- rows back from either function, silently — the same behavior every other
-- role already gets from manager_full_access today.

create or replace function private.current_technician_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.technicians where app_user_id = auth.uid()
$$;

create or replace function public.technician_today_visits()
returns table (
  visit_id uuid,
  scheduled_date date,
  visit_status visit_status,
  job_id uuid,
  job_summary text,
  building_name text,
  building_address text,
  building_postcode text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id, v.scheduled_date, v.status,
    j.id, coalesce(j.job_summary, j.job_notes, '—'),
    b.name, b.address, b.postcode
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

create or replace function public.technician_visit_detail(p_visit_id uuid)
returns table (
  visit_id uuid,
  scheduled_date date,
  visit_status visit_status,
  job_id uuid,
  job_summary text,
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
    j.id, coalesce(j.job_summary, j.job_notes, '—'), j.job_notes,
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
