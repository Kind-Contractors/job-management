// The waste report PDF: the same drawing as the client service report (clientReportPdf.ts - its own output is unchanged), with the
// waste report's wording: "Waste removal report", the job address as the title, the work dates in the facts strip, the description as
// "Work carried out", Before/After photos, and each video as a card with a clickable, secure watch link (issue-waste-video-links).
// Nothing about Jack's account, the internal ids or the storage paths reaches the PDF.
import type { ClientReportModel } from './clientReportModel';
import { generateClientReportPdf, prepareClientReportPhotos, type PreparedReportPhotos, type ReportPdfLayout } from './clientReportPdf';
import { prepareClientReportVideos, type PreparedReportVideos } from './clientVideoLinks';
import { prepareImageForPdf } from './pdfImage';
import { formatDuration } from './reportVideoRules';
import type { WasteReportDetail } from '../repository/wasteReportsRepository';

/** "3 Nov 2026", or "31 Oct – 1 Nov 2026" for a range. */
export function formatWasteWorkDates(start: string, end: string): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  if (start === end) return fmt(start, true);
  return `${fmt(start, start.slice(0, 4) !== end.slice(0, 4))} – ${fmt(end, true)}`;
}

/** The address on one line (Jack may type it over several). */
export function singleLineAddress(address: string): string {
  return address
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * The waste PDF's wording. The facts strip shares its width with the photo and video counts, so each fact is one short date - a range
 * such as "31 Dec 2026 – 2 Jan 2027" would be cut off there. ("Waste removal" is already the line above the title.)
 */
export function wasteReportLayout(report: Pick<WasteReportDetail, 'startDate' | 'endDate'>): ReportPdfLayout {
  const day = (iso: string) => formatWasteWorkDates(iso, iso);
  return {
    documentTitle: 'Waste removal report',
    runningTitle: 'WASTE REMOVAL REPORT',
    subtitle: null,
    facts:
      report.startDate === report.endDate
        ? [['Work date', day(report.startDate)]]
        : [
            ['Started', day(report.startDate)],
            ['Finished', day(report.endDate)],
          ],
    showSpecStatus: false,
  };
}

/**
 * The PDF's content, in the client-report model the drawing code reads. `photoUrls` / `thumbUrls` are short-lived signed URLs by storage
 * path. Only client-safe facts: the address, the dates, the description and the media.
 */
export function buildWasteReportModel(report: WasteReportDetail, photoUrls: Record<string, string>, thumbUrls: Record<string, string> = {}): ClientReportModel {
  return {
    clientName: '',
    buildingName: singleLineAddress(report.address),
    jobSummary: 'Waste removal',
    visitDateLabel: formatWasteWorkDates(report.startDate, report.endDate),
    workCarriedOut: report.description.trim() || null,
    notes: null,
    issues: null,
    specMet: true,
    photos: report.media
      .filter((m) => m.kind === 'photo' && photoUrls[m.storagePath])
      .map((m) => ({ id: m.id, phase: m.phase, url: photoUrls[m.storagePath] })),
    videos: report.media
      .filter((m) => m.kind === 'video')
      .map((m) => ({ id: m.id, phase: m.phase, durationLabel: formatDuration(m.durationSeconds), thumbnailUrl: m.thumbnailPath ? (thumbUrls[m.thumbnailPath] ?? null) : null })),
  };
}

/** "Waste report - 12 High Street, Leeds - 2026-11-03.pdf" (characters a file name can't hold removed). */
export function wasteReportPdfFileName(report: Pick<WasteReportDetail, 'address' | 'endDate'>): string {
  const address = singleLineAddress(report.address).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `Waste report - ${address} - ${report.endDate}.pdf`;
}

export interface WastePdfDeps {
  /** Fresh signed URLs by storage path (photos and posters). */
  signUrls: (paths: string[]) => Promise<Record<string, string>>;
  /** videoId -> secure watch URL. */
  requestLinks: () => Promise<Record<string, string>>;
}

export interface PreparedWastePdf {
  model: ClientReportModel;
  photos: PreparedReportPhotos;
  videos: PreparedReportVideos;
  /** Photos in the report that could not be loaded (they would be missing from the PDF). */
  skippedPhotos: number;
}

/**
 * Loads everything the PDF needs: the photos (shrunk for the PDF) and, for the videos, their secure watch links and posters. A report
 * with videos is never produced without their links: if a link can't be made this throws (ClientVideoLinkError) and nothing is
 * downloaded.
 */
export async function prepareWasteReportPdf(report: WasteReportDetail, deps: WastePdfDeps): Promise<PreparedWastePdf> {
  const photoPaths = report.media.filter((m) => m.kind === 'photo').map((m) => m.storagePath);
  const thumbPaths = report.media.filter((m) => m.kind === 'video' && m.thumbnailPath).map((m) => m.thumbnailPath as string);
  const urls = await deps.signUrls([...photoPaths, ...thumbPaths]);
  const model = buildWasteReportModel(report, urls, urls);
  const missingUrls = photoPaths.length - model.photos.length;
  const photos = await prepareClientReportPhotos(model);
  const videos = await prepareClientReportVideos(model, {
    requestLinks: deps.requestLinks,
    signThumbnails: async () => Object.fromEntries(model.videos.filter((v) => v.thumbnailUrl).map((v) => [v.id, v.thumbnailUrl as string])),
    prepareImage: prepareImageForPdf,
  });
  return { model, photos, videos, skippedPhotos: missingUrls + photos.skippedCount };
}

export async function generateWasteReportPdf(report: WasteReportDetail, prepared: PreparedWastePdf): Promise<Blob> {
  return generateClientReportPdf(prepared.model, prepared.photos, prepared.videos, wasteReportLayout(report));
}
