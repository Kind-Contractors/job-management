-- Xero recipient links: link provenance on contacts, a saved default recipient per building, and a database-level lock on
-- an invoice's recipient once Xero holds the invoice.
--
-- NOT APPLIED to any database when written. Apply to DEV first, and only after review.
-- Depends on 20261016150000_xero_organisation_tags.sql, which adds contacts.xero_org_id and invoices.xero_org_id (apply it first).
-- Additive and safe for existing rows: new columns are nullable, nothing is dropped or rewritten, existing links and invoices
-- are untouched (an existing link simply has no organisation tag yet, so it must be re-verified before it can be used).
--
-- What is NOT added (deliberately, to avoid duplicate columns): no organisation column on contacts or invoices beyond the
-- one the earlier migration adds; invoices.xero_contact_id already exists and is reused as the recipient record.

-- ---- 1. contacts: who linked it, when, and the Xero name seen at that moment --------------------------------------------------
alter table public.contacts add column if not exists xero_contact_name text;
alter table public.contacts add column if not exists xero_linked_at timestamptz;
alter table public.contacts add column if not exists xero_linked_by text;

comment on column public.contacts.xero_contact_name is 'The Xero contact name the manager saw and confirmed when linking (a snapshot, for display and audit; never used to match anything).';
comment on column public.contacts.xero_linked_at is 'When the manager linked this contact to the Xero contact in xero_contact_id.';
comment on column public.contacts.xero_linked_by is 'Who linked it (the signed-in manager''s email).';

-- A link must always say which Xero organisation it belongs to, and a link that is a building's default recipient may not
-- be changed or removed from under that building (the default records the Xero id it was chosen with).
create or replace function public.contacts_xero_link_guard() returns trigger
language plpgsql as $$
begin
  if new.xero_contact_id is not null
     and (tg_op = 'INSERT' or new.xero_contact_id is distinct from old.xero_contact_id)
     and nullif(btrim(coalesce(new.xero_org_id, '')), '') is null then
    raise exception 'xero_org_required: a Xero link must record the Xero organisation it belongs to' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if (new.xero_contact_id is distinct from old.xero_contact_id or new.xero_org_id is distinct from old.xero_org_id)
       and exists (select 1 from public.buildings b where b.default_invoice_contact_id = old.id) then
      raise exception 'contact_is_building_default: this contact is a building''s default invoice recipient; clear that default before changing its Xero link' using errcode = '23514';
    end if;
    if new.client_id is distinct from old.client_id
       and exists (select 1 from public.buildings b where b.default_invoice_contact_id = old.id) then
      raise exception 'contact_is_building_default: this contact is a building''s default invoice recipient and cannot move to another client' using errcode = '23514';
    end if;
  end if;

  -- Removing the link removes its provenance with it.
  if new.xero_contact_id is null then
    new.xero_org_id := null;
    new.xero_contact_name := null;
    new.xero_linked_at := null;
    new.xero_linked_by := null;
  end if;
  return new;
end;
$$;

-- buildings.default_invoice_contact_id is created below; the function body only runs on a write, after both exist.
drop trigger if exists contacts_xero_link_guard on public.contacts;

-- ---- 2. buildings: the saved default recipient --------------------------------------------------------------------------------
alter table public.buildings add column if not exists default_invoice_contact_id uuid references public.contacts (id) on delete restrict;
alter table public.buildings add column if not exists default_invoice_xero_contact_id text;
alter table public.buildings add column if not exists default_invoice_xero_org_id text;

comment on column public.buildings.default_invoice_contact_id is 'The local contact chosen as this building''s default invoice recipient. Must belong to the building''s client (enforced by trigger). NULL = no default: invoices for this building need a recipient chosen each time.';
comment on column public.buildings.default_invoice_xero_contact_id is 'The Xero ContactID that contact was linked to WHEN it was chosen. Compared with the contact''s current link whenever the default is used, so a changed link can never silently change who is invoiced.';
comment on column public.buildings.default_invoice_xero_org_id is 'The Xero organisation that ContactID belongs to. A default is only used against that same organisation.';

alter table public.buildings drop constraint if exists buildings_default_invoice_recipient_all_or_none;
alter table public.buildings add constraint buildings_default_invoice_recipient_all_or_none check (
  (default_invoice_contact_id is null and default_invoice_xero_contact_id is null and default_invoice_xero_org_id is null)
  or (default_invoice_contact_id is not null
      and nullif(btrim(coalesce(default_invoice_xero_contact_id, '')), '') is not null
      and nullif(btrim(coalesce(default_invoice_xero_org_id, '')), '') is not null)
);

create or replace function public.buildings_default_recipient_guard() returns trigger
language plpgsql as $$
begin
  if new.default_invoice_contact_id is not null then
    if not exists (select 1 from public.contacts c where c.id = new.default_invoice_contact_id and c.client_id = new.client_id) then
      raise exception 'default_recipient_wrong_client: the default recipient must be a contact of this building''s client' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists buildings_default_recipient_guard on public.buildings;
create trigger buildings_default_recipient_guard
  before insert or update of default_invoice_contact_id, client_id on public.buildings
  for each row execute function public.buildings_default_recipient_guard();

create trigger contacts_xero_link_guard
  before insert or update on public.contacts
  for each row execute function public.contacts_xero_link_guard();

-- ---- 3. invoices: the recipient (and organisation) are locked once Xero holds the invoice ---------------------------------------
-- Once xero_invoice_id is set, the Xero invoice, its recipient and its organisation can no longer change. A blank value may be
-- filled in once (an invoice sent before these columns existed has no recorded recipient or organisation); a value that is
-- already recorded can never be replaced. This holds against any writer: the Edge Function, a direct request, or a race.
create or replace function public.invoices_xero_recipient_lock() returns trigger
language plpgsql as $$
begin
  if old.xero_invoice_id is not null then
    if new.xero_invoice_id is distinct from old.xero_invoice_id then
      raise exception 'xero_invoice_locked: this invoice already exists in Xero and its Xero invoice id cannot change' using errcode = '23514';
    end if;
    if old.xero_contact_id is not null and new.xero_contact_id is distinct from old.xero_contact_id then
      raise exception 'xero_recipient_locked: this invoice already exists in Xero; its recipient cannot be changed' using errcode = '23514';
    end if;
    if old.xero_org_id is not null and new.xero_org_id is distinct from old.xero_org_id then
      raise exception 'xero_org_locked: this invoice already exists in Xero; its Xero organisation cannot be changed' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_xero_recipient_lock on public.invoices;
create trigger invoices_xero_recipient_lock
  before update on public.invoices
  for each row execute function public.invoices_xero_recipient_lock();

-- To deliberately reset an invoice for a changed Xero organisation (the planned cutover), disable this one trigger inside the
-- cutover transaction: alter table public.invoices disable trigger invoices_xero_recipient_lock; ... enable trigger ...
