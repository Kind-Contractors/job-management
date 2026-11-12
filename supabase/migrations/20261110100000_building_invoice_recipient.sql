-- Building invoice recipient: a building's Xero invoice recipient is its OWN record (the Xero contact named on its invoices),
-- no longer only a pointer to a person contact of the client.
--
-- NOT APPLIED to any database when written. Apply to DEV first, and only after review. Production only after DEV is tested and
-- the change is approved separately.
--
-- Why: the invoice contact (e.g. "16-17 Marylebone Adrian Levy") is not a person (e.g. Laura Newton). Several buildings may share
-- one Xero contact; one email may belong to several Xero contacts. Each building chooses its recipient explicitly; changing one
-- building never changes another, nor any invoice.
--
-- What it does:
--   1. Adds the recipient's details as seen when it was chosen (name, email - display and audit only, never used to match), and
--      when / by whom it was chosen.
--   2. Makes default_invoice_contact_id OPTIONAL: a building's recipient is default_invoice_xero_contact_id + _xero_org_id (+ the
--      name). An existing default that names a contact keeps it (legacy; still checked against that contact's link when used).
--   3. Replaces the all-or-none rule with: no recipient at all, or a Xero contact id + organisation + name (a contact optional).
--   4. Two functions, callable by the SERVER ONLY (service_role), are the only way to set, replace or clear a recipient chosen
--      without a contact: set_building_invoice_recipient / clear_building_invoice_recipient. The Edge Function calls them after
--      checking the manager and verifying the contact live in Xero.
--   5. A trigger enforces it: any other write that would create, replace, clear or edit a contact-less recipient is refused; the
--      "chosen at / by" fields are always stamped by the database and never taken from the writer; a contact-based (legacy)
--      default always takes its name from that contact's link and records no email.
--   6. change_building_client: clears a contact-less recipient too (through the same gate), and records it as cleared.
--
-- What it does NOT do: choose, guess or copy any recipient from emails or names; touch any contact's Xero link; change any invoice
-- (invoices keep their own xero_contact_id, organisation and recipient name/email, locked by invoices_xero_recipient_lock);
-- add any uniqueness rule (the same Xero contact may be the recipient of any number of buildings).
--
-- The current app keeps working unchanged: it only ever writes contact-based defaults (set: contact + Xero id + organisation;
-- clear: all three null), which are still accepted directly, and its send path reads only those. A contact-less recipient can't
-- exist until the server functions are called (Step 2), and the current send path would refuse one as "no default" anyway.
--
-- Existing rows stay valid: every existing default's contact has a link name and the same Xero id (checked read-only on DEV and
-- production before writing), and that name is copied below.
-- Rollback: supabase/rollbacks/20261110100000_building_invoice_recipient.rollback.sql.

-- ---- 1. the recipient's details -------------------------------------------------------------------------------------------------
alter table public.buildings add column if not exists default_invoice_xero_contact_name text;
alter table public.buildings add column if not exists default_invoice_xero_contact_email text;
alter table public.buildings add column if not exists default_invoice_set_at timestamptz;
alter table public.buildings add column if not exists default_invoice_set_by text;

comment on column public.buildings.default_invoice_xero_contact_id is 'This building''s invoice recipient: the Xero ContactID its invoices are addressed to, chosen explicitly by a manager for this building only. Any number of buildings may share one. Verified live in Xero whenever it is used. NULL = no recipient: each invoice needs one chosen.';
comment on column public.buildings.default_invoice_xero_org_id is 'The Xero organisation that ContactID belongs to. A recipient is only used against that same organisation.';
comment on column public.buildings.default_invoice_contact_id is 'LEGACY / optional: the local contact an older recipient was chosen through. When set, it must belong to the building''s client and its current Xero link is compared with default_invoice_xero_contact_id when used. New recipients have no contact (set through set_building_invoice_recipient).';
comment on column public.buildings.default_invoice_xero_contact_name is 'The Xero contact name the manager saw and confirmed when choosing the recipient (a snapshot for display and audit; never used to match anything). For a contact-based default: that contact''s link name.';
comment on column public.buildings.default_invoice_xero_contact_email is 'The Xero contact''s email when it was chosen (a snapshot for display; Xero emails the address it holds at send time). Empty for contact-based defaults.';
comment on column public.buildings.default_invoice_set_at is 'When this recipient was chosen - stamped by the database, never by the writer. NULL for defaults chosen before this column existed (not reconstructed).';
comment on column public.buildings.default_invoice_set_by is 'Who chose it (the manager''s email) - stamped by the database, never by the writer. NULL for defaults chosen before this column existed (not reconstructed).';

