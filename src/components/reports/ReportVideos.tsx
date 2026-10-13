// Videos in Report review: one column per section (Before / During / After), each with its videos and an "Add video" button.
// Every video is included for the client by default; the manager unticks the ones the client should not see.
//
// What a manager can do here, and what the database allows (the database is the authority - this only reflects it):
//   * add a video (resumable upload, with progress; cancel; try again) - not on a Completed report;
//   * play it (a short-lived signed link made only when Play is pressed; the browser streams it with Range requests);
//   * tick / untick "Include for client" per video - not on a Completed report;
//   * remove a video (soft delete: its client links stop working, the file is kept) - allowed on a Completed report too.
// Orchestration (uploading, mutations, which video is playing / being removed) lives in ReportVideos; the pieces below it are
// presentational so they can be rendered and checked on their own.
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  VIDEO_ACCEPT,
  VIDEO_PHASES,
  VIDEO_PHASE_LABEL,
  REPORT_VIDEO_LIMITS,
  explainVideoError,
  formatBytes,
  formatDuration,
  type VideoPhase,
} from '../../lib/reportVideoRules';
import { readVideoMetadata } from '../../lib/videoMetadata';
import { VideoUploadController, type UploadState } from '../../lib/videoUploadController';
import {
  listVideosForVisit,
  removeReportVideo,
  setVideoClientInclusion,
  signVideoPlaybackUrl,
  signVideoThumbnailUrls,
  uploadReportVideo,
  type ReportVideo,
} from '../../repository/reportVideosRepository';

// ---- presentational pieces --------------------------------------------------------------------

export function UploadProgress({
  upload,
  onCancel,
  onRetry,
  onDismiss,
}: {
  upload: UploadState;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const percent = Math.round(upload.progress * 100);
  const label =
    upload.stage === 'reading' ? 'Checking the video…' : upload.stage === 'saving' ? 'Saving…' : upload.stage === 'uploading' ? `Uploading… ${percent}%` : 'Upload failed';
  return (
    <div className={`border p-2 text-[11.5px] ${upload.stage === 'failed' ? 'border-missed bg-missed/10' : 'border-neutral-300 bg-neutral-50'}`}>
      <div className="truncate font-semibold text-ink" title={upload.fileName}>
        {upload.fileName} <span className="font-normal text-neutral-500">· {formatBytes(upload.fileSize)}</span>
      </div>
      {upload.stage === 'failed' ? (
        <>
          <div role="alert" className="mt-1 text-missed-fg">
            {upload.error}
          </div>
          <div className="mt-1.5 flex gap-1.5">
            {upload.retryable !== false && (
              <button onClick={onRetry} className="cursor-pointer bg-teal px-2 py-0.5 text-[11px] font-semibold text-white">
                Try again
              </button>
            )}
            <button onClick={onDismiss} className="cursor-pointer border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700">
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-1 text-neutral-600" aria-live="polite">
            {label}
          </div>
          {upload.stage === 'uploading' && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="mt-1 h-1.5 w-full bg-neutral-200"
            >
              <div className="h-full bg-teal" style={{ width: `${percent}%` }} />
            </div>
          )}
          {upload.stage !== 'saving' && (
            <button onClick={onCancel} className="mt-1.5 cursor-pointer border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700">
              Cancel
            </button>
          )}
        </>
      )}
    </div>
  );
}

export interface VideoCardProps {
  video: ReportVideo;
  posterUrl: string | null;
  /** Set while this video is open in the player. */
  playUrl: string | null;
  playError: string | null;
  playLoading: boolean;
  /** False on a Completed report: the inclusion tick is read-only (removing is still allowed). */
  canChange: boolean;
  includePending: boolean;
  confirmingRemove: boolean;
  removePending: boolean;
  removeError: string | null;
  addedAfterApproval: boolean;
  /** False where "Include for client" makes no sense (a visit that has no report yet). Defaults to true. */
  showInclude?: boolean;
  onPlay: () => void;
  onPlayFailed: () => void;
  onToggleInclude: (included: boolean) => void;
  onAskRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}

