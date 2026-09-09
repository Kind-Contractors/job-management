// Manager-only user administration — the one place this app creates a real
// Supabase Auth account, lists real user identity (email/last sign-in), or
// writes to another user's app_users row. All three are impossible from the
// browser client today: app_users has only a self_select RLS policy
// (id = auth.uid()), and auth.users is never exposed to the anon/
// authenticated client at all (a platform boundary, not an RLS gap) — see
// docs/production-domain-model-proposal.md and _shared/auth.ts's own header
// comment. This function is the FIRST place in this codebase to use the
// service-role key, which Supabase auto-provisions to every Edge Function
// (SUPABASE_SERVICE_ROLE_KEY) — nothing new to configure. Every request is
// still gated by the exact same assertManager() helper xero-create-invoice
// already uses, so only an active manager can ever call this.
//
// One function, action-dispatched body ({ action: 'list'|'create'|
// 'setActive'|'update' }) — keeps the deployment surface to one endpoint
// for a single, cohesive responsibility (user administration), the same
// way xero-create-invoice is one endpoint for its own multi-step flow.
//
// User <-> Technician relationship, kept in sync deliberately:
// - Creating a 'technician' user also creates its technicians row
//   (app_user_id set), so it appears in the Schedule's technician selector
//   immediately via the existing listTechnicians()/manager_full_access RLS
//   — no change needed there.
// - Deactivating a user with a linked technician also deactivates that
//   technicians row (so listTechnicians()'s activeTechnicians filter
//   agrees) — otherwise a manager could deactivate a person here while the
//   Schedule still offered them as an active technician.
// - Editing a linked technician's name updates both app_users.display_name
//   and technicians.name together, so the Users screen and the Schedule
//   never show two different names for the same person going forward.
//
// Technicians and managers are deactivated, never deleted here — same
// convention as setTechnicianActive() already established.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { assertManager, UnauthorizedError } from '../_shared/auth.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

/** The service-role client — the only client in this function with elevated privilege. Never returned or logged; used only for the specific privileged reads/writes below. */
function createServiceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Edge Function runtime is missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.');
  }
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A short, random temporary password — shown once to the manager after creating a user, for them to share and the person to change on first login. Not a security boundary in itself (this is an internal demo tool); real invite-by-email is a later, separate decision. */
function generateTempPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

interface ListedUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string;
  isActive: boolean;
  lastSignInAt: string | null;
  technicianId: string | null;
  technicianName: string | null;
  technicianIsActive: boolean | null;
}

