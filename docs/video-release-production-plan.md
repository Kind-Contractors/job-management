# Report videos - production release plan (NOT EXECUTED)

Production project: `rgcxybsnoqjnbywzycfx`. **Nothing here has been run against production.** DEV (`oewjoxttcxrgwhqcstqc`) has had all of it applied
and verified (2026-10-12). Every production step below needs your explicit approval first, and every database change is a single guarded
transaction that stops if the state differs from what is expected.

## 0. What could not be checked yet (needs production access)

The CLI token in use can see **only the DEV project**, so the production state below is unverified. Run section 1 first and stop if anything differs.

## 1. Read-only prechecks (production)

1. `supabase_migrations.schema_migrations`: newest version is `20261008100000` (cancel work) or later; **none** of `20261012130000`, `20261012140000`, `20261012140100`, `20261013100000`, `20261013110000` are recorded.
2. `to_regclass('public.report_videos')`, `to_regclass('public.report_video_links')`, `to_regclass('public.watch_rate_limits')` are all NULL; `reports.include_videos` does not exist; bucket `report-videos` does not exist.
3. `visit-photos` bucket: record its current `file_size_limit` and `public` (expected private). Record the project-wide upload limit (expected 50 MiB).
4. Edge Functions list: `send-client-report` is the version in the repo (compare to the source that is about to be released); neither `issue-report-video-links` nor `watch-report-video` exists. Secret names: `RESEND_API_KEY`, `RESEND_FROM_EMAIL` exist; `VIDEO_LINK_SECRET` does not.
5. Take the object fingerprint (`dev-object-snapshot.sql` style: functions + privileges, policies, triggers, buckets, columns, grants) and the row counts, and save them. All later steps are compared with it.
6. Confirm a recent backup / restore point exists for the production database (Supabase dashboard > Database > Backups).

## 2. Security hotfix first (independent of videos)

`20261012140000_current_technician_id_active_only.sql` - one `CREATE OR REPLACE FUNCTION private.current_technician_id()`; privileges unchanged; no table touched.
It stops a **deactivated** technician login from still being able to call `technician_submit_report`, `technician_resubmit_report` and
`technician_delete_photo` for visits already assigned to them (confirmed on DEV). It has no dependency on the video migrations, so it can ship
alone and earlier. Verify afterwards: the function body matches DEV's, and a deactivated test login (created for the purpose) gets "not a
technician" from those three functions. Roll back = `CREATE OR REPLACE` with the previous body (saved in the pre-step snapshot).

## 3. Storage configuration (before the video migrations)

Order is deliberate - the photos bucket must be capped **before** the project-wide limit is raised, or photos would silently become allowed up to 250 MiB:

1. Set the existing `visit-photos` bucket `file_size_limit` explicitly to **52,428,800** (50 MiB). Verify it reads back.
2. Raise the project-wide upload limit from 50 MiB to **250 MiB** (dashboard > Storage > Settings; this is a project setting, not SQL).
3. The `report-videos` bucket is created by migration `20261012130000` (private, 157,286,400 = 150 MiB, MIME allow-list `video/mp4, video/quicktime, video/webm, image/jpeg`) - nothing to do by hand. Verify the three settings after the migration.

## 4. Database migrations, in this order

Each is applied with a guarded one-transaction script that also records the migration's exact version (the same method used for DEV), and is
followed by a fingerprint comparison: only the intended objects may differ.

| # | Migration | Adds | Depends on |
|---|---|---|---|
| 1 | `20261012130000_report_videos_foundation` | `report_videos`, `report_video_links`, `reports.include_videos`, private bucket, technician/manager functions, policies, triggers | `20261008100000` |
| 2 | `20261012140000_current_technician_id_active_only` | (already done in step 2) | - |
| 3 | `20261012140100_report_videos_hardening` | stricter limits/guards, soft-delete + revocation, storage policies | #1 |
| 4 | `20261013100000_report_video_link_reuse` | `token_scheme`, link plan + register functions | #3 |
| 5 | `20261013110000_watch_rate_limits` | rate-limit counter table + 2 functions (service role only) | #4 |
| 6 | `20261014100000_report_video_default_included` | one column default: videos are included for the client by default (no existing row changes) | #1 |

Rehearsal done: #1-#4 on a local Postgres 17 container and on DEV (regression suites 159/159 + 25/25); #5 on local (9/9 behaviour, privileges) and DEV; #6 on local (existing video rows keep their flags; refused out of order or twice) and DEV. The production kit scripts `prod-apply-01` to `prod-apply-06` are the same files rehearsed together on a database built to production's pre-video state.

