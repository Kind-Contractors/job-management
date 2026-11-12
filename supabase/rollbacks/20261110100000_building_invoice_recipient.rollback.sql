-- ROLLBACK for supabase/migrations/20261110100000_building_invoice_recipient.sql. NOT a migration: kept outside
-- supabase/migrations/ so no tool applies it. Run by hand only if the change must be undone, as one transaction, DEV first.
--
-- It refuses (and changes nothing) while any building has a recipient chosen WITHOUT a contact: the old rule cannot hold such a
-- row, and removing it silently would lose a manager's choice. Clear those recipients in the app first (or re-choose them through
-- a contact); this script never deletes or rewrites a recipient. Contact-based defaults are kept exactly as they are.
-- The four detail columns are dropped: their content is display/audit only, never authoritative (for contact-based defaults the
-- name is the contact's own link name, which stays on the contact; email/when/who did not exist before this migration).
-- Data kept: every building's contact, Xero id and organisation; every contact and its link; every invoice. Nothing else is touched.
-- Edge Functions / frontend that write the new columns must be rolled back FIRST (they would fail on the dropped columns).

begin;

do $$
declare
  v_n integer;
begin
  select count(*) into v_n from public.buildings
  where default_invoice_xero_contact_id is not null and default_invoice_contact_id is null;
  if v_n > 0 then
    raise exception 'rollback_refused: % building(s) have an invoice recipient chosen without a contact. Clear them in the app first; nothing was changed.', v_n;
  end if;
end;
$$;

drop trigger if exists buildings_invoice_recipient_details on public.buildings;
drop function if exists public.buildings_invoice_recipient_details();
drop function if exists public.set_building_invoice_recipient(uuid, text, text, text, text, text, text, text);
drop function if exists public.clear_building_invoice_recipient(uuid, text, text);

alter table public.buildings drop constraint if exists buildings_default_invoice_recipient_complete;
alter table public.buildings drop constraint if exists buildings_default_invoice_recipient_all_or_none;
alter table public.buildings add constraint buildings_default_invoice_recipient_all_or_none check (
  (default_invoice_contact_id is null and default_invoice_xero_contact_id is null and default_invoice_xero_org_id is null)
  or (default_invoice_contact_id is not null
      and nullif(btrim(coalesce(default_invoice_xero_contact_id, '')), '') is not null
      and nullif(btrim(coalesce(default_invoice_xero_org_id, '')), '') is not null)
);

alter table public.buildings drop column if exists default_invoice_xero_contact_name;
alter table public.buildings drop column if exists default_invoice_xero_contact_email;
alter table public.buildings drop column if exists default_invoice_set_at;
alter table public.buildings drop column if exists default_invoice_set_by;

comment on column public.buildings.default_invoice_contact_id is 'The local contact chosen as this building''s default invoice recipient. Must belong to the building''s client (enforced by trigger). NULL = no default: invoices for this building need a recipient chosen each time.';
comment on column public.buildings.default_invoice_xero_contact_id is 'The Xero ContactID that contact was linked to WHEN it was chosen. Compared with the contact''s current link whenever the default is used, so a changed link can never silently change who is invoiced.';
comment on column public.buildings.default_invoice_xero_org_id is 'The Xero organisation that ContactID belongs to. A default is only used against that same organisation.';

-- change_building_client exactly as in 20261023100000_building_client_history.sql.
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

  -- The default invoice recipient is a contact of the previous client, so it cannot stay: it is cleared in the same update.
  v_cleared := v_building.default_invoice_contact_id is not null;
  update buildings
  set client_id = p_new_client_id,
      default_invoice_contact_id = null,
      default_invoice_xero_contact_id = null,
      default_invoice_xero_org_id = null,
      updated_at = now()
  where id = p_building_id;

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

commit;
