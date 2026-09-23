-- ============================================================================
-- ONE-TIME TEST DATA CLEANUP SCRIPT — NOT A MIGRATION
-- ============================================================================
-- This file must NEVER be placed in supabase/migrations/ and must never be
-- run by any automated migration tool. It is for a human to read, review,
-- and run manually, once, directly against the database (e.g. via the
-- Supabase SQL editor or `psql`), after re-confirming the pre-flight
-- assertions below still hold.
--
-- Prepared from the read-only deletion-safety audit + a follow-up re-query
-- (2026-09-21) that confirmed the exact rows below. NOT YET EXECUTED.
--
-- SCOPE — exactly two confirmed test clients and three confirmed
-- test-only technicians. Every DELETE below targets an explicit, hardcoded
-- UUID list — never a name/ILIKE pattern — so it is structurally
-- impossible for this script to touch any row other than the ones
-- enumerated here, even if unrelated real data is later given a similar
-- name.
--
--   Client: "ZZZ TEST — DELETE BEFORE LAUNCH"  (a48ffb0c-caae-4986-a2f6-818760b9cf1c)
--     Buildings:
--       "ZZZ TEST BUILDING — DELETE BEFORE LAUNCH" (43dfa891-397a-4418-a755-114cfa7757fc) — 3 jobs, 1 building_access row
--       "zzz test building 2"                      (73f49dad-3670-485d-a138-5d3d4d80d4b7) — 0 jobs
--     Contact: "Moureen" (dc1c3e5c-fc96-4772-9cfe-fc917075fb81)
--
--   Client: "Test Client - Mo"  (8942648f-1503-4453-815f-4985a6301420)
--     Building: "Test Building - Mo" (aa0e5603-3d2a-4a9a-aaa9-77f47c8877d8) — 3 jobs, 0 building_access rows
--     Contact: "Moureen" (28e886b0-c47a-494b-9760-2933d6ce1c9b)
--
--   6 jobs / 11 visits / 8 reports / 20 photos / 5 invoices (all status
--   'failed', none sent/sending) / 5 invoice_line_items / 4
--   report_client_sends (cascade automatically with their reports).
--
--   3 technicians, each re-verified (by tracing every one of their
--   visit/job assignments) to have ZERO footprint outside these two
--   clients: "ZZZ TEST TECHNICIAN" (de19b5d2-6298-4612-a2ea-448e3787930f),
--   "Test Tech" (8b5057a6-5e47-40df-a05d-5c9418ccb995),
--   "Test Technician" (a4af4a63-57df-42de-98f5-9f5b21042e1e).
--
-- NOT COVERED BY THIS SCRIPT (separate, manual follow-up):
--   - 20 Storage objects in the 'visit-photos' bucket (one per photo row
--     deleted below). Deleting a `photos` row does NOT delete the
--     underlying file — remove these via the Storage API/dashboard, not
--     a raw SQL DELETE against storage.objects.
--   - The `app_users`/auth.users login rows linked to the 3 technicians
--     (technicians.app_user_id). Removing a login is a separate, more
--     sensitive action (Supabase Auth Admin API, not plain SQL) and was
--     deliberately left out of this script's scope — decide separately
--     whether these three test logins should also be removed.
--   - `activity_events` rows referencing any of the entities below. This
--     table has no foreign key to anything (confirmed), so nothing here
--     will fail because of it — the rows are simply left as orphaned
--     historical log entries, exactly like the audit described.
-- ============================================================================

BEGIN;

