-- Rollback of 20261126100000_invoices_invoiced_manually.sql.
-- Refuses while any invoice is in the 'invoiced_manually' status: those rows are real records of work invoiced by hand, and the
-- old status check can't hold them. Decide what to do with them first (nothing here deletes or rewrites them).

do $$
begin
  if exists (select 1 from public.invoices where status = 'invoiced_manually') then
    raise exception 'Rollback refused: % invoice(s) are marked as already invoiced (status invoiced_manually).',
      (select count(*) from public.invoices where status = 'invoiced_manually');
  end if;
end $$;

drop function if exists public.manager_mark_visits_invoiced_manually(uuid[]);

drop trigger if exists invoices_invoiced_manually_final on public.invoices;
drop function if exists private.invoices_invoiced_manually_final();

alter table public.invoices drop constraint if exists invoices_invoiced_manually_marked;
alter table public.invoices drop constraint if exists invoices_marked_invoiced_pair;
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft', 'sending', 'sent', 'failed', 'in_xero_not_emailed'));
alter table public.invoices drop column if exists marked_invoiced_at;
alter table public.invoices drop column if exists marked_invoiced_by;

comment on column public.invoices.status is 'Local lifecycle: draft -> sending -> sent (created in Xero and emailed) | in_xero_not_emailed (created in Xero, not emailed because invoice emailing was off) | failed (retryable).';

-- As defined by 20261018090000_invoice_status_in_xero_not_emailed.sql.
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
