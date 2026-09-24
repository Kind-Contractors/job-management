-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation. This repo previously had no file for
-- this version at all.

ALTER TABLE jobs DROP CONSTRAINT jobs_source_file_check;

ALTER TABLE jobs ADD CONSTRAINT jobs_source_file_check
  CHECK (source_file = ANY (ARRAY[
    'gen_details'::text,
    'spec_details'::text,
    'contractx'::text,
    'manager_created'::text
  ]));
