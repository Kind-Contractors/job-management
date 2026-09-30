-- Additional technicians per visit (proof of concept, multi-technician visits).
--
-- A visit's participants = visits.technician_id (the primary, unchanged) plus
-- every row here. This table holds ONLY the extra technicians; a visit with no
-- rows here behaves exactly as before.
--
-- Deliberately NOT a composite-primary-key junction (visit_id, technician_id):
-- an earlier attempt used one and PostgREST then saw an implicit many-to-many
-- bridge between visits and technicians, making every visits(...technicians(...))
-- embed ambiguous (PGRST201). A surrogate id primary key plus a separate unique
-- constraint gives the same "no duplicate assignment" guarantee.
create table public.visit_technicians (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.visits (id) on delete restrict,
  technician_id uuid not null references public.technicians (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint visit_technicians_visit_technician_key unique (visit_id, technician_id)
);

-- visit_id lookups are covered by the unique constraint's leading column.
create index visit_technicians_technician_id_idx on public.visit_technicians (technician_id);

comment on table public.visit_technicians is
  'Extra technicians on a visit, beyond visits.technician_id (the primary). Manager-managed; technicians never read or write this table directly.';

-- Same security shape as every other business table: manager-only via RLS.
-- No technician-facing policy; technician access will go through SECURITY
-- DEFINER functions, as for visits/reports/photos.
alter table public.visit_technicians enable row level security;

create policy manager_full_access on public.visit_technicians
  for all
  using (private.current_app_role() = 'manager')
  with check (private.current_app_role() = 'manager');

-- Mirrors prevent_visit_assignment_to_inactive_technician on visits.
create function public.prevent_inactive_technician_in_visit_technicians()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_is_active boolean;
begin
  if tg_op = 'UPDATE' and new.technician_id is not distinct from old.technician_id then
    return new;
  end if;

  select is_active into v_is_active from public.technicians where id = new.technician_id;

  if v_is_active is not true then
    raise exception 'Cannot assign this visit to an inactive technician.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Trigger functions never need to be callable through the API.
revoke execute on function public.prevent_inactive_technician_in_visit_technicians() from public, anon, authenticated;

create trigger prevent_inactive_technician_in_visit_technicians
  before insert or update of technician_id on public.visit_technicians
  for each row execute function public.prevent_inactive_technician_in_visit_technicians();
