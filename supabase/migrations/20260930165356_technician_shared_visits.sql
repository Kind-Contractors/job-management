-- Lets a technician's app know which of THEIR OWN visits are shared with other
-- technicians, so it can show "Shared report - N technicians" and stop treating
-- a visit completed by a colleague's submission as finished for someone who has
-- not yet submitted their own part.
--
-- Read-only and additive: no existing function, table or policy is changed.
-- Deliberately returns only the visit id and the number of assigned technicians
-- (primary + additional, however many) - never colleague names, and never
-- whether any colleague has submitted, is waived or needs correction.
create function public.technician_shared_visits()
returns table(visit_id uuid, assigned_count integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  select v.id, n.c
  from visits v
  cross join lateral (
    select count(*)::int as c
    from (
      select v.technician_id as technician_id where v.technician_id is not null
      union
      select vt.technician_id from visit_technicians vt where vt.visit_id = v.id
    ) assigned
  ) n
  where private.current_app_role() = 'technician'
    and private.is_visit_participant(v.id, private.current_technician_id())
    and v.status <> 'cancelled'
    and n.c > 1
$$;

revoke execute on function public.technician_shared_visits() from public, anon;
grant execute on function public.technician_shared_visits() to authenticated, service_role;
