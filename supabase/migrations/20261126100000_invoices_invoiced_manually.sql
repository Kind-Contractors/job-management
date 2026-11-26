-- "Mark as already invoiced": work that Luke has ALREADY invoiced by hand in Xero is recorded as invoiced in JMS, so it moves
-- from Ready for accounts to Records - without JMS creating, updating or emailing anything in Xero.
--
-- NOT APPLIED to any database when written. Apply to DEV first, and only after review; PROD only with explicit approval, before
-- the frontend that offers the action is deployed. Rollback: supabase/rollbacks/20261126100000_invoices_invoiced_manually.rollback.sql
--
-- What it adds (no existing row changes):
--   1. invoices.status 'invoiced_manually' - a final status: the accounts handoff is done, outside JMS. It is NOT a Xero status:
--      no xero_invoice_id / number / contact / sent_at is ever invented for it. (A draft or failed invoice that JMS had already
--      created in Xero keeps the Xero id it really has.)
--   2. invoices.marked_invoiced_by / marked_invoiced_at - who marked it and when; present exactly when the status is set.
--   3. A guard that makes the status final (it can't be changed or unmarked afterwards).
--   4. jobs_with_open_report_work() treats it as done, like 'sent' / 'in_xero_not_emailed' (closed jobs' accounts work).
--   5. manager_mark_visits_invoiced_manually(visit_ids): the ONLY intended way in. One transaction, all-or-nothing, manager-only,
--      selected visits locked first (two managers marking the same work can't both succeed). Per visit: an existing draft or
--      failed invoice is marked; with no invoice, an invoice record is created for it in this status (one per visit, same line
--      the "Create invoice" draft would have). Anything sending / already in Xero / already marked is refused, as is a visit
--      whose report isn't approved or that isn't completed, and an invoice that also covers visits that weren't selected.
--      One activity event per visit records that it was marked by hand, not created or sent by JMS.
-- xero-create-invoice is unaffected: it only ever claims 'draft' / 'failed' invoices, so it can never pick these up.

alter table public.invoices
  add column if not exists marked_invoiced_by text,
  add column if not exists marked_invoiced_at timestamptz;

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft', 'sending', 'sent', 'failed', 'in_xero_not_emailed', 'invoiced_manually'));

alter table public.invoices add constraint invoices_marked_invoiced_pair
  check ((marked_invoiced_by is null) = (marked_invoiced_at is null));
alter table public.invoices add constraint invoices_invoiced_manually_marked
  check ((status = 'invoiced_manually') = (marked_invoiced_at is not null));

comment on column public.invoices.status is 'Local lifecycle: draft -> sending -> sent (created in Xero and emailed) | in_xero_not_emailed (created in Xero, not emailed because invoice emailing was off) | failed (retryable). invoiced_manually: invoiced by hand in Xero outside JMS and marked so in JMS (manager_mark_visits_invoiced_manually) - JMS created/sent nothing; final.';
comment on column public.invoices.marked_invoiced_by is 'Who marked the invoice as already invoiced by hand in Xero (status invoiced_manually). Null otherwise.';
comment on column public.invoices.marked_invoiced_at is 'When it was marked as already invoiced by hand in Xero (status invoiced_manually). Null otherwise.';

-- 3. Final: once marked, the status and the marking can't change (no "unmark", no hand-off to xero-create-invoice).
create or replace function private.invoices_invoiced_manually_final()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'invoiced_manually'
     and (new.status is distinct from old.status
          or new.marked_invoiced_by is distinct from old.marked_invoiced_by
          or new.marked_invoiced_at is distinct from old.marked_invoiced_at) then
    raise exception 'This invoice was marked as already invoiced in Xero; that can''t be changed.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_invoiced_manually_final on public.invoices;
create trigger invoices_invoiced_manually_final
  before update on public.invoices
  for each row execute function private.invoices_invoiced_manually_final();

-- 4. Closed jobs: an invoice marked as already invoiced is finished accounts work, like one created in Xero.
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
            where li.visit_id = v.id and i.status in ('sent', 'in_xero_not_emailed', 'invoiced_manually')
          )
        )
      )
    )
$$;

