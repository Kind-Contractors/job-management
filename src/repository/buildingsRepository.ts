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
