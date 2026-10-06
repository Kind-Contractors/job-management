import { useAuth } from '../auth/AuthProvider';

/**
 * Every technician query key carries the authenticated user's ID as its
 * second segment. The QueryClient and persisted cache are already per-user
 * (auth/UserScopedQueryProvider.tsx) — this is the second, independent layer:
 * even if a cache entry ever ended up in the wrong client, a different user's
 * screens would look under a different key and never read it.
 */
export const technicianKeys = {
  whoAmI: (userId: string) => ['technician', userId, 'whoAmI'] as const,
  todayVisits: (userId: string) => ['technician', userId, 'todayVisits'] as const,
  /** Today's jobs AND activities merged in the office's running order. A separate key from todayVisits so the two shapes can never be mistaken for each other in a cache. */
  todayItems: (userId: string) => ['technician', userId, 'todayItems'] as const,
  pastVisits: (userId: string) => ['technician', userId, 'pastVisits'] as const,
  needsCorrection: (userId: string) => ['technician', userId, 'needsCorrection'] as const,
  visitDetail: (userId: string, visitId: string | undefined) => ['technician', userId, 'visitDetail', visitId] as const,
  myPhotos: (userId: string, visitId: string | undefined) => ['technician', userId, 'myPhotos', visitId] as const,
};

/** The three list queries a newly booked/assigned visit or a newly synced/returned report could affect. */
export function visitListQueryKeys(userId: string) {
  return [
    technicianKeys.todayVisits(userId),
    technicianKeys.todayItems(userId),
    technicianKeys.pastVisits(userId),
    technicianKeys.needsCorrection(userId),
  ];
}

/**
 * The signed-in user's ID for building technician query keys. Technician
 * screens only render once AuthProvider has resolved an authorized session, so
 * this is always a real ID there; the empty-string fallback exists only so a
 * (never-expected) missing session can't share a real user's key, and every
 * query using it is also disabled in that case (`enabled: userId !== ''`).
 */
export function useTechnicianUserId(): string {
  const { session } = useAuth();
  return session?.user.id ?? '';
}
