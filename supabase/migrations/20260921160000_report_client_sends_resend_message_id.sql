-- Records the Resend-assigned message id per send attempt, for support/
-- audit lookups against Resend's own dashboard/logs — matches this repo's
-- existing xero_invoice_id/xero_invoice_number provider-id-column
-- convention (invoices table). Nullable: a failed attempt never reaches
-- Resend successfully enough to have one.
alter table report_client_sends add column if not exists resend_message_id text;
