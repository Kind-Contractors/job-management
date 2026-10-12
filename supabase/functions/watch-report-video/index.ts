// PUBLIC endpoint clients open from the "Watch video" links in a report PDF:
//   GET https://<project>.supabase.co/functions/v1/watch-report-video?t=<token>
// It checks the token and, if the link is valid right now, redirects (302) to a short-lived signed URL for the video file. All the
// rules (expiry, revocation, removed video, un-shared video, report switch, report APPROVED) are enforced by the database function
// resolve_report_video_link, which only the service role can call. Every other case - including anything wrong - returns the same
// generic 404, so nothing about which tokens, reports or videos exist can be learned. See ../_shared/watchVideo.ts.
//
// DEPLOY WITH JWT VERIFICATION OFF - clients have no Supabase login:
//   supabase functions deploy watch-report-video --no-verify-jwt
// (This is the project's first public function: it accepts no input except the token, holds no write access beyond counting an open, and
// never logs the token, its hash, or any URL containing them.)
//
// Environment (all provided by Supabase except the optional one):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   - provided by the runtime; the service key stays on the server
//   VIDEO_SIGNED_URL_SECONDS (optional)        - how long the redirect target stays valid; default 3600, allowed 60..86400
//   WATCH_RATE_LIMIT_PER_MINUTE (optional)     - requests per address per minute before 429; default 60 (counted in the database)
//   WATCH_FAILURE_LIMIT_PER_10_MIN (optional)  - failed lookups per address per 10 minutes before 429; default 10
//
// Streaming: the signed URL points at Supabase Storage, which supports HTTP Range requests, so playback starts at once and seeking works.
// Email security scanners that follow links will count as an "open"; the count is informational only.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { handleWatchRequest, notAvailable } from '../_shared/watchVideo.ts';
import { createDbWatchGuard } from '../_shared/rateLimit.ts';

const BUCKET = 'report-videos';

function signedUrlSeconds(): number {
  const n = Number(Deno.env.get('VIDEO_SIGNED_URL_SECONDS') ?? '3600');
  return Number.isFinite(n) ? Math.min(86400, Math.max(60, Math.round(n))) : 3600;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Deno.env.get(name);
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

const REQ_LIMIT = intEnv('WATCH_RATE_LIMIT_PER_MINUTE', 60, 5, 1000);
const FAIL_LIMIT = intEnv('WATCH_FAILURE_LIMIT_PER_10_MIN', 10, 3, 200);

let admin: SupabaseClient | null = null;
function adminClient(): SupabaseClient | null {
  if (admin) return admin;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}

Deno.serve(async (req: Request) => {
  const client = adminClient();
  if (!client) return notAvailable();
  return await handleWatchRequest(req, {
    signedUrlSeconds: signedUrlSeconds(),
    // Per-address throttle shared by every instance through the database (see ../_shared/rateLimit.ts); fails open.
    guard: createDbWatchGuard({
      check: async (key) => {
        const { data, error } = await client.rpc('watch_rate_check', { p_key: key, p_req_limit: REQ_LIMIT, p_req_window_seconds: 60, p_fail_limit: FAIL_LIMIT, p_fail_window_seconds: 600 });
        if (error) throw new Error('rate check failed');
        return data !== false; // only an explicit false throttles
      },
      fail: async (key) => {
        const { error } = await client.rpc('watch_rate_fail', { p_key: key, p_fail_window_seconds: 600 });
        if (error) throw new Error('rate record failed');
      },
    }),
    resolve: async (tokenHashHex) => {
      const { data, error } = await client.rpc('resolve_report_video_link', { p_token_hash: `\\x${tokenHashHex}` });
      if (error || !Array.isArray(data) || data.length === 0) return null;
      return { storagePath: data[0].storage_path as string, mimeType: data[0].mime_type as string };
    },
    sign: async (storagePath, seconds) => {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(storagePath, seconds);
      return error || !data?.signedUrl ? null : data.signedUrl;
    },
  });
});
