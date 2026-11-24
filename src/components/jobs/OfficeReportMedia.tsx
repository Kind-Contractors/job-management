// The "Photos and videos" section of Complete & report (OfficeReportDialog): Before / During / After, each with the photos and videos
// chosen for it. Presentational only - the dialog owns the list, the checks and the uploading. Same controls as Report review's photo and
// video sections (preview, delete, "Include for client", "Move to…"), but for files that are not on the report yet: deleting one just
// takes it out of the selection, so there is no "are you sure" popup and nothing to undo on the server.
import { useEffect, useState } from 'react';
import { REPORT_VIDEO_LIMITS, VIDEO_ACCEPT, formatBytes, formatDuration } from '../../lib/reportVideoRules';
import { MEDIA_PHASES, MEDIA_PHASE_LABEL, type MediaPhase, type StagedMedia } from '../../lib/officeReportMedia';
import PhotoDeleteButton from '../../technician/PhotoDeleteButton';

export interface OfficeReportMediaProps {
  items: StagedMedia[];
  /** Videos already on the chosen visit (a technician's, for example): they count towards the limits and stay as they are. */
  existingVideoCount: number;
  /** False once the report is saved: only files that failed can still be changed or removed. */
  editable: boolean;
  /** A refusal for one section (wrong type, too large, section full...). */
  pickError: { phase: MediaPhase; message: string } | null;
  moveTargets: (item: StagedMedia) => MediaPhase[];
  onPickPhotos: (phase: MediaPhase, files: File[]) => void;
  onPickVideo: (phase: MediaPhase, file: File) => void;
  onRemove: (id: string) => void;
  onToggleInclude: (id: string, include: boolean) => void;
  onMove: (id: string, phase: MediaPhase) => void;
}

const kindLabel = (m: StagedMedia) => `${MEDIA_PHASE_LABEL[m.phase].toLowerCase()} ${m.kind}`;

function StatusLine({ item }: { item: StagedMedia }) {
  if (item.status === 'checking') return <div className="text-[10px] text-neutral-500">Checking…</div>;
  if (item.status === 'adding')
    return (
      <div role="status" className="text-[10px] text-neutral-600">
        {item.kind === 'video' && item.progress ? `Adding… ${Math.round(item.progress * 100)}%` : 'Adding…'}
      </div>
    );
  if (item.status === 'added') return <div className="text-[10px] font-semibold text-teal-700">✓ Added</div>;
  if (item.status === 'failed')
    return (
      <div role="alert" className="text-[10px] leading-snug text-missed-fg" data-testid="media-failed">
        {item.savedId ? '' : 'Not added. '}
        {item.error}
      </div>
    );
  return null;
}