-- Existing (contact-based) defaults: the name is the one the manager confirmed when linking that contact. Nothing else is filled in:
-- the email, and when/by whom the default was chosen, are not known and are left empty rather than guessed. (Runs before the
-- trigger below exists.)
update public.buildings b
set default_invoice_xero_contact_name = c.xero_contact_name
from public.contacts c
where c.id = b.default_invoice_contact_id
  and b.default_invoice_xero_contact_id is not null
  and b.default_invoice_xero_contact_name is null;

-- ---- 2. the trigger: who may write what, and the details follow the recipient -----------------------------------------------------
-- app.building_invoice_recipient_write = 'on' is set (transaction-local) only by the functions below and change_building_client;
-- it cannot be set through the API (set_config is not exposed). app.building_invoice_recipient_actor carries the manager's email
-- from set_building_invoice_recipient.
create or replace function public.buildings_invoice_recipient_details() returns trigger
language plpgsql as $$
declare
  v_via_function boolean := coalesce(current_setting('app.building_invoice_recipient_write', true), '') = 'on';
  v_new_contactless boolean := new.default_invoice_xero_contact_id is not null and new.default_invoice_contact_id is null;
  v_old_contactless boolean := false;
  v_changed boolean;
  v_touched boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.default_invoice_xero_contact_id is not null or new.default_invoice_contact_id is not null;
    v_touched := v_changed;
  else
    v_old_contactless := old.default_invoice_xero_contact_id is not null and old.default_invoice_contact_id is null;
    -- A different recipient: another Xero contact, organisation or contact (the same name or email does not make it the same).
    v_changed := new.default_invoice_xero_contact_id is distinct from old.default_invoice_xero_contact_id
      or new.default_invoice_xero_org_id is distinct from old.default_invoice_xero_org_id
      or new.default_invoice_contact_id is distinct from old.default_invoice_contact_id;
    v_touched := v_changed
      or new.default_invoice_xero_contact_name is distinct from old.default_invoice_xero_contact_name
      or new.default_invoice_xero_contact_email is distinct from old.default_invoice_xero_contact_email
      or new.default_invoice_set_at is distinct from old.default_invoice_set_at
      or new.default_invoice_set_by is distinct from old.default_invoice_set_by;
  end if;

  -- A recipient chosen without a contact is created, replaced, cleared and described only through the server functions.
  if not v_via_function and v_touched and (v_new_contactless or v_old_contactless) then
    raise exception 'building_invoice_recipient_server_only: this building''s invoice recipient can only be set, changed or cleared through the invoice recipient panel. Nothing was changed.'
      using errcode = '42501';
  end if;

  -- No recipient: no details.
  if new.default_invoice_xero_contact_id is null then
    new.default_invoice_xero_contact_name := null;
    new.default_invoice_xero_contact_email := null;
    new.default_invoice_set_at := null;
    new.default_invoice_set_by := null;
    return new;
  end if;

  -- Contact-based (legacy) default: its name is always that contact's confirmed link name, and it records no email - so nothing
  -- stale or typed in can stand.
  if new.default_invoice_contact_id is not null then
    select c.xero_contact_name into new.default_invoice_xero_contact_name
    from public.contacts c where c.id = new.default_invoice_contact_id;
    new.default_invoice_xero_contact_email := null;
  end if;

  -- When and by whom: always stamped here, never taken from the writer. A new or replaced recipient is stamped now, by the manager
  -- the server function names or else the signed-in user; any other write keeps the existing stamp.
  if v_changed then
    new.default_invoice_set_at := now();
    new.default_invoice_set_by := case
      when v_via_function then nullif(btrim(coalesce(current_setting('app.building_invoice_recipient_actor', true), '')), '')
      else nullif(auth.jwt() ->> 'email', '')
    end;
  elsif tg_op = 'UPDATE' then
    new.default_invoice_set_at := old.default_invoice_set_at;
    new.default_invoice_set_by := old.default_invoice_set_by;
  end if;
  return new;
end;
$$;

drop trigger if exists buildings_invoice_recipient_details on public.buildings;
create trigger buildings_invoice_recipient_details
  before insert or update of default_invoice_contact_id, default_invoice_xero_contact_id, default_invoice_xero_org_id,
    default_invoice_xero_contact_name, default_invoice_xero_contact_email, default_invoice_set_at, default_invoice_set_by
  on public.buildings
  for each row execute function public.buildings_invoice_recipient_details();

