import type { DraftReport } from './offline/db';

/**
 * Has this visit's report really reached the office? Used by the Completed screen.
 *
 * A report row existing is NOT proof: when a returned report is being resubmitted it already exists, so "has a report id"
 * would say "Sent to the office" before anything was sent. The local draft is the truth for that: the sync engine removes a
 * draft only after the server has confirmed the submit/resubmit, so a draft that is still queued (ready to submit) means the
 * send has not completed yet - whether it is waiting, retrying, or has failed.
 */
export function isReportSyncedToServer(
  visit: { reportId?: string | null } | null | undefined,
  draft: Pick<DraftReport, 'readyToSubmit'> | null | undefined,
): boolean {
  if (!visit?.reportId) return false;
  return !draft?.readyToSubmit;
}
