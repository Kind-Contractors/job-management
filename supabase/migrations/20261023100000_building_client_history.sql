-- Changing a building's client (management company), with a permanent record of each change.
--
-- NOT APPLIED to any database when written. Apply to DEV first, and only after review. Must be applied BEFORE the frontend
-- that offers "Change client" goes live (it calls change_building_client).
--
-- Why one function: a building's client is the only stored link between a building and a client - jobs, visits, reports and
-- invoices reach their client through the building - and the building's default invoice recipient must be a contact of that
-- client (buildings_default_recipient_guard). So the change, clearing the old default recipient, and the history row must
-- happen together or not at all.
--
-- What it does NOT do: move or copy any contact or Xero link (contacts stay with the client they belong to); change any job,
-- visit, report or invoice row; or invent history for earlier changes (only changes made through this function are recorded).
-- Additive: one new table (manager read-only; written only by the functions), two functions - change to an existing client, or
-- to a client created in the same step. Nothing existing is altered, and no client, contact or record is ever deleted.

create table if not exists public.building_client_history (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings (id) on delete restrict,
  previous_client_id uuid not null references public.clients (id) on delete restrict,
  new_client_id uuid not null references public.clients (id) on delete restrict,
  changed_at timestamptz not null default now(),
  changed_by text not null,
  -- True when the building had a default invoice recipient (a contact of the previous client) that was cleared by the change.
  default_recipient_cleared boolean not null default false,
  constraint building_client_history_distinct_check check (previous_client_id <> new_client_id)
);

comment on table public.building_client_history is
  'One row per change of a building''s client (management company), written only by change_building_client(). Starts empty: '
  'changes made before it existed were never recorded and are not reconstructed. Managers can read it; nobody can edit it.';

create index if not exists building_client_history_building_idx on public.building_client_history (building_id, changed_at desc);

-- Managers read the history; rows are written only by the function below. Explicit grants (not the platform defaults): signed-in
-- users may only SELECT, and the policy limits that to managers; nobody but the function can insert, edit or delete a row.
alter table public.building_client_history enable row level security;
drop policy if exists manager_read on public.building_client_history;
create policy manager_read on public.building_client_history
  for select using (private.current_app_role() = 'manager');
revoke all on public.building_client_history from public, anon, authenticated;
grant select on public.building_client_history to authenticated;
grant all on public.building_client_history to service_role;

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

revoke execute on function public.change_building_client(uuid, uuid, uuid) from public, anon;
grant execute on function public.change_building_client(uuid, uuid, uuid) to authenticated, service_role;

-- The same change, to a client created now. One call: the client is created and the building changed together, so a refusal
-- (unfinished invoices, a stale page, a duplicate name...) never leaves a new client behind. A client needs only its company name
-- (clients.company_name, NOT NULL); a name that already exists, ignoring case and spacing, is refused so the existing client is
-- chosen instead of a duplicate being made. Concurrent requests for the same name are serialised by a transaction lock.
create or replace function public.change_building_client_to_new_client(
  p_building_id uuid,
  p_company_name text,
  p_expected_client_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_key text;
  v_existing text;
  v_new_id uuid;
  v_result jsonb;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.' using errcode = 'P0001';
  end if;
  v_name := regexp_replace(btrim(coalesce(p_company_name, '')), '\s+', ' ', 'g');
  if v_name = '' then
    raise exception 'Enter the new client''s company name.' using errcode = 'P0001';
  end if;
  if char_length(v_name) > 200 then
    raise exception 'The company name is too long (200 characters at most).' using errcode = 'P0001';
  end if;
  v_key := lower(v_name);
  perform pg_advisory_xact_lock(hashtext('new_client:' || v_key));
  select company_name into v_existing from clients where lower(regexp_replace(btrim(company_name), '\s+', ' ', 'g')) = v_key limit 1;
  if found then
    raise exception 'A client named "%" already exists. Choose it under "Existing client" instead of creating a duplicate. Nothing was changed.', v_existing
      using errcode = 'P0001';
  end if;

  insert into clients (company_name) values (v_name) returning id into v_new_id;
  -- Every check, the building update and the history row are change_building_client's; if it refuses, the whole call - this new
  -- client included - is rolled back.
  v_result := public.change_building_client(p_building_id, v_new_id, p_expected_client_id);
  return v_result || jsonb_build_object('newClientName', v_name, 'clientCreated', true);
end;
$$;

revoke execute on function public.change_building_client_to_new_client(uuid, text, uuid) from public, anon;
grant execute on function public.change_building_client_to_new_client(uuid, text, uuid) to authenticated, service_role;