-- ---- 3. the rule: no recipient, or a complete one (a contact optional) --------------------------------------------------------------
-- (buildings_default_recipient_guard is unchanged: a contact, when there is one, must belong to the building's client.)
alter table public.buildings drop constraint if exists buildings_default_invoice_recipient_all_or_none;
alter table public.buildings drop constraint if exists buildings_default_invoice_recipient_complete;
alter table public.buildings add constraint buildings_default_invoice_recipient_complete check (
  (default_invoice_contact_id is null and default_invoice_xero_contact_id is null and default_invoice_xero_org_id is null)
  or (nullif(btrim(coalesce(default_invoice_xero_contact_id, '')), '') is not null
      and nullif(btrim(coalesce(default_invoice_xero_org_id, '')), '') is not null
      and nullif(btrim(coalesce(default_invoice_xero_contact_name, '')), '') is not null)
);

-- ---- 4. the server-only functions ------------------------------------------------------------------------------------------------
-- p_expected_current_xero_contact_id + p_expected_current_xero_org_id: the recipient the manager saw (both NULL = none). A
-- recipient is identified by BOTH; if either differs now (someone else changed it meanwhile, or the manager did not confirm
-- replacing it), nothing is changed and the manager is asked to reload.
create or replace function public.set_building_invoice_recipient(
  p_building_id uuid,
  p_xero_contact_id text,
  p_xero_org_id text,
  p_xero_contact_name text,
  p_xero_contact_email text,
  p_actor text,
  p_expected_current_xero_contact_id text,
  p_expected_current_xero_org_id text
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_current_id text;
  v_current_org text;
begin
  if nullif(btrim(coalesce(p_xero_contact_id, '')), '') is null or nullif(btrim(coalesce(p_xero_org_id, '')), '') is null
     or nullif(btrim(coalesce(p_xero_contact_name, '')), '') is null then
    raise exception 'building_invoice_recipient_incomplete: a recipient needs its Xero contact, organisation and name. Nothing was changed.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'building_invoice_recipient_actor_required: who is choosing the recipient must be recorded. Nothing was changed.' using errcode = 'P0001';
  end if;
  select default_invoice_xero_contact_id, default_invoice_xero_org_id into v_current_id, v_current_org
  from buildings where id = p_building_id for update;
  if not found then
    raise exception 'building_not_found: that building could not be found. Nothing was changed.' using errcode = 'P0001';
  end if;
  if v_current_id is distinct from nullif(btrim(coalesce(p_expected_current_xero_contact_id, '')), '')
     or v_current_org is distinct from nullif(btrim(coalesce(p_expected_current_xero_org_id, '')), '') then
    raise exception 'building_invoice_recipient_changed: this building''s invoice recipient is not the one you saw. Reload and try again. Nothing was changed.' using errcode = 'P0001';
  end if;

  perform set_config('app.building_invoice_recipient_write', 'on', true);
  perform set_config('app.building_invoice_recipient_actor', btrim(p_actor), true);
  update buildings
  set default_invoice_contact_id = null,
      default_invoice_xero_contact_id = btrim(p_xero_contact_id),
      default_invoice_xero_org_id = btrim(p_xero_org_id),
      default_invoice_xero_contact_name = btrim(p_xero_contact_name),
      default_invoice_xero_contact_email = nullif(btrim(coalesce(p_xero_contact_email, '')), ''),
      updated_at = now()
  where id = p_building_id;
  perform set_config('app.building_invoice_recipient_write', '', true);
  perform set_config('app.building_invoice_recipient_actor', '', true);
end;
$$;

create or replace function public.clear_building_invoice_recipient(
  p_building_id uuid,
  p_expected_current_xero_contact_id text,
  p_expected_current_xero_org_id text
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_current_id text;
  v_current_org text;
begin
  select default_invoice_xero_contact_id, default_invoice_xero_org_id into v_current_id, v_current_org
  from buildings where id = p_building_id for update;
  if not found then
    raise exception 'building_not_found: that building could not be found. Nothing was changed.' using errcode = 'P0001';
  end if;
  if v_current_id is distinct from nullif(btrim(coalesce(p_expected_current_xero_contact_id, '')), '')
     or v_current_org is distinct from nullif(btrim(coalesce(p_expected_current_xero_org_id, '')), '') then
    raise exception 'building_invoice_recipient_changed: this building''s invoice recipient is not the one you saw. Reload and try again. Nothing was changed.' using errcode = 'P0001';
  end if;

  perform set_config('app.building_invoice_recipient_write', 'on', true);
  update buildings
  set default_invoice_contact_id = null,
      default_invoice_xero_contact_id = null,
      default_invoice_xero_org_id = null,
      updated_at = now()
  where id = p_building_id;
  perform set_config('app.building_invoice_recipient_write', '', true);
end;
$$;

-- Server only: the Edge Function calls these with the service role after checking the manager and verifying the contact in Xero.
revoke all on function public.set_building_invoice_recipient(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.clear_building_invoice_recipient(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_building_invoice_recipient(uuid, text, text, text, text, text, text, text) to service_role;
grant execute on function public.clear_building_invoice_recipient(uuid, text, text) to service_role;

-- ---- 5. change_building_client: also clears a contact-less recipient, and records it as cleared ------------------------------------
-- Identical to 20261023100000_building_client_history.sql except: what counts as "cleared", and the write gate around its update.
create or replace function public.change_building_client(
  p_building_id uuid,
  p_new_client_id uuid,
  p_expected_client_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
  v_building buildings%rowtype;
  v_previous_name text;
  v_new_name text;
  v_open_invoices integer;
  v_cleared boolean;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.' using errcode = 'P0001';
  end if;
  if p_building_id is null or p_new_client_id is null or p_expected_client_id is null then
    raise exception 'Choose the building and the new client.' using errcode = 'P0001';
  end if;
  v_actor := coalesce(nullif(auth.jwt() ->> 'email', ''), 'unknown');

  select * into v_building from buildings where id = p_building_id for update;
  if not found then
    raise exception 'This building no longer exists.' using errcode = 'P0001';
  end if;
  -- The manager confirmed a change FROM a specific client: if it changed meanwhile, nothing is done.
  if v_building.client_id is distinct from p_expected_client_id then
    raise exception 'This building''s client has changed since the page was loaded. Reload the building and try again.' using errcode = 'P0001';
  end if;
  if p_new_client_id = v_building.client_id then
    raise exception 'This building already belongs to that client.' using errcode = 'P0001';
  end if;
  select company_name into v_new_name from clients where id = p_new_client_id;
  if not found then
    raise exception 'That client no longer exists. Choose another client.' using errcode = 'P0001';
  end if;
  select company_name into v_previous_name from clients where id = v_building.client_id;

  -- Invoices still being prepared or sent for this building's jobs would be billed to whichever client the building has when
  -- they are sent: they must be finished (or discarded) first, so none silently changes client.
  select count(*) into v_open_invoices
  from invoices i join jobs j on j.id = i.job_id
  where j.building_id = p_building_id and i.status in ('draft', 'sending', 'failed');
  if v_open_invoices > 0 then
    raise exception 'This building has % invoice(s) not yet finished (draft, sending or failed). Send or discard them first, so they are not billed to the wrong client. Nothing was changed.', v_open_invoices
      using errcode = 'P0001';
  end if;

  -- The building's invoice recipient was chosen for the previous client, so it cannot stay: it is cleared in the same update (with
  -- or without a contact - through the recipient write gate; its details are cleared with it).
  v_cleared := v_building.default_invoice_xero_contact_id is not null or v_building.default_invoice_contact_id is not null;
  perform set_config('app.building_invoice_recipient_write', 'on', true);
  update buildings
  set client_id = p_new_client_id,
      default_invoice_contact_id = null,
      default_invoice_xero_contact_id = null,
      default_invoice_xero_org_id = null,
      updated_at = now()
  where id = p_building_id;
  perform set_config('app.building_invoice_recipient_write', '', true);

  insert into building_client_history (building_id, previous_client_id, new_client_id, changed_by, default_recipient_cleared)
  values (p_building_id, v_building.client_id, p_new_client_id, v_actor, v_cleared);

  insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
  values ('building', p_building_id, 'building_client_changed', coalesce(v_previous_name, 'Unknown client') || ' → ' || v_new_name, v_actor, now());

  return jsonb_build_object(
    'previousClientId', v_building.client_id,
    'newClientId', p_new_client_id,
    'defaultRecipientCleared', v_cleared
  );
end;
$$;

-- Grants unchanged (create or replace keeps them): execute for authenticated and service_role only; the function checks for a manager.
