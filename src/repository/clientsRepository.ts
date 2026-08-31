// Data-access layer for a flat client list — needed only by BuildingCreator's
// existing-client picker. Every other view in the app reads client facts
// denormalized through buildings/jobs (BUILDING_SELECT/JOB_SELECT's embedded
// `clients ( id, company_name )`), never a standalone list, so this is a
// genuinely new query, not a duplicate of an existing one. Deliberately not
// the stale mock-era `Client` domain type (domain/types.ts) — that type's
// `invoiceAddress` field doesn't exist on the real `clients` table at all
// (the real "invoice address" is `buildings.invoice_details`); this is a
// minimal, accurate shape instead.

import { supabase } from '../lib/supabaseClient';

export interface ClientOption {
  id: string;
  companyName: string;
}

export async function listClients(): Promise<ClientOption[]> {
  const { data, error } = await supabase.from('clients').select('id, company_name').order('company_name');

  if (error) {
    throw new Error(`Failed to load clients: ${error.message}`);
  }

  return (data ?? []).map((row) => ({ id: row.id, companyName: row.company_name }));
}
