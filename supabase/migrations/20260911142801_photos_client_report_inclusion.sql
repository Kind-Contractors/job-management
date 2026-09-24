-- Adds per-photo client-report selection, for the new "Ready for Client"
-- Manager workflow (ReadyForClientPage.tsx). Defaults to true (every
-- existing photo stays effectively "included" until a Manager actively
-- deselects one) so no existing data changes meaning on upgrade. Purely
-- additive: a not-null boolean with a default, no backfill needed, no
-- existing query affected (every current SELECT on `photos` lists
-- explicit columns, none of which need to change to keep working).
--
-- Applied directly via the Supabase MCP (version 20260911142801); this
-- file mirrors that applied migration for the repo's own history.
alter table public.photos
  add column include_in_client_report boolean not null default true;

comment on column public.photos.include_in_client_report is
  'Whether this photo is included when a Manager sends this report''s '
  'client-facing summary (see ReadyForClientPage.tsx). Defaults to true. '
  'Never affects the technician-facing report review flow.';
