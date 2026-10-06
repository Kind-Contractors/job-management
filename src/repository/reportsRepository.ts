// Data-access layer for the visit-completion -> report review -> sending
// lifecycle (Manager-only workflow this pass — see the reviewed plan).
// Every mutation here relies on the live DB constraints already confirmed to
// exist (visits_completion_requires_charge_check, reports_sending_requires_approval_check,
// reports_return_reason_check, the reviewed/sent pair checks) rather than
// re-implementing them — this repository only ever sends a well-formed
// request; the DB is still the final authority.

import type { ReportDetail, ReportReviewStatus } from '../domain/types';
import { supabase } from '../lib/supabaseClient';
import { logActivityEvent } from './activityEventsRepository';

interface SupabaseReportRow {
  id: string;
  visit_id: string;
  submitted_by: string;
  submitted_at: string;
  on_site_start: string | null;
  on_site_end: string | null;
  work_carried_out: string | null;
  technician_notes: string | null;
  issues: string | null;
  spec_met: boolean;
  review_status: ReportReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  return_reason: string | null;
  include_photos: boolean;
  include_notes: boolean;
  include_issues: boolean;
  include_price: boolean;
  sent_to_client_at: string | null;
  sent_to_client_by: string | null;
  sent_to_accounts_at: string | null;
  sent_to_accounts_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
}

function mapReport(row: SupabaseReportRow): ReportDetail {
  return {
    id: row.id,
    visitId: row.visit_id,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    onSiteStart: row.on_site_start,
    onSiteEnd: row.on_site_end,
    workCarriedOut: row.work_carried_out,
    technicianNotes: row.technician_notes,
    issues: row.issues,
    specMet: row.spec_met,
    reviewStatus: row.review_status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    returnReason: row.return_reason,
    includePhotos: row.include_photos,
    includeNotes: row.include_notes,
    includeIssues: row.include_issues,
    includePrice: row.include_price,
    sentToClientAt: row.sent_to_client_at,
    sentToClientBy: row.sent_to_client_by,
    sentToAccountsAt: row.sent_to_accounts_at,
    sentToAccountsBy: row.sent_to_accounts_by,
    completedAt: row.completed_at ?? null,
    completedBy: row.completed_by ?? null,
  };
}

const REPORT_SELECT =
  'id, visit_id, submitted_by, submitted_at, on_site_start, on_site_end, work_carried_out, technician_notes, issues, spec_met, review_status, reviewed_by, reviewed_at, return_reason, include_photos, include_notes, include_issues, include_price, sent_to_client_at, sent_to_client_by, sent_to_accounts_at, sent_to_accounts_by, completed_at, completed_by';

/**
 * A completed report cannot be returned for correction, or have a technician's contribution flagged, until it is
 * reopened (the database rule reports_completion_requires_approval_check). If that rule is what refused a write,
 * say so in plain words instead of surfacing the raw constraint message; any other error is passed through as is.
 */
export const REOPEN_FIRST_MESSAGE =
  'This report is marked Completed. Reopen it first (Ready for client, then the Completed tab, then Reopen) before returning it for correction or sending a technician’s section back.';

export function explainCompletionBlock(errorMessage: string): string | null {
  return errorMessage.includes('reports_completion_requires_approval_check') ? REOPEN_FIRST_MESSAGE : null;
}

/**
 * Marks a visit completed. `priceCharged` must already reflect the rule the
 * UI enforces (pre-filled from the job's fixed price, or a real amount the
 * manager typed for a variable-price job) — this function never invents one.
 * The DB's own visits_completion_requires_charge_check is the final guard.
 */
export async function completeVisit(
  visitId: string,
  priceCharged: number,
  completedAt: string,
  actor: string,
): Promise<void> {
  const { error } = await supabase
    .from('visits')
    .update({ status: 'completed', price_charged: priceCharged, completed_at: completedAt })
    .eq('id', visitId);

  if (error) throw new Error(`Failed to mark visit complete: ${error.message}`);
  await logActivityEvent('visit', visitId, 'visit_completed', actor, null, completedAt);
}

export async function markVisitMissed(visitId: string, actor: string): Promise<void> {
  const { error } = await supabase.from('visits').update({ status: 'missed' }).eq('id', visitId);
  if (error) throw new Error(`Failed to mark visit missed: ${error.message}`);
  await logActivityEvent('visit', visitId, 'visit_missed', actor);
}

