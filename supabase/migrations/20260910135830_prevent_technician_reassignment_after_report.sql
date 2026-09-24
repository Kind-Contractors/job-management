-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation. This repo previously had no file for
-- this version at all.

-- Closes the architectural gap documented (but not previously enforced) in
-- 20260907210000_document_reassignment_ownership_gap.sql: that migration's
-- own comment says "today this is safe: no Manager UI reassigns an
-- already-created visit's technician" — that assumption is no longer true
-- now that VisitRow.tsx lets a manager reassign an existing visit's
-- technician_id directly. Every technician-facing RPC/Storage ownership
-- check (technician_visit_detail, technician_submit_report,
-- technician_own_visit_photos_select/insert) is CURRENT visits.technician_id
-- only, with no reassignment history — so reassigning a visit's technician
-- after a report has already been submitted for it would let the newly
-- assigned technician read the previous technician's already-submitted
-- report content and photos for that same visit.
--
-- This migration enforces, at the database level (so it cannot be bypassed
-- by calling supabase.from('visits').update(...) directly, only through
-- assignVisitTechnician()), that once a reports row exists for a visit
-- (reports.visit_id is UNIQUE — "a report has been submitted", regardless
-- of its current review_status), that visit's technician_id can no longer
-- be changed. A trigger, not a CHECK constraint, because the rule needs to
-- look up a sibling table (reports), which a CHECK constraint cannot do.
--
-- Deliberately narrow: fires only when technician_id is actually part of
-- the UPDATE's SET list (BEFORE UPDATE OF technician_id), and only blocks
-- when the value genuinely changes (IS DISTINCT FROM) — every other visits
-- write path (createVisit's INSERT, rescheduleVisit's scheduled_date-only
-- UPDATE, completeVisit/markVisitMissed/markVisitCancelled's status-only
-- UPDATEs) is completely unaffected. jobs.default_technician_id (a
-- different table, the job-level prefill for future bookings only) is also
-- entirely unaffected.

create or replace function public.prevent_technician_reassignment_after_report()
returns trigger
language plpgsql
set search_path = 'public'
as $$
begin
  if new.technician_id is distinct from old.technician_id
     and exists (select 1 from public.reports where visit_id = old.id)
  then
    raise exception
      'Cannot change the technician for this visit: a report has already been submitted for it.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.prevent_technician_reassignment_after_report() is
  'Server-side enforcement (not just a UI disable) of the boundary described '
  'in 20260907210000_document_reassignment_ownership_gap.sql: once a report '
  'exists for a visit, its technician_id can no longer change, because every '
  'technician-facing RPC/Storage ownership check is CURRENT technician_id '
  'only and has no reassignment history.';

drop trigger if exists prevent_technician_reassignment_after_report on public.visits;
create trigger prevent_technician_reassignment_after_report
  before update of technician_id on public.visits
  for each row
  execute function public.prevent_technician_reassignment_after_report();