## 5. Secret and Edge Functions (production)

1. Generate a **new, production-only** `VIDEO_LINK_SECRET` (>= 32 random characters) in memory; set it from a temp `--env-file` that is deleted straight after; never print it, never commit it, never reuse DEV's.
2. `supabase functions deploy issue-report-video-links --project-ref rgcxybsnoqjnbywzycfx` (JWT verification **on**).
3. `supabase functions deploy watch-report-video --no-verify-jwt --project-ref rgcxybsnoqjnbywzycfx` (public by design).
4. Do **not** set `WATCH_RATE_LIMIT_PER_MINUTE` / `WATCH_FAILURE_LIMIT_PER_10_MIN` (defaults 60 per minute / 10 failures per 10 minutes).
5. `send-client-report` needs no change (unchanged in git since its last release).
6. Verify the list shows `verify_jwt = true` for the issuing function and `false` for the watch function.

## 6. Frontend

**Before merging:** `main` has moved on since this plan was written (`e1fe370`, a mobile-logout change committed directly on `main`), so `dev` can no longer fast-forward into it. Merge `origin/main` into `dev` first (expected to be clean: it touches `TopBar.tsx`, a new `LogoutButton.tsx` and a new test), re-run the tests and build, then fast-forward `main`. `dev` now also carries the delete-confirmation popup commit and the Report Review changes (autosave instead of a Save button, no report-level video switch, manager photo add/remove).

Merge the reviewed commit(s) from `dev` to `main`, build (`npm run build`), deploy the build **after** steps 2-5 (the app calls the issuing function when a PDF is
downloaded or emailed; without the function that action stops with a clear message). The only new dependency is `tus-js-client`.

## 7. Post-release smoke tests (production)

Use one clearly labelled fixture (`ZZ Release Smoke ...`) created through the app, with an explicit list of what to remove afterwards, and the real
manager login; no real client contact unless you choose one.

1. Public endpoint: bad token, no token, wrong method -> identical 404; 11th failure from one address -> 429.
2. Manager: upload a small video to a report, tick it for the client, approve, **Download PDF**: thumbnail + play + "Watch video" + 6 annotations for 3 videos (or 2 for 1 video); the link plays and seeks on a real phone.
3. Return the report for correction -> link stops; re-approve -> same link works.
4. Photo-only report -> PDF unchanged, no link request made.
5. Technician (one real technician, supervised): upload a video offline then online, attach, submit a report; photo-only submit still works.
6. Send to a **test address you nominate** (the manager UI's real email path) and open the link from the received PDF.
7. Existing flows: submission, resubmission, completion, cancellation unchanged (spot check).

## 8. Rollback and recovery

* **Fastest stop for client links:** delete the `watch-report-video` function (`supabase functions delete watch-report-video --project-ref ...`) - every link in every PDF stops immediately; or revoke all links in the database (`update report_video_links set revoked_at = now(), revoked_by = 'rollback' where revoked_at is null`). Both are reversible (redeploy / links are not deleted).
* **Stop new links:** unset `VIDEO_LINK_SECRET`, or delete `issue-report-video-links` (downloads of reports that contain videos then stop with the clear message; photo-only reports are unaffected).
* **Frontend:** redeploy the previous build.
* **Database:** every migration is additive. While no real videos exist the scripts in the release kit can drop the new objects; **once real videos exist, do not drop tables** - use the switches above (and `reports.include_videos = false` per report) instead. Restore from the pre-release backup only as a last resort.
* **Secret rotation:** set a new `VIDEO_LINK_SECRET`; new links are issued automatically; links already in sent PDFs stay valid until they expire (their hashes are in the database).
* **Hotfix #2** can be reverted by re-applying the previous function body (saved in the pre-step snapshot).

## 9. Known limits to accept before release

* Rate limiting is per address and database-backed; a distributed attacker needs a WAF rule in front (see `docs/client-video-links.md`).
* Anyone holding a link can watch until it expires (365 days) or the report is returned/links revoked; the PDF is the credential carrier.
* Link-scanner bots count as "opens" (informational).
* Printed PDFs cannot be clicked (QR codes are out of scope).
* Real-phone playback, real email delivery, and the technician app's full browser flow on a real handset have **not** been tested yet (see the DEV verification report).