-- ---- Pre-flight assertions: abort and roll back everything below if ----
-- ---- reality has drifted from what this script assumes. ----
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM clients
    WHERE id = 'a48ffb0c-caae-4986-a2f6-818760b9cf1c' AND company_name = 'ZZZ TEST — DELETE BEFORE LAUNCH';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Aborting: ZZZ TEST client id/name mismatch — re-audit before proceeding'; END IF;

  SELECT count(*) INTO v_count FROM clients
    WHERE id = '8942648f-1503-4453-815f-4985a6301420' AND company_name = 'Test Client - Mo';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Aborting: Test Client - Mo id/name mismatch — re-audit before proceeding'; END IF;

  -- Every scoped technician must still be confined to only the 6 scoped
  -- test jobs (no visit, and no default-technician job, outside them) —
  -- otherwise deleting these jobs/visits would strand a technician who
  -- also has real, non-test work.
  IF EXISTS (
    SELECT 1 FROM visits WHERE technician_id IN (
      '8b5057a6-5e47-40df-a05d-5c9418ccb995', 'de19b5d2-6298-4612-a2ea-448e3787930f', 'a4af4a63-57df-42de-98f5-9f5b21042e1e'
    ) AND job_id NOT IN (
      'c327be08-249c-4d9e-8c88-e7e1c33abc2c', 'dd1755bc-1493-40b3-a452-d650cba6389b', '6b38e4cd-ca01-4f60-aa3b-6505cbfc8b66',
      '44316954-2b3e-4526-85ad-deba6056b106', '6b2d28ec-4b51-4b46-996e-932a7da354b0', '37e2ff01-e02b-406a-be22-1302680a9858'
    )
  ) THEN
    RAISE EXCEPTION 'Aborting: a scoped technician now has a visit outside the scoped test jobs — re-audit before proceeding';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jobs WHERE default_technician_id IN (
      '8b5057a6-5e47-40df-a05d-5c9418ccb995', 'de19b5d2-6298-4612-a2ea-448e3787930f', 'a4af4a63-57df-42de-98f5-9f5b21042e1e'
    ) AND id NOT IN (
      'c327be08-249c-4d9e-8c88-e7e1c33abc2c', 'dd1755bc-1493-40b3-a452-d650cba6389b', '6b38e4cd-ca01-4f60-aa3b-6505cbfc8b66',
      '44316954-2b3e-4526-85ad-deba6056b106', '6b2d28ec-4b51-4b46-996e-932a7da354b0', '37e2ff01-e02b-406a-be22-1302680a9858'
    )
  ) THEN
    RAISE EXCEPTION 'Aborting: a scoped technician is the default technician on a job outside the scoped test jobs — re-audit before proceeding';
  END IF;

  -- None of the scoped invoices may have moved to sent/sending since the audit.
  SELECT count(*) INTO v_count FROM invoices
    WHERE id IN (
      '533bbae4-baab-4ca4-bd9b-8db5b9608d5a', '3ddf996f-dfbb-4aa2-bdfd-344a9287941e', '8276681c-e4eb-44bc-b3df-c0fbfb453592',
      'e539d4a6-dd64-494d-ad69-be7d6d0a3ef1', 'f44d3bb8-0161-442f-9786-708cfcc17cde'
    ) AND status IN ('sent', 'sending');
  IF v_count <> 0 THEN RAISE EXCEPTION 'Aborting: a scoped invoice is now sent/sending — never delete a sent invoice'; END IF;

  -- Exact row-count assertions matching the audit — if anything was
  -- added to (or removed from) these test jobs/visits since, stop rather
  -- than silently deleting a different amount than was reviewed.
  SELECT count(*) INTO v_count FROM visits WHERE job_id IN (
    'c327be08-249c-4d9e-8c88-e7e1c33abc2c', 'dd1755bc-1493-40b3-a452-d650cba6389b', '6b38e4cd-ca01-4f60-aa3b-6505cbfc8b66',
    '44316954-2b3e-4526-85ad-deba6056b106', '6b2d28ec-4b51-4b46-996e-932a7da354b0', '37e2ff01-e02b-406a-be22-1302680a9858'
  );
  IF v_count <> 11 THEN RAISE EXCEPTION 'Aborting: expected exactly 11 visits under the scoped test jobs, found %', v_count; END IF;

  SELECT count(*) INTO v_count FROM reports WHERE visit_id IN (
    '1bfe9837-1d5f-4530-ac39-551ea40f3435', 'ed476e1d-0742-46a1-8b4d-56dc043d9e9c', '01544d10-8cd0-45fb-af81-9363309728ff',
    '7babda44-6cce-45a8-9be2-4b11e6756a2f', '86410509-817e-417f-a9e9-952ee6529142', 'c712ee8d-c4f4-416f-a25c-cc183ddcf9a1',
    '6ad59f78-1afb-41cb-a7cb-bc9f286c0a5f', '996ea373-cf21-462f-8a39-122786c9f923', '4f93cb23-c3f7-47ac-9781-6d53d9a857ec',
    '005c7ba0-b416-4399-8e81-12657ed2b828', 'c0d60294-c8ac-4dfa-82d4-8fc63fbfdb79'
  );
  IF v_count <> 8 THEN RAISE EXCEPTION 'Aborting: expected exactly 8 reports under the scoped test visits, found %', v_count; END IF;

  SELECT count(*) INTO v_count FROM photos WHERE report_id IN (
    '4f2f3f07-3317-40b3-bf55-d3fbbc5b6669', '9a53a2ac-a230-4543-a258-3d8e293ba3c0', 'de849563-5531-4741-9bfd-3f0795b076ac',
    '7a407047-d4d9-4318-b8f3-d9025caf55cf', 'ddfad9e0-09a8-4ad5-8f3d-46974beba979', '9516f9ae-eef4-4484-a7e7-f6d2d51ab7f4',
    '84c72bd1-2dd3-4eb7-a94c-8ac2c9a5306a', 'fd2aa923-720e-4304-9204-b0cce6bed5a1'
  );
  IF v_count <> 20 THEN RAISE EXCEPTION 'Aborting: expected exactly 20 photos under the scoped test reports, found %', v_count; END IF;
