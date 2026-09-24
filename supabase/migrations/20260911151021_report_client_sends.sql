-- Send history for the "Ready for Client" workflow (Phase 2B). One row
-- per send ATTEMPT (success or failure) — reports.sent_to_client_at/_by
-- (existing columns) remain the "last successful send" convenience pair,
-- updated only when an attempt here actually succeeds; this table is the
-- full history neither of those two columns can represent on their own.
--
-- Applied directly via the Supabase MCP (version 20260911151021); this
-- file mirrors that applied migration for the repo's own history.
create table public.report_client_sends (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  recipient_contact_id uuid references public.contacts(id),
  recipient_email text not null,
  sent_by text not null,
  status text not null check (status in ('sending', 'sent', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.report_client_sends is
  'One row per attempt to email a report''s client-facing summary to a '
  'contact (see supabase/functions/send-client-report). Never deleted on '
  'failure -- a failed attempt stays visible as history, and the report '
  'remains available for retry.';

create index report_client_sends_report_id_idx on public.report_client_sends (report_id);

alter table public.report_client_sends enable row level security;

-- Same shape as the existing manager_full_access policy already used on
-- reports/invoices/contacts -- managers only, via the same
-- private.current_app_role() check, no new privilege model introduced.
create policy manager_full_access on public.report_client_sends
  for all
  using (private.current_app_role() = 'manager')
  with check (private.current_app_role() = 'manager');
