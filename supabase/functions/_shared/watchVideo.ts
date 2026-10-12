// The public side of client video links: what happens when a client opens a link. Pure request handling (no Deno, no Supabase client), so
// it is tested directly; index.ts of watch-report-video supplies the real database and Storage.
//
// What a client gets: a 302 redirect to a SHORT-LIVED signed URL for the video file. Storage then streams it, and answers HTTP Range
// requests itself (partial content, seeking), so the browser plays the video without downloading all of it first - this function never
// proxies the file. The private bucket is never made public and no service key leaves the server.
//
// EVERYTHING that is not a valid, current, shared video gets the SAME response: an unknown or malformed token, an expired or revoked link,
// a removed or un-shared video, a report that is not approved (for example returned for correction), a missing file, a database or
// Storage error, any method other than GET. The status, body and headers are identical, so a caller cannot tell which of those it was -
// and so cannot learn whether a token, report or video exists. Nothing in the response names a path, bucket, table or id.
//
// Nothing here logs. In particular the token, the token hash and URLs containing them are never written anywhere.
import { hashTokenHex, isWellFormedToken } from './videoLinks.ts';
import { clientKey, type WatchGuard } from './rateLimit.ts';

export interface ResolvedVideo {
  storagePath: string;
  mimeType: string;
}

export interface WatchDeps {
  /** Looks a link up by token hash (lower-case hex) and counts the open. Null for ANY reason it should not be served. */
  resolve: (tokenHashHex: string) => Promise<ResolvedVideo | null>;
  /** A signed URL for the stored file that lasts `seconds`, or null if there is no such file / signing failed. */
  sign: (storagePath: string, seconds: number) => Promise<string | null>;
  /** How long the signed URL lasts. */
  signedUrlSeconds: number;
  /** Optional per-address throttle (see rateLimit.ts). Absent = no throttling (tests of the plain behaviour). */
  guard?: WatchGuard;
}

const COMMON_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/** The one response for every failure. */
export function notAvailable(): Response {
  return new Response('This video is not available.', {
    status: 404,
    headers: { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Too many requests from one address. Decided from the address alone - never from the token - so it reveals nothing about any link. */
export function tooManyRequests(): Response {
  return new Response('Too many requests. Please try again later.', {
    status: 429,
    headers: { ...COMMON_HEADERS, 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export async function handleWatchRequest(req: Request, deps: WatchDeps): Promise<Response> {
  let key: string | null = null;
  try {
    if (deps.guard) {
      key = clientKey(req.headers);
      if (await deps.guard.shouldThrottle(key)) return tooManyRequests();
    }
    const res = await serve(req, deps);
    // Every uniform failure counts against the address's stricter failure allowance; a valid link never does.
    if (res.status === 404 && key && deps.guard) await deps.guard.recordFailure(key);
    return res;
  } catch {
    if (key && deps.guard) await deps.guard.recordFailure(key);
    return notAvailable();
  }
}

async function serve(req: Request, deps: WatchDeps): Promise<Response> {
  try {
    if (req.method !== 'GET') return notAvailable();
    const token = new URL(req.url).searchParams.get('t');
    if (!isWellFormedToken(token)) return notAvailable();

    const video = await deps.resolve(await hashTokenHex(token));
    if (!video) return notAvailable();

    const signed = await deps.sign(video.storagePath, deps.signedUrlSeconds);
    if (!signed) return notAvailable();

    return new Response(null, { status: 302, headers: { ...COMMON_HEADERS, Location: signed } });
  } catch {
    return notAvailable();
  }
}
