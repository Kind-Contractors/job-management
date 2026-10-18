-- Who an invoice went to, and why it was not emailed, recorded with the invoice.
--
-- NOT APPLIED to any database when written. Apply to DEV first, and only after review. Must be applied BEFORE the
-- xero-create-invoice version that writes these columns is deployed.
-- Additive: three nullable columns on public.invoices. No existing row, constraint, policy, trigger or function changes;
-- existing invoices simply have no recorded name/email (the app then falls back to the local contact, or says it was not
-- recorded). Access is unchanged: invoices are manager-only under the existing RLS policy.

alter table public.invoices add column if not exists xero_recipient_name text;
alter table public.invoices add column if not exists xero_recipient_email text;
alter table public.invoices add column if not exists not_emailed_reason text;

alter table public.invoices drop constraint if exists invoices_not_emailed_reason_check;
alter table public.invoices add constraint invoices_not_emailed_reason_check
  check (not_emailed_reason is null or not_emailed_reason in ('environment', 'app_setting_off'));

comment on column public.invoices.xero_recipient_name is 'Name of the Xero contact the invoice was created for, as Xero held it when the invoice was created or last updated (read from Xero by xero-create-invoice).';
comment on column public.invoices.xero_recipient_email is 'Email address of that Xero contact at the same moment: the address Xero emails the invoice to.';
comment on column public.invoices.not_emailed_reason is 'Why an in_xero_not_emailed invoice was not emailed: environment (XERO_SENDING_ENABLED is off on this system) or app_setting_off (the Automatic Invoice Emails toggle was off). NULL when emailed or not applicable.';
