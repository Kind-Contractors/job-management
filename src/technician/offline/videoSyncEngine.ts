// The background engine that turns the durable video queue (videoDb.ts) into "it eventually reaches the office" - for as long as the
// app is OPEN and online. There is no background upload once the app is closed (a web page cannot do that reliably, least of all on
// iOS): queued videos stay safely on the device and carry on the next time the app is opened.
//
// Separate from the photo/report engine (syncEngine.ts) on purpose, and independent of it in both directions:
//   * a report is submitted exactly as before - it never waits for, counts or even looks at a video (the "first report needs a photo"
//     rule is therefore untouched, and a pending or failed video cannot block "Complete job");
//   * a video can be added before the report exists, after it is submitted, or while it is returned for correction - whatever the
//     database allows (it refuses once the report is Completed or the visit cancelled, and says so).
//
// How a video travels (one at a time, oldest first):
//   1. its poster (a small JPEG) - if that fails the video goes ahead without one;
//   2. the video file, resumable (TUS) with the technician's own session; the upload URL is remembered, so a dropped connection or a
//      restart of the app continues from the last accepted chunk;
//   3. technician_attach_video records it against the visit. Safe to repeat: the same file attached again returns the same video.
//   Only then is the local copy (and its large Blob) deleted - the server's own list takes over.
//
// Retry safety:
//   * A record is only ever changed through updateVideoIfPresent: a removed video is never recreated by a late status update.
//   * If the technician removes a video while its upload or attach is in flight, the engine re-checks the record after the attach and,
//     if it is gone, removes the video it just created on the server (soft delete) - a stale retry can never restore a removed video.
//   * A refusal retrying cannot fix (cancelled visit, Completed report, a limit...) stops automatic retries and is shown; offline
//     failures are never counted; other failures back off (15 s ... 30 min) and stop after MAX_AUTO_ATTEMPTS for a manual retry.
//   * Records belong to the signed-in user; this engine only ever touches the current user's, re-checking before each network call.
import { useEffect, useState } from 'react';
import { getCurrentUserId, subscribeCurrentUser } from '../../auth/currentUser';
import { resumableEndpoint, resumableUpload, type ResumableUploader } from '../../lib/reportVideoUpload';
import { readVideoMetadata, type VideoMetadata } from '../../lib/videoMetadata';
import type { VideoPhase } from '../../lib/reportVideoRules';
import {
  attachVideo,
  currentTechnicianAccessToken,
  deleteMyVideo,
  newVideoPaths,
  removeUnattachedVideoObjects,
  uploadVideoThumbnail,
  type AttachVideoInput,
} from '../videoApi';
import {
  claimVideo,
  deleteVideo,
  getVideo,
  listAllVideos,
  listVideosForVisit,
  putVideo,
  updateVideoIfPresent,
  type QueuedVideo,
} from './videoDb';
import { MAX_AUTO_ATTEMPTS, backoffDelayMs, classifyVideoFailure, describeVideoFailure, sourceKeyOf, validateForQueue, type ServerVideoRef } from './videoQueueLogic';

const RETRY_INTERVAL_MS = 30_000;
const PROGRESS_NOTIFY_MS = 250;
/** How long a tab's claim on a video lasts without a heartbeat, and how often an upload in progress renews it. */
const LEASE_MS = 2 * 60_000;
const LEASE_RENEW_MS = 30_000;

/** Everything the engine reaches out to, so tests can replace the network and the clock. Production code never changes these. */
export interface VideoEngineDeps {
  isOnline: () => boolean;
  now: () => Date;
  uploader: ResumableUploader;
  getAccessToken: () => Promise<string>;
  uploadThumbnail: (path: string, blob: Blob) => Promise<void>;
  attach: (input: AttachVideoInput) => Promise<string>;
  deleteServerVideo: (videoId: string) => Promise<void>;
  removeObjects: (paths: string[]) => Promise<void>;
  endpoint: () => string;
  apiKey: () => string;
  readMetadata: (file: File) => Promise<VideoMetadata>;
}

