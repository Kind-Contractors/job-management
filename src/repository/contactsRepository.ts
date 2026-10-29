// Data-access layer for client contacts. Mirrors listBuildingHistory's
// scoped-by-id shape (buildingsRepository.ts). is_primary/is_accounts_contact
// are read exactly as stored — never inferred or defaulted here or in the UI.

import type { Contact } from '../domain/types';
import { supabase } from '../lib/supabaseClient';
import { logCurrentUserActivity } from './activityEventsRepository';

const CONTACT_SELECT = 'id, client_id, name, role, email, phone_number, is_primary, is_accounts_contact, notes, xero_contact_id, xero_org_id, xero_contact_name, xero_linked_at';

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
    xeroContactId: row.xero_contact_id ?? null,
    xeroOrgId: row.xero_org_id ?? null,
    xeroContactName: row.xero_contact_name ?? null,
    xeroLinkedAt: row.xero_linked_at ?? null,
  }));
}

export interface ContactFieldsInput {
  name: string;
  email: string | null;
  phoneNumber: string | null;
  /** Explicit only — never inferred/defaulted. See unsetOtherPrimaryContacts() below for why setting this true is a two-step operation. */
  isPrimary: boolean;
  /**
   * Accounts-only (invoices; never chosen automatically for job reports). Explicit only — never inferred from the name or email.
   * Omitted = not written: a new contact keeps the database default (false) and an edit leaves the saved value as it is.
   */
  isAccountsContact?: boolean;
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
  // The rows the update actually changed (none when the client had no other main contact), so only a real demotion is recorded.
  const { data: demoted, error } = await query.select('id, name');
  if (error) throw new Error(`Failed to update the client's existing primary contact: ${error.message}`);
  // Recorded as soon as it has happened: the demotion is real even if the caller's own save then fails.
  for (const c of demoted ?? []) {
    await logContactActivity(clientId, 'contact_updated', `Contact updated: ${c.name} (no longer main contact)`);
  }
}

/**
 * What changed, for the contact history: field NAMES and status changes only - never the values themselves (no email
 * address or phone number is written to the history). Empty when nothing really changed.
 */
export function contactChangeSummary(
  before: { name: string; email: string | null; phone_number: string | null; is_primary: boolean; is_accounts_contact: boolean },
  patch: Partial<ContactFieldsInput>,
): string[] {
  const changes: string[] = [];
  if (patch.name !== undefined && patch.name !== before.name) changes.push('name');
  if (patch.email !== undefined && (patch.email ?? null) !== (before.email ?? null)) changes.push('email');
  if (patch.phoneNumber !== undefined && (patch.phoneNumber ?? null) !== (before.phone_number ?? null)) changes.push('phone');
  if (patch.isPrimary !== undefined && patch.isPrimary !== before.is_primary) changes.push(patch.isPrimary ? 'now main contact' : 'no longer main contact');
  if (patch.isAccountsContact !== undefined && patch.isAccountsContact !== before.is_accounts_contact) {
    changes.push(patch.isAccountsContact ? 'marked accounts only' : 'no longer accounts only');
  }
  return changes;
}

/**
 * Contacts belong to a client, not a building (a client can have several
 * buildings) — so a contact event is logged against every building of that
 * client, the same "shows up everywhere this contact is relevant" behavior
 * a shared contact already has on Site File. `activity_entity_type` has no
 * 'contact'/'client' value (and this pass isn't adding one), so 'building'
 * is the closest existing, correct scope.
 */
async function logContactActivity(clientId: string, eventType: string, detail: string): Promise<void> {
  const { data: buildings, error } = await supabase.from('buildings').select('id').eq('client_id', clientId);
  if (error) {
    console.error(`Failed to resolve buildings for contact activity "${eventType}":`, error.message);
    return;
  }
  for (const building of buildings ?? []) {
    await logCurrentUserActivity('building', building.id, eventType, detail);
  }
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
      // Only when the caller says so; otherwise the column default (false) applies.
      ...(input.isAccountsContact !== undefined ? { is_accounts_contact: input.isAccountsContact } : {}),
    })
    .select(CONTACT_SELECT)
    .single();

  if (error) throw new Error(`Failed to create contact: ${error.message}`);

  const added = [data.is_primary ? 'main contact' : null, data.is_accounts_contact ? 'accounts only' : null].filter(Boolean);
  await logContactActivity(clientId, 'contact_added', `Contact added: ${data.name}${added.length ? ` (${added.join(', ')})` : ''}`);

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
    xeroContactId: data.xero_contact_id ?? null,
    xeroOrgId: data.xero_org_id ?? null,
    xeroContactName: data.xero_contact_name ?? null,
    xeroLinkedAt: data.xero_linked_at ?? null,
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
  const { data: before } = await supabase
    .from('contacts')
    .select('name, email, phone_number, is_primary, is_accounts_contact')
    .eq('id', contactId)
    .maybeSingle();

  if (patch.isPrimary) await unsetOtherPrimaryContacts(clientId, contactId);

  const dbPatch: Record<string, unknown> = {};
  if (patch.name !== undefined) dbPatch.name = patch.name;
  if (patch.email !== undefined) dbPatch.email = patch.email;
  if (patch.phoneNumber !== undefined) dbPatch.phone_number = patch.phoneNumber;
  if (patch.isPrimary !== undefined) dbPatch.is_primary = patch.isPrimary;
  // Written only when the caller supplies it: an edit that does not mention it never changes the saved classification.
  if (patch.isAccountsContact !== undefined) dbPatch.is_accounts_contact = patch.isAccountsContact;

  const { error } = await supabase.from('contacts').update(dbPatch).eq('id', contactId);
  if (error) throw new Error(`Failed to update contact: ${error.message}`);

  const changes = before ? contactChangeSummary(before, patch) : [];
  if (changes.length > 0) {
    const name = patch.name ?? before!.name;
    await logContactActivity(clientId, 'contact_updated', `Contact updated: ${name} (${changes.join(', ')})`);
  }
}

