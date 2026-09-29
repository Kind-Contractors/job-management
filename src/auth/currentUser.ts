// The one synchronously-readable answer to "which authenticated user is this
// tab acting as right now?" for code that lives OUTSIDE React (the offline
// sync engine and its IndexedDB queue). Written ONLY by AuthProvider, at
// the exact moment it changes its own resolved identity — cleared to null
// the instant a different user (or no user) is signing in, and set again
// only once that user is confirmed authorized — so a background retry tick
// can never run as one user while another user's session is loading.
//
// Deliberately NOT read from supabase.auth.getSession(): that can trigger a
// token refresh, which fails offline — and offline is exactly when the sync
// queue must still be able to tell whose drafts it is looking at.

let currentUserId: string | null = null;
const listeners = new Set<() => void>();

export function getCurrentUserId(): string | null {
  return currentUserId;
}

/** AuthProvider only. Notifies subscribers (the sync engine's status badge) whenever the value actually changes. */
export function setCurrentUserId(next: string | null): void {
  if (next === currentUserId) return;
  currentUserId = next;
  for (const fn of listeners) fn();
}

export function subscribeCurrentUser(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