const defaultDeps: VideoEngineDeps = {
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  now: () => new Date(),
  uploader: resumableUpload,
  getAccessToken: currentTechnicianAccessToken,
  uploadThumbnail: uploadVideoThumbnail,
  attach: attachVideo,
  deleteServerVideo: deleteMyVideo,
  removeObjects: removeUnattachedVideoObjects,
  endpoint: () => resumableEndpoint(import.meta.env.VITE_SUPABASE_URL as string),
  apiKey: () => import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  readMetadata: readVideoMetadata,
};
let deps: VideoEngineDeps = defaultDeps;

/** Test hook only. */
export function setVideoEngineDepsForTests(over: Partial<VideoEngineDeps> | null): void {
  deps = over ? { ...defaultDeps, ...over } : defaultDeps;
}

// ---- change notification ---------------------------------------------------------------------------------------------------

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}
/** Fires on every local queue change (status, progress, add, remove). Components re-read whatever they need. */
export function subscribeVideoQueue(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

const attachedListeners = new Set<(visitId: string) => void>();
/** Fires once per video the server has confirmed - the screen then re-reads the server's own list. */
export function subscribeVideoAttached(callback: (visitId: string) => void): () => void {
  attachedListeners.add(callback);
  return () => attachedListeners.delete(callback);
}

// ---- in-memory state -------------------------------------------------------------------------------------------------------

const progressById = new Map<string, number>();
const lastProgressNotify = new Map<string, number>();
const controllers = new Map<string, AbortController>();
const attempting = new Set<string>();
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let enqueueChain: Promise<unknown> = Promise.resolve();

/** 0..1 while this video's file is being sent, else null. */
export function getVideoProgress(id: string): number | null {
  return progressById.get(id) ?? null;
}

function requireCurrentUserId(): string {
  const id = getCurrentUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}
function isStillCurrentOwner(ownerId: string): boolean {
  return getCurrentUserId() === ownerId;
}

// ---- adding, removing, retrying ----------------------------------------------------------------------------------------------

/** Raised when a picked video is refused before it is queued; the message is a plain sentence for the technician. */
export class VideoRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoRejectedError';
  }
}

/**
 * Checks a picked video (type, size, length, the section and visit counts, duplicates), saves it on the device and starts uploading it.
 * Resolves as soon as it is SAVED locally - never waits for the network. `serverVideos` is the technician's own videos already
 * recorded for the visit (for the counts). Calls are serialised, so two quick picks can never both slip past a limit.
 */
export function enqueueVideo(visitId: string, phase: VideoPhase, file: File, meta: VideoMetadata, serverVideos: ServerVideoRef[]): Promise<QueuedVideo> {
  const run = async (): Promise<QueuedVideo> => {
    const ownerId = requireCurrentUserId();
    const queued = await listVideosForVisit(ownerId, visitId);
    const check = validateForQueue({ file, phase, durationSeconds: meta.durationSeconds, server: serverVideos, queued });
    if (!check.ok) throw new VideoRejectedError(check.message);
    const { videoPath, thumbPath } = newVideoPaths(visitId, phase, check.ext, !!meta.thumbnail);
    const video: QueuedVideo = {
      id: crypto.randomUUID(),
      ownerId,
      visitId,
      phase,
      blob: file,
      fileName: file.name,
      mime: check.mime,
      ext: check.ext,
      sizeBytes: file.size,
      sourceKey: sourceKeyOf(file),
      durationSeconds: meta.durationSeconds,
      thumbnail: meta.thumbnail,
      status: 'pending',
      videoPath,
      thumbPath,
      videoUploaded: false,
      thumbUploaded: false,
      tusUrl: null,
      lastError: null,
      permanentFailure: false,
      attempts: 0,
      nextAttemptAt: null,
      leaseUntil: null,
      createdAt: deps.now().toISOString(),
    };
    await putVideo(video);
    notify();
    void kickVideoQueue();
    return video;
  };
  const result = enqueueChain.then(run, run);
  enqueueChain = result.catch(() => undefined);
  return result;
}

/** The signed-in user's queued videos for one visit, oldest first. */
export async function getVisitQueuedVideos(visitId: string): Promise<QueuedVideo[]> {
  const ownerId = getCurrentUserId();
  return ownerId ? listVideosForVisit(ownerId, visitId) : [];
}

/**
 * Removes a video that is still queued (waiting, uploading, or failed) - the same action as cancelling an upload. The record is
 * deleted first: from that instant no retry, late status update or attach can bring it back (see the header). An upload in flight is
 * aborted, and files it had already stored are cleaned up on a best-effort basis.
 */
