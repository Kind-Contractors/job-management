-- "Completed": the manager's explicit "this report is fully dealt with" marker, independent of HOW the
-- report reached the client. A report can be downloaded and sent by hand, or emailed through the system, or
-- both - the manager marks it Completed when he considers the whole job finished, and it then leaves the
-- Ready for client queue. This replaces "sent_to_client_at is empty" as the thing that keeps a report in that
-- queue; sent_to_client_at / report_client_sends keep meaning "emailed through our system" and are not changed.
--
-- Purely additive: two nullable columns, two checks, one one-time backfill. No existing column, trigger, policy
-- or function is changed. Manager-only access already covers the new columns (manager_full_access on reports);
-- technicians have no table access and none of the technician functions read these columns.
alter table public.reports
  add column completed_at timestamptz,
  add column completed_by text;

comment on column public.reports.completed_at is
  'When a manager marked this report Completed (the whole report workflow is finished, however it was delivered - emailed through the system, downloaded and sent by hand, or both). Null = not completed. Independent of sent_to_client_at. Cleared by Reopen. Only an approved report can be completed.';
comment on column public.reports.completed_by is
  'Who marked the report Completed (the signed-in manager''s email). Set and cleared together with completed_at.';

-- completed_at / completed_by are always set or cleared together (same pattern as reviewed_* and sent_*).
alter table public.reports
  add constraint reports_completed_pair_check
  check ((completed_by is null) = (completed_at is null));

-- Only an approved report can be completed (same rule the database already enforces for sending). The one
-- consequence: a completed report cannot be returned for correction until it is reopened first.
alter table public.reports
  add constraint reports_completion_requires_approval_check
  check (completed_at is null or review_status = 'approved');

-- One-time backfill: a report already emailed through the system before this existed is, by definition, dealt
-- with, so it is marked Completed at the moment it was sent (otherwise every previously sent report would
-- re-appear in the Ready for client queue). Uses only values already on the row; creates no audit events
-- (nothing is invented). Reports that were never emailed are untouched and stay in the queue until a manager
-- completes them. Idempotent: it only touches rows that are not yet completed.
update public.reports
set completed_at = sent_to_client_at,
    completed_by = sent_to_client_by
where sent_to_client_at is not null
  and completed_at is null;