/** One file. Controls are live only while it can still change: before saving, or after a failed attempt that left it off the report. */
function MediaTile({ item, editable, targets, onRemove, onToggleInclude, onMove }: {
  item: StagedMedia;
  editable: boolean;
  targets: MediaPhase[];
  onRemove: () => void;
  onToggleInclude: (v: boolean) => void;
  onMove: (p: MediaPhase) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  // The playable copy of a chosen video is a browser object URL: hand it back when the tile goes away (a real side effect, not state).
  useEffect(() => () => { if (localUrl) URL.revokeObjectURL(localUrl); }, [localUrl]);
  const changeable = item.status !== 'adding' && item.status !== 'added' && item.status !== 'checking' && (editable || item.status === 'failed');
  // Once a file is on the report only its "Include for client" step can still be retried - it is never moved or removed from here.
  const movable = changeable && !item.savedId;
  const isVideo = item.kind === 'video';
  return (
    <div className={`flex flex-col gap-0.5 ${isVideo ? 'w-full' : 'w-20'}`} data-testid={`staged-${item.kind}`}>
      <div className={`relative ${isVideo ? 'aspect-video w-full' : 'h-20 w-20'}`}>
        {isVideo ? (
          playing && localUrl ? (
            <video controls autoPlay playsInline src={localUrl} className="h-full w-full bg-black" aria-label={`${kindLabel(item)} preview`} />
          ) : (
            <button
              type="button"
              onClick={() => {
                setLocalUrl((u) => u ?? URL.createObjectURL(item.file));
                setPlaying(true);
              }}
              disabled={item.status === 'checking'}
              aria-label={`Play ${kindLabel(item)}`}
              className="group flex h-full w-full cursor-pointer items-center justify-center bg-ink disabled:cursor-wait"
            >
              {item.previewUrl && <img src={item.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
              <span className="relative flex h-8 w-8 items-center justify-center bg-black/60 text-white group-hover:bg-black/80">▶</span>
            </button>
          )
        ) : item.previewUrl ? (
          <img src={item.previewUrl} alt="" className={`h-20 w-20 border object-cover ${item.include ? 'border-neutral-300' : 'border-neutral-300 opacity-40'}`} />
        ) : (
          <div className="h-20 w-20 border border-neutral-300 bg-neutral-200" />
        )}
        {item.status === 'failed' && <div className="pointer-events-none absolute inset-0 border-2 border-missed" />}
        {movable && !isVideo && (
          <PhotoDeleteButton needsConfirm={false} ariaLabel={`Remove ${kindLabel(item)}`} onDelete={async () => onRemove()} onError={() => {}} />
        )}
      </div>
      {isVideo && (
        <div className="truncate text-[10px] text-neutral-600" title={item.file.name}>
          {[formatDuration(item.video?.durationSeconds ?? null), formatBytes(item.file.size)].filter(Boolean).join(' · ')}
        </div>
      )}
      <label className={`flex items-center gap-1 text-[10px] ${changeable ? 'cursor-pointer text-neutral-600' : 'cursor-not-allowed text-neutral-400'}`}>
        <input
          type="checkbox"
          checked={item.include}
          disabled={!changeable}
          onChange={(e) => onToggleInclude(e.target.checked)}
          aria-label={`Include ${kindLabel(item)} in the client report`}
          className="accent-teal"
        />
        Include for client
      </label>
      {movable && isVideo && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${kindLabel(item)}`} className="w-fit cursor-pointer text-[10.5px] text-missed-fg hover:underline">
          Remove
        </button>
      )}
      {movable && targets.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const to = e.target.value as MediaPhase | '';
            if (to) onMove(to);
          }}
          aria-label={`Move ${kindLabel(item)} to another section`}
          className="w-full cursor-pointer border border-neutral-300 bg-white px-1 py-0.5 text-[10px] text-neutral-700"
        >
          <option value="">Move to…</option>
          {targets.map((p) => (
            <option key={p} value={p}>
              {MEDIA_PHASE_LABEL[p]}
            </option>
          ))}
        </select>
      )}
      <StatusLine item={item} />
    </div>
  );
}

export default function OfficeReportMedia(p: OfficeReportMediaProps) {
  const videoTotal = p.existingVideoCount + p.items.filter((m) => m.kind === 'video').length;
  return (
    <div className="flex flex-col gap-2" data-testid="office-report-media">
      {p.existingVideoCount > 0 && (
        <div className="text-[11px] text-neutral-600">
          This visit already has {p.existingVideoCount} video{p.existingVideoCount === 1 ? '' : 's'}; they stay on it and count towards the limits.
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
        {MEDIA_PHASES.map((phase) => {
          const here = p.items.filter((m) => m.phase === phase);
          const photos = here.filter((m) => m.kind === 'photo');
          const videos = here.filter((m) => m.kind === 'video');
          return (
            <div key={phase} className="flex min-w-0 flex-col gap-1.5 border border-neutral-200 p-2" data-testid={`media-phase-${phase}`}>
              <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-600 uppercase">
                {MEDIA_PHASE_LABEL[phase]}
                <span className="ml-1 font-normal tracking-normal normal-case text-neutral-500">
                  · {photos.length} photo{photos.length === 1 ? '' : 's'} · {videos.length} video{videos.length === 1 ? '' : 's'}
                </span>
              </div>
              {photos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {photos.map((m) => (
                    <MediaTile
                      key={m.id}
                      item={m}
                      editable={p.editable}
                      targets={p.moveTargets(m)}
                      onRemove={() => p.onRemove(m.id)}
                      onToggleInclude={(v) => p.onToggleInclude(m.id, v)}
                      onMove={(to) => p.onMove(m.id, to)}
                    />
                  ))}
                </div>
              )}
              {videos.map((m) => (
                <MediaTile
                  key={m.id}
                  item={m}
                  editable={p.editable}
                  targets={p.moveTargets(m)}
                  onRemove={() => p.onRemove(m.id)}
                  onToggleInclude={(v) => p.onToggleInclude(m.id, v)}
                  onMove={(to) => p.onMove(m.id, to)}
                />
              ))}
              {here.length === 0 && <div className="text-[11px] text-neutral-400">None</div>}
              {p.pickError?.phase === phase && (
                <div role="alert" className="text-[11px] text-missed-fg">
                  {p.pickError.message}
                </div>
              )}
              {p.editable && (
                <div className="flex flex-wrap gap-1.5">
                  <label className="w-fit cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100 focus-within:border-teal">
                    + Photos
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="sr-only"
                      aria-label={`Add photos to the ${MEDIA_PHASE_LABEL[phase]} section`}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        e.target.value = ''; // picking the same file again must still fire a change
                        if (files.length) p.onPickPhotos(phase, files);
                      }}
                    />
                  </label>
                  <label className="w-fit cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100 focus-within:border-teal">
                    + Video
                    <input
                      type="file"
                      accept={VIDEO_ACCEPT}
                      className="sr-only"
                      aria-label={`Add a video to the ${MEDIA_PHASE_LABEL[phase]} section`}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) p.onPickVideo(phase, file);
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-[10.5px] text-neutral-500">
        Optional. Everything is shown to the client unless you untick it. Videos: MP4, MOV or WebM · up to {formatBytes(REPORT_VIDEO_LIMITS.maxBytes)} and{' '}
        {formatDuration(REPORT_VIDEO_LIMITS.maxSeconds)} each · {REPORT_VIDEO_LIMITS.maxPerPhase} per section, {REPORT_VIDEO_LIMITS.maxPerVisit} per report ({videoTotal} now).
        Files are added when you complete the report.
      </div>
    </div>
  );
}
