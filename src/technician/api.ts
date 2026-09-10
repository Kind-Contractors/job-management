// Data-access layer for the technician app — calls ONLY the Phase 1-3
// SECURITY DEFINER RPCs (technician_today_visits, technician_visit_detail,
// technician_submit_report). Never queries jobs/visits/buildings/
// building_access/technicians/reports/photos directly — those tables have no
// technician-facing RLS policy at all; the RPC boundary is the only access
// path a technician session has. These types are local to the technician app
// on purpose — not added to src/domain/types.ts, which is the Manager app's
// own shared shape.
//
// KNOWN GAP (Phase 1-3 audit, 2026-09-07 — see matching DB comments on
// technician_visit_detail()/technician_submit_report()/the two technician
// storage.objects policies): every ownership check here is CURRENT
// visits.technician_id only, no reassignment history. If an existing-visit
// reassignment feature is ever built, report/photo ownership across
// reassignment must be explicitly redesigned first — otherwise a newly
// assigned technician would read the previous technician's already-submitted
// report and photos for the same visit. Not an issue today: no Manager UI
// reassigns an already-created visit's technician.

import { supabase } from '../lib/supabaseClient';

export type TechnicianVisitStatus = 'due' | 'booked' | 'completed' | 'missed' | 'cancelled';
export type TechnicianReportReviewStatus = 'awaiting_review' | 'approved' | 'returned_for_correction';

/** 'jobs.job_type' as stored ('general' | 'specialist') — displayed verbatim, never mapped to a derived "division" label. Shared by Day View and Job File so both show the same value the same way. */
export function jobTypeLabel(jobType: string): string {
  return jobType.toUpperCase();
}

export interface TechnicianVisitSummary {
  visitId: string;
  scheduledDate: string;
  status: TechnicianVisitStatus;
  jobId: string;
  jobSummary: string;
  /** Raw `jobs.job_type` value ('general' | 'specialist') — displayed as-is, never mapped to a derived label. */
  jobType: string;
  buildingName: string | null;
  buildingAddress: string;
  buildingPostcode: string | null;
  /**
   * True once a report exists for this visit — a technician-facing
   * presentation flag only (Day View's done/next-stop logic). Independent
   * of `status`: a variable-price visit stays 'booked' even after
   * submission (the office completes it later), so Day View treats
   * `status === 'completed' || reportSubmitted` as "done" from the
   * technician's own point of view. Never implies anything about the
   * underlying visit-completion/pricing state.
   */
  reportSubmitted: boolean;
}

interface RpcTodayVisitRow {
  visit_id: string;
  scheduled_date: string;
  visit_status: TechnicianVisitStatus;
  job_id: string;
  job_summary: string;
  job_type: string;
  building_name: string | null;
  building_address: string;
  building_postcode: string | null;
  report_submitted: boolean;
}

/** Today's assigned visits, office-set order, technician-safe columns only — see technician_today_visits(). */
export async function listTodayVisits(): Promise<TechnicianVisitSummary[]> {
  const { data, error } = await supabase.rpc('technician_today_visits');
  if (error) throw new Error(`Failed to load today's visits: ${error.message}`);

  return ((data ?? []) as RpcTodayVisitRow[]).map((row) => ({
    visitId: row.visit_id,
    scheduledDate: row.scheduled_date,
    status: row.visit_status,
    jobId: row.job_id,
    jobSummary: row.job_summary,
    jobType: row.job_type,
    buildingName: row.building_name,
    buildingAddress: row.building_address,
    buildingPostcode: row.building_postcode,
    reportSubmitted: row.report_submitted,
  }));
}

/**
 * This technician's own future-scheduled visits (scheduled_date strictly
 * after today), soonest first — see technician_upcoming_visits(). Same
 * technician-safe column set and ownership check as listTodayVisits();
 * only the date condition and sort differ.
 */
export async function listUpcomingVisits(): Promise<TechnicianVisitSummary[]> {
  const { data, error } = await supabase.rpc('technician_upcoming_visits');
  if (error) throw new Error(`Failed to load upcoming visits: ${error.message}`);

  return ((data ?? []) as RpcTodayVisitRow[]).map((row) => ({
    visitId: row.visit_id,
    scheduledDate: row.scheduled_date,
    status: row.visit_status,
    jobId: row.job_id,
    jobSummary: row.job_summary,
    jobType: row.job_type,
    buildingName: row.building_name,
    buildingAddress: row.building_address,
    buildingPostcode: row.building_postcode,
    reportSubmitted: row.report_submitted,
  }));
}

