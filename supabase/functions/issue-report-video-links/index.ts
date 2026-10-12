// Manager-only: returns the client "Watch video" URL for every video that is shareable on a report, so the PDF can link to them.
// POST { reportId: string }  ->  { links: [{ videoId, url, reused }] }
//
// Called by the manager's browser just before a client PDF is generated (download or email). Each shareable video (not removed, its own
// "Include for client" on, the report's "Include videos" on) gets ONE link: an existing valid link is REUSED when this function can
// re-derive its token and the hash matches (see ../_shared/videoLinks.ts); otherwise a new link is created. New links are stored with
// the SHA-256 of their token only. Nothing is written to the report itself.
//
// Security: the caller must be an ACTIVE MANAGER (../_shared/auth.ts); all database access uses the caller's own session (RLS applies;
// no service key here). The token secret never leaves this function's environment. Tokens and URLs are returned to the caller but are
// NEVER logged. Errors are generic: they do not echo ids, hashes or database messages.
//
// Environment:
//   VIDEO_LINK_SECRET (REQUIRED, >= 32 random characters)  - the HMAC secret. Set with:  supabase secrets set VIDEO_LINK_SECRET=<long random string>
//                                                            Changing it makes existing links un-reusable (new ones are issued); old PDFs keep working until expiry.
//   VIDEO_LINK_TTL_DAYS (optional, default 365, 1..730)     - how long a NEW link is valid. THE AGREED POLICY IS 365 DAYS.
//   VIDEO_LINK_MIN_REMAINING_DAYS (optional, default 30)    - an existing link with less life than this is not reused (a PDF is never sent with a link about to expire)
//   VIDEO_LINK_PUBLIC_BASE_URL (optional)                   - the address of watch-report-video if it is served from a custom domain;
//                                                            default <SUPABASE_URL>/functions/v1/watch-report-video
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { assertManager, UnauthorizedError } from '../_shared/auth.ts';
import { issueLinks, LinkConfigError, type LinkPlanRow } from '../_shared/videoLinks.ts';

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

  const secret = Deno.env.get('VIDEO_LINK_SECRET') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const watchBaseUrl = Deno.env.get('VIDEO_LINK_PUBLIC_BASE_URL') || `${supabaseUrl}/functions/v1/watch-report-video`;
  const validDays = intEnv('VIDEO_LINK_TTL_DAYS', 365, 1, 730);
  const minRemainingDays = intEnv('VIDEO_LINK_MIN_REMAINING_DAYS', 30, 0, 730);

  try {
    const links = await issueLinks({
      secret,
      watchBaseUrl,
      newId: () => crypto.randomUUID(),
      plan: async () => {
        const { data, error } = await callerClient.rpc('manager_report_video_link_plan', { p_report_id: reportId, p_min_remaining_days: minRemainingDays });
        if (error) throw new Error('plan failed');
        return (data ?? []) as LinkPlanRow[];
      },
      register: async (newLinks) => {
        const { error } = await callerClient.rpc('manager_register_report_video_links', { p_report_id: reportId, p_links: newLinks, p_valid_days: validDays });
        if (error) throw new Error('register failed');
      },
    });
    return json({ links }, 200);
  } catch (err) {
    if (err instanceof LinkConfigError) {
      console.error('VIDEO_LINK_SECRET is missing or too short.'); // the problem only, never a value
      return json({ error: 'Video links are not set up yet. Ask your administrator.' }, 500);
    }
    // No message from the database or the crypto code is passed on: it could contain ids or hashes.
    return json({ error: 'Could not create the video links.' }, 500);
  }
});
