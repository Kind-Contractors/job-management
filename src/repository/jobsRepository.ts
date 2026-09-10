// Data-access layer for jobs. listJobRows() is Supabase-backed — see
// mapJobRow.ts for how each JobRow field is derived/honestly-defaulted from
// the real clients/buildings/jobs/building_access tables (CLAUDE.md section
// 12). listJobRowsFromMock() is kept as a deliberate, explicitly-named
// dev/test seam over the original mock dataset — nothing in the app calls it,
// but it stays available rather than being deleted.

import type { Division, FrequencyType, JobRow } from '../domain/types';
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
  default_technician_id,
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
  technicians ( id, name, is_active ),
  schedules ( schedule_type, interval_unit, interval_count, weekday, week_ordinal, day_of_month, roll_forward_on_weekend, due_month, notes ),
  visits (
    id, technician_id, scheduled_date, status, price_charged, completed_at,
    technicians ( id, name, is_active ),
    reports ( id, review_status, sent_to_client_at, sent_to_accounts_at ),
    invoice_line_items ( invoice_id, invoices ( status ) )
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
 * Assigns (or clears, if technicianId is null) a job's default/usual
 * technician — independent of any individual visit's own assignee. Does not
 * touch visits/schedules.
 */
export async function assignJobTechnician(jobId: string, technicianId: string | null): Promise<void> {
  const { error } = await supabase.from('jobs').update({ default_technician_id: technicianId }).eq('id', jobId);

  if (error) {
    throw new Error(`Failed to assign technician: ${error.message}`);
  }
}

export interface JobEditInput {
  jobSummary: string;
  jobNotes: string | null;
  division: Division;
  pricingType: 'fixed' | 'variable';
  pricePerVisit: number | null;
  frequencyType: FrequencyType | null;
}

/**
 * Edits a job's own descriptive/pricing/frequency fields only — never
 * touches building_id, lifecycle_status, the source_ traceability columns,
 * created_at/updated_at, or the recontact_ fields/lost_reason (see the
 * reviewed plan for why each of those stays out of scope for this pass).
 * `pricePerVisit` must already satisfy
 * the DB's own jobs_pricing_consistency_check (fixed -> non-null, variable
 * -> null) before calling this — it sends exactly what's given, never
 * transforms a value to fit.
 */
export async function updateJob(jobId: string, input: JobEditInput): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({
      job_summary: input.jobSummary,
      job_notes: input.jobNotes,
      job_type: input.division === 'Specialist' ? 'specialist' : 'general',
      pricing_type: input.pricingType,
      price_per_visit: input.pricePerVisit,
      frequency_type: input.frequencyType,
    })
    .eq('id', jobId);

  if (error) {
    throw new Error(`Failed to update job: ${error.message}`);
  }
}

export type JobPatchInput = Partial<JobEditInput>;

/**
 * Patches only the given fields of a job — used by JobsGrid's inline cell
 * edits, where a single Tab-committed cell should touch only its own
 * column rather than resending the whole job (avoids clobbering a change
 * made to a different field in the same moment). Mirrors
 * reportsRepository.ts's updateReport() partial-patch pattern exactly.
 * updateJob() above is unchanged and still used by the full JobEditor form.
 * Never includes default_technician_id — that's assignJobTechnician()'s
 * job alone, reused as-is by the grid's Technician column.
 */
export async function patchJob(jobId: string, input: JobPatchInput): Promise<void> {
  const patch: Record<string, unknown> = {};
  if ('jobSummary' in input) patch.job_summary = input.jobSummary;
  if ('jobNotes' in input) patch.job_notes = input.jobNotes;
  if ('division' in input) patch.job_type = input.division === 'Specialist' ? 'specialist' : 'general';
  if ('pricingType' in input) patch.pricing_type = input.pricingType;
  if ('pricePerVisit' in input) patch.price_per_visit = input.pricePerVisit;
  if ('frequencyType' in input) patch.frequency_type = input.frequencyType;

  const { error } = await supabase.from('jobs').update(patch).eq('id', jobId);

  if (error) {
    throw new Error(`Failed to update job: ${error.message}`);
  }
}

export interface JobCreateInput {
  buildingId: string;
  division: Division;
  jobSummary: string;
  jobNotes: string | null;
  pricingType: 'fixed' | 'variable';
  pricePerVisit: number | null;
  frequencyType: FrequencyType | null;
  defaultTechnicianId: string | null;
}

/**
 * Creates a genuinely new job for an existing building — never a new
 * building/client (see the reviewed plan for why that stays a separate,
 * later feature) and never a schedule (the existing ScheduleEditor covers
 * that immediately afterward, from the Job Inspector this returns into).
 * `source_file: 'manager_created'` states the job's real, true provenance
 * (widened onto `jobs_source_file_check` for exactly this purpose) — never
 * one of the three legacy import labels, which would misrepresent a job
 * that never came from a spreadsheet row. `lifecycle_status`/`created_at`/
 * `updated_at` use the table's own defaults ('active'/`now()`) — not set
 * here. Every legacy staging-era column (`frequency_raw`,
 * `frequency_normalised`, the `charge_per_visit_raw`/`monthly_invoice_raw`/
 * `yearly_total_raw`/`status_notes`/`source_job_id`/`source_*_row` columns)
 * is left at its column default (null) — genuinely inapplicable, not a gap.
 */
export async function createJob(input: JobCreateInput): Promise<string> {
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      building_id: input.buildingId,
      job_type: input.division === 'Specialist' ? 'specialist' : 'general',
      job_summary: input.jobSummary,
      job_notes: input.jobNotes,
      pricing_type: input.pricingType,
      price_per_visit: input.pricePerVisit,
      frequency_type: input.frequencyType,
      default_technician_id: input.defaultTechnicianId,
      source_file: 'manager_created',
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to create job: ${error.message}`);
  }

  return data.id;
}

/** Deliberate dev/test seam over the original mock dataset — not used by the app. */
export function listJobRowsFromMock(): Promise<JobRow[]> {
  const SIMULATED_LATENCY_MS = 150;
  return new Promise((resolve) => {
    setTimeout(() => resolve(denormalizeJobRows()), SIMULATED_LATENCY_MS);
  });
}