export async function markVisitCancelled(visitId: string, actor: string): Promise<void> {
  const { error } = await supabase.from('visits').update({ status: 'cancelled' }).eq('id', visitId);
  if (error) throw new Error(`Failed to mark visit cancelled: ${error.message}`);
  await logActivityEvent('visit', visitId, 'visit_cancelled', actor);
}

export async function getReport(reportId: string): Promise<ReportDetail> {
  const { data, error } = await supabase.from('reports').select(REPORT_SELECT).eq('id', reportId).single();
  if (error) throw new Error(`Failed to load report: ${error.message}`);
  return mapReport(data as unknown as SupabaseReportRow);
}

export interface ReportPhoto {
  id: string;
  phase: 'before' | 'during' | 'after';
  storagePath: string;
  uploadStatus: 'pending' | 'uploaded' | 'failed';
  /** Whether this photo is included in the client-facing report (ReadyForClientPage.tsx) — never affects technician-facing review. Defaults true; see the `photos_client_report_inclusion` migration. */
  includeInClientReport: boolean;
}

/**
 * Real photos for a report — [] for any report with none (the common case
 * for a manager-created report today; technician-submitted reports always
 * have at least one, per technician_submit_report()'s own requirement).
 * Manager already has full table access (manager_full_access); this is a
 * plain read, no new RLS/migration needed.
 */
export async function listPhotosForReport(reportId: string): Promise<ReportPhoto[]> {
  const { data, error } = await supabase
    .from('photos')
    .select('id, phase, storage_path, upload_status, include_in_client_report')
    .eq('report_id', reportId)
    .order('phase');

  if (error) throw new Error(`Failed to load photos: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    phase: row.phase,
    storagePath: row.storage_path,
    uploadStatus: row.upload_status,
    includeInClientReport: row.include_in_client_report,
  }));
}

export interface ReportPhotoWithReport extends ReportPhoto {
  reportId: string;
}

/**
 * Sibling to listPhotosForReport, not a replacement — for Building History's
 * "Work Photos" section, which needs photos across every report belonging
 * to a building at once. listPhotosForReport/its callers (ReportPanel.tsx,
 * ReadyForClientPage.tsx) are unchanged and keep using the single-report
 * version. Only 'uploaded' photos are returned — a pending/failed upload
 * has no real file to sign a URL for, so it's excluded here rather than
 * shown as a placeholder (see req. 9's "skip or placeholder" — this picks
 * skip, the simpler of the two).
 */
export async function listPhotosForReports(reportIds: string[]): Promise<ReportPhotoWithReport[]> {
  if (reportIds.length === 0) return [];

  const { data, error } = await supabase
    .from('photos')
    .select('id, report_id, phase, storage_path, upload_status, include_in_client_report')
    .in('report_id', reportIds)
    .eq('upload_status', 'uploaded')
    .order('phase');

  if (error) throw new Error(`Failed to load photos: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    reportId: row.report_id,
    phase: row.phase,
    storagePath: row.storage_path,
    uploadStatus: row.upload_status,
    includeInClientReport: row.include_in_client_report,
  }));
}

/** Toggles one photo's inclusion in the client-facing report — a single-column update, independent of the report-level include_photos toggle (that one hides the whole photos section; this one hides just this photo within it). */
export async function updatePhotoClientInclusion(photoId: string, included: boolean): Promise<void> {
  const { error } = await supabase.from('photos').update({ include_in_client_report: included }).eq('id', photoId);
  if (error) throw new Error(`Failed to update photo: ${error.message}`);
}

/**
 * Signed URLs for a private bucket — one per photo, 1 hour expiry.
 * Moved here (from ReportPanel.tsx, which now imports this instead of its
 * own copy) so ReadyForClientPage.tsx can reuse the exact same signing
 * logic rather than a second copy — no behavior change.
 */
