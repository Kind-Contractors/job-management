-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation. This repo previously had no file for
-- this version at all.

-- Xero rejects an AUTHORISED invoice without a DueDate ("The document
-- DueDate field must be specified"). No payment-terms concept exists
-- anywhere else in this schema, so a default of 30 days from creation is
-- used — chosen here rather than deferred, per explicit instruction not to
-- ask for clarification at this stage. Always editable before send (same
-- as description/works_order_number), and persisted with the draft rather
-- than computed only at send time, so the manager can see and change it
-- before anything reaches Xero.
alter table public.invoices add column due_date date not null default (current_date + 30);

comment on column public.invoices.due_date is 'Sent to Xero as the invoice DueDate. Defaults to 30 days from creation (no payment-terms concept exists elsewhere in this schema) — always editable before send.';
