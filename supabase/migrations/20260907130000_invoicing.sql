-- Invoicing (Xero integration) — first pass, per the reviewed plan.
--
-- One row per invoice the manager creates (draft, locally, no Xero call
-- yet) and one row per line item — either one line per visit ("normal"
-- jobs) or several lines for a manager-selected set of visits ("combined"
-- invoices, per Luke's explicit requirement that this is always an
-- explicit selection, never inferred from job frequency).
--
-- Duplicate-invoicing protection lives entirely in
-- invoice_line_items.visit_id being UNIQUE: a visit can be linked to at
-- most one line item, ever, for the life of that row. A visit only
-- becomes selectable again if its (draft-or-failed) invoice is explicitly
-- discarded by the manager — deleting the invoice row cascades to its
-- line items, freeing the visit. This is a real DB constraint, not just
-- an application-level check.
--
-- works_order_number lives on invoices, not jobs — Luke's own words are
-- that it "can change from one invoice/job to another," so a job-level
-- "current" number would need constant upkeep for no benefit; the
-- manager just types it in per invoice, always editable before Send.
--
-- Nothing here assumes a Xero AccountCode/TaxType — those are resolved
-- live against the connected organisation at send time (see
-- supabase/functions/xero-create-invoice), never stored as a default here.

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'failed')),
  description text,
  works_order_number text,
  xero_contact_id text,
  xero_invoice_id text,
  xero_invoice_number text,
  idempotency_key uuid not null default gen_random_uuid(),
  last_error text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create table public.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  visit_id uuid unique references public.visits(id) on delete restrict,
  description text not null,
  quantity numeric not null default 1,
  unit_amount numeric not null,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clients add column xero_contact_id text;

comment on table public.invoices is 'One row per invoice the manager creates from completed/approved visits. status is local lifecycle state (draft/sending/sent/failed), independent of any Xero-side status. See docs/production-domain-model-proposal.md-style rationale in this migration file header.';
comment on table public.invoice_line_items is 'One row per invoice line. visit_id is UNIQUE — the actual duplicate-invoicing guard: a visit can belong to at most one line item ever. NULL only for a manually-added line with no visit backing it.';
comment on column public.invoices.works_order_number is 'Per-invoice, not per-job — a works order number can change invoice to invoice (Luke''s own requirement), so there is no job-level "current" number to keep in sync.';
comment on column public.clients.xero_contact_id is 'Set once a client is matched or created in Xero, so contact search/creation happens at most once per client.';

alter table public.invoices enable row level security;
alter table public.invoice_line_items enable row level security;

create policy manager_full_access on public.invoices
  for all
  using (private.current_app_role() = 'manager')
  with check (private.current_app_role() = 'manager');

create policy manager_full_access on public.invoice_line_items
  for all
  using (private.current_app_role() = 'manager')
  with check (private.current_app_role() = 'manager');

create trigger trg_invoices_updated_at
  before update on public.invoices
  for each row execute function jms_set_updated_at();

create trigger trg_invoice_line_items_updated_at
  before update on public.invoice_line_items
  for each row execute function jms_set_updated_at();
