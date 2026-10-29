import { useState } from 'react';
import type { JobRow } from '../../domain/types';
import { buildingReports, type BuildingReportEntry } from '../../lib/buildingReports';
import {
  finishClientReportDownload,
  generateClientReportBlob,
  prepareClientReportDownload,
  reportPdfFileName,
  saveClientReportPdf,
  type ClientReportDownloadDeps,
  type PreparedClientReportDownload,
} from '../../lib/clientReportDownload';
import { generateClientReportPdf, prepareClientReportPhotos } from '../../lib/clientReportPdf';
import { prepareClientReportVideos } from '../../lib/clientVideoLinks';
import { prepareImageForPdf } from '../../lib/pdfImage';
import { getReport, listPhotosForReport, signReportPhotoUrls } from '../../repository/reportsRepository';
import { issueClientVideoLinks, listVideosForVisit, signVideoThumbnailUrls } from '../../repository/reportVideosRepository';
import { formatWhen } from '../reports/ReportCompletionControls';
import SkippedPhotosDialog from '../reports/SkippedPhotosDialog';
import PdfDocumentView from '../reports/PdfDocumentView';
import ScrollableList from '../shared/ScrollableList';
import { backdropDismiss } from '../../lib/dialogHooks';

/** The real data and PDF calls - the same ones the Send to client screen's "Download PDF" uses. */
export const CLIENT_REPORT_DOWNLOAD_DEPS: ClientReportDownloadDeps = {
  getReport,
  listPhotos: listPhotosForReport,
  signPhotoUrls: signReportPhotoUrls,
  listVideos: listVideosForVisit,
  prepareVideos: (model, reportId, videos) =>
    prepareClientReportVideos(model, {
      requestLinks: () => issueClientVideoLinks(reportId),
      signThumbnails: () => signVideoThumbnailUrls(videos.filter((v) => model.videos.some((mv) => mv.id === v.id))),
      prepareImage: prepareImageForPdf,
    }),
  preparePhotos: prepareClientReportPhotos,
  generatePdf: generateClientReportPdf,
  save: saveClientReportPdf,
};

interface BuildingReportsPanelProps {
  buildingId: string;
  /** Active and historical (completed / lost / cancelled) jobs; only this building's are used. */
  jobLists: JobRow[][];
  /** True while the historical jobs are still loading: older reports may not be listed yet. */
  historicalLoading: boolean;
  /** True when the historical jobs could not be loaded: reports of completed jobs may be missing, so say so. */
  historicalError: boolean;
  onRetryHistorical: () => void;
  deps?: ClientReportDownloadDeps;
}

/** The report open in the viewer: the generated PDF and the row it belongs to. */
interface ViewedReport {
  reportId: string;
  title: string;
  fileName: string;
  blob: Blob;
}

/**
 * The client reports of this building's jobs. A report appears once it is marked Completed or has been sent to the client.
 * Reports are not stored as files: View report and Download PDF both build the PDF from the report's current data exactly as
 * the Send to client screen does - View shows that same PDF inside a dialog (drawn in the app, so its video links open in a new
 * tab), so what is read here is exactly what would be downloaded.
 */
