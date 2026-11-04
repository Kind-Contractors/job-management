// PUBLIC endpoint clients open from the "Watch video" links in a WASTE report PDF:
//   GET https://<project>.supabase.co/functions/v1/watch-waste-video?t=<token>
// Checks the token and, if the link is valid now, redirects (302) to a short-lived signed URL for the video in the private
// waste-report-media bucket. The rules (not revoked, not expired, still a video) are enforced by resolve_waste_video_link, which only the
// service role can call. An ARCHIVED report's links keep working. Every other case returns the same generic 404.
//
// Isolated from watch-report-video (job reports): its own resolve function, its own bucket, and its own throttle counters (keys are
// prefixed "waste:"), so neither endpoint can open the other's files or use up the other's allowance. The request handling itself
// (token shape check, uniform 404, 429, redirect) is the shared, tested ../_shared/watchVideo.ts.
//
// DEPLOY WITH JWT VERIFICATION OFF - clients have no Supabase login:
//   supabase functions deploy watch-waste-video --no-verify-jwt
//
// Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided); VIDEO_SIGNED_URL_SECONDS (optional, default 3600, 60..86400);
// WATCH_RATE_LIMIT_PER_MINUTE (default 60) and WATCH_FAILURE_LIMIT_PER_10_MIN (default 10), the same settings as the job-report endpoint.
// Never logs the token, its hash, or any URL containing them.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { handleWatchRequest, notAvailable } from '../_shared/watchVideo.ts';
import { createDbWatchGuard } from '../_shared/rateLimit.ts';

const BUCKET = 'waste-report-media';
const RATE_KEY_PREFIX = 'waste:';
/** watch_rate_check accepts keys of at most 64 characters (a longer one is let through), so the address part is trimmed to fit. */
const rateKey = (key: string) => RATE_KEY_PREFIX + key.slice(0, 64 - RATE_KEY_PREFIX.length);

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
    guard: createDbWatchGuard({
      check: async (key) => {
        const { data, error } = await client.rpc('watch_rate_check', { p_key: rateKey(key), p_req_limit: REQ_LIMIT, p_req_window_seconds: 60, p_fail_limit: FAIL_LIMIT, p_fail_window_seconds: 600 });
        if (error) throw new Error('rate check failed');
        return data !== false;
      },
      fail: async (key) => {
        const { error } = await client.rpc('watch_rate_fail', { p_key: rateKey(key), p_fail_window_seconds: 600 });
        if (error) throw new Error('rate record failed');
      },
    }),
    resolve: async (tokenHashHex) => {
      const { data, error } = await client.rpc('resolve_waste_video_link', { p_token_hash: `\\x${tokenHashHex}` });
      if (error || !Array.isArray(data) || data.length === 0) return null;
      return { storagePath: data[0].storage_path as string, mimeType: data[0].mime_type as string };
    },
    sign: async (storagePath, seconds) => {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(storagePath, seconds);
      return error || !data?.signedUrl ? null : data.signedUrl;
    },
  });
});
