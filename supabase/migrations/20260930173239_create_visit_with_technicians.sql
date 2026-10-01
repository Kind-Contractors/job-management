-- Books a visit and assigns all of its technicians in ONE transaction: the primary
-- (visits.technician_id) plus any number of additional technicians
-- (visit_technicians). If any step fails - including the existing
-- inactive-technician and duplicate guards - nothing is created.
--
-- SECURITY INVOKER (same pattern as create_client_and_building): every insert
-- runs under the caller's own row-level security, so only a manager can use it
-- and every existing trigger/constraint still applies unchanged.
--
-- jobs.default_technician_id is never read or written here.
create function public.create_visit_with_technicians(
  p_job_id uuid,
  p_technician_id uuid,
  p_scheduled_date date,
  p_additional_technician_ids uuid[] default '{}'
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_visit_id uuid;
  v_extras uuid[];
begin
  select coalesce(array_agg(distinct t), '{}')
  into v_extras
  from unnest(coalesce(p_additional_technician_ids, '{}')) as t
  where t is not null;

  if cardinality(v_extras) > 0 and p_technician_id is null then
    raise exception 'Choose a primary technician before adding additional technicians.' using errcode = 'P0001';
  end if;

  if p_technician_id is not null and p_technician_id = any(v_extras) then
    raise exception 'The primary technician cannot also be an additional technician.' using errcode = 'P0001';
  end if;

  insert into visits (job_id, technician_id, scheduled_date, status)
  values (p_job_id, p_technician_id, p_scheduled_date, 'booked')
  returning id into v_visit_id;

  if cardinality(v_extras) > 0 then
    insert into visit_technicians (visit_id, technician_id)
    select v_visit_id, t from unnest(v_extras) as t;
  end if;

  return v_visit_id;
end;
$$;

revoke execute on function public.create_visit_with_technicians(uuid, uuid, date, uuid[]) from public, anon;
grant execute on function public.create_visit_with_technicians(uuid, uuid, date, uuid[]) to authenticated, service_role;
