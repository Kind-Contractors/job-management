// Data-access layer for client contacts. Mirrors listBuildingHistory's
// scoped-by-id shape (buildingsRepository.ts). is_primary/is_accounts_contact
// are read exactly as stored — never inferred or defaulted here or in the UI.

import type { Contact } from '../domain/types';
import { supabase } from '../lib/supabaseClient';

const CONTACT_SELECT = 'id, client_id, name, role, email, phone_number, is_primary, is_accounts_contact, notes';

export async function listContactsForClient(clientId: string): Promise<Contact[]> {
  const { data, error } = await supabase
    .from('contacts')
    .select(CONTACT_SELECT)
    .eq('client_id', clientId)
    .order('is_primary', { ascending: false })
    .order('name', { ascending: true });

  if (error) throw new Error(`Failed to load contacts: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    role: row.role,
    email: row.email,
    phoneNumber: row.phone_number,
    isPrimary: row.is_primary,
    isAccountsContact: row.is_accounts_contact,
    notes: row.notes,
  }));
}

export interface ContactFieldsInput {
  name: string;
  email: string | null;
  phoneNumber: string | null;
  /** Explicit only — never inferred/defaulted. See unsetOtherPrimaryContacts() below for why setting this true is a two-step operation. */
  isPrimary: boolean;
}

/**
 * `contacts_one_primary_per_client_idx` (a partial UNIQUE index on
 * `client_id WHERE is_primary`) means a second contact can never be set
 * primary while one already is — INSERT/UPDATE would violate the
 * constraint. This is the one safe way to change which contact is primary:
 * clear the client's current primary (if any) first, in its own statement,
 * before the caller's create/update sets the new one. Never called unless
 * the caller is explicitly setting a new primary (see createContactForClient/
 * updateContact below) — an ordinary field edit never touches this.
 */
async function unsetOtherPrimaryContacts(clientId: string, exceptContactId?: string): Promise<void> {
  let query = supabase.from('contacts').update({ is_primary: false }).eq('client_id', clientId).eq('is_primary', true);
  if (exceptContactId) query = query.neq('id', exceptContactId);
  const { error } = await query;
  if (error) throw new Error(`Failed to update the client's existing primary contact: ${error.message}`);
}

/**
 * Creates a genuinely NEW contact for a client — only ever called from an
 * explicit "+ Add contact" action (see ContactPopover.tsx), never as a
 * side effect of editing an existing contact's fields (that's updateContact
 * below). Setting `isPrimary: true` here is still safe even though this
 * contact doesn't exist yet: unsetOtherPrimaryContacts() runs first, so the
 * unique index is never at risk of two primaries existing at once.
 */
export async function createContactForClient(clientId: string, input: ContactFieldsInput): Promise<Contact> {
  if (input.isPrimary) await unsetOtherPrimaryContacts(clientId);

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      client_id: clientId,
      name: input.name,
      email: input.email,
      phone_number: input.phoneNumber,
      is_primary: input.isPrimary,
    })
    .select(CONTACT_SELECT)
    .single();

  if (error) throw new Error(`Failed to create contact: ${error.message}`);

  return {
    id: data.id,
    clientId: data.client_id,
    name: data.name,
    role: data.role,
    email: data.email,
    phoneNumber: data.phone_number,
    isPrimary: data.is_primary,
    isAccountsContact: data.is_accounts_contact,
    notes: data.notes,
  };
}

/**
 * Updates ONE exact, already-identified contact by its real id — never by
 * matching name/email, which is the actual duplicate/wrong-record risk
 * this function exists to avoid. `clientId` is required only so a
 * `isPrimary: true` edit can safely clear the client's other primary
 * contact first (see unsetOtherPrimaryContacts) — every other field is a
 * plain, single-row UPDATE.
 */
export async function updateContact(
  contactId: string,
  clientId: string,
  patch: Partial<ContactFieldsInput>,
): Promise<void> {
  if (patch.isPrimary) await unsetOtherPrimaryContacts(clientId, contactId);

  const dbPatch: Record<string, unknown> = {};
  if (patch.name !== undefined) dbPatch.name = patch.name;
  if (patch.email !== undefined) dbPatch.email = patch.email;
  if (patch.phoneNumber !== undefined) dbPatch.phone_number = patch.phoneNumber;
  if (patch.isPrimary !== undefined) dbPatch.is_primary = patch.isPrimary;

  const { error } = await supabase.from('contacts').update(dbPatch).eq('id', contactId);
  if (error) throw new Error(`Failed to update contact: ${error.message}`);
}