export async function removeQueuedVideo(video: QueuedVideo): Promise<void> {
  controllers.get(video.id)?.abort();
  await deleteVideo(video.id);
  progressById.delete(video.id);
  notify();
  const uploaded = [video.videoUploaded ? video.videoPath : null, video.thumbUploaded ? video.thumbPath : null].filter((p): p is string => !!p);
  if (uploaded.length > 0 && deps.isOnline()) void deps.removeObjects(uploaded);
}

/** "Tap to retry": starts again now, with a fresh attempt count. Keeps the resumable upload URL, so it continues where it stopped. */
export async function retryQueuedVideo(video: QueuedVideo): Promise<void> {
  const next = await updateVideoIfPresent(video.id, (v) => ({ ...v, status: 'pending', attempts: 0, nextAttemptAt: null, permanentFailure: false, lastError: null, leaseUntil: null }));
  if (!next) return;
  notify();
  void kickVideoQueue();
}

// ---- the loop ----------------------------------------------------------------------------------------------------------------------

type StepResult = 'continue' | 'stop';

let runPromise: Promise<void> | null = null;
let runAgain = false;

/**
 * Runs the queue until nothing is due. Safe to call from any trigger at any time: a call that arrives while a pass is running does
 * not start a second one, but makes the running pass look again before it ends (so a video added at the last moment is not left
 * waiting for the next 30 s tick). The returned promise settles when the pass has finished.
 */
export function kickVideoQueue(): Promise<void> {
  if (runPromise) {
    runAgain = true;
    return runPromise;
  }
  runPromise = (async () => {
    // Without this, a pass that has nothing to do (offline, empty queue) would finish and clear runPromise BEFORE it was assigned below,
    // leaving the queue looking permanently busy.
    await Promise.resolve();
    try {
      do {
        runAgain = false;
        for (;;) {
          const ownerId = getCurrentUserId();
          if (!ownerId || !deps.isOnline()) break;
          const nowIso = deps.now().toISOString();
          const next = (await listAllVideos(ownerId)).find(
            (v) => v.status !== 'failed' && !attempting.has(v.id) && (!v.nextAttemptAt || v.nextAttemptAt <= nowIso) && (!v.leaseUntil || v.leaseUntil <= nowIso),
          );
          if (!next) break;
          if ((await attemptVideo(ownerId, next.id)) === 'stop') break;
        }
      } while (runAgain);
    } finally {
      runPromise = null;
      void scheduleWake();
    }
  })();
  return runPromise;
}

/** Wakes the loop when the earliest backed-off video becomes due (the 30 s tick would also catch it; this is just prompt). */
async function scheduleWake(): Promise<void> {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  const due = (await listAllVideos(ownerId)).filter((v) => v.status === 'pending' && v.nextAttemptAt).map((v) => Date.parse(v.nextAttemptAt!));
  if (due.length === 0) return;
  const delay = Math.max(1000, Math.min(...due) - deps.now().getTime());
  wakeTimer = setTimeout(() => void kickVideoQueue(), delay);
  // A timer must never keep a process alive (tests, or a page being torn down).
  (wakeTimer as unknown as { unref?: () => void }).unref?.();
}

const lastLeaseRenew = new Map<string, number>();

function reportProgress(id: string, sent: number, total: number): void {
  const fraction = total > 0 ? Math.min(1, sent / total) : 0;
  progressById.set(id, fraction);
  const now = Date.now();
  if (now - (lastLeaseRenew.get(id) ?? now) >= LEASE_RENEW_MS || !lastLeaseRenew.has(id)) {
    lastLeaseRenew.set(id, now);
    void updateVideoIfPresent(id, (v) => ({ ...v, leaseUntil: new Date(deps.now().getTime() + LEASE_MS).toISOString() }));
  }
  if (fraction >= 1 || now - (lastProgressNotify.get(id) ?? 0) >= PROGRESS_NOTIFY_MS) {
    lastProgressNotify.set(id, now);
    notify();
  }
}

