-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation. This repo previously had no file for
-- this version at all.

-- Closes the gap found in the final readiness audit: Week/Day drag-and-drop
-- in ScheduleTechnicianGrid.tsx renders every technician as a droppable row
-- (never filtered to is_active), unlike every other technician <select> in
-- the app (ScheduleDayDrawer, MonthGrid's confirm step, VisitRow,
-- JobInspectorDrawer), which already list active technicians only.
--
-- Enforced here — at the shared visits.technician_id write boundary — rather
-- than as three separate UI-only checks, since createVisit() (INSERT) and
-- assignVisitTechnician() (UPDATE) in techniciansRepository.ts are the only
-- two places anything ever writes that column, from any calling UI (Day
-- drawer, Week/Day drag-drop, Month drag-drop-confirm, VisitRow's
-- reassignment select). A CHECK constraint can't do this (it would need to
-- look up a sibling table, technicians.is_active), so this is a trigger,
-- same pattern as prevent_technician_reassignment_after_report.
--
-- Deliberately narrow: only fires when technician_id is actually part of
-- the write (INSERT, or UPDATE OF technician_id), and only blocks when the
-- value is genuinely changing to a new, currently-inactive technician.
-- Does NOT touch existing visits at all when a technician is later
-- deactivated (public.technicians.is_active is a different table/trigger
-- entirely — setTechnicianActive() never writes to visits, so a visit
-- already assigned to a technician who later becomes inactive is never
-- retroactively touched).

create or replace function public.prevent_visit_assignment_to_inactive_technician()
returns trigger
language plpgsql
set search_path = 'public'
as $$
declare
  v_is_active boolean;
begin
  if new.technician_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.technician_id is not distinct from old.technician_id then
    return new;
  end if;

  select is_active into v_is_active from public.technicians where id = new.technician_id;

  if v_is_active is not true then
    raise exception
      'Cannot assign this visit to an inactive technician.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.prevent_visit_assignment_to_inactive_technician() is
  'Server-side enforcement (not just a UI filter) that a visit can only ever '
  'be newly assigned to an active technician — createVisit() and '
  'assignVisitTechnician() in techniciansRepository.ts are the only two '
  'writers of visits.technician_id. Never touches existing visits when a '
  'technician is later deactivated (that only updates public.technicians).';

drop trigger if exists prevent_visit_assignment_to_inactive_technician on public.visits;
create trigger prevent_visit_assignment_to_inactive_technician
  before insert or update of technician_id on public.visits
  for each row
  execute function public.prevent_visit_assignment_to_inactive_technician();
