-- Per-technician contributions to a visit's single combined report
-- (multi-technician visits, database layer only).
--
-- reports keeps exactly one row per visit (reports.visit_id is UNIQUE) and
-- stays the authoritative combined report the manager reviews and the client
-- PDF reads. This table records WHO contributed WHAT to it, so each
-- technician's work is attributable, correctable on its own, and never
-- editable by anyone else. A visit with no rows here (every existing report)
-- behaves exactly as before.
--
-- A row is either a SUBMITTED contribution or a WAIVER (the office decided a
-- technician who never submitted no longer blocks the report). The report's
-- visit is not duplicated here: reports.visit_id already identifies it.
--
-- Access model matches visits/reports/photos: manager-only RLS, and NO
-- technician-facing policy. Technician reads/writes will go through SECURITY
-- DEFINER functions (a later step) so every lifecycle rule lives in one place
-- and a technician can never write this table directly.
create table public.report_contributions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete restrict,
  technician_id uuid not null references public.technicians (id) on delete restrict,

  work_carried_out text,
  technician_notes text,
  issues text,
  spec_met boolean not null default true,
  on_site_start timestamptz,
  on_site_end timestamptz,
  submitted_at timestamptz,

  needs_correction boolean not null default false,
  correction_reason text,

  waived_at timestamptz,
  waived_by text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One contribution (or waiver) per technician per report.
  constraint report_contributions_report_technician_key unique (report_id, technician_id),

  -- Exactly one of: submitted, or waived.
  constraint report_contributions_submitted_xor_waived_check
    check ((submitted_at is null) <> (waived_at is null)),
  constraint report_contributions_waived_pair_check
    check ((waived_at is null) = (waived_by is null)),
  constraint report_contributions_waived_has_no_content_check
    check (waived_at is null or (work_carried_out is null and technician_notes is null and issues is null)),

  -- A submitted contribution always records arrival and departure (the
  -- technician RPC requires them for every report today).
  constraint report_contributions_submitted_times_check
    check (submitted_at is null or (on_site_start is not null and on_site_end is not null)),
  constraint report_contributions_time_order_check
    check (on_site_start is null or on_site_end is null or on_site_end >= on_site_start),

  -- Mirrors reports_return_reason_check: a correction must say why, and only a
  -- submitted contribution can be sent back for correction.
  constraint report_contributions_correction_reason_check
    check (not needs_correction or correction_reason is not null),
  constraint report_contributions_correction_only_when_submitted_check
    check (not needs_correction or submitted_at is not null)
);

-- report_id lookups are covered by the unique constraint's leading column.
create index report_contributions_technician_id_idx on public.report_contributions (technician_id);

comment on table public.report_contributions is
  'One row per technician per visit report: their own submitted work, or an office waiver. The combined report stays on reports (one row per visit). Manager-only RLS; technician access is via SECURITY DEFINER functions only.';

alter table public.report_contributions enable row level security;

create policy manager_full_access on public.report_contributions
  for all
  using (private.current_app_role() = 'manager')
  with check (private.current_app_role() = 'manager');

create trigger jms_set_updated_at
  before update on public.report_contributions
  for each row execute function public.jms_set_updated_at();

-- Integrity that holds no matter who writes the row (manager, service role, or
-- a future SECURITY DEFINER function): a contribution must belong to a
-- technician assigned to the report's visit, and can never be moved to another
-- report or technician. SECURITY DEFINER so the check does not depend on the
-- caller's own RLS visibility of reports/visits/visit_technicians.
create function public.check_report_contribution_integrity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_visit_id uuid;
  v_primary uuid;
begin
  if tg_op = 'UPDATE' then
    if new.report_id is distinct from old.report_id or new.technician_id is distinct from old.technician_id then
      raise exception 'A contribution cannot be moved to a different report or technician.' using errcode = 'P0001';
    end if;
    return new;
  end if;

  select v.id, v.technician_id into v_visit_id, v_primary
  from public.reports r
  join public.visits v on v.id = r.visit_id
  where r.id = new.report_id;

  if v_visit_id is null then
    raise exception 'Report not found.' using errcode = 'P0001';
  end if;

  if new.technician_id is distinct from v_primary
     and not exists (
       select 1 from public.visit_technicians vt
       where vt.visit_id = v_visit_id and vt.technician_id = new.technician_id
     )
  then
    raise exception 'This technician is not assigned to the visit for this report.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.check_report_contribution_integrity() from public, anon, authenticated;

create trigger check_report_contribution_integrity
  before insert or update of report_id, technician_id on public.report_contributions
  for each row execute function public.check_report_contribution_integrity();

-- Mirrors prevent_technician_reassignment_after_report: once a technician has
-- contributed (or been waived), they cannot be removed from the visit, which
-- would strand that attribution.
create function public.prevent_visit_technician_removal_after_contribution()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if exists (
    select 1
    from public.report_contributions rc
    join public.reports r on r.id = rc.report_id
    where r.visit_id = old.visit_id and rc.technician_id = old.technician_id
  ) then
    raise exception 'Cannot remove this technician from the visit: they have already contributed to its report.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.prevent_visit_technician_removal_after_contribution() from public, anon, authenticated;

create trigger prevent_visit_technician_removal_after_contribution
  before delete or update of visit_id, technician_id on public.visit_technicians
  for each row execute function public.prevent_visit_technician_removal_after_contribution();
