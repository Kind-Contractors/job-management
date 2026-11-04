// Waste reports: the server's own check of one file the waste reporter has just uploaded.
//   POST { path: "<his user id>/<report id>/<before|after>/<file id>.<ext>" }
//   -> 200 { ok: true, durationSeconds, sizeBytes }            the file passed; waste_submit_report() will accept it
//   -> 200 { ok: false, reason }                               the file was rejected (and removed); the reason is shown to him
//   -> 409 { error }  the file is not in storage (yet)          -> the phone uploads it again
//   -> 423 { error }  the file belongs to a report that has already been sent - it is never checked, changed or removed
//   -> 503 { error }  the file could not be read just now       -> the phone retries later
//
// What is checked, from the stored file itself (never from its name or the type the phone claimed): the type, from its first bytes
// (JPEG / PNG / MP4-MOV / WebM, matching the extension); the size; and for a video its real length, read from the container header
// with a few small Range requests (see ../_shared/mediaProbe.ts). A video whose length cannot be read is rejected.
//
// The result is written to waste_media_checks with the service role - the only writer of that table - so the phone can never vouch
// for its own files. waste_submit_report() only accepts a file whose passing check is newer than the stored file.
//
// SENT REPORTS ARE UNTOUCHABLE. Before anything is read, the database is asked (service role, so the answer can't be hidden) whether
// the file's report has been sent or any sent report uses the file; if so the request is refused (423). The same question is asked
// again immediately before a rejected file is removed, so this function can never delete a file a sent report uses - even if a
// later, stricter rule would reject it. Rejected files of unsent drafts are still removed, as before.
//
// Security: the caller must be an ACTIVE WASTE REPORTER (../_shared/auth.ts) and may only name a file under his own user folder. The
// service key is used only after that, only for this one file. Nothing about other users' files can be learned: any other name is a 400.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { assertWasteReporter, UnauthorizedError } from '../_shared/auth.ts';
import { checkMediaFile, kindFromPath, type Reader } from '../_shared/mediaProbe.ts';

const BUCKET = 'waste-report-media';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH_RE = new RegExp(`^(${UUID})/${UUID}/(before|after)/${UUID}(\\.(jpg|png|mp4|mov|webm)|\\.thumb\\.jpg)$`);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

class NotStoredError extends Error {}
class ReadError extends Error {}

/**
 * True when the file belongs to a sent report: its report (the second folder of the path) exists in waste_reports, or a sent report's
 * media row uses it as its file or poster. Asks the database; throws when it can't answer (the caller then refuses to go on).
 */
export async function belongsToSentReport(service: SupabaseClient, path: string): Promise<boolean> {
  const reportId = path.split('/')[1];
  const report = await service.from('waste_reports').select('id').eq('id', reportId).limit(1);
  if (report.error) throw new Error('report lookup failed');
  if ((report.data ?? []).length > 0) return true;
  for (const column of ['storage_path', 'thumbnail_path']) {
    const used = await service.from('waste_report_media').select('id').eq(column, path).limit(1);
    if (used.error) throw new Error('media lookup failed');
    if ((used.data ?? []).length > 0) return true;
  }
  return false;
}

/** A Range reader over a short-lived signed URL; also learns the file's total size from the first answer. */
function rangeReader(url: string, fetchImpl: typeof fetch): { read: Reader; size: () => Promise<number> } {
  let total: number | null = null;
  const read: Reader = async (offset, length) => {
    if (length <= 0) return new Uint8Array(0);
    const res = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (res.status === 404 || res.status === 400) throw new NotStoredError('not stored');
    if (res.status !== 206 && res.status !== 200) throw new ReadError(`read ${res.status}`);
    const range = res.headers.get('content-range');
    const m = range && /\/(\d+)$/.exec(range);
    if (m) total = Number(m[1]);
    else if (res.status === 200 && res.headers.get('content-length')) total = Number(res.headers.get('content-length'));
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A 200 is the whole file: hand back only the part asked for.
    return res.status === 200 ? bytes.subarray(offset, offset + length) : bytes;
  };
  return {
    read,
    size: async () => {
      if (total == null) await read(0, 1);
      if (total == null) throw new ReadError('no size');
      return total;
    },
  };
}

let admin: SupabaseClient | null = null;
function adminClient(): SupabaseClient {
  if (admin) return admin;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Edge Function runtime is missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.');
  admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed. Use POST.' }, 405);

  let userId: string;
  try {
    ({ userId } = await assertWasteReporter(req));
  } catch (err) {
    if (err instanceof UnauthorizedError) return json({ error: 'Not authorized.' }, 403);
    return json({ error: 'Could not check authorization.' }, 500);
  }

  let path: string;
  try {
    const body = await req.json();
    path = body.path;
    const m = typeof path === 'string' ? PATH_RE.exec(path) : null;
    if (!m || m[1] !== userId || !kindFromPath(path)) throw new Error('bad');
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const service = adminClient();
  const SENT = 'This report has already been sent, so its photos and videos can’t be checked or changed.';
  try {
    if (await belongsToSentReport(service, path)) return json({ error: SENT }, 423);
  } catch {
    return json({ error: 'The file could not be checked just now. It will be tried again.' }, 503);
  }

  const signed = await service.storage.from(BUCKET).createSignedUrl(path, 60);
  if (signed.error || !signed.data?.signedUrl) {
    return json({ error: 'That file isn’t in storage yet. It will be uploaded again.' }, 409);
  }

  let result;
  try {
    const reader = rangeReader(signed.data.signedUrl, fetch);
    const size = await reader.size();
    result = await checkMediaFile(path, size, reader.read);
  } catch (err) {
    if (err instanceof NotStoredError) return json({ error: 'That file isn’t in storage yet. It will be uploaded again.' }, 409);
    return json({ error: 'The file could not be checked just now. It will be tried again.' }, 503);
  }

  const { error: writeError } = await service.from('waste_media_checks').upsert(
    {
      storage_path: path,
      owner_user_id: userId,
      kind: result.kind,
      detected_mime: result.mime,
      size_bytes: result.sizeBytes,
      duration_seconds: result.durationSeconds,
      ok: result.ok,
      reason: result.reason,
      // checked_at is set by the database itself (trigger waste_media_checks_stamp), on the same clock as the stored file's time.
    },
    { onConflict: 'storage_path' },
  );
  if (writeError) return json({ error: 'The file could not be checked just now. It will be tried again.' }, 503);

  if (!result.ok) {
    // A rejected file of an UNSENT draft is never usable: remove it so it doesn't take up space or count against the upload limit.
    // Asked again right before removing: a file that a sent report uses (or that may now be in one) is never removed.
    let removable = false;
    try {
      removable = !(await belongsToSentReport(service, path));
    } catch {
      removable = false;
    }
    if (removable) await service.storage.from(BUCKET).remove([path]).catch(() => undefined);
    return json({ ok: false, reason: result.reason }, 200);
  }
  return json({ ok: true, durationSeconds: result.durationSeconds, sizeBytes: result.sizeBytes }, 200);
});
