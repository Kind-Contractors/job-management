// Data-access layer for jobs. listJobRows() is Supabase-backed — see
// mapJobRow.ts for how each JobRow field is derived/honestly-defaulted from
// the real clients/buildings/jobs/building_access tables (CLAUDE.md section
// 12). listJobRowsFromMock() is kept as a deliberate, explicitly-named
// dev/test seam over the original mock dataset — nothing in the app calls it,
// but it stays available rather than being deleted.

import type { JobRow } from '../domain/types';
import { denormalizeJobRows } from '../mock/jobsData';
import { supabase } from '../lib/supabaseClient';
import { mapJobRow, type SupabaseJobRecord } from './mapJobRow';

const JOB_SELECT = `
  id,
  building_id,
  job_type,
  job_summary,
  job_notes,
  frequency_raw,
  frequency_type,
  pricing_type,
  price_per_visit,
  source_job_id,
  default_team_id,
  buildings (
    id,
    client_id,
    address,
    invoice_details,
    name,
    postcode,
    clients ( id, company_name ),
    building_access ( access_notes )
  ),
  teams ( id, name, is_active ),
  schedules ( schedule_type, interval_unit, interval_count, weekday, week_ordinal, day_of_month, roll_forward_on_weekend, due_month, notes ),
  visits (
    id, team_id, scheduled_date, status, price_charged, completed_at,
    teams ( id, name, is_active ),
    reports ( id, review_status, sent_to_client_at, sent_to_accounts_at )
  )
`;

/**
 * Every view in the app shares this one query — filtering `lifecycle_status`
 * here (rather than per-view) is what "one master dataset, several views"
 * means in practice. Only 'active' counts as live for this pass; a future
 * historical/lost-jobs view is a natural, separate, parameterized query —
 * not this one.
 */
export async function listJobRows(): Promise<JobRow[]> {
  const { data, error } = await supabase.from('jobs').select(JOB_SELECT).eq('lifecycle_status', 'active');

  if (error) {
    throw new Error(`Failed to load jobs: ${error.message}`);
  }

  return ((data ?? []) as unknown as SupabaseJobRecord[]).map(mapJobRow);
}

/**
 * Assigns (or clears, if teamId is null) a job's default team — the first
 * write this repository performs. Does not touch visits/schedules.
 */
export async function assignJobTeam(jobId: string, teamId: string | null): Promise<void> {
  const { error } = await supabase.from('jobs').update({ default_team_id: teamId }).eq('id', jobId);

  if (error) {
    throw new Error(`Failed to assign team: ${error.message}`);
  }
}

/** Deliberate dev/test seam over the original mock dataset — not used by the app. */
export function listJobRowsFromMock(): Promise<JobRow[]> {
  const SIMULATED_LATENCY_MS = 150;
  return new Promise((resolve) => {
    setTimeout(() => resolve(denormalizeJobRows()), SIMULATED_LATENCY_MS);
  });
}
