// Session + authorization state for the Manager app. Authorization is
// derived from the app_users table (role/is_active), not just from having a
// valid Supabase Auth session — see the reviewed auth/RLS design. A signed-in
// user who is unassigned, inactive, or not a manager is 'unauthorized', not
// 'authorized' — the app must never show Manager data to such a user, even
// though RLS would already block their actual data queries independently.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

export type AuthStatus = 'loading' | 'signed_out' | 'unauthorized' | 'authorized';

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

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

      const { data, error } = await supabase
        .from('app_users')
        .select('role, is_active')
        .eq('id', nextSession.user.id)
        .maybeSingle();

      if (cancelled) return;
      setSession(nextSession);
      setStatus(!error && data?.is_active && data.role === 'manager' ? 'authorized' : 'unauthorized');
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

  return <AuthContext.Provider value={{ status, session, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
