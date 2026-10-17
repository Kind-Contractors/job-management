-- A status for an invoice that was created (and authorised) in Xero but NOT emailed by the app, because invoice emailing
-- (XERO_SENDING_ENABLED) is off while creation (XERO_CREATION_ENABLED) is on. 'sent' keeps meaning "created in Xero AND
-- emailed"; an invoice is never recorded as sent when no email went out.
--
-- NOT APPLIED to any database when written. Apply to DEV first, and only after review. Must be applied BEFORE the
-- xero-create-invoice version that writes this status is deployed.
-- Additive: one more allowed value in the existing status check, and one read-only function taught that the new status
-- also means "the accounts work is done" (the invoice is in Xero). No existing row changes.

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft', 'sending', 'sent', 'failed', 'in_xero_not_emailed'));

comment on column public.invoices.status is 'Local lifecycle: draft -> sending -> sent (created in Xero and emailed) | in_xero_not_emailed (created in Xero, not emailed because invoice emailing was off) | failed (retryable).';

create or replace function public.jobs_with_open_report_work()
returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  select distinct j.id
  from jobs j
  join visits v on v.job_id = j.id
  join reports r on r.visit_id = v.id
  where private.current_app_role() = 'manager'
    and j.lifecycle_status <> 'active'
    and (
      r.review_status in ('awaiting_review', 'returned_for_correction')
      or (
        r.review_status = 'approved'
        and (
          r.completed_at is null
          or not exists (
            select 1 from invoice_line_items li join invoices i on i.id = li.invoice_id
            where li.visit_id = v.id and i.status in ('sent', 'in_xero_not_emailed')
          )
        )
      )
    )
$$;

comment on function public.jobs_with_open_report_work() is
  'Ids of non-active jobs that still have report or accounting work a manager must act on (awaiting review, returned, approved and not completed, or approved with no invoice in Xero yet). Manager-only; read-only.';
