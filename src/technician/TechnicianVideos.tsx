// Videos on the technician's report screen: a "+ Video" action under each of Before / During / After, with the videos already with the
// office and the ones still on this device (waiting, uploading, failed). Everything the technician adds is saved on the device first and
// uploaded by the video engine (offline/videoSyncEngine.ts) - this screen never waits for the network, and nothing here is part of
// "Complete job": a video that is pending or has failed cannot stop a report being submitted.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { retryUnlessOffline } from './api';
import { technicianKeys } from './queryKeys';
import { deleteMyVideo, listMyVideos, signOwnVideoThumbs, signOwnVideoUrl, type TechnicianOwnVideo } from './videoApi';
import {
  VideoRejectedError,
  enqueueVideo,
  getVideoProgress,
  removeQueuedVideo,
  retryQueuedVideo,
  subscribeVideoAttached,
  subscribeVideoQueue,
  useVisitQueuedVideos,
} from './offline/videoSyncEngine';
import type { QueuedVideo } from './offline/videoDb';
import { countsForPhase, videoDisplay, type VideoDisplay } from './offline/videoQueueLogic';
import { useSyncStatus } from './offline/syncEngine';
import { readVideoMetadata } from '../lib/videoMetadata';
import ConfirmDeleteDialog from './ConfirmDeleteDialog';
import {
  REPORT_VIDEO_LIMITS,
  VIDEO_ACCEPT,
  VIDEO_PHASES,
  VIDEO_PHASE_LABEL,
  explainVideoError,
  formatBytes,
  formatDuration,
  type VideoPhase,
} from '../lib/reportVideoRules';

const TONE_STYLE: Record<VideoDisplay['tone'], string> = {
  waiting: 'border-neutral-400 text-neutral-600',
  working: 'border-due text-due-fg',
  bad: 'border-missed text-missed-fg',
};

// ---- presentational tiles ------------------------------------------------------------------------------------------------------

export interface QueuedVideoTileProps {
  video: QueuedVideo;
  display: VideoDisplay;
  /** 0..1 while the file is being sent. */
  progress: number | null;
  posterUrl: string | null;
  /** A local link to the picked file while it is open in the player. */
  playUrl: string | null;
  confirmingRemove: boolean;
  onPlay: () => void;
  onRetry: () => void;
  onAskRemove: () => void;
  onConfirmRemove: () => void;
  onKeep: () => void;
}