export interface TechnicianVisitDetail {
  visitId: string;
  scheduledDate: string;
  status: TechnicianVisitStatus;
  jobId: string;
  jobSummary: string;
  /** Raw `jobs.job_type` value ('general' | 'specialist') — displayed as-is, never mapped to a derived label. */
  jobType: string;
  jobNotes: string | null;
  buildingName: string | null;
  buildingAddress: string;
  buildingPostcode: string | null;
  siteInstructions: string | null;
  keySafeCode: string | null;
  keyholderName: string | null;
  keyholderPhone: string | null;
  parkingNotes: string | null;
  accessNotes: string | null;
  reportId: string | null;
  reportReviewStatus: TechnicianReportReviewStatus | null;
  reportReturnReason: string | null;
  reportWorkCarriedOut: string | null;
  reportTechnicianNotes: string | null;
  reportIssues: string | null;
  /** Existing photos already attached to the report — 0 when no report exists yet. Lets the resubmission form show "N already added" without a separate photo-listing RPC. */
  reportPhotoCount: number;
  /** true = specification completed (the normal case); false = the technician previously selected "Something not done". null only when no report exists yet for this visit — treated as the default (true) by the caller. */
  reportSpecMet: boolean | null;
}

interface RpcVisitDetailRow {
  visit_id: string;
  scheduled_date: string;
  visit_status: TechnicianVisitStatus;
  job_id: string;
  job_summary: string;
  job_type: string;
  job_notes: string | null;
  building_name: string | null;
  building_address: string;
  building_postcode: string | null;
  site_instructions: string | null;
  key_safe_code: string | null;
  keyholder_name: string | null;
  keyholder_phone: string | null;
  parking_notes: string | null;
  access_notes: string | null;
  report_id: string | null;
  report_review_status: TechnicianReportReviewStatus | null;
  report_return_reason: string | null;
  report_work_carried_out: string | null;
  report_technician_notes: string | null;
  report_issues: string | null;
  report_photo_count: number;
  report_spec_met: boolean | null;
}

/**
 * A single visit's operational detail — technician-safe columns only (no
 * price, no client identity, no invoice/Xero data, no manager-only report
 * fields). Returns null when the visit doesn't exist, isn't scheduled to
 * this technician, or the caller isn't a technician at all —
 * technician_visit_detail() returns zero rows in every one of those cases,
 * indistinguishably, by design (never reveals which case it was).
 */
export async function getVisitDetail(visitId: string): Promise<TechnicianVisitDetail | null> {
  const { data, error } = await supabase.rpc('technician_visit_detail', { p_visit_id: visitId }).maybeSingle();
  if (error) throw new Error(`Failed to load visit: ${error.message}`);
  if (!data) return null;

  const row = data as unknown as RpcVisitDetailRow;
  return {
    visitId: row.visit_id,
    scheduledDate: row.scheduled_date,
    status: row.visit_status,
    jobId: row.job_id,
    jobSummary: row.job_summary,
    jobType: row.job_type,
    jobNotes: row.job_notes,
    buildingName: row.building_name,
    buildingAddress: row.building_address,
    buildingPostcode: row.building_postcode,
    siteInstructions: row.site_instructions,
    keySafeCode: row.key_safe_code,
    keyholderName: row.keyholder_name,
    keyholderPhone: row.keyholder_phone,
    parkingNotes: row.parking_notes,
    accessNotes: row.access_notes,
    reportId: row.report_id,
    reportReviewStatus: row.report_review_status,
    reportReturnReason: row.report_return_reason,
    reportWorkCarriedOut: row.report_work_carried_out,
    reportTechnicianNotes: row.report_technician_notes,
    reportIssues: row.report_issues,
    reportPhotoCount: row.report_photo_count,
    reportSpecMet: row.report_spec_met,
  };
}

export interface TechnicianCorrectionSummary {
  visitId: string;
  reportId: string;
  scheduledDate: string;
  jobId: string;
  jobSummary: string;
  jobType: string;
  buildingName: string | null;
  buildingAddress: string;
  buildingPostcode: string | null;
  returnReason: string | null;
}

interface RpcNeedsCorrectionRow {
  visit_id: string;
  report_id: string;
  scheduled_date: string;
  job_id: string;
  job_summary: string;
  job_type: string;
  building_name: string | null;
  building_address: string;
  building_postcode: string | null;
  return_reason: string | null;
}

/** The technician's own reports currently returned for correction, regardless of date — see technician_needs_correction(). */
export async function listNeedsCorrection(): Promise<TechnicianCorrectionSummary[]> {
  const { data, error } = await supabase.rpc('technician_needs_correction');
  if (error) throw new Error(`Failed to load returned reports: ${error.message}`);

  return ((data ?? []) as RpcNeedsCorrectionRow[]).map((row) => ({
    visitId: row.visit_id,
    reportId: row.report_id,
    scheduledDate: row.scheduled_date,
    jobId: row.job_id,
    jobSummary: row.job_summary,
    jobType: row.job_type,
    buildingName: row.building_name,
    buildingAddress: row.building_address,
    buildingPostcode: row.building_postcode,
    returnReason: row.return_reason,
  }));
}

export type PhotoPhase = 'before' | 'during' | 'after';

export interface UploadedPhoto {
  storagePath: string;
  phase: PhotoPhase;
}

