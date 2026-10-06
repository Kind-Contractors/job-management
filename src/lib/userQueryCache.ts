// Per-user persistence for the TanStack Query cache.
//
// Before this existed, every signed-in user of a browser shared ONE
// localStorage entry ('kind-contractors-query-cache') — so user B's session
// restored user A's cached lists, visit details and technician identity.
// Now each authenticated Supabase user ID gets its own key, the persisted
// payload is additionally stamped with that ID (`buster`, see
// UserScopedQueryProvider), and the old shared key is never read again.
//
// Only this module touches these localStorage keys, and only ever removes
// (a) the legacy shared key and (b) one specific user's own key on their
// explicit sign-out — never a blanket localStorage.clear(), never Supabase's
// own auth-token entry, and never the IndexedDB offline queue.

import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

/** The pre-isolation shared key. Never read or written by current code — only removed. */
const LEGACY_SHARED_KEY = 'kind-contractors-query-cache';
const KEY_PREFIX = 'kind-contractors-query-cache:v2:';
const WRITE_THROTTLE_MS = 1000;

/** How long a restored cache entry is trusted for — unchanged from before (24h). */
export const QUERY_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24;

/**
 * The shape version of what is stored in the persisted query cache. BUMP THIS
 * whenever the data returned by any cached query changes shape (a field is
 * added, renamed or removed in a repository mapper): a browser that cached the
 * previous shape would otherwise restore it into the new code and render it
 * before the fresh fetch lands, which is exactly how 7af7739 blanked the
 * Schedule (cached visits had no additionalTechnicianIds). A changed version
 * makes every previously persisted cache be discarded on restore.
 */
export const QUERY_CACHE_SCHEMA_VERSION = '2026-10-06-activities';

/**
 * The `buster` the persisted cache is stamped with and restored against: the
 * user ID (so one user's cache is never trusted for another - unchanged) plus
 * the shape version above.
 */
export function queryCacheBuster(userId: string): string {
  return `${userId}:${QUERY_CACHE_SCHEMA_VERSION}`;
}

/**
 * Users whose cache was just purged by an explicit sign-out. A throttled
 * write that was already scheduled for that user's (now unmounting) client
 * must not resurrect the entry the purge just removed. Cleared again the
 * next time that same user gets a fresh persister (i.e. signs back in).
 */
const purgedUserIds = new Set<string>();

function storageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/** Drops the old shared cache so its stale, cross-user data can never be restored. Touches only that one key. Safe to call on every startup. */
export function removeLegacySharedQueryCache(): void {
  try {
    window.localStorage.removeItem(LEGACY_SHARED_KEY);
  } catch {
    // Storage unavailable (private mode, blocked) — nothing to remove and nothing that could be restored either.
  }
}

/** Removes ONE user's persisted query cache (their explicit sign-out). Other users' caches are untouched. */
export function purgePersistedQueryCache(userId: string): void {
  purgedUserIds.add(userId);
  try {
    window.localStorage.removeItem(storageKey(userId));
  } catch {
    // Nothing more to do — the in-memory client for this user is discarded regardless.
  }
}

/**
 * A localStorage persister bound to exactly one user's key. Hand-rolled
 * (instead of createAsyncStoragePersister) so its throttled write can be
 * suppressed after a purge — see purgedUserIds.
 */
export function createUserQueryPersister(userId: string): Persister {
  purgedUserIds.delete(userId);
  const key = storageKey(userId);
  let pending: PersistedClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    const snapshot = pending;
    pending = null;
    if (!snapshot || purgedUserIds.has(userId)) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(snapshot));
    } catch {
      // Quota exceeded / storage blocked — the cache just stays in memory this session.
    }
  };

  return {
    persistClient(client) {
      pending = client;
      timer ??= setTimeout(flush, WRITE_THROTTLE_MS);
    },
    restoreClient() {
      if (purgedUserIds.has(userId)) return undefined;
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as PersistedClient) : undefined;
      } catch {
        return undefined;
      }
    },
    removeClient() {
      pending = null;
      try {
        window.localStorage.removeItem(key);
      } catch {
        // See purgePersistedQueryCache.
      }
    },
  };
}
