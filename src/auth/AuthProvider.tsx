// Session + authorization state for the Manager app. Authorization is
// derived from the app_users table (role/is_active), not just from having a
// valid Supabase Auth session — see the reviewed auth/RLS design. A signed-in
// user who is unassigned, inactive, or not a manager is 'unauthorized', not
// 'authorized' — the app must never show Manager data to such a user, even
// though RLS would already block their actual data queries independently.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

/**
 * 'check_failed' is distinct from 'unauthorized': it means the app_users
 * lookup itself errored (a real Supabase/network problem), never that the
 * lookup succeeded and said "not authorized." It's exactly as blocked as
 * 'unauthorized' — see App.tsx — just with different copy and a retry.
 */
export type AuthStatus = 'loading' | 'signed_out' | 'unauthorized' | 'check_failed' | 'authorized';

/** `app_users.role` — the only two values the DB's own CHECK constraint allows. */
export type AppRole = 'manager' | 'technician';

interface AuthContextValue {
  status: AuthStatus;
  /** Non-null only when status === 'authorized'. Lets App.tsx route to the Manager tree vs. the technician tree — the two never share a route or component. */
  role: AppRole | null;
  session: Session | null;
  signOut: () => Promise<void>;
  /** Re-runs the app_users lookup for the current session — for the 'check_failed' screen's "Try again". */
  recheck: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

interface AuthorizationResult {
  status: 'authorized' | 'unauthorized' | 'check_failed';
  role: AppRole | null;
}

/**
 * The one place the authorization decision is made, so the mount effect and
 * recheck() can never disagree about what counts as 'authorized'. Both
 * 'manager' and 'technician' are valid authorized roles — the condition is
 * unchanged for 'manager' (data?.is_active && role === 'manager'), widened
 * only to also accept 'technician' the same way.
 */
async function checkAuthorization(userId: string): Promise<AuthorizationResult> {
  const { data, error } = await supabase.from('app_users').select('role, is_active').eq('id', userId).maybeSingle();
  if (error) return { status: 'check_failed', role: null };
  if (data?.is_active && (data.role === 'manager' || data.role === 'technician')) {
    return { status: 'authorized', role: data.role };
  }
  return { status: 'unauthorized', role: null };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [role, setRole] = useState<AppRole | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolve(nextSession: Session | null) {
      if (!nextSession) {
        if (!cancelled) {
          setSession(null);
          setStatus('signed_out');
          setRole(null);
        }
        return;
      }

      const result = await checkAuthorization(nextSession.user.id);

      if (cancelled) return;
      setSession(nextSession);
      setStatus(result.status);
      setRole(result.role);
    }

    supabase.auth.getSession().then(({ data }) => resolve(data.session));

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // TOKEN_REFRESHED is a routine, same-user event — notably, Supabase's
      // own client checks/refreshes the session on tab-visibility change, so
      // simply switching back to this tab fires it. Treating every event
      // here identically (the previous behavior) sent the whole app through
      // 'loading' — a full-screen wipe via App.tsx's AuthLoadingScreen — and
      // re-ran the app_users authorization lookup from scratch, for a token
      // refresh that changes nothing about who's signed in or their manager
      // status. That round-trip through 'loading' was the "the app reloads
      // when I come back to the tab" symptom — not a real reload, no
      // navigation ever happened, and not a TanStack Query refetch (nothing
      // here shows a loading UI on a background refetch). Update the
      // session in place instead, and skip the loading flash and the
      // redundant DB round-trip entirely. Every other event (SIGNED_IN,
      // SIGNED_OUT, USER_UPDATED, etc.) still goes through the full,
      // unchanged resolve() flow — this only narrows the one case that was
      // never a meaningful authorization change to begin with.
      if (event === 'TOKEN_REFRESHED') {
        if (nextSession) setSession(nextSession);
        return;
      }
      setStatus('loading');
      resolve(nextSession);
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  /** Only ever called from the 'check_failed' screen — re-checks the same, already-known session, never signs in as anyone new. */
  const recheck = () => {
    if (!session) return;
    setStatus('loading');
    checkAuthorization(session.user.id).then((result) => {
      setStatus(result.status);
      setRole(result.role);
    });
  };

  return <AuthContext.Provider value={{ status, role, session, signOut, recheck }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