export function QueuedVideoTile(p: QueuedVideoTileProps) {
  const v = p.video;
  const uploading = v.status === 'uploading' && p.progress != null;
  return (
    <div className={`border bg-white ${TONE_STYLE[p.display.tone].split(' ')[0]}`} data-testid="queued-video">
      <div className="relative aspect-video w-full bg-ink">
        {p.playUrl ? (
          <video controls playsInline preload="metadata" src={p.playUrl} className="h-full w-full bg-black" aria-label={`${VIDEO_PHASE_LABEL[v.phase]} video`} />
        ) : (
          <button onClick={p.onPlay} aria-label={`Play ${VIDEO_PHASE_LABEL[v.phase]} video`} className="relative flex h-full w-full cursor-pointer items-center justify-center">
            {p.posterUrl && <img src={p.posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            <span className="relative flex h-7 w-7 items-center justify-center bg-black/60 text-[12px] text-white">▶</span>
          </button>
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-1 text-[9.5px] leading-tight">
        <div className="text-neutral-600 tabular-nums">{[formatDuration(v.durationSeconds), formatBytes(v.sizeBytes)].filter(Boolean).join(' · ')}</div>
        <div className={TONE_STYLE[p.display.tone].split(' ')[1]} aria-live="polite">
          {p.display.label}
        </div>
        {uploading && (
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((p.progress ?? 0) * 100)} className="h-1 w-full bg-neutral-200">
            <div className="h-full bg-teal" style={{ width: `${Math.round((p.progress ?? 0) * 100)}%` }} />
          </div>
        )}
        {v.lastError && v.status === 'failed' && (
          <div role="alert" className="text-missed-fg">
            {v.lastError}
          </div>
        )}
        <div className="flex gap-2">
          {p.display.retryable && (
            <button onClick={p.onRetry} className="cursor-pointer font-semibold text-teal-700 underline">
              Try again
            </button>
          )}
          <button onClick={p.onAskRemove} className="cursor-pointer text-missed-fg underline">
            {v.status === 'uploading' ? 'Cancel' : 'Delete'}
          </button>
        </div>
        {p.confirmingRemove && (
          <ConfirmDeleteDialog
            ariaLabel="Delete this video"
            message={
              v.status === 'uploading'
                ? 'Are you sure you want to cancel this upload and delete the video?'
                : 'Are you sure you want to delete this video? It has not reached the office yet, so it will be lost.'
            }
            busy={false}
            onCancel={p.onKeep}
            onConfirm={p.onConfirmRemove}
          />
        )}
      </div>
    </div>
  );
}

export interface ServerVideoTileProps {
  video: TechnicianOwnVideo;
  posterUrl: string | null;
  playUrl: string | null;
  playError: string | null;
  confirmingRemove: boolean;
  removePending: boolean;
  removeError: string | null;
  onPlay: () => void;
  onAskRemove: () => void;
  onConfirmRemove: () => void;
  onKeep: () => void;
}

export function ServerVideoTile(p: ServerVideoTileProps) {
  const v = p.video;
  return (
    <div className="border border-teal bg-white" data-testid="server-video">
      <div className="relative aspect-video w-full bg-ink">
        {p.playUrl ? (
          <video controls autoPlay playsInline preload="metadata" src={p.playUrl} className="h-full w-full bg-black" aria-label={`${VIDEO_PHASE_LABEL[v.phase]} video`} />
        ) : (
          <button onClick={p.onPlay} aria-label={`Play ${VIDEO_PHASE_LABEL[v.phase]} video`} className="relative flex h-full w-full cursor-pointer items-center justify-center">
            {p.posterUrl && <img src={p.posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            <span className="relative flex h-7 w-7 items-center justify-center bg-black/60 text-[12px] text-white">▶</span>
          </button>
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-1 text-[9.5px] leading-tight">
        <div className="text-neutral-600 tabular-nums">{[formatDuration(v.durationSeconds), formatBytes(v.sizeBytes)].filter(Boolean).join(' · ')}</div>
        <div className="text-teal-700">Uploaded · with the office</div>
        {p.playError && (
          <div role="alert" className="text-missed-fg">
            {p.playError}
          </div>
        )}
        {v.canDelete ? (
          <button onClick={p.onAskRemove} disabled={p.removePending} className="w-fit cursor-pointer text-missed-fg underline disabled:opacity-50">
            Delete
          </button>
        ) : (
          <div className="text-neutral-500">The office has approved this report</div>
        )}
        {p.confirmingRemove && v.canDelete && (
          <ConfirmDeleteDialog
            ariaLabel="Delete this video"
            message="Are you sure you want to delete this video?"
            busy={p.removePending}
            onCancel={p.onKeep}
            onConfirm={p.onConfirmRemove}
          />
        )}
        {p.removeError && (
          <div role="alert" className="text-missed-fg">
            {p.removeError}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- the section --------------------------------------------------------------------------------------------------------------------

export default function TechnicianVideos({ visitId, userId }: { visitId: string; userId: string }) {
  const queryClient = useQueryClient();
  const { online } = useSyncStatus();
  const queued = useVisitQueuedVideos(visitId);
  const [, forceRender] = useState(0);
  const [pickError, setPickError] = useState<{ phase: VideoPhase; message: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [playing, setPlaying] = useState<{ kind: 'server' | 'queued'; id: string; url: string } | null>(null);
  const [playError, setPlayError] = useState<{ id: string; message: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removePendingId, setRemovePendingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<{ id: string; message: string } | null>(null);
  const inputs = useRef<Record<VideoPhase, HTMLInputElement | null>>({ before: null, during: null, after: null });
  const addingRef = useRef(false);
  const posterUrls = useRef<Map<string, string>>(new Map());
  const playedLocalUrl = useRef<string | null>(null);

  const key = technicianKeys.myVideos(userId, visitId);
  const {
    data: serverVideos = [],
    isError: serverListFailed,
    refetch,
  } = useQuery({ queryKey: key, queryFn: () => listMyVideos(visitId), enabled: userId !== '', retry: retryUnlessOffline });
  const { data: serverPosters = {} } = useQuery({
    queryKey: [...key, 'posters', serverVideos.map((v) => v.id).join(',')],
    queryFn: () => signOwnVideoThumbs(serverVideos),
    enabled: online && serverVideos.some((v) => v.thumbnailPath),
    refetchInterval: 8 * 60 * 1000,
    meta: { persist: false },
  });

  // The engine reports a video the server has now recorded: re-read the server's own list so it appears there at once.
  useEffect(() => subscribeVideoAttached((id) => id === visitId && void queryClient.invalidateQueries({ queryKey: key })), [visitId, queryClient, userId]);
  // Progress changes are not stored in React state anywhere; re-render on engine notifications so the bars move.
  useEffect(() => subscribeVideoQueue(() => forceRender((n) => n + 1)), []);
  // Local links (posters, previews) are object URLs: free them when the screen goes away.
  useEffect(() => {
    const urls = posterUrls.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      if (playedLocalUrl.current) URL.revokeObjectURL(playedLocalUrl.current);
    };
  }, []);

  const localPoster = (v: QueuedVideo): string | null => {
    if (!v.thumbnail) return null;
    const existing = posterUrls.current.get(v.id);
    if (existing) return existing;
    const url = URL.createObjectURL(v.thumbnail);
    posterUrls.current.set(v.id, url);
    return url;
  };

  const handleFiles = async (phase: VideoPhase, files: FileList | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0 || addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    setPickError(null);
    try {
      for (const file of list) {
        try {
          const meta = await readVideoMetadata(file);
          await enqueueVideo(visitId, phase, file, meta, serverVideos);
        } catch (e) {
          setPickError({ phase, message: e instanceof VideoRejectedError ? e.message : explainVideoError(e) });
          break; // stop at the first refusal; the rest of the selection is not queued
        }
      }
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };

  const playServer = async (v: TechnicianOwnVideo) => {
    setPlayError(null);
    try {
      setPlaying({ kind: 'server', id: v.id, url: await signOwnVideoUrl(v.storagePath) });
    } catch (e) {
      setPlayError({ id: v.id, message: online ? explainVideoError(e) : 'Connect to the internet to watch this video.' });
    }
  };
  const playQueued = (v: QueuedVideo) => {
    if (playedLocalUrl.current) URL.revokeObjectURL(playedLocalUrl.current);
    const url = URL.createObjectURL(v.blob);
    playedLocalUrl.current = url;
    setPlaying({ kind: 'queued', id: v.id, url });
  };

  const removeServer = async (v: TechnicianOwnVideo) => {
    setRemovePendingId(v.id);
    setRemoveError(null);
    try {
      await deleteMyVideo(v.id);
      if (playing?.id === v.id) setPlaying(null);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      setRemoveError({ id: v.id, message: online ? explainVideoError(e) : 'You need to be online to remove a video that has already reached the office.' });
    } finally {
      setConfirmId(null); // close the popup either way; on a failure the message shows on the tile and the video stays
      setRemovePendingId(null);
    }
  };

  const total = serverVideos.length + queued.length;

  return (
    <div className="border-b border-divider px-4 py-3" data-testid="technician-videos">
      <div className="mb-1.5 flex items-center justify-between font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
        Videos (optional)
        <span className="text-neutral-400 normal-case">{total}</span>
      </div>
      {serverListFailed && (
        <div className="mb-2 text-[11px] text-neutral-600">
          {online ? "Couldn't load the videos already sent. " : 'Offline — videos already sent are not shown. '}
          <button onClick={() => void refetch()} className="cursor-pointer text-teal-700 underline">
            Try again
          </button>
        </div>
      )}
      <div className="grid grid-cols-3 items-start gap-2">
        {VIDEO_PHASES.map((phase) => {
          const phaseServer = serverVideos.filter((v) => v.phase === phase);
          const phaseQueued = queued.filter((v) => v.phase === phase);
          const counts = countsForPhase(phase, serverVideos, queued);
          const atPhaseLimit = counts.inPhase >= REPORT_VIDEO_LIMITS.maxPerPhase;
          const atVisitLimit = counts.inVisit >= REPORT_VIDEO_LIMITS.maxPerVisit;
          const hint = atPhaseLimit ? `At most ${REPORT_VIDEO_LIMITS.maxPerPhase} videos per section` : atVisitLimit ? `At most ${REPORT_VIDEO_LIMITS.maxPerVisit} videos per job` : undefined;
          return (
            <div key={phase} className="flex min-w-0 flex-col gap-1.5" data-testid={`tech-video-phase-${phase}`}>
              <div className="font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                {VIDEO_PHASE_LABEL[phase]} ({counts.inPhase})
              </div>
              {phaseServer.map((v) => (
                <ServerVideoTile
                  key={v.id}
                  video={v}
                  posterUrl={serverPosters[v.id] ?? null}
                  playUrl={playing?.kind === 'server' && playing.id === v.id ? playing.url : null}
                  playError={playError?.id === v.id ? playError.message : null}
                  confirmingRemove={confirmId === v.id}
                  removePending={removePendingId === v.id}
                  removeError={removeError?.id === v.id ? removeError.message : null}
                  onPlay={() => void playServer(v)}
                  onAskRemove={() => {
                    setRemoveError(null);
                    setConfirmId(v.id);
                  }}
                  onConfirmRemove={() => void removeServer(v)}
                  onKeep={() => setConfirmId(null)}
                />
              ))}
              {phaseQueued.map((v) => (
                <QueuedVideoTile
                  key={v.id}
                  video={v}
                  display={videoDisplay(v, online, getVideoProgress(v.id))}
                  progress={getVideoProgress(v.id)}
                  posterUrl={localPoster(v)}
                  playUrl={playing?.kind === 'queued' && playing.id === v.id ? playing.url : null}
                  confirmingRemove={confirmId === v.id}
                  onPlay={() => playQueued(v)}
                  onRetry={() => void retryQueuedVideo(v)}
                  onAskRemove={() => setConfirmId(v.id)}
                  onConfirmRemove={() => {
                    setConfirmId(null);
                    if (playing?.id === v.id) setPlaying(null);
                    void removeQueuedVideo(v);
                  }}
                  onKeep={() => setConfirmId(null)}
                />
              ))}
              {pickError?.phase === phase && (
                <div role="alert" className="text-[10.5px] leading-snug text-missed-fg">
                  {pickError.message}
                </div>
              )}
              <input
                ref={(el) => {
                  inputs.current[phase] = el;
                }}
                type="file"
                accept={VIDEO_ACCEPT}
                multiple
                hidden
                aria-label={`Choose videos for the ${VIDEO_PHASE_LABEL[phase]} section`}
                onChange={(e) => {
                  void handleFiles(phase, e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => inputs.current[phase]?.click()}
                disabled={adding || atPhaseLimit || atVisitLimit}
                title={hint}
                className="flex h-9 w-full cursor-pointer items-center justify-center border border-dashed border-neutral-400 text-[10.5px] text-neutral-600 hover:border-teal hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                + Video
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[10.5px] leading-snug text-neutral-500">
        MP4, MOV or WebM · up to {formatBytes(REPORT_VIDEO_LIMITS.maxBytes)} and {formatDuration(REPORT_VIDEO_LIMITS.maxSeconds)} each · {REPORT_VIDEO_LIMITS.maxPerPhase} per section.
        Videos are saved on this device and upload while the app is open and online; if you close the app they carry on next time you open it.
        A video never stops you completing the job, and does not replace the required photo.
      </div>
    </div>
  );
}
