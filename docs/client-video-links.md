# Client video links and the PDF

How a client watches the videos in a service report, and how the PDF links to them.

**Status (2026-10-12):** applied, deployed and verified live on **DEV only** (migrations `20261013100000_report_video_link_reuse` and
`20261013110000_watch_rate_limits`, secret `VIDEO_LINK_SECRET`, both Edge Functions). **Nothing is on production yet** - see
`docs/video-release-production-plan.md`.

## What the client sees

Each video that is included for the client appears in the PDF's **Videos** section as a thumbnail with a round play button, its
Before / During / After tag, and a **Watch video** strip showing the length (for example `1:15`). The thumbnail and the strip are both
clickable. If a video has no thumbnail it is drawn as a dark placeholder with the same play button and the same working link. The video
file is never put inside the PDF.

Every video is **included by default** (technician and manager uploads alike); the manager unticks a video's "Include for client" box in Report
Review or Ready for client to keep it from the client. There is no report-level "Include videos" switch any more (the hidden `reports.include_videos`
column stays, always true, and the database still honours it). Removed videos never appear. A report with no included videos produces exactly
the PDF it did before.

Links are made when a PDF is **downloaded or emailed**, not when the preview is looked at. If the links cannot be made, nothing is
downloaded or sent, and the manager sees a message saying so. Downloading or emailing does not complete the report or change its approval;
emailing marks it "sent to client" exactly as before.

## How a link works

```
PDF link  ->  watch-report-video?t=<token>  ->  302 redirect to a signed Storage URL (1 hour)  ->  the browser plays the video
```

* The **token** is 43 URL-safe characters (256 bits): `base64url(HMAC-SHA256(VIDEO_LINK_SECRET, "kc-video-link-v1:" + link id))`.
* The database stores **only the SHA-256 of the token** (`report_video_links.token_hash`). The token is never stored, never logged, never
  sent to the database. Looking a link up means hashing the token that was presented and finding that hash.
* `VIDEO_LINK_SECRET` exists only in the issuing function's environment. It is what lets the function **reuse** a video's link (it can
  re-derive the token from the stored link id and check the hash matches) without the token being stored anywhere. A database leak alone
  gives nobody a usable link.
* The private `report-videos` bucket stays private. The watch function holds the service key; the browser never does. The signed URL
  points at Storage, which answers HTTP **Range** requests itself, so the video starts playing straight away and seeking works. The
  function does not proxy the file.

### When a link works

The database function `resolve_report_video_link` (callable by the service role only) serves a link only when **all** are true:

| Rule | Effect when it fails |
|---|---|
| link not expired | stops |
| link not revoked | stops |
| video not removed (soft-deleted) | stops (removing a video also revokes its links) |
| video's own "Include for client" is on | stops |
| the report's hidden `include_videos` flag is on (always, now that nothing switches it off) | stops |
| report is **approved** | stops - a report returned for correction (or resubmitted but not yet approved) stops working, and the **same** link works again after re-approval |
| the file exists in Storage | stops |