-- 5. The action.
create or replace function public.manager_mark_visits_invoiced_manually(p_visit_ids uuid[])
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ids uuid[];
  v_actor text;
  v_now timestamptz := now();
  v_inv record;
  v_visit record;
  v_new uuid;
  v_existing uuid[] := '{}';
  v_created uuid[] := '{}';
  v_updated int;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Only a manager can mark work as already invoiced.' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(p_visit_ids) as x where x is not null;
  if cardinality(v_ids) = 0 then
    raise exception 'Select at least one visit to mark as already invoiced.' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 200 then
    raise exception 'Mark at most 200 visits at a time.' using errcode = '22023';
  end if;

  v_actor := private.current_manager_label();

  -- Lock the selected visits first, in id order: a second request for any of them waits here, then finds them already done.
  perform 1 from visits where id = any(v_ids) order by id for update;
  if (select count(*) from visits where id = any(v_ids)) <> cardinality(v_ids) then
    raise exception 'One or more of the selected visits no longer exists. Refresh and try again.' using errcode = '22023';
  end if;

  -- Visits already on an invoice: that invoice must still be a draft or a failed attempt, and every visit on it must be selected.
  for v_inv in
    select i.id, i.status,
           (select coalesce(b.name, 'a building') from jobs j left join buildings b on b.id = j.building_id where j.id = i.job_id) as building
    from invoices i
    where i.id in (select li.invoice_id from invoice_line_items li where li.visit_id = any(v_ids))
    order by i.id
    for update of i
  loop
    if v_inv.status = 'sending' then
      raise exception 'The invoice for % is being sent to Xero right now. Wait for it to finish; nothing was marked.', v_inv.building using errcode = '55000';
    elsif v_inv.status not in ('draft', 'failed') then
      raise exception 'The invoice for % is already in Records. Nothing was marked.', v_inv.building using errcode = '55000';
    end if;
    if exists (select 1 from invoice_line_items li where li.invoice_id = v_inv.id and li.visit_id is not null and not (li.visit_id = any(v_ids))) then
      raise exception 'The invoice for % also covers visits that weren''t selected. Select every visit on it. Nothing was marked.', v_inv.building using errcode = '22023';
    end if;
    v_existing := v_existing || v_inv.id;
  end loop;

  -- Visits with no invoice yet: the same work Ready for accounts offers for invoicing - approved report, completed visit.
  for v_visit in
    select vi.id, vi.job_id, vi.status, vi.price_charged, j.job_summary, r.review_status, coalesce(b.name, 'a building') as building
    from visits vi
    join jobs j on j.id = vi.job_id
    left join buildings b on b.id = j.building_id
    left join reports r on r.visit_id = vi.id
    where vi.id = any(v_ids)
      and not exists (select 1 from invoice_line_items li where li.visit_id = vi.id)
    order by vi.id
  loop
    if v_visit.review_status is distinct from 'approved' then
      raise exception 'A selected visit at % has no approved report. Nothing was marked.', v_visit.building using errcode = '22023';
    end if;
    if v_visit.status <> 'completed' or v_visit.price_charged is null then
      raise exception 'A selected visit at % isn''t completed yet - complete it first. Nothing was marked.', v_visit.building using errcode = '22023';
    end if;
    insert into invoices (job_id, status, description, created_by, marked_invoiced_by, marked_invoiced_at)
      values (v_visit.job_id, 'invoiced_manually', v_visit.job_summary, v_actor, v_actor, v_now)
      returning id into v_new;
    insert into invoice_line_items (invoice_id, visit_id, description, quantity, unit_amount, sort_order)
      values (v_new, v_visit.id, coalesce(nullif(btrim(v_visit.job_summary), ''), 'Visit'), 1, v_visit.price_charged, 0);
    v_created := v_created || v_new;
  end loop;

  if cardinality(v_existing) > 0 then
    update invoices
       set status = 'invoiced_manually', marked_invoiced_by = v_actor, marked_invoiced_at = v_now
     where id = any(v_existing) and status in ('draft', 'failed');
    get diagnostics v_updated = row_count;
    if v_updated <> cardinality(v_existing) then
      raise exception 'An invoice changed while it was being marked. Nothing was marked; refresh and try again.' using errcode = '40001';
    end if;
  end if;

  insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    select 'visit'::public.activity_entity_type, x, 'invoice_marked_manually',
           'Marked as already invoiced by hand in Xero - JMS did not create or send an invoice.', v_actor, v_now
    from unnest(v_ids) as x;

  return jsonb_build_object(
    'visits', cardinality(v_ids),
    'invoices', cardinality(v_existing) + cardinality(v_created),
    'created', cardinality(v_created),
    'marked_existing', cardinality(v_existing)
  );
end;
$$;

revoke all on function public.manager_mark_visits_invoiced_manually(uuid[]) from public, anon;
grant execute on function public.manager_mark_visits_invoiced_manually(uuid[]) to authenticated;
comment on function public.manager_mark_visits_invoiced_manually(uuid[]) is
  'Records visits that were already invoiced by hand in Xero: their draft/failed invoice, or a new invoice record per visit, becomes invoiced_manually (moves to Records). Never contacts Xero. Manager only; all-or-nothing; visits locked.';
