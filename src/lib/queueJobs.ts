// Which jobs/visits the three report queues (Report review, Ready for client, Ready for accounts) read.
//
// They read every ACTIVE job, exactly as before, PLUS the non-active jobs (cancelled, completed, lost, on hold) that still
// have report or accounting work a manager must act on - so cancelling a job never makes such work disappear. Nothing
// else in the app reads the extra rows (All Live Jobs, the schedule, Month Matrix ... stay on active jobs only).
//
// A queue only takes the visits that genuinely still need action - for active and non-active jobs alike - so a report or
// invoice that has been dealt with leaves the queue (it is found in Records), and the Delivered tab never sees a closed job.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../domain/types';
import { listJobRows, listJobRowsWithOpenReportWork } from '../repository/jobsRepository';
import { isInvoiceInXero } from './invoiceStatus';
import { isReportReadyForClient, isVisitReadyForAccounts } from './statusPresentation';
import { isOpenVisit } from './cancelWork';

/** `?? 'active'`: job rows cached before lifecycle status was carried have no such field (they were all active). */
export function isActiveJob(job: JobRow): boolean {
  return (job.lifecycleStatus ?? 'active') === 'active';
}

/** A report that needs a manager's review: awaiting review, or returned for correction. */
export function isVisitInReviewQueue(visit: JobVisitSummary): boolean {
  return !!visit.reportId && (visit.reportReviewStatus === 'awaiting_review' || visit.reportReviewStatus === 'returned_for_correction');
}

/** Approved, with no invoice yet or an invoice that is not in Xero yet (draft / sending / failed). Completed or not. */
export function hasOpenAccountsWork(visit: JobVisitSummary): boolean {
  return visit.reportReviewStatus === 'approved' && (!visit.invoiceId || !isInvoiceInXero(visit.invoiceStatus));
}

/** Ready for client: approved and not yet delivered (emailed or marked Completed) - the same rule for active and non-active jobs. */
export function isVisitInClientQueue(visit: JobVisitSummary): boolean {
  return isReportReadyForClient(visit);
}

/**
 * Ready for accounts: approved and no invoice yet, or an invoice that is not in Xero yet (draft / sending / failed) - the
 * same rule for active and non-active jobs, and the SAME rule for the list, its heading and the rail badge. A visit whose
 * invoice has been created in Xero ('sent' or 'in_xero_not_emailed') has left the queue; it is found in Records.
 * `job` is kept in the signature for callers; the rule itself is per visit.
 */
export function isVisitInAccountsQueue(_job: JobRow, visit: JobVisitSummary): boolean {
  return isVisitReadyForAccounts(visit);
}

/** The "ready for accounts" rail count - exactly the list's rule (kept as its own name for existing callers). */
export function isVisitCountedForAccounts(job: JobRow, visit: JobVisitSummary): boolean {
  return isVisitInAccountsQueue(job, visit);
}

/** The jobs in the chosen division ('Both' = all) - the rail's division filter, applied the same way by the queue pages. */
export function jobsInDivision(jobs: JobRow[], division: string | null | undefined): JobRow[] {
  const d = division ?? 'Both';
  return d === 'Both' ? jobs : jobs.filter((j) => j.division === d);
}

/** One row per visit in a queue. */
export interface QueueVisitRow {
  job: JobRow;
  visit: JobVisitSummary;
}

/** The Ready for client queue's rows for the division - what the page lists and what the rail counts. */
export function clientQueueRows(jobs: JobRow[], division: string | null | undefined): QueueVisitRow[] {
  return jobsInDivision(jobs, division).flatMap((job) => job.visits.filter(isVisitInClientQueue).map((visit) => ({ job, visit })));
}

/** The Ready for accounts queue's rows for the division - what the page lists and what the rail counts. */
export function accountsQueueRows(jobs: JobRow[], division: string | null | undefined): QueueVisitRow[] {
  return jobsInDivision(jobs, division).flatMap((job) => job.visits.filter((v) => isVisitInAccountsQueue(job, v)).map((visit) => ({ job, visit })));
}

/**
 * An open (due/booked) visit that belongs to a job that is no longer active - a "kept" visit: it had a report, so cancelling
 * the job did not cancel it. It must be completed (price + date) before it can be invoiced; completing it never reopens the job.
 */
export function visitNeedsCompletion(job: JobRow, visit: JobVisitSummary): boolean {
  return !isActiveJob(job) && isOpenVisit(visit);
}

/** Active jobs followed by the non-active jobs with open work (a job id is never listed twice). */
export function mergeQueueJobs(active: JobRow[], nonActiveWithOpenWork: JobRow[]): JobRow[] {
  const seen = new Set(active.map((j) => j.id));
  return [...active, ...nonActiveWithOpenWork.filter((j) => !seen.has(j.id))];
}

/** The three nav badges for the report queues, over active jobs plus closed jobs with open work, for the chosen division. */
export function queueCounts(queueJobRows: JobRow[], division: string): { review: number; readyForAccounts: number; readyForClient: number } {
  return {
    review: jobsInDivision(queueJobRows, division).filter((j) => j.status === 'review').length,
    // The same row builders the two pages list from, so a badge always equals its page's list.
    readyForAccounts: accountsQueueRows(queueJobRows, division).length,
    readyForClient: clientQueueRows(queueJobRows, division).length,
  };
}

/**
 * The jobs a report queue reads. Keyed under ['jobRows', ...] on purpose: every existing
 * invalidateQueries(['jobRows']) after a report, send, complete or invoice action refreshes this too.
 */
export function useQueueJobRows() {
  const active = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });
  const nonActive = useQuery({ queryKey: ['jobRows', 'openReportWork'], queryFn: listJobRowsWithOpenReportWork });

  const activeJobs = active.data;
  const nonActiveJobs = nonActive.data;
  const jobRows = useMemo(() => mergeQueueJobs(activeJobs ?? [], nonActiveJobs ?? []), [activeJobs, nonActiveJobs]);

  return {
    /** Active jobs plus non-active jobs with open report/accounting work. */
    jobRows,
    /** Active jobs only (the Completed tab reads these). */
    activeJobRows: activeJobs ?? [],
    // The queues show as soon as the active jobs are loaded; the closed-job rows join them when they arrive.
    isLoading: active.isLoading,
    isError: active.isError,
    error: active.error,
    // The extra list could not be read: the queues may then be missing report work on cancelled jobs, so say so.
    closedJobsError: nonActive.isError,
    retryClosedJobs: () => void nonActive.refetch(),
  };
}

/** Shown on a report queue when report work on cancelled/closed jobs could not be loaded - never silently show less. */
export const CLOSED_JOBS_ERROR_TEXT =
  'Couldn’t load report work on cancelled or closed jobs, so this list may be incomplete.';
