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
