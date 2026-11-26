import type { JobRow, JobVisitSummary } from '../domain/types';
import { visitNeedsCompletion } from './queueJobs';

/**
 * Whether a Ready for accounts row can be marked as already invoiced (invoiced by hand in Xero). The same rules the database
 * function enforces, so the checkbox only appears where the action will be accepted:
 *   - an invoice that is still a draft or a failed attempt (not one being sent, or already in Xero); or
 *   - no invoice yet, an approved report and a completed visit (an open visit on a closed job must be completed first).
 */
export function canMarkAsAlreadyInvoiced(job: JobRow, visit: JobVisitSummary): boolean {
  if (visit.invoiceId) return visit.invoiceStatus === 'draft' || visit.invoiceStatus === 'failed';
  if (visitNeedsCompletion(job, visit)) return false;
  return visit.reportReviewStatus === 'approved' && visit.status === 'completed';
}

/**
 * The visits one "Already invoiced in Xero" action covers: every visit on the row's invoice (a combined draft is marked as a whole -
 * the database refuses to mark part of one), or just this visit when it has no invoice yet.
 */
export function visitsMarkedTogether(rows: { visit: JobVisitSummary }[], visit: JobVisitSummary): string[] {
  if (!visit.invoiceId) return [visit.id];
  return rows.filter((r) => r.visit.invoiceId === visit.invoiceId).map((r) => r.visit.id);
}