const VISIT_PHOTOS_BUCKET = 'visit-photos';

/**
 * Generates a photo's storage path — `{visitId}/{phase}/{uuid}.{ext}`, the
 * same convention the Storage policy and technician_submit_report() both
 * check against. Split out from the actual upload call (see
 * uploadVisitPhotoToPath below) specifically so the offline sync queue can
 * generate this ONCE at capture time and reuse the exact same path on
 * every retry — the path itself is what makes a retried upload idempotent,
 * not anything about the upload call.
 */
export function newVisitPhotoStoragePath(visitId: string, phase: PhotoPhase, filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop() : 'jpg';
  return `${visitId}/${phase}/${crypto.randomUUID()}.${ext}`;
}

/**
 * Uploads one photo to a specific, already-decided storage path, under the
 * private `visit-photos` bucket — idempotent under retry, which is what
 * makes it safe for the offline sync queue to call repeatedly on the same
 * photo until it succeeds.
 *
 * The idempotency mechanism is a check-then-upload, NOT `upsert: true` —
 * confirmed via a real, live test (not assumed) that upsert fails on a
 * retry: technicians only ever have INSERT + SELECT policies on
 * `storage.objects` (see 20260908090000_fix_technician_storage_policy_ownership.sql
 * and its sibling SELECT policy), deliberately no UPDATE policy, and an
 * upsert of an already-existing object is an UPDATE under the hood — RLS
 * correctly rejects it. So: if a previous attempt already succeeded (e.g.
 * the network dropped before its success response arrived), `.exists()`
 * (covered by the existing SELECT policy) finds it and this returns
 * immediately without re-uploading; only a genuinely new object goes
 * through `.upload(..., { upsert: false })`. No RLS/schema change needed
 * or made.
 */
export async function uploadVisitPhotoToPath(storagePath: string, file: Blob): Promise<void> {
  const { data: alreadyExists } = await supabase.storage.from(VISIT_PHOTOS_BUCKET).exists(storagePath);
  if (alreadyExists) return;

  const { error } = await supabase.storage.from(VISIT_PHOTOS_BUCKET).upload(storagePath, file, { upsert: false });
  if (error) throw new Error(`Failed to upload photo: ${error.message}`);
}

export interface SubmitReportInput {
  visitId: string;
  workCarriedOut: string | null;
  technicianNotes: string | null;
  issues: string | null;
  /** ISO timestamps — captured client-side at the moment of the technician's own action (never typed), per the established localStorage start-time approach. */
  onSiteStart: string;
  onSiteEnd: string;
  photos: UploadedPhoto[];
  /** true = specification completed (default); false = "Something not done" — never blocks submission either way. */
  specMet: boolean;
}

/**
 * First (and, this phase, only) report submission for a visit — every rule
 * (ownership, no double-submit, required timestamps with end >= start, at
 * least one real visit-owned photo) is enforced server-side by
 * technician_submit_report(); this function only shapes the request.
 */
export async function submitReport(input: SubmitReportInput): Promise<string> {
  const { data, error } = await supabase.rpc('technician_submit_report', {
    p_visit_id: input.visitId,
    p_work_carried_out: input.workCarriedOut,
    p_technician_notes: input.technicianNotes,
    p_issues: input.issues,
    p_on_site_start: input.onSiteStart,
    p_on_site_end: input.onSiteEnd,
    p_photos: input.photos.map((p) => ({ storage_path: p.storagePath, phase: p.phase })),
    p_spec_met: input.specMet,
  });

  if (error) throw new Error(error.message);
  return data as string;
}

export interface ResubmitReportInput {
  reportId: string;
  workCarriedOut: string | null;
  technicianNotes: string | null;
  issues: string | null;
  /** May be empty — zero additional photos is a valid resubmission (e.g. a text-only fix). Never re-collects on_site_start/on_site_end: a correction fixes the existing report, it is not a second visit. */
  additionalPhotos: UploadedPhoto[];
  /** true = specification completed; false = "Something not done" — preserved from the original submission and freely correctable here, never blocks resubmission either way. */
  specMet: boolean;
}

/**
 * Resubmits a report that's currently returned_for_correction. Every rule
 * (ownership, must actually be returned, photo validity if any are given)
 * is enforced server-side by technician_resubmit_report() — this function
 * only shapes the request. Never sends on-site timing; the original visit's
 * on_site_start/on_site_end are left untouched by design.
 */
export async function resubmitReport(input: ResubmitReportInput): Promise<void> {
  const { error } = await supabase.rpc('technician_resubmit_report', {
    p_report_id: input.reportId,
    p_work_carried_out: input.workCarriedOut,
    p_technician_notes: input.technicianNotes,
    p_issues: input.issues,
    p_additional_photos: input.additionalPhotos.map((p) => ({ storage_path: p.storagePath, phase: p.phase })),
    p_spec_met: input.specMet,
  });

  if (error) throw new Error(error.message);
}
