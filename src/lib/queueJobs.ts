// Which jobs/visits the three report queues (Report review, Ready for client, Ready for accounts) read.
//
// They read every ACTIVE job, exactly as before, PLUS the non-active jobs (cancelled, completed, lost, on hold) that still
// have report or accounting work a manager must act on - so cancelling a job never makes such work disappear. Nothing
// else in the app reads the extra rows (All Live Jobs, the schedule, Month Matrix ... stay on active jobs only).
//
// For a non-active job a queue only takes the visits that genuinely still need action, so a job whose reports are all
// finished never shows up, and the Completed tab never sees one.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../domain/types';
import { listJobRows, listJobRowsWithOpenReportWork } from '../repository/jobsRepository';
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

/** Approved, with no invoice yet or an invoice that has not been sent (draft / sending / failed). Completed or not. */
export function hasOpenAccountsWork(visit: JobVisitSummary): boolean {
  return visit.reportReviewStatus === 'approved' && (!visit.invoiceId || visit.invoiceStatus !== 'sent');
}

/** Ready for client: approved and not yet marked Completed - the same rule for active and non-active jobs. */
export function isVisitInClientQueue(visit: JobVisitSummary): boolean {
  return isReportReadyForClient(visit);
}

/** Ready for accounts list: unchanged for an active job (approved-and-unbilled, or already invoiced); only open work for a non-active one. */
export function isVisitInAccountsQueue(job: JobRow, visit: JobVisitSummary): boolean {
  return isActiveJob(job) ? isVisitReadyForAccounts(visit) || !!visit.invoiceId : hasOpenAccountsWork(visit);
}

/** The "ready for accounts" nav count: unchanged for an active job; open accounting work for a non-active one. */
export function isVisitCountedForAccounts(job: JobRow, visit: JobVisitSummary): boolean {
  return isActiveJob(job) ? isVisitReadyForAccounts(visit) : hasOpenAccountsWork(visit);
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
  const rows = queueJobRows.filter((j) => division === 'Both' || j.division === division);
  return {
    review: rows.filter((j) => j.status === 'review').length,
    readyForAccounts: rows.reduce((n, j) => n + j.visits.filter((v) => isVisitCountedForAccounts(j, v)).length, 0),
    readyForClient: rows.reduce((n, j) => n + j.visits.filter(isVisitInClientQueue).length, 0),
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
