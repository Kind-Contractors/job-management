// Shared manager-only authorization gate for Edge Functions.
//
// Supabase's own gateway already requires a valid Supabase session JWT
// before this code even runs (verify_jwt defaults to true) — but "any
// signed-in user" is not the same as "an active manager," exactly as
// AuthProvider.tsx/current_app_role() distinguish client-side and at the
// RLS layer. An Edge Function is NOT automatically covered by table-level
// RLS, so it needs the same check applied explicitly here.
//
// This reuses the caller's OWN forwarded JWT (never the service-role key)
// against the anon key, relying on app_users' existing `self_select` RLS
// policy (`id = auth.uid()`) — a user can only ever read their own row this
// way, so this cannot be used to check anyone else's role. No new DB
// objects are introduced.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Builds a Supabase client scoped to the caller's own forwarded JWT (anon key, never service-role) — every query through it is subject to that caller's own RLS, same as if they'd queried directly. */
function createCallerClient(authHeader: string): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    // These are auto-provisioned by Supabase for every Edge Function — if
    // they're missing something is wrong with the runtime itself, not the
    // caller's request.
    throw new Error('Edge Function runtime is missing SUPABASE_URL/SUPABASE_ANON_KEY.');
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Throws UnauthorizedError unless the request carries a valid session for an
 * active manager. On success, returns a Supabase client scoped to that same
 * caller's JWT — reusable for the rest of the function's own DB reads/
 * writes, so a caller doesn't need to build a second client itself.
 */
export async function assertManager(req: Request): Promise<SupabaseClient> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    throw new UnauthorizedError('Missing Authorization header.');
  }

  const callerClient = createCallerClient(authHeader);

  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) {
    throw new UnauthorizedError('Invalid or expired session.');
  }

  const { data: appUser, error: appUserError } = await callerClient
    .from('app_users')
    .select('role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (appUserError) {
    throw new Error(`Authorization check failed: ${appUserError.message}`);
  }
  if (!appUser?.is_active || appUser.role !== 'manager') {
    throw new UnauthorizedError('Not an active manager.');
  }

  return callerClient;
}