export default function BuildingReportsPanel({
  buildingId,
  jobLists,
  historicalLoading,
  historicalError,
  onRetryHistorical,
  deps = CLIENT_REPORT_DOWNLOAD_DEPS,
}: BuildingReportsPanelProps) {
  const { available, notYetAvailable } = buildingReports(buildingId, ...jobLists);
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<{ reportId: string; action: 'download' | 'view'; title: string; prepared: PreparedClientReportDownload } | null>(null);
  const [viewed, setViewed] = useState<ViewedReport | null>(null);

  const closeViewer = () => setViewed(null);

  const run = async (reportId: string, work: () => Promise<void>) => {
    setBusyReportId(reportId);
    setErrors((e) => ({ ...e, [reportId]: '' }));
    try {
      await work();
    } catch (err) {
      setErrors((e) => ({ ...e, [reportId]: err instanceof Error ? err.message : 'The report could not be downloaded.' }));
    } finally {
      setBusyReportId(null);
    }
  };

  /** Opens the generated PDF in the viewer. The PDF is the one Download PDF would save (same steps, same generator). */
  const openViewer = async (reportId: string, title: string, prepared: PreparedClientReportDownload) => {
    const blob = await generateClientReportBlob(prepared, deps);
    setViewed({ reportId, title, fileName: reportPdfFileName(prepared.model), blob });
  };

  const start = (entry: BuildingReportEntry, action: 'download' | 'view') =>
    run(entry.reportId, async () => {
      // Each row prepares ITS OWN report (this entry's job and visit); a report of another visit is refused there.
      const prepared = await prepareClientReportDownload(entry.job, entry.visit, deps);
      if (prepared.photos.skippedCount > 0) {
        setSkipped({ reportId: entry.reportId, action, title: reportTitle(entry), prepared });
        return;
      }
      if (action === 'view') await openViewer(entry.reportId, reportTitle(entry), prepared);
      else await finishClientReportDownload(prepared, deps);
    });

  return (
    <div data-testid="building-reports" className="border border-neutral-300 bg-white">
      <div className="border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
        Job reports · {available.length} ready
      </div>
      {historicalError && (
        <div className="border-b border-divider px-4 py-2 text-[12px] text-missed-fg">
          Couldn&apos;t load completed and closed jobs, so their reports may be missing from this list.{' '}
          <button onClick={onRetryHistorical} className="cursor-pointer text-teal-700 underline">
            Try again
          </button>
        </div>
      )}
      {available.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-neutral-500">
          {historicalLoading
            ? 'Loading reports…'
            : 'No reports to download yet. A report appears here once it is marked Completed or sent to the client in Ready for client.'}
        </div>
      ) : (
        <ScrollableList count={available.length} label="Job reports">
        {available.map((entry) => {
          const busy = busyReportId === entry.reportId;
          const error = errors[entry.reportId];
          return (
            <div key={entry.reportId} className="border-b border-divider px-4 py-2.5 text-[12.5px] last:border-b-0">
              <div className="flex items-center gap-3">
                <VisitDateBlock date={entry.visit.scheduledDate} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-semibold text-ink">{entry.job.jobSummary}</span>
                    <span className="text-neutral-500">{visitLabel(entry)}</span>
                    {entry.sentToClientAt ? (
                      <span className="bg-teal px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-white uppercase">Sent to client</span>
                    ) : (
                      <span className="border border-teal-700 px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">Completed</span>
                    )}
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    {[
                      entry.sentToClientAt ? `Sent to client ${formatWhen(entry.sentToClientAt)}` : null,
                      entry.completedAt ? `Completed ${formatWhen(entry.completedAt)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <button
                  onClick={() => void start(entry, 'view')}
                  disabled={busyReportId !== null}
                  className="flex-none cursor-pointer bg-teal px-2.5 py-1 text-[11.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  View report
                </button>
                <button
                  onClick={() => void start(entry, 'download')}
                  disabled={busyReportId !== null}
                  className="flex-none cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Download PDF
                </button>
              </div>
              {busy && <div className="mt-1 text-[11.5px] text-neutral-500">Preparing the report…</div>}
              {error && (
                <div role="alert" className="mt-1 text-[11.5px] text-missed-fg">
                  {error}
                </div>
              )}
            </div>
          );
        })}
        </ScrollableList>
      )}
      {notYetAvailable > 0 && (
        <div className="border-t border-divider px-4 py-2 text-[11.5px] text-neutral-500">
          {notYetAvailable} more {notYetAvailable === 1 ? 'report is' : 'reports are'} not available yet: still in review, or not yet marked
          Completed or sent to the client.
        </div>
      )}
      {skipped && (
        <SkippedPhotosDialog
          count={skipped.prepared.photos.skippedCount}
          action={skipped.action}
          onCancel={() => setSkipped(null)}
          onContinue={() => {
            const { reportId, action, title, prepared } = skipped;
            setSkipped(null);
            void run(reportId, () => (action === 'view' ? openViewer(reportId, title, prepared) : finishClientReportDownload(prepared, deps)));
          }}
        />
      )}
      {viewed && (
        <ReportViewerDialog title={viewed.title} blob={viewed.blob} onDownload={() => deps.save(viewed.blob, viewed.fileName)} onClose={closeViewer} />
      )}
    </div>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric' });
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short' });

/** The visit's day and month at a glance (the full date is in the row's text). Blank when the visit has no date. */
function VisitDateBlock({ date }: { date: string | null }) {
  const d = date ? new Date(date) : null;
  const valid = d !== null && !Number.isNaN(d.getTime());
  return (
    <div aria-hidden="true" className="w-11 flex-none border border-neutral-300 py-0.5 text-center">
      <div className="font-heading text-base leading-tight font-semibold text-ink tabular-nums">{valid ? DAY.format(d) : '—'}</div>
      <div className="font-heading text-[9.5px] font-semibold tracking-[0.08em] text-neutral-600 uppercase">{valid ? MONTH.format(d) : ''}</div>
    </div>
  );
}

function visitLabel(entry: BuildingReportEntry): string {
  return `Visit ${entry.visit.scheduledDate ? new Date(entry.visit.scheduledDate).toLocaleDateString('en-GB') : 'date not set'}`;
}

function reportTitle(entry: BuildingReportEntry): string {
  return `${entry.job.jobSummary} · ${visitLabel(entry)}`;
}

interface ReportViewerDialogProps {
  title: string;
  /** The generated PDF (in memory only; nothing is uploaded). */
  blob: Blob;
  onDownload: () => void;
  onClose: () => void;
}

/**
 * The generated report PDF, shown inside a dialog. Its "Watch video" links open in a new tab, so the report stays open here.
 * Close, a click outside, or Escape returns to the Building screen.
 */
export function ReportViewerDialog({ title, blob, onDownload, onClose }: ReportViewerDialogProps) {
  // Closes on a backdrop click only when the press also started on the backdrop (never mid-typing: see backdropDismiss).
  const backdrop = backdropDismiss(onClose);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Job report: ${title}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30"
      {...backdrop}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="flex h-[90vh] w-[min(960px,95vw)] flex-col border border-neutral-300 bg-white">
        <div className="flex flex-none items-center gap-2 border-b border-divider px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Job report</div>
            <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
          </div>
          <button
            onClick={onDownload}
            className="flex-none cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100"
          >
            Download PDF
          </button>
          <button autoFocus onClick={onClose} className="flex-none cursor-pointer bg-teal px-3 py-1 text-[11.5px] font-semibold text-white">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PdfDocumentView blob={blob} title={`Job report: ${title}`} />
        </div>
      </div>
    </div>
  );
}
