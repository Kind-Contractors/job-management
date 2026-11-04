import { useState } from 'react';
import type { WasteEventType, WasteReportDetail, WasteReportMedia } from '../../repository/wasteReportsRepository';
import { formatDuration } from '../../lib/reportVideoRules';
import { formatWasteWorkDates } from '../../lib/wasteReportPdf';

export const WASTE_EVENT_LABEL: Record<WasteEventType, string> = {
  submitted: 'Submitted',
  marked_sent: 'Marked as sent to the client',
  unmarked_sent: 'Sent mark removed',
  archived: 'Archived',
  restored: 'Restored from the archive',
};

const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
export const formatWasteWhen = (iso: string): string => WHEN.format(new Date(iso));

const sectionLabel = 'mb-1.5 font-heading text-[10.5px] font-semibold tracking-[0.14em] text-neutral-600 uppercase';

interface WasteReportDetailPanelProps {
  report: WasteReportDetail;
  /** Signed view URLs by storage path (photos and video posters); a missing one shows a placeholder. */
  urls: Record<string, string>;
  urlsLoading: boolean;
  /** A playable URL for a video, fetched when Play is pressed. */
  onPlay: (video: WasteReportMedia) => Promise<string>;
  busy: 'sent' | 'archive' | 'pdf' | null;
  error: string | null;
  onViewPdf: () => void;
  onDownloadPdf: () => void;
  onSetSent: (sent: boolean) => void;
  onSetArchived: (archived: boolean) => void;
}

