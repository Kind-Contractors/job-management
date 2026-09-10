// Data-access layer for buildings — mirrors jobsRepository.ts's structure.
// Job counts / per-year totals are deliberately NOT recomputed here; the
// Buildings pages combine this with the app's existing listJobRows() result
// (grouped client-side by buildingId), so the yearly-value honesty rules
// (mapJobRow.ts) are computed in exactly one place. See the reviewed plan.

import type { BuildingHistoryEvent, BuildingRow } from '../domain/types';
import { supabase } from '../lib/supabaseClient';
import { mapBuildingRow, type SupabaseBuildingRecord } from './mapBuildingRow';

const BUILDING_SELECT = `
  id,
  client_id,
  address,
  invoice_details,
  extra_requirements,
  name,
  postcode,
  clients ( id, company_name ),
  building_access ( key_safe_code, keyholder_name, keyholder_phone, parking_notes, access_notes )
`;

export async function listBuildingRows(): Promise<BuildingRow[]> {
  const { data, error } = await supabase.from('buildings').select(BUILDING_SELECT);

  if (error) {
    throw new Error(`Failed to load buildings: ${error.message}`);
  }

  return ((data ?? []) as unknown as SupabaseBuildingRecord[]).map(mapBuildingRow);
}

export interface BuildingCreateFields {
  address: string;
  name: string | null;
  postcode: string | null;
  invoiceDetails: string | null;
  siteInstructions: string | null;
}

/**
 * Creates a building for an already-existing client — a plain single-table
 * insert, no atomicity requirement (see createClientAndBuilding() for the
 * new-client case, which genuinely needs one). `building_access`/`who` are
 * never set here — access details are a separate table with no creation UI
 * yet, and `who` is a legacy column nothing in this app reads.
 */
export async function createBuilding(clientId: string, input: BuildingCreateFields): Promise<string> {
  const { data, error } = await supabase
    .from('buildings')
    .insert({
      client_id: clientId,
      address: input.address,
      name: input.name,
      postcode: input.postcode,
      invoice_details: input.invoiceDetails,
      extra_requirements: input.siteInstructions,
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to create building: ${error.message}`);
  }

  return data.id;
}

export interface BuildingEditFields {
  name: string | null;
  address: string;
  postcode: string | null;
  invoiceDetails: string | null;
  siteInstructions: string | null;
}

/**
 * Edits a building's own general details — never client_id (no reassignment
 * workflow exists, and none is being added here) and never building_access
 * (a separate table/function below, kept behind its own reveal-gated UI).
 * Plain update by id, same manager_full_access RLS as createBuilding().
 */
export async function updateBuilding(buildingId: string, fields: BuildingEditFields): Promise<void> {
  const { error } = await supabase
    .from('buildings')
    .update({
      name: fields.name,
      address: fields.address,
      postcode: fields.postcode,
      invoice_details: fields.invoiceDetails,
      extra_requirements: fields.siteInstructions,
    })
    .eq('id', buildingId);

  if (error) {
    throw new Error(`Failed to update building: ${error.message}`);
  }
}

export interface BuildingAccessEditFields {
  keySafeCode: string | null;
  keyholderName: string | null;
  keyholderPhone: string | null;
  parkingNotes: string | null;
  accessNotes: string | null;
}

/**
 * Upserts building_access, keyed on building_id (its primary key) — most
 * buildings (~325/342) have no row here yet, so a plain UPDATE would
 * silently touch zero rows the first time a manager records access details
 * for one. Internal-only data: never read by anything client-facing, and
 * this function is only ever called from the Building File's already
 * reveal-gated access panel. updated_by is deliberately left unset this
 * pass (not required yet).
 */
export async function upsertBuildingAccess(buildingId: string, fields: BuildingAccessEditFields): Promise<void> {
  const { error } = await supabase.from('building_access').upsert(
    {
      building_id: buildingId,
      key_safe_code: fields.keySafeCode,
      keyholder_name: fields.keyholderName,
      keyholder_phone: fields.keyholderPhone,
      parking_notes: fields.parkingNotes,
      access_notes: fields.accessNotes,
    },
    { onConflict: 'building_id' },
  );

  if (error) {
    throw new Error(`Failed to update access details: ${error.message}`);
  }
}

export interface NewClientBuildingInput extends BuildingCreateFields {
  companyName: string;
}

/**
 * Creates a brand-new client and its first building together, atomically —
 * via the create_client_and_building() Postgres function (SECURITY INVOKER,
 * so it's bound by the exact same manager_full_access RLS check the two
 * inserts would face individually; no new privilege surface). Atomic by
 * Postgres's own function-call transaction semantics: if the building insert
 * fails, the client insert inside the same call is rolled back too — an
 * orphan client cannot result from a failed building insert.
 */
export async function createClientAndBuilding(input: NewClientBuildingInput): Promise<{ clientId: string; buildingId: string }> {
  const { data, error } = await supabase
    .rpc('create_client_and_building', {
      p_company_name: input.companyName,
      p_address: input.address,
      p_name: input.name,
      p_postcode: input.postcode,
      p_invoice_details: input.invoiceDetails,
      p_extra_requirements: input.siteInstructions,
    })
    .single();

  if (error) {
    throw new Error(`Failed to create client and building: ${error.message}`);
  }

  const row = data as unknown as { client_id: string; building_id: string };
  return { clientId: row.client_id, buildingId: row.building_id };
}

/**
 * Real activity_events for a building's History tab. The table is empty for
 * every building today — this returns [] rather than any fabricated event
 * (CLAUDE.md section 15).
 */
export async function listBuildingHistory(buildingId: string): Promise<BuildingHistoryEvent[]> {
  const { data, error } = await supabase
    .from('activity_events')
    .select('id, event_type, detail, occurred_at, actor')
    .eq('entity_type', 'building')
    .eq('entity_id', buildingId)
    .order('occurred_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load building history: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    eventType: row.event_type,
    detail: row.detail,
    occurredAt: row.occurred_at,
    actor: row.actor,
  }));
}
