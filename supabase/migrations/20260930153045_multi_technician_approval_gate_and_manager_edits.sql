-- Multi-technician refinements (database layer only):
--  1. Approval gate: a contribution-mode report cannot be approved until EVERY
--     technician currently assigned to its visit (primary + visit_technicians)
--     has a valid submitted contribution or has been waived by a manager.
--  2. Manager-edited combined text is no longer silently overwritten by a
--     technician's later submission/resubmission.
-- All signatures are unchanged. Reports with no contribution rows (every
-- ordinary single-technician report, and any pre-existing report) are
-- unaffected by both changes.

-- 1. Manager-edit marker. Set automatically when a manager changes the
--    combined text of a report that has contributions; cleared by
--    manager_reset_combined_report(). Null everywhere else.
alter table public.reports add column manager_edited_at timestamptz;

comment on column public.reports.manager_edited_at is
  'Set when a manager hand-edits the combined text (work/notes/issues) of a report that has technician contributions. While set, technician submissions no longer overwrite that text; contributions submitted after this time are visible via report_contributions.submitted_at. Cleared by manager_reset_combined_report().';

create function public.mark_report_manager_edit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- The recompose step sets this for its own updates so they are never mistaken for a manager edit.
  if coalesce(current_setting('app.report_recompose', true), '') = 'on' then
    return new;
  end if;

  if private.current_app_role() = 'manager'
     and (
       new.work_carried_out is distinct from old.work_carried_out
       or new.technician_notes is distinct from old.technician_notes
       or new.issues is distinct from old.issues
     )
     and exists (select 1 from public.report_contributions where report_id = new.id)
  then
    new.manager_edited_at := now();
  end if;

  return new;
end;
$$;

revoke execute on function public.mark_report_manager_edit() from public, anon, authenticated;

create trigger mark_report_manager_edit
  before update of work_carried_out, technician_notes, issues on public.reports
  for each row execute function public.mark_report_manager_edit();

-- Recompose now leaves the three text fields alone once a manager has edited
-- them; everything else (spec, on-site times, names) is still derived.
create or replace function private.recompose_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count int;
  v_work text;
  v_notes text;
  v_issues text;
  v_spec boolean;
  v_start timestamptz;
  v_end timestamptz;
  v_by text;
  v_locked boolean;
begin
  select
    count(*),
    string_agg(case when btrim(rc.work_carried_out) <> '' then rc.work_carried_out end, E'\n\n' order by rc.created_at, rc.id),
    string_agg(case when btrim(rc.technician_notes) <> '' then rc.technician_notes end, E'\n\n' order by rc.created_at, rc.id),
    string_agg(case when btrim(rc.issues) <> '' then rc.issues end, E'\n\n' order by rc.created_at, rc.id),
    bool_and(rc.spec_met),
    min(rc.on_site_start),
    max(rc.on_site_end),
    string_agg(t.name, ', ' order by rc.created_at, rc.id)
  into v_count, v_work, v_notes, v_issues, v_spec, v_start, v_end, v_by
  from report_contributions rc
  join technicians t on t.id = rc.technician_id
  where rc.report_id = p_report_id and rc.submitted_at is not null;

  if v_count = 0 then
    return;
  end if;

  select manager_edited_at is not null into v_locked from reports where id = p_report_id;

  perform set_config('app.report_recompose', 'on', true);
  update reports set
    work_carried_out = case when v_locked then work_carried_out else v_work end,
    technician_notes = case when v_locked then technician_notes else v_notes end,
    issues = case when v_locked then issues else v_issues end,
    spec_met = v_spec,
    on_site_start = v_start,
    on_site_end = v_end,
    submitted_by = v_by
  where id = p_report_id;
  perform set_config('app.report_recompose', '', true);
end;
$$;

-- Manager action: drop the manual edit and rebuild the combined text from the
-- contributions (e.g. to pick up contributions submitted after the edit).
create function public.manager_reset_combined_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.';
  end if;

  if not exists (select 1 from report_contributions where report_id = p_report_id) then
    raise exception 'This report has no technician contributions to combine.';
  end if;

  update reports set manager_edited_at = null where id = p_report_id;
  perform private.recompose_report(p_report_id);
end;
$$;

revoke execute on function public.manager_reset_combined_report(uuid) from public, anon;
grant execute on function public.manager_reset_combined_report(uuid) to authenticated, service_role;

-- 2. Approval gate. Replaces the review-transition check: same flagged-
--    contribution guard and same whole-report-return fan-out as before, plus
--    the assigned-technician gate. Dynamic: the required set is whoever is
--    assigned to the visit right now, however many that is.
create or replace function public.check_report_review_transition()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_pending int;
  v_names text;
begin
  if new.review_status is distinct from old.review_status then
    if new.review_status = 'approved' then
      if exists (select 1 from report_contributions where report_id = new.id and needs_correction) then
        raise exception 'Cannot approve this report: one or more technician contributions are awaiting correction.'
          using errcode = 'P0001';
      end if;

      -- Only reports that have contributions are gated; an ordinary
      -- single-technician report (or one from before contributions) has none.
      if exists (select 1 from report_contributions where report_id = new.id) then
        select count(*), string_agg(t.name, ', ' order by t.name)
        into v_pending, v_names
        from (
          select v.technician_id as technician_id from visits v
          where v.id = new.visit_id and v.technician_id is not null
          union
          select vt.technician_id from visit_technicians vt where vt.visit_id = new.visit_id
        ) assigned
        join technicians t on t.id = assigned.technician_id
        where not exists (
          select 1 from report_contributions rc
          where rc.report_id = new.id
            and rc.technician_id = assigned.technician_id
            and ((rc.submitted_at is not null and not rc.needs_correction) or rc.waived_at is not null)
        );

        if v_pending > 0 then
          raise exception 'Cannot approve this report yet: % assigned technician(s) have not submitted or been waived (%).', v_pending, v_names
            using errcode = 'P0001';
        end if;
      end if;
    end if;

    if new.review_status = 'returned_for_correction'
       and exists (select 1 from report_contributions where report_id = new.id and submitted_at is not null)
       and not exists (select 1 from report_contributions where report_id = new.id and needs_correction)
    then
      update report_contributions
      set needs_correction = true, correction_reason = new.return_reason
      where report_id = new.id and submitted_at is not null;
    end if;
  end if;
  return null;
end;
$$;