async function handleList(service: SupabaseClient): Promise<ListedUser[]> {
  const [{ data: appUsers, error: appUsersError }, { data: authList, error: authError }] = await Promise.all([
    service.from('app_users').select('id, role, display_name, is_active, technicians ( id, name, is_active )'),
    service.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  if (appUsersError) throw new Error(`Failed to load users: ${appUsersError.message}`);
  if (authError) throw new Error(`Failed to load auth identities: ${authError.message}`);

  const authById = new Map(authList.users.map((u) => [u.id, u]));

  return (appUsers ?? []).map((row) => {
    const auth = authById.get(row.id);
    const technician = Array.isArray(row.technicians) ? row.technicians[0] : row.technicians;
    return {
      id: row.id,
      email: auth?.email ?? null,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active,
      lastSignInAt: auth?.last_sign_in_at ?? null,
      technicianId: technician?.id ?? null,
      technicianName: technician?.name ?? null,
      technicianIsActive: technician?.is_active ?? null,
    };
  });
}

async function handleCreate(
  service: SupabaseClient,
  body: { firstName?: string; lastName?: string; email?: string; role?: string },
): Promise<{ id: string; email: string; tempPassword: string }> {
  const firstName = (body.firstName ?? '').trim();
  const lastName = (body.lastName ?? '').trim();
  const email = (body.email ?? '').trim();
  const role = body.role;

  if (!firstName) throw new Error('First name is required.');
  if (!email) throw new Error('Email is required.');
  if (role !== 'manager' && role !== 'technician') throw new Error('Role must be "manager" or "technician".');

  const displayName = [firstName, lastName].filter(Boolean).join(' ');
  const tempPassword = generateTempPassword();

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(`Failed to create the account: ${createError?.message ?? 'unknown error'}`);
  }
  const userId = created.user.id;

  // Best-effort rollback of the auth account if anything below fails — an
  // auth-only account with no app_users row would otherwise be unable to
  // ever sign in meaningfully (checkAuthorization() would call it
  // 'unauthorized' forever) and would just sit there unexplained.
  try {
    const { error: appUserError } = await service
      .from('app_users')
      .insert({ id: userId, role, display_name: displayName, is_active: true });
    if (appUserError) throw new Error(`Failed to create the user record: ${appUserError.message}`);

    if (role === 'technician') {
      const { error: technicianError } = await service
        .from('technicians')
        .insert({ name: displayName, is_active: true, app_user_id: userId });
      if (technicianError) throw new Error(`Failed to link the technician record: ${technicianError.message}`);
    }
  } catch (err) {
    await service.auth.admin.deleteUser(userId).catch(() => {
      // Best-effort only — the original error below is the one that matters.
    });
    throw err;
  }

  return { id: userId, email, tempPassword };
}

async function handleSetActive(service: SupabaseClient, body: { userId?: string; isActive?: boolean }): Promise<void> {
  const userId = body.userId;
  if (!userId || typeof body.isActive !== 'boolean') throw new Error('userId and isActive are required.');

  const { error: appUserError } = await service.from('app_users').update({ is_active: body.isActive }).eq('id', userId);
  if (appUserError) throw new Error(`Failed to update the user: ${appUserError.message}`);

  // Keep the linked technician's own is_active in step — deactivating a
  // person here must also remove them from the Schedule's active-technician
  // list, not leave a split state.
  const { error: technicianError } = await service
    .from('technicians')
    .update({ is_active: body.isActive })
    .eq('app_user_id', userId);
  if (technicianError) throw new Error(`Failed to update the linked technician: ${technicianError.message}`);
}

async function handleUpdate(
  service: SupabaseClient,
  body: { userId?: string; firstName?: string; lastName?: string },
): Promise<void> {
  const userId = body.userId;
  const firstName = (body.firstName ?? '').trim();
  const lastName = (body.lastName ?? '').trim();
  if (!userId) throw new Error('userId is required.');
  if (!firstName) throw new Error('First name is required.');

  const displayName = [firstName, lastName].filter(Boolean).join(' ');

  const { error: appUserError } = await service.from('app_users').update({ display_name: displayName }).eq('id', userId);
  if (appUserError) throw new Error(`Failed to update the user: ${appUserError.message}`);

  const { error: technicianError } = await service
    .from('technicians')
    .update({ name: displayName })
    .eq('app_user_id', userId);
  if (technicianError) throw new Error(`Failed to update the linked technician: ${technicianError.message}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed. Use POST.' }, 405);
  }

  try {
    await assertManager(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return json({ error: err.message }, 403);
    return json({ error: errorMessage(err) }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (err) {
    return json({ error: `Invalid request body: ${errorMessage(err)}` }, 400);
  }

  const service = createServiceClient();

  try {
    switch (body.action) {
      case 'list':
        return json({ users: await handleList(service) }, 200);
      case 'create':
        return json(await handleCreate(service, body), 200);
      case 'setActive':
        await handleSetActive(service, body);
        return json({ ok: true }, 200);
      case 'update':
        await handleUpdate(service, body);
        return json({ ok: true }, 200);
      default:
        return json({ error: `Unknown action: ${String(body.action)}` }, 400);
    }
  } catch (err) {
    return json({ error: errorMessage(err) }, 400);
  }
});
