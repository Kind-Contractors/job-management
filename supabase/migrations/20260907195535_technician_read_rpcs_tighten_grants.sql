-- PRODUCTION MIGRATION — recovered verbatim from production's
-- supabase_migrations.schema_migrations.statements during the 2026-09-24
-- migration-history reconciliation. This repo previously had no file for
-- this version at all.

-- Supabase's default-privileges automation grants EXECUTE to anon/service_role
-- on every newly created public-schema function, separately from the plain
-- `REVOKE ALL ... FROM PUBLIC` already in the prior migration (which only
-- strips the PUBLIC pseudo-role's own entry, not anon's separately-granted
-- one). Not a data leak — technician_today_visits()/technician_visit_detail()
-- already return zero rows for anon (current_app_role() resolves to null
-- with no JWT) — but tightened anyway to match the intended minimal surface:
-- only `authenticated` should ever be able to call these.

revoke execute on function public.technician_today_visits() from anon;
revoke execute on function public.technician_visit_detail(uuid) from anon;
