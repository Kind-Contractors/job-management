-- ROLLBACK of supabase/migrations/20261124100000_manager_office_reports.sql - run BY HAND, as ONE transaction, never by a tool.
--
-- Removes the office-report function and the reports.source marker (and its trigger). Reports, visits and photos written with the
-- feature are KEPT (they are ordinary reports/visits); only the "written by the office" marker on them is lost. Remove the app's
-- "Complete & write report" / "Record work already done" actions first, then run this, then:
--   supabase migration repair --status reverted 20261124100000
begin;

drop function if exists public.manager_complete_visit_with_report(uuid, uuid, date, timestamptz, numeric, text, text, text, boolean, timestamptz, timestamptz);
drop trigger if exists reports_set_source on public.reports;
drop function if exists public.reports_set_source();
alter table public.reports drop constraint if exists reports_source_check;
alter table public.reports drop column if exists source;

commit;