END $$;

-- ---- 1. Photos (nothing references a photo — always the safe leaf) ----
DELETE FROM photos WHERE id IN (
  '34ff7774-4add-47ea-81fb-aa871bd5e30a', '55d9bf0d-1e67-40b9-8351-1e9eb5e244ea', '38f93681-de2e-4483-b0d5-3ae55676c451',
  'c7ee79dc-2fc2-4c25-8588-b1fe25ef3666', 'bb1e721b-e417-4275-9abf-67a4eab81ac8', '507e55fc-4f08-4b63-981f-af8bb4a22cd1',
  'b04a7ff2-e760-47fb-861a-60ee7ec99cdc', '3087d104-1df2-426d-abfb-0ec8de2ca5e2', '9d44330f-8dba-4b84-8591-454e3d9b1adc',
  'a512bbd1-77f3-4eb8-97e4-32e7c751c61d', '24e69ab9-3d56-477a-b148-3e9942aaa3cd', '95aeefb1-6999-47cb-ba93-3b898ce7da56',
  '7524a204-c6cd-4adc-915e-0485c92e1a86', '51295844-e8af-4107-91e2-1098ea95a759', '4cc82bfd-a29b-4d51-9754-8171fda9b33f',
  '6053f1fc-198c-4a26-895f-0ececd8f2c7f', 'e67f74d6-37d9-482c-baa4-63db81282537', '46c56eb9-27a9-4c93-a016-29fd4bde6962',
  '2aa6416c-6943-4080-a10e-2c0ae1d36a1c', '421ffbbd-3cf2-46d2-b030-08bd297c54e0'
);
-- Expect exactly 20 rows deleted.

-- ---- 2. Reports (report_client_sends cascades automatically — 4 rows) ----
DELETE FROM reports WHERE id IN (
  '4f2f3f07-3317-40b3-bf55-d3fbbc5b6669', '9a53a2ac-a230-4543-a258-3d8e293ba3c0', 'de849563-5531-4741-9bfd-3f0795b076ac',
  '7a407047-d4d9-4318-b8f3-d9025caf55cf', 'ddfad9e0-09a8-4ad5-8f3d-46974beba979', '9516f9ae-eef4-4484-a7e7-f6d2d51ab7f4',
  '84c72bd1-2dd3-4eb7-a94c-8ac2c9a5306a', 'fd2aa923-720e-4304-9204-b0cce6bed5a1'
);
-- Expect exactly 8 rows deleted.

