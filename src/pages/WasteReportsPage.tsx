import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDebouncedValue } from '../lib/dialogHooks';
import {
  getWasteReport,
  issueWasteVideoLinks,
  listWasteReports,
  setWasteReportArchived,
  setWasteReportSent,
  signWasteMediaUrls,
  signWasteVideoPlaybackUrl,
  WASTE_LIST_LIMIT,
  type WasteReportDetail,
  type WasteReportListRow,
  type WasteStatusFilter,
} from '../repository/wasteReportsRepository';
import { formatWasteWorkDates, generateWasteReportPdf, prepareWasteReportPdf, singleLineAddress, wasteReportPdfFileName, type PreparedWastePdf } from '../lib/wasteReportPdf';
import { saveClientReportPdf } from '../lib/clientReportDownload';
import { ClientVideoLinkError } from '../lib/clientVideoLinks';
import WasteReportDetailPanel, { formatWasteWhen } from '../components/waste/WasteReportDetailPanel';
import { ReportViewerDialog } from '../components/buildings/BuildingReportsPanel';
import SkippedPhotosDialog from '../components/reports/SkippedPhotosDialog';

export const WASTE_STATUS_OPTIONS: { value: WasteStatusFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'unsent', label: 'Not sent' },
  { value: 'sent', label: 'Sent' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
];