export async function signReportPhotoUrls(photos: ReportPhoto[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    photos.map(async (p) => {
      const { data } = await supabase.storage.from('visit-photos').createSignedUrl(p.storagePath, 3600);
      return [p.id, data?.signedUrl ?? ''] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export interface CreateReportInput {
  workCarriedOut: string | null;
  technicianNotes: string | null;
  issues: string | null;
  onSiteStart: string | null;
  onSiteEnd: string | null;
  includePhotos: boolean;
  includeNotes: boolean;
  includeIssues: boolean;
  includePrice: boolean;
}

/** submittedBy/submittedAt are always the signed-in manager's real identity/action time — never a fabricated technician. */
export async function createReport(visitId: string, submittedBy: string, input: CreateReportInput): Promise<ReportDetail> {
  const { data, error } = await supabase
    .from('reports')
    .insert({
      visit_id: visitId,
      submitted_by: submittedBy,
      submitted_at: new Date().toISOString(),
      work_carried_out: input.workCarriedOut,
      technician_notes: input.technicianNotes,
      issues: input.issues,
      on_site_start: input.onSiteStart,
      on_site_end: input.onSiteEnd,
      include_photos: input.includePhotos,
      include_notes: input.includeNotes,
      include_issues: input.includeIssues,
      include_price: input.includePrice,
    })
    .select(REPORT_SELECT)
    .single();

  if (error) throw new Error(`Failed to create report: ${error.message}`);
  const report = mapReport(data as unknown as SupabaseReportRow);
  await logActivityEvent('report', report.id, 'report_created', submittedBy);
  return report;
}

export type UpdateReportInput = Partial<CreateReportInput>;

/** Edits report fields in place — no version history (deliberately deferred), matching the reviewed plan. */
export async function updateReport(reportId: string, input: UpdateReportInput): Promise<void> {
  const patch: Record<string, unknown> = {};
  if ('workCarriedOut' in input) patch.work_carried_out = input.workCarriedOut;
  if ('technicianNotes' in input) patch.technician_notes = input.technicianNotes;
  if ('issues' in input) patch.issues = input.issues;
  if ('onSiteStart' in input) patch.on_site_start = input.onSiteStart;
  if ('onSiteEnd' in input) patch.on_site_end = input.onSiteEnd;
  if ('includePhotos' in input) patch.include_photos = input.includePhotos;
  if ('includeNotes' in input) patch.include_notes = input.includeNotes;
  if ('includeIssues' in input) patch.include_issues = input.includeIssues;
  if ('includePrice' in input) patch.include_price = input.includePrice;

  const { error } = await supabase.from('reports').update(patch).eq('id', reportId);
  if (error) throw new Error(`Failed to update report: ${error.message}`);
}

export async function approveReport(reportId: string, actor: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('reports')
    .update({ review_status: 'approved', reviewed_by: actor, reviewed_at: now, return_reason: null })
    .eq('id', reportId);

  if (error) throw new Error(`Failed to approve report: ${error.message}`);
  await logActivityEvent('report', reportId, 'report_approved', actor, null, now);
}

/** The DB rejects this without a reason (reports_return_reason_check) — the UI validates before calling this too. */
export async function returnReportForCorrection(reportId: string, reason: string, actor: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('reports')
    .update({ review_status: 'returned_for_correction', reviewed_by: actor, reviewed_at: now, return_reason: reason })
    .eq('id', reportId);

  if (error) throw new Error(explainCompletionBlock(error.message) ?? `Failed to return report: ${error.message}`);
  await logActivityEvent('report', reportId, 'report_returned', actor, reason, now);
}

/**
 * Marks an approved report Completed: the manager's "this report is fully dealt with" marker, independent of HOW it
 * reached the client (emailed through the system, downloaded and sent by hand, or both). Records who and when, and
 * leaves sent_to_client_* untouched. Only an approved, not-yet-completed report is changed - if nothing was changed
 * (already completed, or not approved) it says so instead of silently succeeding. Logs 'report_completed'.
 */
export async function completeReport(reportId: string, actor: string): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('reports')
    .update({ completed_at: now, completed_by: actor })
    .eq('id', reportId)
    .eq('review_status', 'approved')
    .is('completed_at', null)
    .select('id');

  if (error) throw new Error(`Failed to mark report completed: ${error.message}`);
  if (!data || data.length === 0) throw new Error('This report could not be marked completed - it may already be completed, or it is not approved. Refresh and try again.');
  await logActivityEvent('report', reportId, 'report_completed', actor, null, now);
}

/** Undoes Completed: clears who/when so the report returns to the Ready for client queue. Logs 'report_reopened'. */
export async function reopenReport(reportId: string, actor: string): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('reports')
    .update({ completed_at: null, completed_by: null })
    .eq('id', reportId)
    .not('completed_at', 'is', null)
    .select('id');

  if (error) throw new Error(`Failed to reopen report: ${error.message}`);
  if (!data || data.length === 0) throw new Error('This report is not completed, so there is nothing to reopen. Refresh and try again.');
  await logActivityEvent('report', reportId, 'report_reopened', actor, null, now);
}

/** Back to awaiting_review after a correction — clears the now-stale return_reason. */
export async function resubmitReport(reportId: string, actor: string): Promise<void> {
  const { error } = await supabase
    .from('reports')
    .update({ review_status: 'awaiting_review', return_reason: null })
    .eq('id', reportId);

  if (error) throw new Error(`Failed to resubmit report: ${error.message}`);
  await logActivityEvent('report', reportId, 'report_resubmitted', actor);
}

/** Sending to a client and sending to accounts are fully independent — see CLAUDE.md section 7. */
export interface SendClientReportInput {
  reportId: string;
  contactId: string;
  /** Generated in the browser by src/lib/clientReportPdf.ts — see that function and the Edge Function's own header comment for why the PDF is never regenerated server-side. */
  pdfBase64: string;
}

export interface SendClientReportResult {
  status: 'sent' | 'failed';
  error?: string;
}

/**
 * Invokes the send-client-report Edge Function — the ONLY place this app
 * actually emails a report to a client (Phase 2B). Mirrors
 * invoicesRepository.ts's sendInvoice() exactly: a thin invoke wrapper,
 * with the real detailed error surfaced separately via
 * getLatestClientSend() below (report_client_sends.error_message) rather
 * than parsed out of this call's own thrown Error — same reason
 * InvoiceEditor.tsx reads invoice.lastError rather than sendInvoice()'s
 * own error message.
 */
export async function sendClientReport(input: SendClientReportInput): Promise<SendClientReportResult> {
  const { data, error } = await supabase.functions.invoke<SendClientReportResult>('send-client-report', { body: input });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('No response from send-client-report.');
  return data;
}

export interface ClientSendRecord {
  id: string;
  status: 'sending' | 'sent' | 'failed';
  recipientEmail: string;
  sentBy: string;
  errorMessage: string | null;
  createdAt: string;
  /** Resend's own message id for this attempt — null until a send succeeds (and for any attempt made before this column existed). Useful for cross-referencing Resend's own dashboard/logs if a client reports a delivery issue. */
  resendMessageId: string | null;
}

/** The most recent send attempt for a report, if any — lets the UI show "last attempt failed: ..." without a full send-history page. */
export async function getLatestClientSend(reportId: string): Promise<ClientSendRecord | null> {
  const { data, error } = await supabase
    .from('report_client_sends')
    .select('id, status, recipient_email, sent_by, error_message, created_at, resend_message_id')
    .eq('report_id', reportId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to load send history: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    status: data.status,
    recipientEmail: data.recipient_email,
    sentBy: data.sent_by,
    errorMessage: data.error_message,
    createdAt: data.created_at,
    resendMessageId: data.resend_message_id,
  };
}

// ---------------------------------------------------------------------------
// Multi-technician reports — per-technician contributions to one combined report.
// Manager-only (RLS: manager_full_access on report_contributions); the combined
// report on `reports` stays the single thing that is reviewed, approved and sent.
// ---------------------------------------------------------------------------

export type ContributionStatus = 'pending' | 'submitted' | 'waived';

export interface ReportParticipant {
  technicianId: string;
  name: string;
  isPrimary: boolean;
  isActive: boolean;
  status: ContributionStatus;
  needsCorrection: boolean;
  correctionReason: string | null;
  submittedAt: string | null;
  waivedAt: string | null;
  waivedBy: string | null;
  workCarriedOut: string | null;
  technicianNotes: string | null;
  issues: string | null;
  specMet: boolean | null;
  onSiteStart: string | null;
  onSiteEnd: string | null;
}

export interface ReportContributionOverview {
  /** True once any contribution/waiver row exists. False for every ordinary single-technician (legacy) report. */
  contributionMode: boolean;
  /** Set when a manager hand-edited the combined text; later submissions no longer overwrite it. */
  managerEditedAt: string | null;
  /** Everyone currently assigned to the visit (primary first, then additional) — each with their own state. */
  participants: ReportParticipant[];
}

interface TechnicianRef {
  id: string;
  name: string;
  is_active: boolean;
}

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export async function getReportContributionOverview(reportId: string): Promise<ReportContributionOverview> {
  const { data: report, error: reportError } = await supabase
    .from('reports')
    .select(
      `manager_edited_at,
       visits (
         technician_id,
         technicians ( id, name, is_active ),
         visit_technicians ( technician_id, technicians ( id, name, is_active ) )
       )`,
    )
    .eq('id', reportId)
    .single();

  if (reportError) throw new Error(`Failed to load report technicians: ${reportError.message}`);

  const { data: rows, error: rowsError } = await supabase
    .from('report_contributions')
    .select(
      `technician_id, work_carried_out, technician_notes, issues, spec_met, on_site_start, on_site_end,
       submitted_at, needs_correction, correction_reason, waived_at, waived_by, created_at`,
    )
    .eq('report_id', reportId)
    .order('created_at', { ascending: true });

  if (rowsError) throw new Error(`Failed to load report contributions: ${rowsError.message}`);

  const visit = firstOf(report.visits) as {
    technician_id: string | null;
    technicians: TechnicianRef | TechnicianRef[] | null;
    visit_technicians: { technician_id: string; technicians: TechnicianRef | TechnicianRef[] | null }[] | null;
  } | null;

  const assigned: { tech: TechnicianRef; isPrimary: boolean }[] = [];
  const primary = firstOf(visit?.technicians);
  if (primary) assigned.push({ tech: primary, isPrimary: true });
  for (const vt of visit?.visit_technicians ?? []) {
    const t = firstOf(vt.technicians);
    if (t) assigned.push({ tech: t, isPrimary: false });
  }

  const byTechnician = new Map((rows ?? []).map((r) => [r.technician_id, r]));

  const participants: ReportParticipant[] = assigned.map(({ tech, isPrimary }) => {
    const r = byTechnician.get(tech.id);
    return {
      technicianId: tech.id,
      name: tech.name,
      isPrimary,
      isActive: tech.is_active,
      status: r?.waived_at ? 'waived' : r?.submitted_at ? 'submitted' : 'pending',
      needsCorrection: r?.needs_correction ?? false,
      correctionReason: r?.correction_reason ?? null,
      submittedAt: r?.submitted_at ?? null,
      waivedAt: r?.waived_at ?? null,
      waivedBy: r?.waived_by ?? null,
      workCarriedOut: r?.work_carried_out ?? null,
      technicianNotes: r?.technician_notes ?? null,
      issues: r?.issues ?? null,
      specMet: r ? r.spec_met : null,
      onSiteStart: r?.on_site_start ?? null,
      onSiteEnd: r?.on_site_end ?? null,
    };
  });

  return { contributionMode: (rows ?? []).length > 0, managerEditedAt: report.manager_edited_at ?? null, participants };
}

/**
 * Sends ONE technician's submitted contribution back for correction. The
 * database (sync_report_state_from_contributions) moves the whole report to
 * 'returned_for_correction' and records the reason; every other technician's
 * contribution is untouched. Distinct from returnReportForCorrection(), which
 * returns everyone's.
 */
export async function returnContributionForCorrection(
  reportId: string,
  technicianId: string,
  technicianName: string,
  reason: string,
  actor: string,
): Promise<void> {
  const { error } = await supabase
    .from('report_contributions')
    .update({ needs_correction: true, correction_reason: reason })
    .eq('report_id', reportId)
    .eq('technician_id', technicianId)
    .not('submitted_at', 'is', null);

  if (error) throw new Error(explainCompletionBlock(error.message) ?? `Failed to return contribution: ${error.message}`);
  await logActivityEvent('report', reportId, 'report_contribution_returned', actor, `${technicianName}: ${reason}`);
}

/** The office decides a technician who never submitted no longer blocks the report. Only for a technician with no submission yet. */
export async function waiveContribution(reportId: string, technicianId: string, technicianName: string, actor: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('report_contributions')
    .insert({ report_id: reportId, technician_id: technicianId, waived_at: now, waived_by: actor });

  if (error) throw new Error(`Failed to waive technician: ${error.message}`);
  await logActivityEvent('report', reportId, 'report_contribution_waived', actor, technicianName, now);
}

/** Drops a manual edit of the combined text and rebuilds it from the contributions (database function). */
export async function resetCombinedReport(reportId: string): Promise<void> {
  const { error } = await supabase.rpc('manager_reset_combined_report', { p_report_id: reportId });
  if (error) throw new Error(`Failed to rebuild combined report: ${error.message}`);
}
