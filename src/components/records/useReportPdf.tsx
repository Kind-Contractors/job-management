import { useState, type ReactNode } from 'react';
import type { BuildingReportEntry } from '../../lib/buildingReports';
import {
  finishClientReportDownload,
  generateClientReportBlob,
  prepareClientReportDownload,
  reportPdfFileName,
  type ClientReportDownloadDeps,
  type PreparedClientReportDownload,
} from '../../lib/clientReportDownload';
import { CLIENT_REPORT_DOWNLOAD_DEPS, ReportViewerDialog } from '../buildings/BuildingReportsPanel';
import SkippedPhotosDialog from '../reports/SkippedPhotosDialog';

export function reportRecordTitle(entry: BuildingReportEntry): string {
  const date = entry.visit.scheduledDate ? new Date(entry.visit.scheduledDate).toLocaleDateString('en-GB') : 'date not set';
  return `${entry.job.buildingName} · ${entry.job.jobSummary} · Visit ${date}`;
}

/**
 * View report / Download PDF for a delivered report - the very same steps and PDF generator the Building File's Job reports
 * panel and Ready for client use (the PDF is built from the report's current data; nothing is stored). Returns the actions,
 * their busy/error state, and the dialogs to render (skipped-photos warning and the PDF viewer).
 */
export function useReportPdf(deps: ClientReportDownloadDeps = CLIENT_REPORT_DOWNLOAD_DEPS): {
  start: (entry: BuildingReportEntry, action: 'view' | 'download') => Promise<void>;
  busyReportId: string | null;
  errors: Record<string, string>;
  dialogs: ReactNode;
} {
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<{ reportId: string; action: 'download' | 'view'; title: string; prepared: PreparedClientReportDownload } | null>(null);
  const [viewed, setViewed] = useState<{ title: string; fileName: string; blob: Blob } | null>(null);

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

  const openViewer = async (title: string, prepared: PreparedClientReportDownload) => {
    const blob = await generateClientReportBlob(prepared, deps);
    setViewed({ title, fileName: reportPdfFileName(prepared.model), blob });
  };

  const start = (entry: BuildingReportEntry, action: 'view' | 'download') =>
    run(entry.reportId, async () => {
      // Each row prepares ITS OWN report (this entry's job and visit); a report of another visit is refused there.
      const prepared = await prepareClientReportDownload(entry.job, entry.visit, deps);
      if (prepared.photos.skippedCount > 0) {
        setSkipped({ reportId: entry.reportId, action, title: reportRecordTitle(entry), prepared });
        return;
      }
      if (action === 'view') await openViewer(reportRecordTitle(entry), prepared);
      else await finishClientReportDownload(prepared, deps);
    });

  const dialogs = (
    <>
      {skipped && (
        <SkippedPhotosDialog
          count={skipped.prepared.photos.skippedCount}
          action={skipped.action}
          onCancel={() => setSkipped(null)}
          onContinue={() => {
            const { reportId, action, title, prepared } = skipped;
            setSkipped(null);
            void run(reportId, () => (action === 'view' ? openViewer(title, prepared) : finishClientReportDownload(prepared, deps)));
          }}
        />
      )}
      {viewed && <ReportViewerDialog title={viewed.title} blob={viewed.blob} onDownload={() => deps.save(viewed.blob, viewed.fileName)} onClose={() => setViewed(null)} />}
    </>
  );

  return { start, busyReportId, errors, dialogs };
}