/**
 * What decides whether a contact may be deleted, read fresh when the delete dialog opens. Contacts belong to the CLIENT, so every
 * check covers all of the client's buildings. `updatedAt` is the version the manager is looking at: the delete only goes ahead if
 * the contact is still exactly that version (see deleteContact). Null when the contact no longer exists for this client.
 */
export interface ContactDeletionCheck {
  contactId: string;
  name: string;
  updatedAt: string;
  isPrimary: boolean;
  /** The client's buildings whose default invoice recipient is this contact (a delete is refused by the database while any is). */
  defaultForBuildings: { id: string; name: string }[];
  /** Job reports sent to this contact (the send history references it, so the database refuses the delete). */
  reportSends: number;
  /** Linked to a Xero contact: deleting removes only the app's link; nothing changes in Xero. */
  xeroContactName: string | null;
  linkedToXero: boolean;
  /** How many buildings share this client's contacts (the contact is removed from all of them). */
  buildingCount: number;
}

export async function checkContactDeletion(contactId: string, clientId: string): Promise<ContactDeletionCheck | null> {
  const { data: contact, error } = await supabase
    .from('contacts')
    .select('id, client_id, name, is_primary, xero_contact_id, xero_contact_name, updated_at')
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw new Error(`Could not check the contact: ${error.message}`);
  if (!contact || contact.client_id !== clientId) return null;

  const [defaults, sends, buildings] = await Promise.all([
    supabase.from('buildings').select('id, name, address').eq('default_invoice_contact_id', contactId),
    supabase.from('report_client_sends').select('id', { count: 'exact', head: true }).eq('recipient_contact_id', contactId),
    supabase.from('buildings').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
  ]);
  for (const r of [defaults, sends, buildings]) if (r.error) throw new Error(`Could not check the contact: ${r.error.message}`);

  return {
    contactId: contact.id,
    name: contact.name,
    updatedAt: contact.updated_at,
    isPrimary: contact.is_primary === true,
    defaultForBuildings: (defaults.data ?? []).map((b) => ({ id: b.id, name: b.name || b.address })),
    reportSends: sends.count ?? 0,
    xeroContactName: contact.xero_contact_name ?? null,
    linkedToXero: !!contact.xero_contact_id?.trim(),
    buildingCount: buildings.count ?? 0,
  };
}

/** Why a delete was refused: the database's foreign keys are the final word, whatever was checked before. */
export const CONTACT_DELETE_REFUSED = {
  invoiceDefault: 'This contact is now the default invoice recipient of a building. Change or clear that default first. Nothing was deleted.',
  reportHistory: 'This contact has been sent job reports, so it is kept for the record of who they went to. Nothing was deleted.',
  changed: 'This contact changed (or was removed) after you opened it. Close this and check it again. Nothing was deleted.',
};

/**
 * Deletes ONE contact by its id - only if it is still the version the manager checked (`expectedUpdatedAt`), so an edit made in the
 * meantime (for example becoming the main contact) is never deleted unseen. The database still refuses a contact that is a building's
 * default invoice recipient or has been sent job reports (foreign keys), whatever was checked before; those refusals come back as
 * plain messages. On success the deletion is recorded in each of the client's building histories, by name only.
 */
export async function deleteContact(contactId: string, clientId: string, expectedUpdatedAt: string, name: string): Promise<void> {
  const { data, error } = await supabase
    .from('contacts')
    .delete()
    .eq('id', contactId)
    .eq('client_id', clientId)
    .eq('updated_at', expectedUpdatedAt)
    .select('id');
  if (error) {
    if (error.code === '23503') {
      const which = `${error.message} ${error.details ?? ''}`;
      if (which.includes('report_client_sends')) throw new Error(CONTACT_DELETE_REFUSED.reportHistory);
      throw new Error(CONTACT_DELETE_REFUSED.invoiceDefault);
    }
    throw new Error(`The contact could not be deleted: ${error.message}`);
  }
  if (!data || data.length === 0) throw new Error(CONTACT_DELETE_REFUSED.changed);

  await logContactActivity(clientId, 'contact_deleted', `Contact deleted: ${name}`);
}
