-- Automatic invoice emails: an app-wide, manager-controlled setting that decides whether the app asks Xero to EMAIL an
-- invoice after creating it. Invoice creation is unaffected: with the setting off, invoices are still created and
-- authorised in Xero, and recorded as 'in_xero_not_emailed' (that status is added by 20261018090000, which must be applied
-- first), never 'sent'.
--
-- NOT APPLIED to any database when written. Apply to DEV first, and only after review.
-- Additive: one new single-row table, defaulting to OFF. No existing table, row, constraint or function changes.
--
-- The Edge Function (xero-create-invoice) is the only place an invoice is ever emailed. Immediately before that step it
-- requires BOTH the environment's XERO_SENDING_ENABLED and this setting; a missing row, a read error or anything other
-- than an explicit TRUE here means "do not email".

-- ---- 1. the setting -------------------------------------------------------------------------------------------------------
create table if not exists public.app_settings (
  id                          boolean     primary key default true check (id),   -- exactly one row
  auto_invoice_emails_enabled boolean     not null default false,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid
);

comment on table public.app_settings is 'App-wide settings: exactly one row (id = true). Read and changed by active managers only (RLS).';
comment on column public.app_settings.auto_invoice_emails_enabled is 'When true AND the environment allows invoice emails (XERO_SENDING_ENABLED), xero-create-invoice asks Xero to email each invoice it creates. When false (the default), invoices are still created in Xero but not emailed by the app. Checked by the Edge Function immediately before every email; anything other than an explicit true means do not email.';
comment on column public.app_settings.updated_by is 'auth.users id of the manager who last changed a setting (set by trigger).';

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;

-- Managers may read and update the one row. No insert or delete policy: the row cannot be removed or duplicated through
-- the API, so "no row" can only mean something is wrong, which the Edge Function treats as "do not email".
drop policy if exists manager_select on public.app_settings;
create policy manager_select on public.app_settings
  for select using (private.current_app_role() = 'manager');
drop policy if exists manager_update on public.app_settings;
create policy manager_update on public.app_settings
  for update using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');

create or replace function public.app_settings_stamp() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists app_settings_stamp on public.app_settings;
create trigger app_settings_stamp
  before update on public.app_settings
  for each row execute function public.app_settings_stamp();
