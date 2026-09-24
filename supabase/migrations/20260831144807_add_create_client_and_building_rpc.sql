-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation. This repo previously had no file for
-- this version at all.

create or replace function public.create_client_and_building(
  p_company_name text,
  p_address text,
  p_name text default null,
  p_postcode text default null,
  p_invoice_details text default null,
  p_extra_requirements text default null
) returns table (client_id uuid, building_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_client_id uuid;
  v_building_id uuid;
begin
  insert into clients (company_name) values (p_company_name) returning id into v_client_id;
  insert into buildings (client_id, address, name, postcode, invoice_details, extra_requirements)
    values (v_client_id, p_address, p_name, p_postcode, p_invoice_details, p_extra_requirements)
    returning id into v_building_id;
  return query select v_client_id, v_building_id;
end;
$$;

grant execute on function public.create_client_and_building(text, text, text, text, text, text) to authenticated;
