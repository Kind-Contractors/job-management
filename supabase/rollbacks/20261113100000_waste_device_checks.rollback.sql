-- ROLLBACK of supabase/migrations/20261113100000_waste_device_checks.sql - run BY HAND, as ONE transaction, never by a tool.
--
-- Removes the Waste Reports device compatibility check's function and table. The stored checks are DELETED (technical diagnostics,
-- kept 30 days at most - export first if any are still needed). Nothing else is touched. Remove the app's "Device compatibility
-- check" (src/waste/DeviceCheckPage.tsx and its link/route) first, then run this, then:
--   supabase migration repair --status reverted 20261113100000
begin;

drop function if exists public.waste_submit_device_check(jsonb);
drop table if exists public.waste_device_checks;

commit;
