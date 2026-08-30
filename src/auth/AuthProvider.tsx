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
 * lookup succeeded and said "not a manager." It's exactly as blocked as
 * 'unauthorized' — see App.tsx — just with different copy and a retry.
 */
export type AuthStatus = 'loading' | 'signed_out' | 'unauthorized' | 'check_failed' | 'authorized';

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  signOut: () => Promise<void>;
  /** Re-runs the app_users lookup for the current session — for the 'check_failed' screen's "Try again". */
  recheck: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * The one place the manager/authorization decision is made, so the mount
 * effect and recheck() can never disagree about what counts as
 * 'authorized' — the condition itself (data?.is_active && data.role ===
 * 'manager') is unchanged from before 'check_failed' existed.
 */
async function checkAuthorization(userId: string): Promise<'authorized' | 'unauthorized' | 'check_failed'> {
  const { data, error } = await supabase.from('app_users').select('role, is_active').eq('id', userId).maybeSingle();
  if (error) return 'check_failed';
  return data?.is_active && data.role === 'manager' ? 'authorized' : 'unauthorized';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    let cancelled = false;

    async function resolve(nextSession: Session | null) {
      if (!nextSession) {
        if (!cancelled) {
          setSession(null);
          setStatus('signed_out');
        }
        return;
      }

      const result = await checkAuthorization(nextSession.user.id);

      if (cancelled) return;
      setSession(nextSession);
      setStatus(result);
    }

    supabase.auth.getSession().then(({ data }) => resolve(data.session));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
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
    checkAuthorization(session.user.id).then(setStatus);
  };

  return <AuthContext.Provider value={{ status, session, signOut, recheck }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
