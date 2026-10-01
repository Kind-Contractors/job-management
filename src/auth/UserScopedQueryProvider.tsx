import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useAuth } from './AuthProvider';
import { QUERY_CACHE_MAX_AGE_MS, createUserQueryPersister, queryCacheBuster } from '../lib/userQueryCache';

interface ScopedProps {
  userId: string;
  children: ReactNode;
}

/**
 * One QueryClient — and one persisted cache — per authenticated user.
 * Persisted data is restored only into that same user's client, and the
 * payload is stamped with the user ID plus a cache-shape version (`buster`,
 * see queryCacheBuster) so even a mis-keyed entry - or one written by an older
 * version of the app with differently shaped data - is discarded on restore
 * rather than trusted.
 *
 * The client/persister live in useState so they're created once per mount;
 * the `key` on the caller changes with the user ID, which discards the
 * previous user's client entirely (nothing about it can reach the next user)
 * and restores/creates the new user's own.
 */
function PersistedForUser({ userId, children }: ScopedProps) {
  const [client] = useState(() => new QueryClient());
  const [persister] = useState(() => createUserQueryPersister(userId));

  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{ persister, maxAge: QUERY_CACHE_MAX_AGE_MS, buster: queryCacheBuster(userId) }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}

/** Signed out (login screen): nothing is fetched or worth persisting, so a throwaway in-memory client with no storage at all. */
function AnonymousClient({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Must sit inside AuthProvider. Follows AuthProvider's own `session`, which
 * only changes once a new identity has been fully resolved (see the
 * `loading` state in AuthProvider) — so the swap to a different user's
 * client happens exactly when App stops showing its loading screen, never
 * mid-render of another user's screens.
 */
export function UserScopedQueryProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  if (!userId) return <AnonymousClient key="anonymous">{children}</AnonymousClient>;
  return (
    <PersistedForUser key={userId} userId={userId}>
      {children}
    </PersistedForUser>
  );
}
