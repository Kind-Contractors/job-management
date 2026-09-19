// Data-access layer for jobs. listJobRows() is Supabase-backed — see
// mapJobRow.ts for how each JobRow field is derived/honestly-defaulted from
// the real clients/buildings/jobs/building_access tables (CLAUDE.md section
// 12). listJobRowsFromMock() is kept as a deliberate, explicitly-named
// dev/test seam over the original mock dataset — nothing in the app calls it,
// but it stays available rather than being deleted.

import type { Division, FrequencyType, JobLifecycleStatus, JobRow, JobVisitSummary } from '../domain/types';
import { denormalizeJobRows } from '../mock/jobsData';
import { supabase } from '../lib/supabaseClient';
import { mapJobRow, mapVisitRow, FREQUENCY_TYPE_LABEL, type SupabaseJobRecord, type SupabaseVisit } from './mapJobRow';
import { logCurrentUserActivity } from './activityEventsRepository';

function formatMoney(n: number | null): string {
  return n == null ? 'Variable' : `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatFrequency(f: string | null): string {
  return f ? (FREQUENCY_TYPE_LABEL[f as FrequencyType] ?? f) : 'Not set';
}

interface JobBeforeFields {
  job_summary: string;
  job_notes: string | null;
  job_type: string;
  pricing_type: string;
  price_per_visit: number | null;
  frequency_type: string | null;
}

/**
 * Shared by updateJob() and patchJob() — both end up diffing the same
 * before/after shape, just with different subsets of fields present on
 * `input` (patchJob only ever sends the one column a grid cell edited).
 * Price/frequency get their own event types (distinct bullets in the
 * requirements, with an old → new value); everything else collapses into
 * one generic "details updated" event naming only which fields changed.
 */
async function logJobChanges(jobId: string, before: JobBeforeFields, input: JobPatchInput): Promise<void> {
  const changedFields: string[] = [];
  if (input.jobSummary !== undefined && input.jobSummary !== before.job_summary) changedFields.push('name');
  if (input.jobNotes !== undefined && input.jobNotes !== before.job_notes) changedFields.push('notes');
  if (input.division !== undefined) {
    const newJobType = input.division === 'Specialist' ? 'specialist' : 'general';
    if (newJobType !== before.job_type) changedFields.push('division');
  }
  if (input.pricingType !== undefined && input.pricingType !== before.pricing_type) changedFields.push('pricing type');

  if (changedFields.length > 0) {
    await logCurrentUserActivity('job', jobId, 'job_details_updated', `Updated: ${changedFields.join(', ')}`);
  }

  if (input.pricePerVisit !== undefined && input.pricePerVisit !== before.price_per_visit) {
    await logCurrentUserActivity(
      'job',
      jobId,
      'job_price_changed',
      `${formatMoney(before.price_per_visit)} → ${formatMoney(input.pricePerVisit)}`,
    );
  }

  if (input.frequencyType !== undefined && input.frequencyType !== before.frequency_type) {
    await logCurrentUserActivity(
      'job',
      jobId,
      'job_frequency_changed',
      `${formatFrequency(before.frequency_type)} → ${formatFrequency(input.frequencyType)}`,
    );
  }
}

const JOB_BEFORE_SELECT = 'job_summary, job_notes, job_type, pricing_type, price_per_visit, frequency_type';

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
  lifecycle_status,
  lost_reason,
  recontact_due_at,
  recontact_notes,
  recontact_interval_months,
  buildings (
    id,
    client_id,
    address,
    invoice_details,
    name,
    postcode,
    clients (
      id, company_name,
      contacts ( id, name, email, phone_number, is_primary, is_accounts_contact )
    ),
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
  const { data, error } = await supabase
    .from('jobs')
    .select(JOB_SELECT)
    .eq('lifecycle_status', 'active')
    // Deterministic order — without one, Postgres/PostgREST give no
    // ordering guarantee at all, and since every inline grid edit now
    // triggers a reconciling refetch of this exact query (see JobsGrid.tsx),
    // an unordered result could visibly reshuffle rows/groups moments after
    // every edit even though nothing about the data actually changed.
    // created_at is a genuine, meaningful "oldest/imported first" order;
    // id is a pure tiebreaker for rows sharing an identical timestamp
    // (common for bulk-migrated legacy jobs).
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    throw new Error(`Failed to load jobs: ${error.message}`);
  }

  return ((data ?? []) as unknown as SupabaseJobRecord[]).map(mapJobRow);
}

/** The three lifecycle values Historical Jobs shows — deliberately excludes 'on_hold' (a job that may resume, not a historical one) and 'active'. See the reviewed Historical Jobs audit. */
const HISTORICAL_LIFECYCLE_STATUSES: JobLifecycleStatus[] = ['completed', 'lost', 'cancelled'];

/**
 * Sibling to listJobRows() above — never a modification of it, and never
 * called by anything listJobRows() itself feeds (All Live Jobs, Report
 * Review, Ready for Accounts, Ready for Client, Month Matrix, Schedule all
 * keep reading listJobRows() exactly as before). Reuses the identical
 * JOB_SELECT/mapJobRow() so a historical JobRow has the exact same shape
 * as a live one — only the lifecycle filter differs, matching an explicit
 * allow-list of the three historical values rather than a broad `.neq()`
 * (which would incorrectly also surface 'on_hold').
 */
export async function listHistoricalJobRows(): Promise<JobRow[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select(JOB_SELECT)
    .in('lifecycle_status', HISTORICAL_LIFECYCLE_STATUSES)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    throw new Error(`Failed to load historical jobs: ${error.message}`);
  }

  return ((data ?? []) as unknown as SupabaseJobRecord[]).map(mapJobRow);
}

/** Same visit/report/invoice columns as JOB_SELECT's own `visits(...)` sub-select above — deliberately excludes buildings/clients/schedules, which the safeguards never look at. */
const JOB_LIFECYCLE_SAFEGUARD_VISIT_SELECT = `
  id, technician_id, scheduled_date, status, price_charged, completed_at,
  technicians ( id, name, is_active ),
  reports ( id, review_status, sent_to_client_at, sent_to_accounts_at ),
  invoice_line_items ( invoice_id, invoices ( status ) )
`;

/**
 * A fresh, job-scoped re-read of exactly the visit/report/invoice state
 * JobLifecycleDialog's safeguards evaluate (isUnresolvedVisit()/
 * hasIncompleteReportWork()) — called once, immediately before
 * updateJobLifecycle(), to close the race window where the cached
 * `jobRows` snapshot the dialog opened with could be stale (another
 * session or a technician booked a visit, or a report's state changed,
 * after that query ran but before Confirm was clicked). Returns the exact
 * same JobVisitSummary shape as job.visits (via the shared mapVisitRow()),
 * so the dialog's existing safeguard predicates apply unchanged to both
 * the cached and the fresh result — one set of safeguard rules, never two.
 */
export async function getJobLifecycleSafeguardState(jobId: string): Promise<JobVisitSummary[]> {
  const { data, error } = await supabase
    .from('visits')
    .select(JOB_LIFECYCLE_SAFEGUARD_VISIT_SELECT)
    .eq('job_id', jobId);

  if (error) {
    throw new Error(`Failed to verify job status: ${error.message}`);
  }

  return ((data ?? []) as unknown as SupabaseVisit[]).map(mapVisitRow);
}

export type ActiveToHistoricalLifecycleStatus = 'completed' | 'lost' | 'cancelled';

export interface UpdateJobLifecycleInput {
  lifecycleStatus: ActiveToHistoricalLifecycleStatus;
  /** Also used to store an optional cancellation reason (see UI layer) — there is no separate cancellation-reason column, and this phase does not change the schema. */
  lostReason: string | null;
  recontactDueAt: string | null;
  recontactNotes: string | null;
  recontactIntervalMonths: number | null;
}

/**
 * The one write path for a lifecycle transition (Mark as Completed/Lost/
 * Cancelled — see JobLifecycleDialog.tsx, the only caller). Updates ONLY
 * the five lifecycle-related columns via a single targeted `.update()` —
 * never job_summary/pricing/frequency/building_id/default_technician_id/
 * anything else, and never touches visits/reports/invoices/photos/contacts.
 * All safeguard checks (unresolved visits, in-flight report work) happen
 * in the caller BEFORE this is ever invoked; this function itself performs
 * no business-rule validation and trusts the caller completely, matching
 * every other narrow, single-purpose mutation in this file (e.g.
 * assignJobTechnician).
 */
export async function updateJobLifecycle(jobId: string, input: UpdateJobLifecycleInput): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({
      lifecycle_status: input.lifecycleStatus,
      lost_reason: input.lostReason,
      recontact_due_at: input.recontactDueAt,
      recontact_notes: input.recontactNotes,
      recontact_interval_months: input.recontactIntervalMonths,
    })
    .eq('id', jobId);

  if (error) {
    throw new Error(`Failed to update job status: ${error.message}`);
  }

  await logCurrentUserActivity('job', jobId, 'job_lifecycle_changed', `Status changed to ${input.lifecycleStatus}`);
}

/**
 * Assigns (or clears, if technicianId is null) a job's default/usual
 * technician — independent of any individual visit's own assignee. Does not
 * touch visits/schedules.
 */
export async function assignJobTechnician(jobId: string, technicianId: string | null): Promise<void> {
  const { data: before } = await supabase.from('jobs').select('default_technician_id').eq('id', jobId).maybeSingle();

  const { error } = await supabase.from('jobs').update({ default_technician_id: technicianId }).eq('id', jobId);

  if (error) {
    throw new Error(`Failed to assign technician: ${error.message}`);
  }

  const beforeId = before?.default_technician_id ?? null;
  if (beforeId === technicianId) return;

  const idsToResolve = [beforeId, technicianId].filter((id): id is string => !!id);
  const namesById = new Map<string, string>();
  if (idsToResolve.length > 0) {
    const { data: techs } = await supabase.from('technicians').select('id, name').in('id', idsToResolve);
    for (const t of techs ?? []) namesById.set(t.id, t.name);
  }
  const beforeName = beforeId ? (namesById.get(beforeId) ?? 'Unknown') : 'Unassigned';
  const afterName = technicianId ? (namesById.get(technicianId) ?? 'Unknown') : 'Unassigned';
  await logCurrentUserActivity('job', jobId, 'job_default_technician_changed', `${beforeName} → ${afterName}`);
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
  const { data: before } = await supabase.from('jobs').select(JOB_BEFORE_SELECT).eq('id', jobId).maybeSingle();

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

  if (before) await logJobChanges(jobId, before, input);
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
  const { data: before } = await supabase.from('jobs').select(JOB_BEFORE_SELECT).eq('id', jobId).maybeSingle();

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

  if (before) await logJobChanges(jobId, before, input);
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

  await logCurrentUserActivity('job', data.id, 'job_created');
  return data.id;
}

/** Deliberate dev/test seam over the original mock dataset — not used by the app. */
export function listJobRowsFromMock(): Promise<JobRow[]> {
  const SIMULATED_LATENCY_MS = 150;
  return new Promise((resolve) => {
    setTimeout(() => resolve(denormalizeJobRows()), SIMULATED_LATENCY_MS);
  });
}
