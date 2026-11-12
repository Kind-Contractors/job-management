// A sign-in that has ENDED on the server (signed out elsewhere, removed, or expired) while this browser still holds it.
//
// The database only checks that a sign-in token has not expired, so a browser can keep reading data for up to an hour after its
// session was ended; the Edge Functions also ask the sign-in service whether the session still exists, and refuse it ("Invalid or
// expired session."). Without this, the app kept looking signed in while showing that raw text in places.
//
// Every request goes through sessionAwareFetch (the Supabase client's fetch, see ../lib/supabaseClient.ts). When the server rejects
// the sign-in itself, it:
//   - replaces an Edge Function's refusal with one clear message (SESSION_ENDED_MESSAGE), so every screen that shows a server
//     error says the same thing instead of "Invalid or expired session.";
//   - tells AuthProvider, which asks the sign-in service whether the session really ended (createSessionEndHandler) and only
//     then signs this browser out (this browser only) and shows the sign-in page with that message. A check that cannot reach
//     the server (offline) never signs anyone out.
// Refusals that are not about the sign-in ("Not an active manager.", a permission or validation error) are left as they are.
import { isAuthApiError, isAuthRetryableFetchError, isAuthSessionMissingError } from '@supabase/supabase-js';

export const SESSION_ENDED_MESSAGE = 'Your sign-in has ended. Sign in again to continue.';

/** The Edge Functions' own words for a session that no longer exists (see supabase/functions/_shared/auth.ts). */
const FUNCTION_SESSION_REFUSAL = /^(invalid or expired session|missing authorization header)\.?$/i;

/** Did this reply reject the sign-in itself (not the request)? */
export function isSessionEndedReply(reply: { status: number; path: string; error?: string | null }): boolean {
  if (reply.path.startsWith('/functions/v1/')) {
    if (reply.status === 401) return true; // the functions gateway refused the sign-in token
    return reply.status === 403 && FUNCTION_SESSION_REFUSAL.test((reply.error ?? '').trim());
  }
  if (reply.path.startsWith('/rest/v1/') || reply.path.startsWith('/storage/v1/')) return reply.status === 401;
  return false; // the sign-in service's own answers (/auth/v1) are handled by the Supabase client itself
}

// ---- who wants to know --------------------------------------------------------------------------------------------------------------
const listeners = new Set<() => void>();

export function onSessionEndedReply(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function reportSessionEndedReply(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // a listener's own failure must never break the request that reported it
    }
  }
}

function pathOf(input: RequestInfo | URL): string | null {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * The Supabase client's fetch: the normal fetch (read at call time, so a test's replacement is used), plus the check above. Only a
 * 401/403 reply is ever looked at (its body read from a copy); every other reply passes through untouched.
 */
export async function sessionAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await globalThis.fetch(input, init);
  if (res.status !== 401 && res.status !== 403) return res;
  const path = pathOf(input);
  if (!path) return res;
  let error: string | null = null;
  try {
    const body = await res.clone().json();
    error = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : null;
  } catch {
    error = null;
  }
  if (!isSessionEndedReply({ status: res.status, path, error })) return res;
  reportSessionEndedReply();
  if (!path.startsWith('/functions/v1/')) return res;
  return new Response(JSON.stringify({ error: SESSION_ENDED_MESSAGE, code: 'SESSION_ENDED' }), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---- confirming, then signing this browser out -------------------------------------------------------------------------------------

/** Did the sign-in service confirm the session is gone? A failure to reach it (offline, timeout) is NOT a confirmation. */
export function isSessionEndConfirmed(error: unknown): boolean {
  if (!error) return false;
  if (isAuthRetryableFetchError(error)) return false;
  if (isAuthSessionMissingError(error)) return true;
  if (isAuthApiError(error)) {
    return error.status === 401 || error.status === 403 || error.code === 'session_not_found' || error.code === 'bad_jwt' || error.code === 'session_expired';
  }
  return false;
}

/**
 * What AuthProvider does when a reply rejected the sign-in: ask the sign-in service (one check at a time, however many replies
 * arrive together); if it confirms the session is gone, sign out THIS browser and say so. Otherwise nothing happens.
 */
export function createSessionEndHandler(deps: {
  getUser: () => Promise<{ error: unknown }>;
  signOutHere: () => Promise<unknown>;
  onEnded: () => void;
}): () => Promise<void> {
  let checking: Promise<void> | null = null;
  return () => {
    if (checking) return checking;
    checking = (async () => {
      try {
        const { error } = await deps.getUser();
        if (!isSessionEndConfirmed(error)) return;
        deps.onEnded();
        await deps.signOutHere();
      } catch {
        // could not check: leave the sign-in as it is
      } finally {
        checking = null;
      }
    })();
    return checking;
  };
}
