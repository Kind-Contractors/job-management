import { useRef, useState } from 'react';
import { formatDuration, VIDEO_ACCEPT } from '../lib/reportVideoRules';
import type { WasteMedia } from './offline/wasteDb';
import { WASTE_LIMITS, WASTE_PHASE_LABEL, type WasteMediaKind, type WastePhase } from './wasteRules';
import WasteConfirmDialog from './WasteConfirmDialog';
import { describeWasteMedia } from './wasteMediaStatus';

interface WasteMediaSectionProps {
  phase: WastePhase;
  media: WasteMedia[];
  /** Live upload progress (0..1) of a file, or null. */
  progressOf: (mediaId: string) => number | null;
  /** A video's live bytes sent / size while it uploads, or null. */
  bytesOf?: (mediaId: string) => { sent: number; total: number } | null;
  /** The phone has a connection (false: files say they wait for signal). */
  online?: boolean;
  previewUrl: (blob: Blob, key: string) => string;
  locked: boolean;
  /** Plain-words problem from the last add, shown under the buttons. */
  addError: string | null;
  onAdd: (kind: WasteMediaKind, files: File[]) => void;
  onRemove: (mediaId: string) => void;
  onRetry: (mediaId: string) => void;
}

/**
 * One section (Before or After) of the waste report: its photos and videos as tiles with their upload state, and the two add
 * buttons. Presentational: everything it does goes through the callbacks.
 */
export default function WasteMediaSection({
  phase,
  media,
  progressOf,
  bytesOf = () => null,
  online = true,
  previewUrl,
  locked,
  addError,
  onAdd,
  onRemove,
  onRetry,
}: WasteMediaSectionProps) {
  const photoInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);
  const [removing, setRemoving] = useState<WasteMedia | null>(null);
  const photos = media.filter((m) => m.kind === 'photo').length;
  const videos = media.filter((m) => m.kind === 'video').length;
  const label = WASTE_PHASE_LABEL[phase];
  const shown = media.map((m) => ({ m, d: describeWasteMedia(m, { fraction: progressOf(m.id), bytes: bytesOf(m.id), online }) }));
  // The explanation of every file that is stuck or waiting (refused, unreadable, waiting to retry, paused) - never just a label.
  const notes = shown.filter(({ d }) => d.detail && (d.tone === 'bad' || d.tone === 'wait'));

  return (
    <section className="border-b border-divider px-4 py-3" data-testid={`waste-section-${phase}`}>
      <div className="mb-2 flex items-baseline justify-between font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
        {label}
        <span className="font-sans text-[11px] font-normal tracking-normal text-neutral-500 normal-case">
          {photos} photo{photos === 1 ? '' : 's'} · {videos} video{videos === 1 ? '' : 's'}
        </span>
      </div>

      {media.length > 0 && (
        <div className="mb-2 grid grid-cols-3 gap-2">
          {shown.map(({ m, d: status }) => {
            const still = m.kind === 'photo' ? m.blob : m.thumbnail;
            return (
              <div key={m.id} className="relative" data-testid="waste-media-tile">
                <div className="relative aspect-square overflow-hidden border border-neutral-300 bg-neutral-200">
                  {still ? (
                    <img src={previewUrl(still, m.id)} alt={`${label} ${m.kind}`} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[11px] text-neutral-500">Video</div>
                  )}
                  {m.kind === 'video' && (
                    <span className="absolute bottom-1 left-1 bg-near-black/70 px-1 text-[10px] text-white">
                      ▶ {formatDuration(m.durationSeconds) || 'video'}
                    </span>
                  )}
                  {!locked && (
                    <button
                      type="button"
                      onClick={() => setRemoving(m)}
                      aria-label={`Remove ${label.toLowerCase()} ${m.kind}`}
                      className="absolute top-0.5 right-0.5 flex h-7 w-7 cursor-pointer items-center justify-center bg-white/90 text-[15px] leading-none text-ink"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div
                  data-testid="waste-media-status"
                  className={`mt-0.5 truncate text-[10.5px] ${status.tone === 'ok' ? 'text-done-fg' : status.tone === 'bad' ? 'text-missed-fg' : status.tone === 'wait' ? 'text-due-fg' : 'text-neutral-500'}`}
                >
                  {status.label}
                </div>
                {status.canRetry && (
                  <button type="button" onClick={() => onRetry(m.id)} className="cursor-pointer text-[11px] text-teal underline">
                    Try again
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {notes.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {notes.map(({ m, d }) => (
            <li
              key={m.id}
              role={d.tone === 'bad' ? 'alert' : undefined}
              className={`border px-2 py-1 text-[11.5px] ${d.tone === 'bad' ? 'border-missed bg-missed/10 text-missed-fg' : 'border-due bg-due/10 text-due-fg'}`}
            >
              <span className="font-semibold">{m.kind === 'video' ? 'Video' : 'Photo'} {m.sortOrder + 1}:</span> {d.detail}
            </li>
          ))}
        </ul>
      )}

      {!locked && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => photoInput.current?.click()}
            disabled={photos >= WASTE_LIMITS.photosPerPhase}
            className="flex-1 cursor-pointer border border-dashed border-neutral-400 py-3 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Photo
          </button>
          <button
            type="button"
            onClick={() => videoInput.current?.click()}
            disabled={videos >= WASTE_LIMITS.videosPerPhase}
            className="flex-1 cursor-pointer border border-dashed border-neutral-400 py-3 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Video
          </button>
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-label={`Add ${label.toLowerCase()} photos`}
            onChange={(e) => {
              onAdd('photo', Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <input
            ref={videoInput}
            type="file"
            accept={VIDEO_ACCEPT}
            multiple
            hidden
            aria-label={`Add ${label.toLowerCase()} videos`}
            onChange={(e) => {
              onAdd('video', Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      )}
      {addError && (
        <p role="alert" className="mt-1.5 text-[12px] text-missed-fg">
          {addError}
        </p>
      )}

      {removing && (
        <WasteConfirmDialog
          ariaLabel={`Remove ${removing.kind}`}
          message={`Remove this ${removing.kind} from the report?`}
          confirmLabel="Remove"
          destructive
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            onRemove(removing.id);
            setRemoving(null);
          }}
        />
      )}
    </section>
  );
}
