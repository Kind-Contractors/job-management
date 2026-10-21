// Downloading a client report PDF, shared by the Send to client screen (ReadyForClientPage) and the Building screen
// (BuildingReportsPanel). Client reports are NOT stored as files: every download (and every send) builds the PDF in the
// browser from the report's current data, through the same client-safe model (clientReportModel.ts) and the same generator
// (clientReportPdf.ts). Nothing is uploaded, emailed or recorded as sent here.
//
// The steps match "Download PDF" on the Send to client screen exactly:
//   1. load the report, its photos (with short-lived signed URLs) and its videos;
//   2. build the ClientReportModel (only client-safe fields);
//   3. prepare the videos first - their secure watch links are made now, and if they cannot be made nothing is downloaded;
//   4. prepare (resize) the photos, counting any that could not be included - the caller asks before downloading without them;
//   5. generate the PDF and save it under the same file name.

import type { JobRow, JobVisitSummary, ReportDetail } from '../domain/types';
import type { ReportPhoto } from '../repository/reportsRepository';
import type { ReportVideo } from '../repository/reportVideosRepository';
import { buildClientReportModel, type ClientReportModel } from './clientReportModel';
import type { PreparedReportPhotos } from './clientReportPdf';
import type { PreparedReportVideos } from './clientVideoLinks';

/** The downloaded file's name: the same on every screen. */
export function reportPdfFileName(model: Pick<ClientReportModel, 'buildingName'>): string {
  return `${model.buildingName.replace(/[^a-z0-9]+/gi, '-')}-report.pdf`;
}

/** Saves a generated PDF through the browser (Blob URL + a throwaway <a download>). Nothing leaves the browser. */
export function saveClientReportPdf(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ClientReportDownloadDeps {
  getReport: (reportId: string) => Promise<ReportDetail>;
  listPhotos: (reportId: string) => Promise<ReportPhoto[]>;
  signPhotoUrls: (photos: ReportPhoto[]) => Promise<Record<string, string>>;
  listVideos: (visitId: string) => Promise<ReportVideo[]>;
  /** Builds the videos' secure watch links and thumbnails (prepareClientReportVideos with the real link and signing calls). */
  prepareVideos: (model: ClientReportModel, reportId: string, videos: ReportVideo[]) => Promise<PreparedReportVideos>;
  preparePhotos: (model: ClientReportModel) => Promise<PreparedReportPhotos>;
  generatePdf: (model: ClientReportModel, photos: PreparedReportPhotos, videos: PreparedReportVideos) => Promise<Blob>;
  save: (blob: Blob, fileName: string) => void;
}

export interface PreparedClientReportDownload {
  model: ClientReportModel;
  photos: PreparedReportPhotos;
  videos: PreparedReportVideos;
}

/**
 * Steps 1-4 for one visit's report. Throws a readable error when the report cannot be loaded or its video links cannot be
 * made; nothing is downloaded then. `photos.skippedCount > 0` means some photos could not be included: the caller must ask
 * before calling finishClientReportDownload.
 */
export async function prepareClientReportDownload(
  job: JobRow,
  visit: JobVisitSummary,
  deps: ClientReportDownloadDeps,
): Promise<PreparedClientReportDownload> {
  const reportId = visit.reportId;
  if (!reportId) throw new Error('This visit has no report to download.');
  let report: ReportDetail;
  try {
    report = await deps.getReport(reportId);
  } catch {
    throw new Error('The report could not be loaded, so nothing was downloaded. Please try again.');
  }
  // A report row belongs to exactly one visit; never build a PDF for one that does not belong to this visit (and so this job).
  if (report.visitId !== visit.id) throw new Error('This report does not belong to this visit, so it was not downloaded.');
  const photos = await deps.listPhotos(reportId);
  const photoUrls = photos.length > 0 ? await deps.signPhotoUrls(photos) : {};
  const videos = await deps.listVideos(visit.id);
  const model = buildClientReportModel(job, visit, report, photos, photoUrls, videos, {});
  const preparedVideos = await deps.prepareVideos(model, reportId, videos);
  const preparedPhotos = await deps.preparePhotos(model);
  return { model, photos: preparedPhotos, videos: preparedVideos };
}

/** Step 5a: generates the PDF from the prepared report. Viewing and downloading both use this, so they show the same file. */
export async function generateClientReportBlob(prepared: PreparedClientReportDownload, deps: Pick<ClientReportDownloadDeps, 'generatePdf'>): Promise<Blob> {
  return deps.generatePdf(prepared.model, prepared.photos, prepared.videos);
}

/** Step 5: generates the PDF from the prepared report and saves it. */
export async function finishClientReportDownload(prepared: PreparedClientReportDownload, deps: Pick<ClientReportDownloadDeps, 'generatePdf' | 'save'>): Promise<void> {
  deps.save(await generateClientReportBlob(prepared, deps), reportPdfFileName(prepared.model));
}
