-- Xero organisation tags. NOT APPLIED to any database (written in Phase 1 of the Xero safeguards work; applying it
-- needs explicit approval, DEV first). Purely additive: two nullable text columns, nothing dropped or rewritten,
-- no data changed, and no application code depends on them yet.
--
-- Why: a Xero ID only means something inside the Xero organisation it came from. Every ID stored today came from
-- the Xero TEST organisation. Recording the organisation alongside a stored Xero reference lets the app recognise a
-- reference that belongs to a different organisation and refuse it, instead of relying only on Xero answering
-- "not found". Until this is applied the app verifies each reference live against the connected organisation
-- (see supabase/functions/_shared/xeroSafeguards.ts), which already fails closed.

alter table public.contacts add column if not exists xero_org_id text;
alter table public.invoices add column if not exists xero_org_id text;

comment on column public.contacts.xero_org_id is
  'The Xero organisation id that contacts.xero_contact_id belongs to. NULL = not recorded (treat the link as unverified).';
comment on column public.invoices.xero_org_id is
  'The Xero organisation id that invoices.xero_invoice_id and invoices.xero_contact_id belong to. NULL = not recorded.';
