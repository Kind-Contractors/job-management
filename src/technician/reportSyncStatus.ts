import type { DraftReport, PendingPhoto } from './offline/db';

/**
 * Where one completed report is, in plain words, for the Completed screen - from the most to the least serious, so a genuine send
 * failure is never hidden behind "photos uploading". `detail` never contains technical text (that stays in the queue records).
 */
export type ReportSyncState = 'sent' | 'refused' | 'send-failed' | 'photos-failed' | 'uploading' | 'sending';
export function reportSyncSummary(
  synced: boolean,
  draft: Pick<DraftReport, 'permanentFailure' | 'submitError'> | null | undefined,
  photos: Pick<PendingPhoto, 'status'>[],
): { state: ReportSyncState; headline: string } {
  if (synced) return { state: 'sent', headline: 'Sent to the office' };
  if (draft?.permanentFailure) return { state: 'refused', headline: 'Couldn’t be sent — contact the office' };
  if (draft?.submitError) return { state: 'send-failed', headline: 'Report not sent yet — retrying automatically' };
  const failed = photos.filter((p) => p.status === 'failed').length;
  const uploaded = photos.filter((p) => p.status === 'uploaded').length;
  if (failed > 0) return { state: 'photos-failed', headline: `${failed} photo${failed === 1 ? '' : 's'} not uploaded yet — retrying automatically` };
  if (uploaded < photos.length) return { state: 'uploading', headline: `Uploading photos — ${uploaded} of ${photos.length} done` };
  return { state: 'sending', headline: 'Sending to the office' };
}

/** Why one photo hasn't uploaded, in plain words (no technical details), and whether it will be tried again by itself. */
export function photoProblemText(photo: Pick<PendingPhoto, 'failureKind'>): string {
  switch (photo.failureKind) {
    case 'unreadable':
      return 'This photo can’t be read from this phone. It will be checked again; if it stays like this, remove it.';
    case 'rejected':
      return 'The server didn’t accept this photo. Please contact the office.';
    case 'timeout':
      return 'The upload stopped (weak or no signal). Trying again automatically.';
    case 'verify':
      return 'The upload couldn’t be confirmed. Uploading it again automatically.';
    default:
      return 'The upload didn’t go through (no connection). Trying again automatically.';
  }
}


/**
 * Has this visit's report really reached the office? Used by the Completed screen.
 *
 * A report row existing is NOT proof: when a returned report is being resubmitted it already exists, so "has a report id"
 * would say "Sent to the office" before anything was sent. The local draft is the truth for that: the sync engine removes a
 * draft only after the server has confirmed the submit/resubmit, so a draft that is still queued (ready to submit) means the
 * send has not completed yet - whether it is waiting, retrying, or has failed.
 */
export function isReportSyncedToServer(
  visit: { reportId?: string | null; reportReviewStatus?: string | null } | null | undefined,
  draft: Pick<DraftReport, 'readyToSubmit' | 'serverConfirmedAt'> | null | undefined,
): boolean {
  if (!visit?.reportId) return false;
  if (!draft?.readyToSubmit) return true;
  // A failed draft that a check found the server already holds exactly (see offline/draftReconciliation.ts) counts as sent - unless
  // the visit, as just loaded from the server, says the report has since been returned (the mark is only re-checked next session).
  return !!draft.serverConfirmedAt && visit.reportReviewStatus !== 'returned_for_correction';
}
