// Does the server already hold exactly this (permanently failed) local draft? Pure - no network, no storage.
//
// A report that really reached the office can still be left behind on the phone as a "failed" draft: e.g. two sends of the same
// resubmission raced, the first was accepted and the second was refused ("This report is not awaiting correction.") and saved as a
// permanent failure. Such a draft would say "not sent" for ever. This decides - strictly - whether the server's copy is the same report,
// so the draft can be marked as confirmed instead (it is never deleted, never re-sent, and its photos are never touched).
import type { DraftReport } from './db';

/** What the server holds for THIS technician's own part of a visit's report (technician_visit_detail + technician_my_photos). */
export interface ServerReportForDraft {
  reportId: string;
  /** This technician's view: 'returned_for_correction' only when THEIR part is awaiting a correction. */
  reviewStatus: string | null;
  workCarriedOut: string | null;
  technicianNotes: string | null;
  issues: string | null;
  specMet: boolean | null;
  /** Storage paths of this technician's own photos in the report. */
  photoPaths: string[];
}

const sameText = (a: string | null | undefined, b: string | null | undefined) => (a ?? '') === (b ?? '');
/** The only states in which the server has this technician's part and is NOT waiting on them; anything else (incl. missing) = no match. */
const RECEIVED_STATES = new Set(['awaiting_review', 'approved']);

/**
 * True only when every one of these holds:
 *  - the server has a report for this technician (null = no report of theirs, or the visit is no longer theirs to see);
 *  - for a resubmission, it is the very report the draft was correcting;
 *  - the server has received it and is not waiting for this technician's correction (awaiting review or approved only - if it is
 *    returned, the draft is genuinely not done; a missing or unknown state proves nothing);
 *  - the text and "something not done" are exactly what the draft holds;
 *  - every photo queued with the draft is among the technician's photos in that report (photo paths are random, so this is decisive);
 *  - a first report has at least one photo to match on (the server requires one, and text alone could be a coincidence).
 * Anything else - including any doubt - is "no match".
 */
export function draftMatchesServerReport(
  draft: Pick<DraftReport, 'mode' | 'reportId' | 'workCarriedOut' | 'technicianNotes' | 'issues' | 'specMet'>,
  localPhotoPaths: string[],
  server: ServerReportForDraft | null,
): boolean {
  if (!server?.reportId) return false;
  if (draft.mode === 'resubmit' && (!draft.reportId || draft.reportId !== server.reportId)) return false;
  if (draft.mode === 'submit' && localPhotoPaths.length === 0) return false;
  if (!server.reviewStatus || !RECEIVED_STATES.has(server.reviewStatus)) return false;
  if (!sameText(draft.workCarriedOut, server.workCarriedOut) || !sameText(draft.technicianNotes, server.technicianNotes) || !sameText(draft.issues, server.issues)) {
    return false;
  }
  if (draft.specMet !== (server.specMet ?? true)) return false;
  const onServer = new Set(server.photoPaths);
  return localPhotoPaths.every((path) => onServer.has(path));
}
