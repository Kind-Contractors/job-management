// What a cancellation will do, worked out in the browser from the job's visits so the dialog can show exact counts before
// anything is saved. It mirrors the rules of the database function cancel_job_work (which is the authority and re-checks
// everything inside one transaction): only due/booked visits are ever cancelled, and a visit that already has a report, an
// invoice line or a video (that has not been removed) is KEPT, never cancelled.
import type { JobRow, JobVisitSummary } from '../domain/types';
import type { CancelWorkScope, KeptVisitReason } from '../repository/jobsRepository';

export type KeptReason = KeptVisitReason;

export interface CancelPlan {
  /** Visits that will be cancelled. */
  willCancel: JobVisitSummary[];
  /** Open visits that will NOT be cancelled because they already carry a report, an invoice or a video. */
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
    else if (v.hasActiveVideo) plan.kept.push({ visit: v, reason: 'has_video' });
    else plan.willCancel.push(v);
  }
  return plan;
}

/** How a kept visit is described next to its date. */
export function keptReasonLabel(reason: KeptReason): string {
  if (reason === 'has_invoice') return 'has an invoice';
  if (reason === 'has_video') return 'has a video (not yet in a report)';
  return 'has a report';
}

/**
 * What the kept visits "already have", for the sentence that explains why they were not cancelled. When none is kept for a video
 * this is exactly the wording used before videos existed.
 */
export function keptSubject(kept: { reason: KeptReason }[]): string {
  const hasVideo = kept.some((k) => k.reason === 'has_video');
  const hasDoc = kept.some((k) => k.reason !== 'has_video');
  if (!hasVideo) return 'a report or an invoice';
  return hasDoc ? 'a report, an invoice or a video' : 'a video';
}

/** Where kept visits go from here. A visit kept only for a video has no report yet, so it is not in any review queue. */
export function keptStayText(kept: { reason: KeptReason }[], plural: boolean): string {
  const hasVideo = kept.some((k) => k.reason === 'has_video');
  const hasDoc = kept.some((k) => k.reason !== 'has_video');
  const noun = plural ? 'They' : 'It';
  if (!hasVideo) return `${noun} ${plural ? 'stay' : 'stays'} in the report queues until finished.`;
  const video = 'A visit kept for its video stays open until the technician submits the report; it is not in the report queues before then.';
  return hasDoc ? `Visits with a report or an invoice stay in the report queues until finished. ${video}` : `${noun} ${plural ? 'keep their videos and stay' : 'keeps its video and stays'} open until the technician submits the report; ${plural ? 'they are' : 'it is'} not in the report queues before then.`;
}
