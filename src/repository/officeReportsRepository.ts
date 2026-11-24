// Office-written reports: a manager (an "Administrator") completes a visit and writes its report in one step - also for work that was
// already done before the job was added to JMS (no visit yet). One database call does it all, in one transaction, and the report is
// saved already approved (the office is the final reviewer) - see supabase/migrations/20261124100000_manager_office_reports.sql,
// which also enforces every rule below on the server. Technician reporting is untouched.
import { supabase } from '../lib/supabaseClient';
import type { JobVisitSummary } from '../domain/types';

export interface OfficeReportInput {
  /** An existing visit - or null to record a NEW completed visit for `jobId` (work done before it was added to JMS). */
  visitId: string | null;
  jobId: string | null;
  /** The day the work was done (YYYY-MM-DD) - the new visit's date. Only used when there is no visit. */
  workDate: string | null;
  /** When the work was finished (ISO). An already completed visit keeps its own recorded time and price. */
  completedAt: string;
  priceCharged: number;
  workCarriedOut: string | null;
  technicianNotes: string | null;
  issues: string | null;
  /** false = "Something not done". */
  specMet: boolean;
  onSiteStart: string | null;
  onSiteEnd: string | null;
}

export interface OfficeReportResult {
  visitId: string;
  reportId: string;
  visitCreated: boolean;
}

export async function completeVisitWithOfficeReport(input: OfficeReportInput): Promise<OfficeReportResult> {
  const { data, error } = await supabase.rpc('manager_complete_visit_with_report', {
    p_visit_id: input.visitId,
    p_job_id: input.jobId,
    p_work_date: input.workDate,
    p_completed_at: input.completedAt,
    p_price_charged: input.priceCharged,
    p_work_carried_out: input.workCarriedOut,
    p_technician_notes: input.technicianNotes,
    p_issues: input.issues,
    p_spec_met: input.specMet,
    p_on_site_start: input.onSiteStart,
    p_on_site_end: input.onSiteEnd,
  });
  if (error) throw new Error(error.message);
  const r = data as { visit_id: string; report_id: string; visit_created: boolean };
  return { visitId: r.visit_id, reportId: r.report_id, visitCreated: r.visit_created };
}

export type ReportSource = 'technician' | 'manager' | null;

/** Who wrote a report: the office ('manager'), a technician, or null (written before this was recorded). */
export async function getReportAuthorship(reportId: string): Promise<{ source: ReportSource; submittedBy: string }> {
  const { data, error } = await supabase.from('reports').select('source, submitted_by').eq('id', reportId).single();
  if (error) throw new Error(`Failed to load the report's author: ${error.message}`);
  const row = data as { source: ReportSource; submitted_by: string };
  return { source: row.source ?? null, submittedBy: row.submitted_by };
}

/** "Written by the office · Luke" - or null for a technician's report (or one from before this was recorded). */
export function officeAuthorLabel(source: ReportSource, submittedBy: string): string | null {
  return source === 'manager' ? `Written by the office · ${submittedBy}` : null;
}

/**
 * Why "Complete & write report" can't be used for this visit (null = it can). The same rules the database enforces; shown so the
 * manager knows where to go instead.
 */
export function officeReportBlockedReason(visit: Pick<JobVisitSummary, 'status' | 'reportId' | 'invoiceId' | 'additionalTechnicians'>): string | null {
  if (visit.reportId) return 'This visit already has a report — check or edit it in Report review or Ready for client.';
  if (visit.status === 'cancelled') return 'This visit was cancelled.';
  if ((visit.additionalTechnicians ?? []).length > 0) return 'Visits with more than one technician aren’t supported here yet.';
  if (visit.invoiceId) return 'This visit is already on an invoice.';
  return null;
}

/**
 * The warning shown before the office writes the report for a visit that has a technician: once a report exists that technician
 * can't submit their own, and a report they started on their phone won't be sent. Stronger when the visit is today or later (they may
 * still be going, or be on site now). null when nobody is assigned, or the visit is already completed in the past with nothing to warn.
 */
export function technicianLockoutWarning(
  visit: Pick<JobVisitSummary, 'technicianName' | 'technicianId' | 'scheduledDate' | 'status'>,
  today: string,
): { strong: boolean; text: string } | null {
  if (!visit.technicianId) return null;
  const name = visit.technicianName ?? 'The assigned technician';
  const upcoming = visit.scheduledDate != null && visit.scheduledDate >= today && visit.status !== 'completed';
  const text =
    `${name} won’t be able to submit their own report for this visit once this one is saved. ` +
    'If they have already completed one on their phone, it won’t be sent — it stays on their phone, marked as not sent, so ask them for anything it had.';
  return { strong: upcoming, text: upcoming ? `This visit is ${visit.scheduledDate === today ? 'today' : 'still to come'}. ${text}` : text };
}

/** A completion time this far ahead of now is refused (the same allowance the database uses, for clock differences). */
export const FUTURE_COMPLETION_ALLOWANCE_MS = 2 * 60_000;

/**
 * Checks the form before saving; returns the first problem, or null. The database checks again. `completedAt` is the ISO time the
 * work finished, or null when the visit is already completed (its recorded time is kept, so there is nothing to check).
 */
export function officeReportFormError(
  f: { needsWorkDate: boolean; workDate: string; completedAt: string | null; price: string; onSiteStart: string; onSiteEnd: string },
  now: number = Date.now(),
): string | null {
  if (f.needsWorkDate && !f.workDate) return 'Enter the date the work was done.';
  if (f.completedAt === '') return 'Enter when the work was done.';
  if (f.completedAt && Date.parse(f.completedAt) > now + FUTURE_COMPLETION_ALLOWANCE_MS) return 'The work can’t be recorded as done in the future.';
  if (f.price.trim() === '' || !Number.isFinite(Number(f.price)) || Number(f.price) < 0) return 'Enter the price charged.';
  if ((f.onSiteStart && !f.onSiteEnd) || (!f.onSiteStart && f.onSiteEnd)) return 'Enter both on-site times, or neither.';
  if (f.onSiteStart && f.onSiteEnd && f.onSiteEnd < f.onSiteStart) return 'The on-site end time is before the start time.';
  return null;
}
