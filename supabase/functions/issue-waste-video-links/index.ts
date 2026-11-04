// Manager-only: the client "Watch video" URL for every video of a WASTE report, so its PDF can link to them.
// POST { reportId: string }  ->  { links: [{ videoId, url, reused }] }
//
// Separate from issue-report-video-links (job reports) on purpose: its own table (waste_video_links), its own plan/register functions,
// its own token prefix and secret (../_shared/wasteVideoLinks.ts) and its own public watch endpoint (watch-waste-video). Each video gets
// ONE link: an existing valid one is reused, otherwise a new one is registered (the database stores only the token's SHA-256).
//
// Security: the caller must be an ACTIVE MANAGER (../_shared/auth.ts); database access uses the caller's own session (RLS applies; no
// service key here). The secret never leaves this function. Tokens and URLs are returned to the caller but NEVER logged; errors are
// generic and never echo ids, hashes or database messages.
//
// Environment:
//   WASTE_VIDEO_LINK_SECRET (REQUIRED, >= 32 random characters)  - the HMAC secret for waste links (NOT the job-report secret).
//   WASTE_VIDEO_LINK_TTL_DAYS (optional, default 365, 1..730)     - how long a NEW link is valid. The agreed policy is 365 days.
//   WASTE_VIDEO_LINK_MIN_REMAINING_DAYS (optional, default 30)    - an existing link with less life than this is not reused.
//   WASTE_VIDEO_LINK_PUBLIC_BASE_URL (optional)                   - watch-waste-video's address if served from a custom domain;
//                                                                  default <SUPABASE_URL>/functions/v1/watch-waste-video
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { assertManager, UnauthorizedError } from '../_shared/auth.ts';
import { LinkConfigError, type LinkPlanRow } from '../_shared/videoLinks.ts';
import { issueWasteLinks } from '../_shared/wasteVideoLinks.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(Deno.env.get(name));
  return Deno.env.get(name) && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed. Use POST.' }, 405);

  let callerClient: SupabaseClient;
  try {
    callerClient = await assertManager(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return json({ error: 'Not authorized.' }, 403);
    return json({ error: 'Could not check authorization.' }, 500);
  }

  let reportId: string;
  try {
    const body = await req.json();
    reportId = body.reportId;
    if (!reportId || typeof reportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(reportId)) throw new Error('bad');
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const secret = Deno.env.get('WASTE_VIDEO_LINK_SECRET') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const watchBaseUrl = Deno.env.get('WASTE_VIDEO_LINK_PUBLIC_BASE_URL') || `${supabaseUrl}/functions/v1/watch-waste-video`;
  const validDays = intEnv('WASTE_VIDEO_LINK_TTL_DAYS', 365, 1, 730);
  const minRemainingDays = intEnv('WASTE_VIDEO_LINK_MIN_REMAINING_DAYS', 30, 0, 730);

  try {
    const links = await issueWasteLinks({
      secret,
      watchBaseUrl,
      newId: () => crypto.randomUUID(),
      plan: async () => {
        const { data, error } = await callerClient.rpc('manager_waste_video_link_plan', { p_report_id: reportId, p_min_remaining_days: minRemainingDays });
        if (error) throw new Error('plan failed');
        return (data ?? []) as LinkPlanRow[];
      },
      register: async (newLinks) => {
        const { error } = await callerClient.rpc('manager_register_waste_video_links', { p_report_id: reportId, p_links: newLinks, p_valid_days: validDays });
        if (error) throw new Error('register failed');
      },
    });
    return json({ links }, 200);
  } catch (err) {
    if (err instanceof LinkConfigError) {
      console.error('WASTE_VIDEO_LINK_SECRET is missing or too short.'); // the problem only, never a value
      return json({ error: 'Video links are not set up yet. Ask your administrator.' }, 500);
    }
    return json({ error: 'Could not create the video links.' }, 500);
  }
});
