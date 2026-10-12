import type { JobRow, JobVisitSummary, ReportDetail } from '../domain/types';
import type { ReportPhoto } from '../repository/reportsRepository';
import type { ReportVideo } from '../repository/reportVideosRepository';
import { VIDEO_PHASES, formatDuration, type VideoPhase } from './reportVideoRules';

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
  /**
   * Videos the client may watch: the report's "Include videos" switch is on AND the video's own "Include for client" is on (removed videos
   * are never loaded). No storage path and no watch link live here - the link is made only when a PDF is actually delivered
   * (clientVideoLinks.ts), so merely looking at the preview never creates one. `thumbnailUrl` is a short-lived preview image for the screen.
   */
  videos: { id: string; phase: VideoPhase; durationLabel: string; thumbnailUrl: string | null }[];
}

/** Reused unchanged by both the preview and PDF generation — see ClientReportModel's own doc comment for why this is the one place client-safe fields are picked. */
export function buildClientReportModel(
  job: JobRow,
  visit: JobVisitSummary,
  report: ReportDetail,
  photos: ReportPhoto[],
  photoUrls: Record<string, string>,
  videos: ReportVideo[] = [],
  videoThumbnailUrls: Record<string, string> = {},
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
    videos: report.includeVideos
      ? orderVideosForReport(videos.filter((v) => v.includeInClientReport)).map((v) => ({
          id: v.id,
          phase: v.phase,
          durationLabel: formatDuration(v.durationSeconds),
          thumbnailUrl: videoThumbnailUrls[v.id] || null,
        }))
      : [],
  };
}

/** Before, then During, then After; within a phase, the order they were added. */
export function orderVideosForReport<T extends { phase: VideoPhase; createdAt: string }>(videos: T[]): T[] {
  return VIDEO_PHASES.flatMap((phase) => videos.filter((v) => v.phase === phase).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}