/** One attempt at one video. Never throws; every outcome is recorded on the record or ends it. */
async function attemptVideo(ownerId: string, id: string): Promise<StepResult> {
  const first = await getVideo(id);
  if (!first || first.ownerId !== ownerId || attempting.has(id)) return 'continue';
  attempting.add(id);
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    // Claim it (atomically): gone, or another tab is already working on it -> leave it.
    const claimNow = deps.now();
    let rec = await claimVideo(id, claimNow.toISOString(), new Date(claimNow.getTime() + LEASE_MS).toISOString());
    if (!rec) return 'continue';
    notify();

    // 1. the poster - optional: any failure just means no poster
    if (!rec.videoUploaded && rec.thumbnail && rec.thumbPath && !rec.thumbUploaded) {
      try {
        await deps.uploadThumbnail(rec.thumbPath, rec.thumbnail);
        rec = await updateVideoIfPresent(id, (v) => ({ ...v, thumbUploaded: true }));
        if (!rec) {
          void deps.removeObjects([first.thumbPath].filter((p): p is string => !!p));
          return 'continue';
        }
      } catch {
        rec = await updateVideoIfPresent(id, (v) => ({ ...v, thumbPath: null }));
        if (!rec) return 'continue';
      }
    }

    // 2. the file
    if (!rec.videoUploaded) {
      if (!isStillCurrentOwner(ownerId)) return 'stop';
      const current = rec;
      await deps.uploader({
        endpoint: deps.endpoint(),
        apiKey: deps.apiKey(),
        bucket: 'report-videos',
        objectName: current.videoPath,
        file: current.blob,
        contentType: current.mime,
        uploadUrl: current.tusUrl,
        getAccessToken: deps.getAccessToken,
        signal: controller.signal,
        onUploadUrl: (url) => void updateVideoIfPresent(id, (v) => ({ ...v, tusUrl: url })),
        onProgress: (sent, total) => reportProgress(id, sent, total),
      });
      rec = await updateVideoIfPresent(id, (v) => ({ ...v, videoUploaded: true, tusUrl: null }));
      if (!rec) {
        // removed while the last chunk was going up: nothing is attached, so the stored files are just leftovers
        void deps.removeObjects([current.videoPath, current.thumbUploaded ? current.thumbPath : null].filter((p): p is string => !!p));
        return 'continue';
      }
    }

    // 3. record it against the visit
    if (!isStillCurrentOwner(ownerId)) return 'stop';
    rec = await updateVideoIfPresent(id, (v) => ({ ...v, status: 'attaching' }));
    if (!rec) return 'continue';
    notify();
    const serverId = await deps.attach({
      visitId: rec.visitId,
      phase: rec.phase,
      videoPath: rec.videoPath,
      thumbnailPath: rec.thumbUploaded ? rec.thumbPath : null,
      mime: rec.mime,
      sizeBytes: rec.sizeBytes,
      durationSeconds: rec.durationSeconds,
    });

    // Removed while the attach was in flight? Then the video that now exists on the server must not stay: undo it.
    if (!(await getVideo(id))) {
      await deps.deleteServerVideo(serverId).catch(() => undefined);
      notifyAttached(rec.visitId);
      return 'continue';
    }
    await deleteVideo(id);
    progressById.delete(id);
    notify();
    notifyAttached(rec.visitId);
    return 'continue';
  } catch (err) {
    return await recordFailure(id, err);
  } finally {
    attempting.delete(id);
    controllers.delete(id);
    lastProgressNotify.delete(id);
    lastLeaseRenew.delete(id);
    if (!(await getVideo(id))) progressById.delete(id);
  }
}

function notifyAttached(visitId: string): void {
  for (const fn of attachedListeners) fn(visitId);
}

