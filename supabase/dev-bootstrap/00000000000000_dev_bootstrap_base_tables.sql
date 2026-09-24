-- DEV-ONLY BOOTSTRAP — not part of the real repository, not for production.
--
-- Recreates public.clients, public.buildings, public.jobs (and the
-- public.job_type enum) exactly as they existed immediately BEFORE
-- 20260828120000_production_domain_model.sql ever ran. In production these
-- three tables (and job_type) were created by the separate Data Manager app,
-- outside this repo's supabase/migrations/ history entirely — this repo's
-- migrations have only ever assumed they already exist.
--
-- Reconstructed by reading production's CURRENT live schema (read-only
-- introspection, 2026-09-22) and subtracting every column this repo's own
-- 21 migrations add or rename, so each migration's ADD COLUMN/RENAME COLUMN
-- lands exactly once, in the same order, producing the same end state as
-- production:
--   - buildings.name, buildings.postcode: added by
--     20260828120000_production_domain_model.sql -- excluded here.
--   - buildings.key_access_notes: dropped by that same migration inside an
--     `IF EXISTS` guard -- safely omitted; nothing to copy on an empty table.
--   - clients.xero_contact_id: added by 20260907130000_invoicing.sql --
--     excluded here.
--   - jobs.pricing_type/price_per_visit/frequency_type/lifecycle_status/
--     lost_reason/recontact_*: added by
--     20260828120000_production_domain_model.sql -- excluded here.
--   - jobs.default_technician_id: added AS default_team_id by
--     20260828120000_production_domain_model.sql, then renamed by
--     20260907150000_rename_teams_to_technicians.sql -- excluded here
--     entirely (must not pre-exist under either name, or the later RENAME
--     COLUMN would fail against an already-existing target name).
--   - jobs.frequency_normalised: untouched by any migration in this repo --
--     included here as genuinely pre-existing.
--
-- Verified against production (read-only queries against
-- information_schema/pg_constraint/pg_enum only -- no row data read):
--   - buildings_client_id_fkey and jobs_building_id_fkey are both ON DELETE
--     RESTRICT.
--   - job_type enum values are exactly ('general', 'specialist').

create type public.job_type as enum ('general', 'specialist');

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  contact_name text,
  email text,
  accounts_email text,
  phone_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete restrict,
  address text not null,
  invoice_details text,
  extra_requirements text,
  who text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings (id) on delete restrict,
  job_type public.job_type not null,
  job_summary text,
  job_notes text,
  frequency_raw text,
  frequency_normalised text,
  charge_per_visit_raw text,
  monthly_invoice_raw text,
  yearly_total_raw text,
  status_notes text,
  source_job_id text,
  source_file text not null,
  source_gen_details_row integer,
  source_spec_details_row integer,
  source_contractx_row integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- _data_migration_runs: the idempotency-guard marker table normally created
-- by 20260829091500_data_migration.sql (the excluded data migration).
-- 20260829120000_auth_rls_policies.sql independently assumes this table
-- already exists (it enables RLS on it, with zero policies). Discovered via
-- a real local Docker migration replay: "relation public._data_migration_runs
-- does not exist" at that migration's statement 10. Contains zero business
-- data either way -- just an id/timestamp bookkeeping row -- left empty here
-- (no row inserted), which is also more accurate for dev: the real data
-- migration genuinely has not been applied.
create table if not exists public._data_migration_runs (
  id text primary key,
  applied_at timestamptz not null default now()
);