-- ---- 3. Invoices (invoice_line_items cascades automatically — 5 rows) ----
DELETE FROM invoices WHERE id IN (
  '533bbae4-baab-4ca4-bd9b-8db5b9608d5a', '3ddf996f-dfbb-4aa2-bdfd-344a9287941e', '8276681c-e4eb-44bc-b3df-c0fbfb453592',
  'e539d4a6-dd64-494d-ad69-be7d6d0a3ef1', 'f44d3bb8-0161-442f-9786-708cfcc17cde'
);
-- Expect exactly 5 rows deleted.

-- ---- 4. Visits ----
DELETE FROM visits WHERE id IN (
  '1bfe9837-1d5f-4530-ac39-551ea40f3435', 'ed476e1d-0742-46a1-8b4d-56dc043d9e9c', '01544d10-8cd0-45fb-af81-9363309728ff',
  '7babda44-6cce-45a8-9be2-4b11e6756a2f', '86410509-817e-417f-a9e9-952ee6529142', 'c712ee8d-c4f4-416f-a25c-cc183ddcf9a1',
  '6ad59f78-1afb-41cb-a7cb-bc9f286c0a5f', '996ea373-cf21-462f-8a39-122786c9f923', '4f93cb23-c3f7-47ac-9781-6d53d9a857ec',
  '005c7ba0-b416-4399-8e81-12657ed2b828', 'c0d60294-c8ac-4dfa-82d4-8fc63fbfdb79'
);
-- Expect exactly 11 rows deleted.

-- ---- 5. Jobs (no schedules exist for any of these — confirmed, nothing to remove there) ----
DELETE FROM jobs WHERE id IN (
  'c327be08-249c-4d9e-8c88-e7e1c33abc2c', 'dd1755bc-1493-40b3-a452-d650cba6389b', '6b38e4cd-ca01-4f60-aa3b-6505cbfc8b66',
  '44316954-2b3e-4526-85ad-deba6056b106', '6b2d28ec-4b51-4b46-996e-932a7da354b0', '37e2ff01-e02b-406a-be22-1302680a9858'
);
-- Expect exactly 6 rows deleted.

-- ---- 6. Building access ----
DELETE FROM building_access WHERE building_id IN (
  '43dfa891-397a-4418-a755-114cfa7757fc'
);
-- Expect exactly 1 row deleted.

-- ---- 7. Buildings ----
DELETE FROM buildings WHERE id IN (
  '43dfa891-397a-4418-a755-114cfa7757fc', '73f49dad-3670-485d-a138-5d3d4d80d4b7', 'aa0e5603-3d2a-4a9a-aaa9-77f47c8877d8'
);
-- Expect exactly 3 rows deleted.

-- ---- 8. Contacts ----
DELETE FROM contacts WHERE id IN (
  'dc1c3e5c-fc96-4772-9cfe-fc917075fb81', '28e886b0-c47a-494b-9760-2933d6ce1c9b'
);
-- Expect exactly 2 rows deleted.

-- ---- 9. Clients ----
DELETE FROM clients WHERE id IN (
  'a48ffb0c-caae-4986-a2f6-818760b9cf1c', '8942648f-1503-4453-815f-4985a6301420'
);
-- Expect exactly 2 rows deleted.

-- ---- 10. Technicians ----
DELETE FROM technicians WHERE id IN (
  '8b5057a6-5e47-40df-a05d-5c9418ccb995', 'de19b5d2-6298-4612-a2ea-448e3787930f', 'a4af4a63-57df-42de-98f5-9f5b21042e1e'
);
-- Expect exactly 3 rows deleted.

COMMIT;
-- Review every "expect exactly N rows" comment above against the actual
-- rowcount Postgres reports for each statement before trusting this ran
-- correctly. If any assertion in the DO block above raised, NOTHING was
-- deleted (the whole transaction rolled back).