async function recordFailure(id: string, err: unknown): Promise<StepResult> {
  const kind = classifyVideoFailure(err, deps.isOnline());
  if (kind === 'cancelled') return 'continue';
  const message = describeVideoFailure(err);
  const nowMs = deps.now().getTime();
  let leftovers: string[] = [];

  const updated = await updateVideoIfPresent(id, (v) => {
    const restart = () => {
      // the old names may be half-used: new ones for the next upload, the old stored files cleaned up afterwards
      leftovers = [v.videoUploaded ? v.videoPath : null, v.thumbUploaded ? v.thumbPath : null].filter((p): p is string => !!p);
      const paths = newVideoPaths(v.visitId, v.phase, v.ext, !!v.thumbnail);
      return { videoPath: paths.videoPath, thumbPath: paths.thumbPath, videoUploaded: false, thumbUploaded: false, tusUrl: null };
    };
    const attempts = v.attempts + 1;
    const give = attempts >= MAX_AUTO_ATTEMPTS;
    switch (kind) {
      case 'offline':
        return { ...v, status: 'pending', lastError: null, leaseUntil: null };
      case 'permanent':
        return { ...v, status: 'failed', permanentFailure: true, lastError: message, tusUrl: null, leaseUntil: null };
      case 'reupload':
      case 'restart':
        return { ...v, ...restart(), attempts, status: give ? 'failed' : 'pending', nextAttemptAt: give ? null : new Date(nowMs + backoffDelayMs(attempts)).toISOString(), lastError: message, leaseUntil: null };
      default:
        return { ...v, attempts, status: give ? 'failed' : 'pending', nextAttemptAt: give ? null : new Date(nowMs + backoffDelayMs(attempts)).toISOString(), lastError: message, leaseUntil: null };
    }
  });
  notify();
  if (leftovers.length > 0 && deps.isOnline()) void deps.removeObjects(leftovers);
  if (!updated) return 'continue'; // removed meanwhile: nothing to record
  return kind === 'offline' ? 'stop' : 'continue';
}

// ---- starting it, and what the screens read ------------------------------------------------------------------------------------

let engineStarted = false;

/** Wires the retry triggers once for the life of the tab - call from TechnicianShell on mount. */
export function startVideoSyncEngine(): void {
  if (engineStarted) return;
  engineStarted = true;
  const resume = () => {
    void normaliseInterrupted().then(() => kickVideoQueue());
  };
  window.addEventListener('online', () => void kickVideoQueue());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void kickVideoQueue();
  });
  subscribeCurrentUser(resume);
  setInterval(() => void kickVideoQueue(), RETRY_INTERVAL_MS);
  resume();
}

/** A video left "uploading" or "attaching" by a closed tab or a crash is simply waiting again (its resumable URL is kept). */
export async function normaliseInterrupted(): Promise<void> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  for (const v of await listAllVideos(ownerId)) {
    const leaseActive = !!v.leaseUntil && v.leaseUntil > deps.now().toISOString();
    if ((v.status === 'uploading' || v.status === 'attaching') && !attempting.has(v.id) && !leaseActive) {
      await updateVideoIfPresent(v.id, (r) => ({ ...r, status: 'pending', leaseUntil: null }));
    }
  }
  notify();
}

export interface VideoSyncStatus {
  /** Videos on this device not yet recorded by the server (waiting or uploading). */
  pending: number;
  /** Videos that stopped and need the technician (failed or refused). */
  failed: number;
}

async function computeStatus(): Promise<VideoSyncStatus> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return { pending: 0, failed: 0 };
  const all = await listAllVideos(ownerId);
  return { pending: all.filter((v) => v.status !== 'failed').length, failed: all.filter((v) => v.status === 'failed').length };
}

/** For the header badge: counts only the signed-in user's own queued videos. */
export function useVideoSyncStatus(): VideoSyncStatus {
  const [status, setStatus] = useState<VideoSyncStatus>({ pending: 0, failed: 0 });
  // Syncs React state with the IndexedDB queue (an external store): re-counts on every queue change and when the signed-in user changes.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void computeStatus().then((next) => {
        if (!cancelled) setStatus(next);
      });
    };
    refresh();
    const a = subscribeVideoQueue(refresh);
    const b = subscribeCurrentUser(refresh);
    return () => {
      cancelled = true;
      a();
      b();
    };
  }, []);
  return status;
}

/** One visit's queued videos, kept current as the engine works. */
export function useVisitQueuedVideos(visitId: string | undefined): QueuedVideo[] {
  const [videos, setVideos] = useState<QueuedVideo[]>([]);
  // Same pattern as above, for one visit: re-reads that visit's queue whenever the engine reports a change.
  useEffect(() => {
    if (!visitId) return;
    let cancelled = false;
    const refresh = () => {
      void getVisitQueuedVideos(visitId).then((next) => {
        if (!cancelled) setVideos(next);
      });
    };
    refresh();
    const a = subscribeVideoQueue(refresh);
    const b = subscribeCurrentUser(refresh);
    return () => {
      cancelled = true;
      a();
      b();
    };
  }, [visitId]);
  return videos;
}