/** One row of the list: the address, the work dates, what it holds and its state. */
export function WasteReportRow({ row, selected, onSelect }: { row: WasteReportListRow; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="waste-list-row"
      aria-current={selected ? 'true' : undefined}
      className={`block w-full cursor-pointer border-b border-divider px-4 py-3 text-left ${selected ? 'bg-teal-100' : 'bg-white hover:bg-neutral-100'}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-[13.5px] leading-snug font-semibold text-ink">{singleLineAddress(row.address)}</div>
        {row.archivedAt ? (
          <span className="flex-none border border-due px-1.5 text-[10.5px] text-due-fg">Archived</span>
        ) : row.sentAt ? (
          <span className="flex-none border border-done px-1.5 text-[10.5px] text-done-fg">Sent</span>
        ) : (
          <span className="flex-none border border-neutral-300 px-1.5 text-[10.5px] text-neutral-600">Not sent</span>
        )}
      </div>
      <div className="mt-0.5 text-[12px] text-neutral-600">
        {formatWasteWorkDates(row.startDate, row.endDate)} · {row.photoCount} photo{row.photoCount === 1 ? '' : 's'} · {row.videoCount} video{row.videoCount === 1 ? '' : 's'}
      </div>
      <div className="text-[11px] text-neutral-500">Submitted {formatWasteWhen(row.submittedAt)}</div>
    </button>
  );
}

/** Why a PDF could not be made, in plain words. */
function pdfError(err: unknown): string {
  if (err instanceof ClientVideoLinkError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message ? `The PDF could not be made: ${message}` : 'The PDF could not be made. Try again.';
}

/**
 * Luke's Waste reports: Jack's submitted reports, searchable by address and filterable by work dates and state; the selected report's
 * photos, videos, PDF (with secure video links), "sent" mark, archive and history. Archived reports stay here (filter "Archived" / "All").
 */
export default function WasteReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<WasteStatusFilter>('active');
  const debouncedSearch = useDebouncedValue(search, 300);
  const selectedId = searchParams.get('report');
  const [busy, setBusy] = useState<'sent' | 'archive' | 'pdf' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ blob: Blob; fileName: string; title: string } | null>(null);
  const [skipped, setSkipped] = useState<{ prepared: PreparedWastePdf; report: WasteReportDetail; mode: 'view' | 'download' } | null>(null);

  const filters = { search: debouncedSearch, from, to, status };
  const list = useQuery({ queryKey: ['wasteReports', filters], queryFn: () => listWasteReports(filters) });
  const detail = useQuery({ queryKey: ['wasteReport', selectedId], queryFn: () => getWasteReport(selectedId!), enabled: !!selectedId });
  const report = detail.data ?? null;
  const mediaPaths = report ? report.media.flatMap((m) => (m.kind === 'photo' ? [m.storagePath] : m.thumbnailPath ? [m.thumbnailPath] : [])) : [];
  const urls = useQuery({
    queryKey: ['wasteMediaUrls', selectedId, mediaPaths.join('|')],
    queryFn: () => signWasteMediaUrls(mediaPaths),
    enabled: mediaPaths.length > 0,
    staleTime: 45 * 60_000,
    meta: { persist: false },
  });

  const select = (id: string) => {
    setActionError(null);
    const next = new URLSearchParams(searchParams);
    next.set('report', id);
    setSearchParams(next);
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['wasteReports'] }),
      queryClient.invalidateQueries({ queryKey: ['wasteReport', selectedId] }),
      queryClient.invalidateQueries({ queryKey: ['wasteReportsUnsentCount'] }),
    ]);
  };

  const change = useMutation({
    mutationFn: async (action: { kind: 'sent'; value: boolean } | { kind: 'archive'; value: boolean }) => {
      if (!report) return;
      if (action.kind === 'sent') await setWasteReportSent(report.id, action.value);
      else await setWasteReportArchived(report.id, action.value);
    },
    onMutate: (action) => {
      setActionError(null);
      setBusy(action.kind);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : 'That could not be saved. Try again.'),
    onSettled: async () => {
      await refresh();
      setBusy(null);
    },
  });

  const finishPdf = async (prepared: PreparedWastePdf, forReport: WasteReportDetail, mode: 'view' | 'download') => {
    const blob = await generateWasteReportPdf(forReport, prepared);
    const fileName = wasteReportPdfFileName(forReport);
    if (mode === 'download') saveClientReportPdf(blob, fileName);
    else setViewer({ blob, fileName, title: singleLineAddress(forReport.address) });
  };

  const makePdf = async (mode: 'view' | 'download') => {
    if (!report) return;
    setActionError(null);
    setBusy('pdf');
    try {
      const prepared = await prepareWasteReportPdf(report, { signUrls: (paths) => signWasteMediaUrls(paths, 600), requestLinks: () => issueWasteVideoLinks(report.id) });
      if (prepared.skippedPhotos > 0) setSkipped({ prepared, report, mode });
      else await finishPdf(prepared, report, mode);
    } catch (err) {
      setActionError(pdfError(err));
    } finally {
      setBusy(null);
    }
  };

  const rows = list.data?.rows ?? [];
  const filtered = !!(debouncedSearch.trim() || from || to || status !== 'active');

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[400px] flex-none flex-col border-r border-divider bg-white">
        <div className="flex flex-none flex-col gap-2 border-b border-divider px-4 pt-4 pb-3">
          <div>
            <h1 className="font-heading text-[24px] leading-none font-semibold text-ink">Waste reports</h1>
            <p className="mt-1 text-[12px] text-neutral-600">Reports sent in by the waste reporter. No approval needed.</p>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by address"
            aria-label="Search by address"
            className="w-full border border-neutral-300 px-2.5 py-1.5 text-[13px] outline-none focus:border-teal"
          />
          <div className="flex items-center gap-1.5 text-[11.5px] text-neutral-600">
            <label className="flex items-center gap-1">
              From
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Work dates from" className="border border-neutral-300 px-1.5 py-1 text-[12px]" />
            </label>
            <label className="flex items-center gap-1">
              to
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Work dates to" className="border border-neutral-300 px-1.5 py-1 text-[12px]" />
            </label>
            {(from || to) && (
              <button type="button" onClick={() => { setFrom(''); setTo(''); }} className="cursor-pointer underline">
                Clear
              </button>
            )}
          </div>
          <div className="flex border border-neutral-300" role="group" aria-label="Show">
            {WASTE_STATUS_OPTIONS.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setStatus(o.value)}
                aria-pressed={status === o.value}
                className={`flex-1 cursor-pointer py-1 text-[11.5px] ${i > 0 ? 'border-l border-neutral-300' : ''} ${status === o.value ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="waste-list">
          {list.isPending && <p className="px-4 py-3 text-[12.5px] text-neutral-500">Loading…</p>}
          {list.isError && <p className="px-4 py-3 text-[12.5px] text-missed-fg">{list.error instanceof Error ? list.error.message : 'The reports could not be loaded.'}</p>}
          {!list.isPending && !list.isError && rows.length === 0 && (
            <p className="px-4 py-3 text-[12.5px] text-neutral-600">
              {filtered ? 'No waste reports match these filters.' : 'No waste reports yet.'}
            </p>
          )}
          {rows.map((r) => (
            <WasteReportRow key={r.id} row={r} selected={r.id === selectedId} onSelect={() => select(r.id)} />
          ))}
          {list.data?.truncated && <p className="px-4 py-3 text-[11.5px] text-neutral-500">Showing the newest {WASTE_LIST_LIMIT}. Narrow the search or dates to see older ones.</p>}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto bg-neutral-50">
        {!selectedId && <p className="p-6 text-[13px] text-neutral-600">Select a report to see its photos, videos and PDF.</p>}
        {selectedId && detail.isPending && <p className="p-6 text-[13px] text-neutral-500">Loading…</p>}
        {selectedId && detail.isError && <p className="p-6 text-[13px] text-missed-fg">The report could not be loaded.</p>}
        {selectedId && detail.isSuccess && !report && <p className="p-6 text-[13px] text-neutral-600">This report wasn’t found.</p>}
        {report && (
          <WasteReportDetailPanel
            report={report}
            urls={urls.data ?? {}}
            urlsLoading={urls.isPending && mediaPaths.length > 0}
            onPlay={(video) => signWasteVideoPlaybackUrl(video.storagePath)}
            busy={busy}
            error={actionError}
            onViewPdf={() => void makePdf('view')}
            onDownloadPdf={() => void makePdf('download')}
            onSetSent={(sent) => change.mutate({ kind: 'sent', value: sent })}
            onSetArchived={(archived) => change.mutate({ kind: 'archive', value: archived })}
          />
        )}
      </div>

      {skipped && (
        <SkippedPhotosDialog
          count={skipped.prepared.skippedPhotos}
          action={skipped.mode}
          onCancel={() => setSkipped(null)}
          onContinue={() => {
            const s = skipped;
            setSkipped(null);
            void finishPdf(s.prepared, s.report, s.mode).catch((err: unknown) => setActionError(pdfError(err)));
          }}
        />
      )}
      {viewer && (
        <ReportViewerDialog label="Waste report" title={viewer.title} blob={viewer.blob} onDownload={() => saveClientReportPdf(viewer.blob, viewer.fileName)} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
