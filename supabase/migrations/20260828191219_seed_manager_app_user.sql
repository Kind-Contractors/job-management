-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation. This repo previously had no file for
-- this version at all.

-- Provision the first Manager app_users row for the existing Supabase Auth user
-- ai@kindcontractors.co.uk, approved as-is: role manager, display_name NULL,
-- is_active true. No other change.
insert into public.app_users (id, role, display_name, is_active)
values ('c5e6d779-f416-497a-ab7b-a9375b6267af', 'manager', null, true);
