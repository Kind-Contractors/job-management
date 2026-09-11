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
  };
}

const REPORT_SELECT =
  'id, visit_id, submitted_by, submitted_at, on_site_start, on_site_end, work_carried_out, technician_notes, issues, spec_met, review_status, reviewed_by, reviewed_at, return_reason, include_photos, include_notes, include_issues, include_price, sent_to_client_at, sent_to_client_by, sent_to_accounts_at, sent_to_accounts_by';

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

  if (error) throw new Error(`Failed to return report: ${error.message}`);
  await logActivityEvent('report', reportId, 'report_returned', actor, reason, now);
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

/** Send to client and send to accounts are fully independent — see CLAUDE.md section 7. No real email/document is generated (section 15) — this only records the handoff. */
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
}

/** The most recent send attempt for a report, if any — lets the UI show "last attempt failed: ..." without a full send-history page. */
export async function getLatestClientSend(reportId: string): Promise<ClientSendRecord | null> {
  const { data, error } = await supabase
    .from('report_client_sends')
    .select('id, status, recipient_email, sent_by, error_message, created_at')
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
  };
}

export async function sendReportToClient(reportId: string, actor: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('reports')
    .update({ sent_to_client_at: now, sent_to_client_by: actor })
    .eq('id', reportId);

  if (error) throw new Error(`Failed to send report to client: ${error.message}`);
  await logActivityEvent('report', reportId, 'report_sent_to_client', actor, null, now);
}

export async function sendReportToAccounts(reportId: string, actor: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('reports')
    .update({ sent_to_accounts_at: now, sent_to_accounts_by: actor })
    .eq('id', reportId);

  if (error) throw new Error(`Failed to send report to accounts: ${error.message}`);
  await logActivityEvent('report', reportId, 'report_sent_to_accounts', actor, null, now);
}