function VideoTile({ video, poster, onPlay }: { video: WasteReportMedia; poster: string | undefined; onPlay: (v: WasteReportMedia) => Promise<string> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  if (src) {
    return <video src={src} controls autoPlay playsInline poster={poster} className="aspect-video w-full bg-near-black" data-testid="waste-video-player" />;
  }
  return (
    <button
      type="button"
      onClick={() => {
        setState('loading');
        onPlay(video)
          .then((url) => setSrc(url))
          .catch(() => setState('error'));
      }}
      aria-label={`Play ${video.phase} video`}
      className="relative flex aspect-video w-full cursor-pointer items-center justify-center overflow-hidden bg-near-black"
    >
      {poster && <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" />}
      <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-[16px] text-ink">▶</span>
      <span className="absolute bottom-1.5 left-1.5 bg-near-black/70 px-1.5 text-[11px] text-white">
        {state === 'loading' ? 'Loading…' : state === 'error' ? 'Could not load - try again' : formatDuration(video.durationSeconds)}
      </span>
    </button>
  );
}

/** One waste report: what Jack sent (address, dates, description, Before/After photos and videos), its state, actions and history. */
export default function WasteReportDetailPanel({ report, urls, urlsLoading, onPlay, busy, error, onViewPdf, onDownloadPdf, onSetSent, onSetArchived }: WasteReportDetailPanelProps) {
  const [zoomed, setZoomed] = useState<WasteReportMedia | null>(null);
  const button = 'cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-[12px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="flex flex-col gap-4 p-5" data-testid="waste-report-detail">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Waste report</div>
          <h2 className="font-heading text-[22px] leading-tight font-semibold whitespace-pre-line text-ink">{report.address}</h2>
          <div className="mt-1 text-[12.5px] text-neutral-600">
            {formatWasteWorkDates(report.startDate, report.endDate)} · by {report.reporterName} · submitted {formatWasteWhen(report.submittedAt)}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={onViewPdf} disabled={busy !== null} className={button}>
            View PDF
          </button>
          <button type="button" onClick={onDownloadPdf} disabled={busy !== null} className="cursor-pointer bg-teal px-3 py-1.5 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">
            {busy === 'pdf' ? 'Preparing PDF…' : 'Download PDF'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className={`flex items-center gap-2 border px-3 py-2 ${report.sentAt ? 'border-done bg-done/10' : 'border-neutral-300 bg-neutral-100'}`} data-testid="waste-sent-state">
          <div className="min-w-0 flex-1 text-[12.5px]">
            {report.sentAt ? (
              <>
                <span className="font-semibold text-done-fg">Sent to the client</span>
                <span className="text-neutral-600"> · marked {formatWasteWhen(report.sentAt)} by {report.sentBy}</span>
              </>
            ) : (
              <span className="text-neutral-700">Not marked as sent to the client</span>
            )}
          </div>
          <button type="button" onClick={() => onSetSent(!report.sentAt)} disabled={busy !== null} className={button}>
            {busy === 'sent' ? 'Saving…' : report.sentAt ? 'Unmark' : 'Mark as sent'}
          </button>
        </div>
        <div className={`flex items-center gap-2 border px-3 py-2 ${report.archivedAt ? 'border-due bg-due/10' : 'border-neutral-300 bg-neutral-100'}`} data-testid="waste-archive-state">
          <div className="min-w-0 flex-1 text-[12.5px]">
            {report.archivedAt ? (
              <>
                <span className="font-semibold text-due-fg">Archived</span>
                <span className="text-neutral-600"> · {formatWasteWhen(report.archivedAt)} by {report.archivedBy}. Its video links still work.</span>
              </>
            ) : (
              <span className="text-neutral-700">Active</span>
            )}
          </div>
          <button type="button" onClick={() => onSetArchived(!report.archivedAt)} disabled={busy !== null} className={button}>
            {busy === 'archive' ? 'Saving…' : report.archivedAt ? 'Restore' : 'Archive'}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="border border-missed bg-missed/10 px-3 py-2 text-[12.5px] text-missed-fg">
          {error}
        </p>
      )}

      <section>
        <div className={sectionLabel}>Work carried out</div>
        <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{report.description.trim() || <span className="text-neutral-500">No description.</span>}</p>
      </section>

      {(['before', 'after'] as const).map((phase) => {
        const photos = report.media.filter((m) => m.phase === phase && m.kind === 'photo');
        const videos = report.media.filter((m) => m.phase === phase && m.kind === 'video');
        return (
          <section key={phase} data-testid={`waste-detail-${phase}`}>
            <div className={sectionLabel}>
              {phase === 'before' ? 'Before' : 'After'} · {photos.length} photo{photos.length === 1 ? '' : 's'}, {videos.length} video{videos.length === 1 ? '' : 's'}
            </div>
            {photos.length === 0 && videos.length === 0 && <p className="text-[12.5px] text-neutral-500">Nothing in this section.</p>}
            {photos.length > 0 && (
              <div className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
                {photos.map((p) => (
                  <button key={p.id} type="button" onClick={() => setZoomed(p)} className="aspect-square cursor-zoom-in overflow-hidden border border-neutral-300 bg-neutral-200" aria-label={`Open ${phase} photo`}>
                    {urls[p.storagePath] ? (
                      <img src={urls[p.storagePath]} alt={`${phase} photo`} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <span className="text-[11px] text-neutral-500">{urlsLoading ? 'Loading…' : 'Unavailable'}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {videos.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {videos.map((v) => (
                  <VideoTile key={v.id} video={v} poster={v.thumbnailPath ? urls[v.thumbnailPath] : undefined} onPlay={onPlay} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      <section>
        <div className={sectionLabel}>History</div>
        <ol className="flex flex-col gap-1.5 border-l border-divider pl-3" data-testid="waste-history">
          {report.events.map((e) => (
            <li key={e.id} className="text-[12.5px]">
              <span className="font-semibold text-ink">{WASTE_EVENT_LABEL[e.type] ?? e.type}</span>
              <span className="text-neutral-600">
                {' '}
                · {e.actor} · {formatWasteWhen(e.occurredAt)}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {zoomed && urls[zoomed.storagePath] && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo"
          className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/80 p-6"
          onClick={() => setZoomed(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setZoomed(null);
          }}
        >
          <img src={urls[zoomed.storagePath]} alt={`${zoomed.phase} photo`} className="max-h-full max-w-full object-contain" />
          <button type="button" autoFocus onClick={() => setZoomed(null)} className="absolute top-4 right-4 cursor-pointer bg-white px-3 py-1.5 text-[12px] text-ink">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
