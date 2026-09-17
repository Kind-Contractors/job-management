// Data-access layer for the Users screen — every operation here is
// privileged (real Auth-account creation, reading another user's identity/
// email/last-login, writing another user's app_users row) and none of it
// is possible through plain RLS-covered client calls: app_users only ever
// grants a user read access to their OWN row (self_select), and auth.users
// itself is never exposed to the client at all. All four actions go
// through the admin-users Edge Function, which is manager-gated
// (assertManager — the same helper xero-create-invoice already uses) and
// uses the service-role key only inside that function, never in the
// browser. See that function's own file header for the full rationale.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

export type AppRole = 'manager' | 'technician';

export interface AppUserRow {
  id: string;
  email: string | null;
  displayName: string | null;
  role: AppRole;
  isActive: boolean;
  lastSignInAt: string | null;
  technicianId: string | null;
  technicianName: string | null;
  technicianIsActive: boolean | null;
}

interface AdminUsersErrorBody {
  error?: string;
}

/**
 * Every call goes through this one Edge Function invocation — mirrors
 * invoicesRepository.ts's sendInvoice() pattern exactly (one privileged
 * action, one function.invoke call, errors surfaced as plain thrown
 * Errors).
 *
 * A non-2xx response makes the Supabase client throw a `FunctionsHttpError`
 * whose own `.message` is just the generic "Edge Function returned a
 * non-2xx status code" — NOT what admin-users actually said. The real
 * `{ error: "..." }` body it returned is only available by reading
 * `error.context` (the raw Response) — see the supabase-js FunctionsClient
 * source's own documented error-handling example. Without this, every
 * admin-users failure (duplicate email, validation, etc.) surfaced as that
 * one generic string, regardless of what admin-users itself explained.
 */
async function callAdminUsers<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & AdminUsersErrorBody>('admin-users', { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const message = await readAdminUsersErrorMessage(error);
      if (message) throw new Error(message);
    }
    throw new Error(error.message);
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(data.error);
  }
  return data as T;
}

/** Reads the real `{ error: "..." }` body a FunctionsHttpError's underlying Response carries — returns null (never throws) if the body isn't that expected JSON shape, so the caller falls back to the generic message instead. */
async function readAdminUsersErrorMessage(error: FunctionsHttpError): Promise<string | null> {
  try {
    const body = (await error.context.json()) as AdminUsersErrorBody;
    return body?.error ?? null;
  } catch {
    return null;
  }
}

export async function listUsers(): Promise<AppUserRow[]> {
  const { users } = await callAdminUsers<{ users: AppUserRow[] }>({ action: 'list' });
  return users;
}

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  email: string;
  role: AppRole;
}

export interface CreatedUser {
  id: string;
  email: string;
  /** Shown once to the manager right after creation — not persisted or retrievable again; the person should change it after their first sign-in. */
  tempPassword: string;
}

export async function createUser(input: CreateUserInput): Promise<CreatedUser> {
  return callAdminUsers<CreatedUser>({ action: 'create', ...input });
}

/** Activating/deactivating a user also activates/deactivates its linked technician row (if any) in the same call, server-side — see admin-users/index.ts. Never call setTechnicianActive() separately for a user managed here; that would race this. */
export async function setUserActive(userId: string, isActive: boolean): Promise<void> {
  await callAdminUsers<{ ok: true }>({ action: 'setActive', userId, isActive });
}

export interface UpdateUserInput {
  userId: string;
  firstName: string;
  lastName: string;
}

export async function updateUser(input: UpdateUserInput): Promise<void> {
  await callAdminUsers<{ ok: true }>({ action: 'update', ...input });
}

export interface DeletedUser {
  deletedUserId: string;
  deletedTechnicianId: string | null;
}

/**
 * Permanent removal — unlike setUserActive(), this cannot be undone. Only
 * ever call this on an account already confirmed (separately, read-only)
 * to have no jobs/visits/reports/photos referencing it; the Edge Function
 * itself does not check for that, exactly like a real DROP would not.
 */
export async function deleteUser(userId: string): Promise<DeletedUser> {
  return callAdminUsers<DeletedUser>({ action: 'delete', userId });
}
