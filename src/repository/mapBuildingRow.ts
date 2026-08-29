// Maps a raw Supabase `buildings` row (with embedded client/access data) onto
// BuildingRow — mirrors mapJobRow.ts's structure and honesty rules.

import type { BuildingAccessInfo, BuildingRow } from '../domain/types';

interface SupabaseClient {
  id: string;
  company_name: string;
}

interface SupabaseBuildingAccess {
  key_safe_code: string | null;
  keyholder_name: string | null;
  keyholder_phone: string | null;
  parking_notes: string | null;
  access_notes: string | null;
}

export interface SupabaseBuildingRecord {
  id: string;
  client_id: string;
  address: string;
  invoice_details: string | null;
  extra_requirements: string | null;
  name: string | null;
  postcode: string | null;
  clients: SupabaseClient | SupabaseClient[] | null;
  building_access: SupabaseBuildingAccess | SupabaseBuildingAccess[] | null;
}

/** Supabase embeds can come back as a single object or a one-item array — normalize both shapes. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function mapBuildingRow(row: SupabaseBuildingRecord): BuildingRow {
  const client = one(row.clients);
  const access = one(row.building_access);

  const buildingName = row.name ?? row.address.split(',')[0]?.trim() ?? '';

  const accessInfo: BuildingAccessInfo | null = access
    ? {
        keySafeCode: access.key_safe_code,
        keyholderName: access.keyholder_name,
        keyholderPhone: access.keyholder_phone,
        parkingNotes: access.parking_notes,
        accessNotes: access.access_notes,
      }
    : null;

  return {
    id: row.id,
    clientId: row.client_id,
    clientName: client?.company_name ?? '',
    address: row.address,
    buildingName,
    postcode: row.postcode ?? '',
    invoiceDetails: row.invoice_details ?? '',
    siteInstructions: row.extra_requirements ?? '',
    access: accessInfo,
  };
}