export function VideoCard(p: VideoCardProps) {
  const v = p.video;
  const meta = [formatDuration(v.durationSeconds), formatBytes(v.sizeBytes)].filter(Boolean).join(' · ');
  return (
    <div className="border border-neutral-300 bg-white" data-testid="video-card">
      <div className="relative aspect-video w-full bg-ink">
        {p.playUrl ? (
          <video
            controls
            autoPlay
            playsInline
            preload="metadata"
            src={p.playUrl}
            poster={p.posterUrl ?? undefined}
            onError={p.onPlayFailed}
            className="h-full w-full bg-black"
            aria-label={`${VIDEO_PHASE_LABEL[v.phase]} video`}
          />
        ) : (
          <button
            onClick={p.onPlay}
            disabled={p.playLoading}
            aria-label={`Play ${VIDEO_PHASE_LABEL[v.phase]} video`}
            className="group flex h-full w-full cursor-pointer items-center justify-center disabled:cursor-wait"
          >
            {p.posterUrl && <img src={p.posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            <span className="relative flex h-9 w-9 items-center justify-center bg-black/60 text-white group-hover:bg-black/80">
              {p.playLoading ? '…' : '▶'}
            </span>
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1 p-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-1.5 text-neutral-600">
          <span className="tabular-nums">{meta}</span>
          <span>· {v.source === 'technician' ? (v.uploadedByName ?? 'Technician') : 'Added by the office'}</span>
          {p.addedAfterApproval && <span className="border border-due px-1 text-[10px] text-due-fg">Added after approval</span>}
        </div>
        {p.playError && (
          <div role="alert" className="text-missed-fg">
            {p.playError}{' '}
            <button onClick={p.onPlay} className="cursor-pointer text-teal-700 underline">
              Reload
            </button>
          </div>
        )}
        {p.showInclude !== false && (
          <label className={`flex items-center gap-1.5 ${p.canChange ? 'cursor-pointer' : 'cursor-not-allowed text-neutral-500'}`}>
            <input
              type="checkbox"
              checked={v.includeInClientReport}
              disabled={!p.canChange || p.includePending}
              onChange={(e) => p.onToggleInclude(e.target.checked)}
              className="accent-teal"
            />
            Include for client
          </label>
        )}
        {p.confirmingRemove ? (
          <div role="alertdialog" aria-label="Confirm removing this video" className="border border-due bg-due/10 p-1.5 text-due-fg">
            Remove this video? The client will no longer be able to open it and any links already sent stop working. The file is kept.
            <div className="mt-1 flex gap-1.5">
              <button
                onClick={p.onConfirmRemove}
                disabled={p.removePending}
                className="cursor-pointer bg-missed px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50"
              >
                {p.removePending ? 'Removing…' : 'Remove video'}
              </button>
              <button onClick={p.onCancelRemove} disabled={p.removePending} className="cursor-pointer border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700">
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button onClick={p.onAskRemove} className="w-fit cursor-pointer text-[11px] text-missed-fg hover:underline">
            Remove
          </button>
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

// ---- the section --------------------------------------------------------------------------------

/**
 * Where the videos are shown:
 *  - 'review'   Report review: add, play, include, remove.
 *  - 'client'   Ready for client: play, include, remove - no uploading (that belongs to review).
 *  - 'noReport' a visit that has videos but no report yet (so no inclusion choices and no report switch): play and remove only.
 */
export type ReportVideosMode = 'review' | 'client' | 'noReport';

export interface ReportVideosProps {
  /** Null for a visit that has no report yet (mode 'noReport'). Videos belong to the visit, so the list itself does not need it. */
  reportId: string | null;
  visitId: string;
  reviewStatus: 'awaiting_review' | 'approved' | 'returned_for_correction' | null;
  reviewedAt: string | null;
  /** Completed reports refuse new videos and inclusion changes (a video can still be removed). */
  completed: boolean;
  actor: string;
  mode?: ReportVideosMode;
}

export default function ReportVideos({ visitId, reviewStatus, reviewedAt, completed, actor, mode = 'review' }: ReportVideosProps) {
  const queryClient = useQueryClient();
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [pickError, setPickError] = useState<{ phase: VideoPhase; message: string } | null>(null);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [playLoadingId, setPlayLoadingId] = useState<string | null>(null);
  const [playError, setPlayError] = useState<{ id: string; message: string } | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const inputs = useRef<Record<VideoPhase, HTMLInputElement | null>>({ before: null, during: null, after: null });

  const videosKey = ['reportVideos', visitId];
  const { data: videos = [], isLoading, isError, error, refetch } = useQuery({ queryKey: videosKey, queryFn: () => listVideosForVisit(visitId) });
  // Short-lived signed links: kept in memory only (never written to the persisted cache) and re-made before they expire.
  const { data: posters = {} } = useQuery({
    queryKey: ['reportVideoPosters', visitId, videos.map((v) => v.id).join(',')],
    queryFn: () => signVideoThumbnailUrls(videos),
    enabled: videos.some((v) => v.thumbnailPath),
    refetchInterval: 8 * 60 * 1000,
    meta: { persist: false },
  });

  const refreshVideos = () => {
    // The list of visits that have videos but no report (and its nav count) reads the same videos.
    void queryClient.invalidateQueries({ queryKey: ['videosWithoutReport'] });
    return queryClient.invalidateQueries({ queryKey: videosKey });
  };

  const includeMutation = useMutation({
    mutationFn: ({ id, included }: { id: string; included: boolean }) => setVideoClientInclusion(id, included),
    onSuccess: () => {
      setRowError(null);
      void refreshVideos();
    },
    onError: (e, { id }) => setRowError({ id, message: explainVideoError(e) }),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => removeReportVideo(id, actor),
    onSuccess: (_d, id) => {
      setConfirmRemoveId(null);
      setRowError(null);
      if (playing?.id === id) setPlaying(null);
      void refreshVideos();
    },
    onError: (e, id) => setRowError({ id, message: explainVideoError(e) }),
  });

  // One controller per mounted report (ReportPanel remounts this per report): it owns the "one upload at a time" rule, the checks,
  // retry and cancel. It always reads the latest list and report state through `latest`.
  const latest = useRef({ videos, completed });
  latest.current = { videos, completed };
  const controller = useRef<VideoUploadController | null>(null);
  if (controller.current === null) {
    controller.current = new VideoUploadController({
      visitId,
      context: () => latest.current,
      readMetadata: readVideoMetadata,
      upload: (input) => uploadReportVideo(input),
      onState: setUpload,
      onPickError: (phase, message) => setPickError(message ? { phase, message } : null),
      onUploaded: () => {
        void queryClient.invalidateQueries({ queryKey: ['reportVideos', visitId] });
        void queryClient.invalidateQueries({ queryKey: ['videosWithoutReport'] });
      },
    });
  }

  const onPick = (phase: VideoPhase, files: FileList | null) => {
    const file = files?.[0];
    const input = inputs.current[phase];
    if (input) input.value = ''; // picking the same file again must still fire a change
    if (file) void controller.current!.start(file, phase);
  };

  const play = async (video: ReportVideo) => {
    setPlayError(null);
    setPlayLoadingId(video.id);
    try {
      setPlaying({ id: video.id, url: await signVideoPlaybackUrl(video.storagePath) });
    } catch (e) {
      setPlayError({ id: video.id, message: explainVideoError(e) });
    } finally {
      setPlayLoadingId(null);
    }
  };

  const total = videos.length;

  return (
    <div className="flex flex-col gap-2" data-testid="report-videos">
      {completed && mode === 'review' && (
        <div className="text-[11px] text-neutral-500">
          This report is Completed, so videos can’t be added and the “Include” choices can’t be changed. A video can still be removed.
        </div>
      )}
      {completed && mode === 'client' && (
        <div className="text-[11px] text-neutral-500">
          This report is Completed, so the “Include” choices can’t be changed (Reopen it first). A video can still be removed.
        </div>
      )}

      {isLoading ? (
        <div className="text-[11.5px] text-neutral-500">Loading videos…</div>
      ) : isError ? (
        <div role="alert" className="text-[11.5px] text-missed-fg">
          Couldn’t load videos: {error instanceof Error ? error.message : 'something went wrong.'}{' '}
          <button onClick={() => void refetch()} className="cursor-pointer text-teal-700 underline">
            Try again
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-3 items-start gap-3">
          {VIDEO_PHASES.map((phase) => {
            const phaseVideos = videos.filter((v) => v.phase === phase);
            const uploadingHere = upload?.phase === phase;
            const atPhaseLimit = phaseVideos.length >= REPORT_VIDEO_LIMITS.maxPerPhase;
            const atVisitLimit = total >= REPORT_VIDEO_LIMITS.maxPerVisit;
            const addDisabled = completed || upload !== null || atPhaseLimit || atVisitLimit;
            const addHint = completed
              ? 'This report is Completed'
              : atPhaseLimit
                ? `At most ${REPORT_VIDEO_LIMITS.maxPerPhase} videos per section`
                : atVisitLimit
                  ? `At most ${REPORT_VIDEO_LIMITS.maxPerVisit} videos per report`
                  : upload
                    ? 'Another upload is in progress'
                    : undefined;
            return (
              <div key={phase} className="flex min-w-0 flex-col gap-1.5" data-testid={`video-phase-${phase}`}>
                <div className="font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                  {VIDEO_PHASE_LABEL[phase]} ({phaseVideos.length}/{REPORT_VIDEO_LIMITS.maxPerPhase})
                </div>
                {phaseVideos.map((v) => (
                  <VideoCard
                    key={v.id}
                    video={v}
                    posterUrl={posters[v.id] || null}
                    playUrl={playing?.id === v.id ? playing.url : null}
                    playError={playError?.id === v.id ? playError.message : null}
                    playLoading={playLoadingId === v.id}
                    canChange={!completed}
                    showInclude={mode !== 'noReport'}
                    includePending={includeMutation.isPending && includeMutation.variables?.id === v.id}
                    confirmingRemove={confirmRemoveId === v.id}
                    removePending={removeMutation.isPending && removeMutation.variables === v.id}
                    removeError={rowError?.id === v.id ? rowError.message : null}
                    addedAfterApproval={reviewStatus === 'approved' && reviewedAt != null && v.createdAt > reviewedAt}
                    onPlay={() => void play(v)}
                    onPlayFailed={() => {
                      setPlaying(null);
                      setPlayError({ id: v.id, message: 'This video couldn’t be played here (the link may have expired, or this browser can’t play this format).' });
                    }}
                    onToggleInclude={(included) => includeMutation.mutate({ id: v.id, included })}
                    onAskRemove={() => {
                      setRowError(null);
                      setConfirmRemoveId(v.id);
                    }}
                    onConfirmRemove={() => removeMutation.mutate(v.id)}
                    onCancelRemove={() => setConfirmRemoveId(null)}
                  />
                ))}
                {mode !== 'review' && phaseVideos.length === 0 && <div className="text-[11px] text-neutral-400">None</div>}
                {mode === 'review' && uploadingHere && (
                  <UploadProgress
                    upload={upload!}
                    onCancel={() => controller.current!.cancel()}
                    onRetry={() => void controller.current!.retry()}
                    onDismiss={() => controller.current!.dismiss()}
                  />
                )}
                {mode === 'review' && pickError?.phase === phase && (
                  <div role="alert" className="text-[11px] text-missed-fg">
                    {pickError.message}
                  </div>
                )}
                {mode === 'review' && (
                  <>
                    <input
                      ref={(el) => {
                        inputs.current[phase] = el;
                      }}
                      type="file"
                      accept={VIDEO_ACCEPT}
                      className="hidden"
                      aria-label={`Choose a video for the ${VIDEO_PHASE_LABEL[phase]} section`}
                      onChange={(e) => onPick(phase, e.target.files)}
                    />
                    <button
                      onClick={() => inputs.current[phase]?.click()}
                      disabled={addDisabled}
                      title={addHint}
                      className="w-fit cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      + Add video
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {mode === 'review' && (
        <div className="text-[10.5px] text-neutral-500">
          MP4, MOV or WebM · up to {formatBytes(REPORT_VIDEO_LIMITS.maxBytes)} and {formatDuration(REPORT_VIDEO_LIMITS.maxSeconds)} each · {REPORT_VIDEO_LIMITS.maxPerPhase} per section, {REPORT_VIDEO_LIMITS.maxPerVisit} per report.
          Videos are shown to the client unless you untick them.
        </div>
      )}
      {mode === 'client' && (
        <div className="text-[10.5px] text-neutral-500" data-testid="videos-in-report-note">
          Each ticked video appears in the client report as a thumbnail with a “Watch video” link. Untick a video to keep it from the client.
        </div>
      )}
    </div>
  );
}
