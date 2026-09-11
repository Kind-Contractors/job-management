import type { JobRow, JobVisitSummary, ReportDetail } from '../domain/types';
import type { ReportPhoto } from '../repository/reportsRepository';

/**
 * The one shape both the on-screen preview (ReadyForClientPage.tsx) and
 * PDF generation (clientReportPdf.ts) are allowed to read from — never the
 * raw ReportDetail/ReportPhoto/JobRow objects, so a future field added to
 * any of them (e.g. internal pricing, key safe codes, review status)
 * can't silently leak into what a client sees just by being present on
 * the source object. Everything here is already something a client is
 * allowed to know.
 *
 * "Work carried out" has no include_* column today (only notes/issues/
 * photos/price do) so it's always included here — a real limitation
 * carried over from Phase 1, not an oversight.
 */
export interface ClientReportModel {
  clientName: string;
  buildingName: string;
  jobSummary: string;
  visitDateLabel: string;
  workCarriedOut: string | null;
  notes: string | null;
  issues: string | null;
  specMet: boolean;
  photos: { id: string; phase: ReportPhoto['phase']; url: string }[];
}

/** Reused unchanged by both the preview and PDF generation — see ClientReportModel's own doc comment for why this is the one place client-safe fields are picked. */
export function buildClientReportModel(
  job: JobRow,
  visit: JobVisitSummary,
  report: ReportDetail,
  photos: ReportPhoto[],
  photoUrls: Record<string, string>,
): ClientReportModel {
  return {
    clientName: job.clientName,
    buildingName: job.buildingName,
    jobSummary: job.jobSummary,
    visitDateLabel: visit.scheduledDate ? new Date(visit.scheduledDate).toLocaleDateString('en-GB') : 'Date not set',
    workCarriedOut: report.workCarriedOut,
    notes: report.includeNotes ? report.technicianNotes : null,
    issues: report.includeIssues ? report.issues : null,
    specMet: report.specMet,
    photos: report.includePhotos
      ? photos.filter((p) => p.includeInClientReport && photoUrls[p.id]).map((p) => ({ id: p.id, phase: p.phase, url: photoUrls[p.id] }))
      : [],
  };
}
