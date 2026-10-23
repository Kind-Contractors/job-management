// Changing a building's client (management company) and reading the record of past changes. The change itself is one database
// function, change_building_client (migration 20261023100000), so that the new client, clearing the old client's default invoice
// recipient, and the history row happen together or not at all - and so the manager-only rule and the "unfinished invoices
// block the change" rule are enforced by the database, whatever calls it.

import { supabase } from '../lib/supabaseClient';

/** One recorded change of a building's client. Only changes made through the app are recorded; earlier ones never were. */
export interface BuildingClientChange {
  id: string;
  previousClientId: string;
  previousClientName: string;
  newClientId: string;
  newClientName: string;
  changedAt: string;
  changedBy: string;
  /** True when the building's default invoice recipient (a contact of the previous client) was cleared by the change. */
  defaultRecipientCleared: boolean;
}

interface RawChange {
  id: string;
  previous_client_id: string;
  new_client_id: string;
  changed_at: string;
  changed_by: string;
  default_recipient_cleared: boolean;
  previous: { company_name: string } | { company_name: string }[] | null;
  next: { company_name: string } | { company_name: string }[] | null;
}

const nameOf = (v: RawChange['previous']) => (Array.isArray(v) ? v[0]?.company_name : v?.company_name) ?? 'Unknown client';

/** The building's recorded client changes, oldest first. */
export async function listBuildingClientHistory(buildingId: string): Promise<BuildingClientChange[]> {
  const { data, error } = await supabase
    .from('building_client_history')
    .select(
      'id, previous_client_id, new_client_id, changed_at, changed_by, default_recipient_cleared, ' +
        'previous:clients!building_client_history_previous_client_id_fkey ( company_name ), ' +
        'next:clients!building_client_history_new_client_id_fkey ( company_name )',
    )
    .eq('building_id', buildingId)
    .order('changed_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`Failed to load the management history: ${error.message}`);
  return ((data ?? []) as unknown as RawChange[]).map((r) => ({
    id: r.id,
    previousClientId: r.previous_client_id,
    previousClientName: nameOf(r.previous),
    newClientId: r.new_client_id,
    newClientName: nameOf(r.next),
    changedAt: r.changed_at,
    changedBy: r.changed_by,
    defaultRecipientCleared: r.default_recipient_cleared,
  }));
}

export interface ChangeBuildingClientInput {
  buildingId: string;
  newClientId: string;
  /** The client the manager saw and confirmed changing FROM: if it changed meanwhile, the database refuses. */
  expectedClientId: string;
}

/**
 * Creates a client (company name only - all a client record requires) and changes the building to it, in ONE database call:
 * if anything is refused (a duplicate name, unfinished invoices, a stale page...) the new client is not created either.
 */
export async function changeBuildingClientToNewClient(input: {
  buildingId: string;
  companyName: string;
  expectedClientId: string;
}): Promise<{ newClientId: string; newClientName: string; defaultRecipientCleared: boolean }> {
  const { data, error } = await supabase.rpc('change_building_client_to_new_client', {
    p_building_id: input.buildingId,
    p_company_name: input.companyName,
    p_expected_client_id: input.expectedClientId,
  });
  if (error) throw new Error(error.message);
  const result = data as { newClientId?: unknown; newClientName?: unknown; defaultRecipientCleared?: unknown } | null;
  if (typeof result?.newClientId !== 'string') throw new Error('The new client was not confirmed by the server. Reload the building to check it.');
  return {
    newClientId: result.newClientId,
    newClientName: typeof result.newClientName === 'string' ? result.newClientName : input.companyName,
    defaultRecipientCleared: result.defaultRecipientCleared === true,
  };
}

/** Changes the building's client. Throws the database's own explanation when it refuses; nothing is changed then. */
export async function changeBuildingClient(input: ChangeBuildingClientInput): Promise<{ defaultRecipientCleared: boolean }> {
  const { data, error } = await supabase.rpc('change_building_client', {
    p_building_id: input.buildingId,
    p_new_client_id: input.newClientId,
    p_expected_client_id: input.expectedClientId,
  });
  if (error) throw new Error(error.message);
  const result = data as { defaultRecipientCleared?: unknown } | null;
  return { defaultRecipientCleared: result?.defaultRecipientCleared === true };
}
