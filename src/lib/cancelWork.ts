// What a cancellation will do, worked out in the browser from the job's visits so the dialog can show exact counts before
// anything is saved. It mirrors the rules of the database function cancel_job_work (which is the authority and re-checks
// everything inside one transaction): only due/booked visits are ever cancelled, and a visit that already has a report or
// an invoice line is KEPT, never cancelled.
import type { JobRow, JobVisitSummary } from '../domain/types';
import type { CancelWorkScope } from '../repository/jobsRepository';

export type KeptReason = 'has_report' | 'has_invoice';

export interface CancelPlan {
  /** Visits that will be cancelled. */
  willCancel: JobVisitSummary[];
  /** Open visits that will NOT be cancelled because they already carry a report or an invoice. */
  kept: { visit: JobVisitSummary; reason: KeptReason }[];
}

/** A visit that can be the starting point of a cancellation: still open (due or booked). */
export function isOpenVisit(visit: JobVisitSummary): boolean {
  return visit.status === 'due' || visit.status === 'booked';
}

export function planCancelWork(job: JobRow, scope: CancelWorkScope, from: JobVisitSummary | null): CancelPlan {
  const candidates = job.visits.filter((v) => {
    if (!isOpenVisit(v)) return false;
    if (scope === 'job') return true;
    if (!from) return false;
    if (scope === 'visit') return v.id === from.id;
    // this and all future visits: the selected one, later-dated ones, and undated open ones
    return v.id === from.id || v.scheduledDate == null || (from.scheduledDate != null && v.scheduledDate > from.scheduledDate);
  });

  const plan: CancelPlan = { willCancel: [], kept: [] };
  for (const v of candidates) {
    if (v.reportId) plan.kept.push({ visit: v, reason: 'has_report' });
    else if (v.invoiceId) plan.kept.push({ visit: v, reason: 'has_invoice' });
    else plan.willCancel.push(v);
  }
  return plan;
}