**Every** failure - unknown, malformed, expired, revoked, removed, un-shared, not approved, missing file, a server error, or a non-GET
request - returns the same response: `404`, body `This video is not available.`, identical headers. Nothing in it names a path, bucket,
table or id, so it cannot be used to discover whether a token, report or video exists. Success and failure responses are `no-store`,
`Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.

### Reuse

Asking for links again for the same report returns the **same** URL for each video as long as its link is still valid, not revoked and has
at least 30 days left - so resending a report never piles up duplicate links. A link with less than 30 days left is not reused, so a PDF is
never sent with a link about to expire; a new one is made.

If `VIDEO_LINK_SECRET` is ever changed, stored hashes no longer match and fresh links are issued automatically. Old PDFs keep working
until their link expires (the old links remain valid in the database; they are simply no longer re-derivable).

## Expiry

| Setting | Value | Where |
|---|---|---|
| Link lifetime | **365 days** | `VIDEO_LINK_TTL_DAYS` (1-730; the database refuses more than 730) |
| Reuse threshold | **30 days** remaining | `VIDEO_LINK_MIN_REMAINING_DAYS` (0-730) |
| Signed Storage URL lifetime | **3600 seconds** | `VIDEO_SIGNED_URL_SECONDS` (60-86400) |

A client who opens a link after it expires, or after the report is returned, sees "This video is not available." and should ask the office.
A manager can revoke a link at any time by revoking it in `report_video_links` (setting `revoked_at`); removing a video does this
automatically.

## Configuration

| Name | Function | Required | Notes |
|---|---|---|---|
| `VIDEO_LINK_SECRET` | issue-report-video-links | **yes** | at least 32 random characters. `supabase secrets set VIDEO_LINK_SECRET=<long random string>` |
| `VIDEO_LINK_TTL_DAYS` | issue-report-video-links | no | default 365 |
| `VIDEO_LINK_MIN_REMAINING_DAYS` | issue-report-video-links | no | default 30 |
| `VIDEO_LINK_PUBLIC_BASE_URL` | issue-report-video-links | no | only if watch links should use a custom domain; default `<SUPABASE_URL>/functions/v1/watch-report-video` |
| `VIDEO_SIGNED_URL_SECONDS` | watch-report-video | no | default 3600 |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | both | provided | the runtime provides these |

Use a different `VIDEO_LINK_SECRET` for DEV and production.

## Rate limiting (public endpoint)

Tokens are 256-bit, so guessing one is not practical; the controls exist to stop floods and hammering with made-up tokens.

* Counted **in the database** (`watch_rate_limits`, via `watch_rate_check` / `watch_rate_fail`, service role only), so every function
  instance shares them. (An in-memory counter was tried first and measured live: Supabase Edge instances do not keep or share memory, so
  17 consecutive failures from one address were never throttled. It is not used for the public endpoint.)
* Per client address: **60 requests per minute**, and **10 failed lookups per 10 minutes** (`WATCH_RATE_LIMIT_PER_MINUTE`,
  `WATCH_FAILURE_LIMIT_PER_10_MIN`). Over a limit the response is `429` with `Retry-After: 60` - decided from the address alone, so it
  reveals nothing about any link. A valid link never counts as a failure. Fixed windows, so a blocked address recovers when the window rolls over.
* The address is `cf-connecting-ip` (set by the platform proxy; a client cannot choose it). **Measured on DEV:** the last
  `x-forwarded-for` entry on Supabase Edge is a rotating proxy node (`13.248.x.x`), not the caller, so it is only a fallback. IPv6 callers
  are keyed by their /64.
* **Fails open:** if the database call errors, the request is served. The limiter can never take the endpoint down.
* Known trade-offs: a shared office/NAT address that fires 10 bad requests blocks that address's valid links for the rest of the 10-minute
  window; a distributed attacker using many addresses is only stopped by a front-door rule (Cloudflare/WAF) in front of the function.
  The table is pruned opportunistically (rows older than an hour).

## Deploying

Order matters. Everything below is already done on DEV; production is not.

1. Migrations, in order: `20261013100000_report_video_link_reuse.sql`, then `20261013110000_watch_rate_limits.sql` (after the three earlier video migrations).
2. `supabase secrets set VIDEO_LINK_SECRET=...` (32+ random characters, **different per project**; use `--env-file`, never the command line).
3. `supabase functions deploy issue-report-video-links` (JWT verification on - managers only, also checked in code).
4. `supabase functions deploy watch-report-video --no-verify-jwt` - **public by design**: clients have no login. It takes only the token.
5. Deploy the frontend last (it calls the issuing function when a PDF is downloaded or emailed).

## Files

* Database: `20261013100000_report_video_link_reuse.sql` (plan + register functions, `token_scheme` column), `20261013110000_watch_rate_limits.sql`
  (rate-limit counters); the earlier migrations hold the tables, `resolve_report_video_link`, and revocation.
* Edge Functions: `supabase/functions/issue-report-video-links/`, `supabase/functions/watch-report-video/`; shared, tested logic in
  `_shared/videoLinks.ts`, `_shared/watchVideo.ts` and `_shared/rateLimit.ts`.
* Browser: `src/lib/clientVideoLinks.ts` (prepare links + thumbnails), `src/lib/clientReportModel.ts` (which videos appear),
  `src/lib/clientReportPdf.ts` (drawing + link annotations), `src/pages/ReadyForClientPage.tsx` (preview, download, send),
  `issueClientVideoLinks` in `src/repository/reportVideosRepository.ts`.

## Known limits

* **Link scanners count as opens.** Email security tools that follow links will increase `open_count` / `last_opened_at`. Informational only.
* **Printed PDFs cannot be clicked.** QR codes are out of scope for now.
* **Anyone with the link can watch** until it expires or the report is returned - the link is the credential, as with any unlisted link.
  Treat the PDF as private to the client.
* **Videos are not embedded**, so a client needs an internet connection to watch.
* The Ready for Client preview shows the video section but the real links are made only on Download / Send.
