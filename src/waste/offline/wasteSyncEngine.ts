// The waste reporter's upload-and-send engine: framework-free, driven by IndexedDB (./wasteDb.ts), so nothing is lost when the
// phone loses signal, the app is closed, or the page reloads.
//
//   add a photo/video  ->  queued on the phone at once  ->  uploaded (videos resumable)  ->  checked by the server (waste-media-check)
//   "Send report"      ->  draft locked  ->  sent with waste_submit_report() as soon as every file has passed its check
//
// ONE WORKER AT A TIME. Every trigger (a new file, "Send", coming back online, the app reopening, a 30 s timer) calls kick(). The
// worker flag is claimed synchronously - before anything is awaited - so two triggers can never run two workers, and a trigger that
// arrives while one runs just asks it for one more pass. Sending a report is therefore never attempted twice at the same time; and
// even if it were (another tab, a lost reply), the report id chosen on the phone makes the server return the existing report
// instead of creating a second one.
//
// A FILE THAT CAN STILL BE UPLOADED NEVER STOPS FOR GOOD. A dropped connection, a weak signal or the phone suspending the app is
// retried with growing pauses (at most 10 minutes apart) for as long as it takes; opening the app, coming back to it, coming back
// online and "Try now" retry at once. Only a file the server will never accept (wrong type, too big, rejected by its check) stops,
// and the report then says it needs attention and how to fix it. (Before: six failures in about 14 minutes stopped a file until an
// "online" event, which iOS rarely sends - so a report could sit on "Sending..." indefinitely.) A request that hangs without an
// answer (or, for a video, no progress) for 2 minutes is abandoned and retried, so it can't hold up every other file and report.
// That is not a time limit on an upload: a slow video that keeps making progress is never cut off.
import { useEffect, useState } from 'react';
import { getCurrentUserId } from '../../auth/currentUser';
import { preparePhotoForUpload } from '../../technician/offline/photoCompression';
import { readVideoMetadata, type VideoMetadata } from '../../lib/videoMetadata';
import { UploadCancelledError, UploadError } from '../../lib/reportVideoUpload';
import { UploadPausedError } from '../wasteTus';
import { otherReportHasWaitingVideo, pickNext, type UploadLane } from './wasteUploadScheduler';
import {
  checkUploadedFile,
  removeUnsubmittedFiles,
  submitWasteReport,
  uploadSmallFile,
  uploadVideoFile,
  WasteRpcError,
  type FileCheckOutcome,
  type SubmitWasteReportInput,
  type VideoUploadOptions,
} from '../wasteApi';
import {
  checkWastePick,
  checkWasteVideoLength,
  londonToday,
  photoExtFor,
  wasteMediaPath,
  wasteThumbPath,
  type WasteMediaKind,
  type WastePhase,
} from '../wasteRules';
import {
  deleteDraft,
  deleteMedia,
  getDraft,
  getMedia,
  listDrafts,
  listMediaForOwner,
  listMediaForReport,
  putDraft,
  putMedia,
  updateDraftIfPresent,
  updateMediaIfPresent,
  type WasteDraft,
  type WasteMedia,
} from './wasteDb';

/** Everything the engine reaches out to, so tests can replace the network and the clock. */
export interface WasteEngineDeps {
  isOnline: () => boolean;
  now: () => Date;
  newId: () => string;
  uploadSmallFile: (path: string, blob: Blob, contentType: string, signal?: AbortSignal) => Promise<void>;
  uploadVideoFile: (path: string, blob: Blob, contentType: string, options: VideoUploadOptions) => Promise<void>;
  checkUploadedFile: (path: string) => Promise<FileCheckOutcome>;
  removeFiles: (paths: string[]) => Promise<void>;
  submitReport: (input: SubmitWasteReportInput) => Promise<{ created: boolean }>;
  preparePhoto: (file: File) => Promise<{ blob: Blob; filename: string }>;
  readVideoMetadata: (file: File) => Promise<VideoMetadata>;
  /** How long a request may go without an answer (or progress) before it is stopped and retried. */
  stallMs: number;
  /** How long a video may upload before it gives its turn to another report's waiting video (at a confirmed chunk boundary). */
  videoTurnMs: number;
  /** Whether a saved file can still be read from the phone. */
  isReadable: (blob: Blob) => Promise<boolean>;
}

const defaultDeps: WasteEngineDeps = {
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  now: () => new Date(),
  newId: () => crypto.randomUUID(),
  uploadSmallFile,
  uploadVideoFile,
  checkUploadedFile,
  removeFiles: removeUnsubmittedFiles,
  submitReport: submitWasteReport,
  preparePhoto: preparePhotoForUpload,
  readVideoMetadata,
  stallMs: 120_000,
  videoTurnMs: 4 * 60_000,
  isReadable: (blob) => blobReadable(blob),
};
let deps: WasteEngineDeps = defaultDeps;

/** Test hook only. */
export function setWasteEngineDepsForTests(over: Partial<WasteEngineDeps> | null): void {
  deps = over ? { ...defaultDeps, ...over } : defaultDeps;
}

const RETRY_INTERVAL_MS = 30_000;
/** After this many failed attempts in a row the file's note says it keeps trying and to check the signal. */
const SLOW_RETRY_AFTER = 6;
/** Pauses between attempts; the last one repeats for as long as the file keeps failing. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 180_000, 600_000];


// ---- change notification -----------------------------------------------------------------------------------------------------
const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}
/** Fires on every local change (a file added/removed, a status or progress change, a report sent). */
export function subscribeWasteQueue(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

const sentListeners = new Set<(reportId: string) => void>();
/** Fires once when the server has confirmed a report (sent now, or found already sent). */
export function subscribeWasteReportSent(callback: (reportId: string) => void): () => void {
  sentListeners.add(callback);
  return () => sentListeners.delete(callback);
}

/** Upload progress lives in memory only (writing it to IndexedDB on every chunk would be wasteful). */
const progressById = new Map<string, number>();
export function uploadProgress(mediaId: string): number | null {
  return progressById.get(mediaId) ?? null;
}
/** A video's bytes sent so far (including the chunk in flight) and its size, while it uploads. */
const bytesById = new Map<string, { sent: number; total: number }>();
export function uploadBytes(mediaId: string): { sent: number; total: number } | null {
  return bytesById.get(mediaId) ?? null;
}

function requireOwner(): string {
  const ownerId = getCurrentUserId();
  if (!ownerId) throw new Error('You are not signed in.');
  return ownerId;
}

// ---- drafts ------------------------------------------------------------------------------------------------------------------

function emptyDraft(ownerId: string): WasteDraft {
  const today = londonToday(deps.now());
  const at = deps.now().toISOString();
  return {
    ownerId,
    reportId: deps.newId(),
    address: '',
    startDate: today,
    endDate: today,
    description: '',
    submitRequested: false,
    submitError: null,
    permanentFailure: false,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * The report being written now: `preferredReportId` when that draft is on this phone and not sent (the report he chose to open
 * again to fix it - never silently swapped for a newer one), otherwise the newest draft not yet sent, or a fresh one.
 */
export async function getOrCreateEditingDraft(preferredReportId?: string | null): Promise<WasteDraft> {
  const ownerId = requireOwner();
  const editing = (await listDrafts(ownerId)).filter((d) => !d.submitRequested);
  const preferred = preferredReportId ? editing.find((d) => d.reportId === preferredReportId) : undefined;
  if (preferred) return preferred;
  if (editing.length > 0) return editing[editing.length - 1];
  const draft = emptyDraft(ownerId);
  await putDraft(draft);
  notify();
  return draft;
}

/** "Start another report". A blank draft already open is reused rather than piling up empty ones. */
export async function startNewDraft(): Promise<WasteDraft> {
  return getOrCreateEditingDraft();
}

export async function getWasteDraft(reportId: string): Promise<WasteDraft | undefined> {
  const ownerId = getCurrentUserId();
  return ownerId ? getDraft(ownerId, reportId) : undefined;
}

export async function listWasteDrafts(): Promise<WasteDraft[]> {
  const ownerId = getCurrentUserId();
  return ownerId ? listDrafts(ownerId) : [];
}

export async function listWasteMedia(reportId: string): Promise<WasteMedia[]> {
  const ownerId = getCurrentUserId();
  return ownerId ? listMediaForReport(ownerId, reportId) : [];
}

/** Saves typing as it happens. Ignored once the report has been sent (it is locked). */
export async function updateWasteDraftFields(
  reportId: string,
  fields: Partial<Pick<WasteDraft, 'address' | 'startDate' | 'endDate' | 'description'>>,
): Promise<void> {
  const ownerId = requireOwner();
  const draft = await getDraft(ownerId, reportId);
  if (!draft || draft.submitRequested) return;
  await updateDraftIfPresent({ ...draft, ...fields, updatedAt: deps.now().toISOString() });
}

/** "Send report": locks the draft; the worker sends it once every file has passed its check. */
export async function requestWasteSubmit(reportId: string): Promise<void> {
  const ownerId = requireOwner();
  const draft = await getDraft(ownerId, reportId);
  if (!draft) throw new Error('This report is no longer on this phone.');
  await updateDraftIfPresent({ ...draft, submitRequested: true, submitError: null, permanentFailure: false, updatedAt: deps.now().toISOString() });
  notify();
  kick();
}

/** After a refusal that needs a change (a date, the address): unlock the draft so it can be edited and sent again. */
export async function editWasteDraftAgain(reportId: string): Promise<void> {
  const ownerId = requireOwner();
  const draft = await getDraft(ownerId, reportId);
  if (!draft) return;
  await updateDraftIfPresent({ ...draft, submitRequested: false, submitError: null, permanentFailure: false, updatedAt: deps.now().toISOString() });
  notify();
}

/** Try sending again after a refusal (e.g. once a rejected file has been removed). */
export async function retryWasteSubmit(reportId: string): Promise<void> {
  const ownerId = requireOwner();
  const draft = await getDraft(ownerId, reportId);
  if (!draft) return;
  await updateDraftIfPresent({ ...draft, submitError: null, permanentFailure: false, updatedAt: deps.now().toISOString() });
  notify();
  kick();
}

/** Throws the draft and its files away (only a draft that has not been confirmed by the server - a sent report is never touched). */
export async function discardWasteDraft(reportId: string): Promise<void> {
  const ownerId = requireOwner();
  const media = await listMediaForReport(ownerId, reportId);
  for (const m of media) controllers.get(m.id)?.abort(); // stop its uploads first
  for (const m of media) await deleteMedia(m.id);
  await deleteDraft(ownerId, reportId);
  notify();
  // Best effort: files already uploaded for it. The bucket refuses to remove anything a submitted report uses.
  const uploaded = media.flatMap((m) => [m.fileUploaded || m.status !== 'pending' ? m.storagePath : null, m.thumbPath]).filter((p): p is string => !!p);
  if (uploaded.length > 0 && deps.isOnline()) await deps.removeFiles(uploaded).catch(() => undefined);
}

// ---- files -------------------------------------------------------------------------------------------------------------------

export type AddMediaResult = { ok: true; media: WasteMedia } | { ok: false; message: string };

/** Adds a picked photo or video to a section: checked, prepared and saved on the phone at once; the upload starts in the background. */
export async function addWasteMedia(reportId: string, phase: WastePhase, kind: WasteMediaKind, file: File): Promise<AddMediaResult> {
  const ownerId = requireOwner();
  const draft = await getDraft(ownerId, reportId);
  if (!draft) return { ok: false, message: 'This report is no longer on this phone.' };
  if (draft.submitRequested) return { ok: false, message: 'This report has been sent, so it can’t be changed.' };

  const existing = await listMediaForReport(ownerId, reportId);
  const sourceKey = `${file.name}|${file.size}|${file.lastModified}`;
  if (existing.some((m) => m.sourceKey === sourceKey && m.phase === phase)) {
    return { ok: false, message: 'That file is already in this section.' };
  }
  const pick = checkWastePick(file, kind, phase, existing);
  if (!pick.ok) return pick;

  const id = deps.newId();
  let blob: Blob = file;
  let mime: string;
  let ext: string;
  let durationSeconds: number | null = null;
  let thumbnail: Blob | null = null;

  if (pick.kind === 'photo') {
    const prepared = await deps.preparePhoto(file);
    blob = prepared.blob;
    const photoExt = photoExtFor(blob.type || file.type);
    if (!photoExt) {
      return { ok: false, message: 'This photo’s format can’t be used. In the camera settings choose "Most Compatible" (JPEG), or take a screenshot of it.' };
    }
    mime = photoExt === 'jpg' ? 'image/jpeg' : 'image/png';
    ext = photoExt;
  } else {
    mime = pick.mime;
    ext = pick.ext;
    const meta = await deps.readVideoMetadata(file).catch(() => ({ durationSeconds: null, thumbnail: null }));
    const tooLong = checkWasteVideoLength(meta.durationSeconds);
    if (tooLong) return { ok: false, message: tooLong };
    durationSeconds = meta.durationSeconds;
    thumbnail = meta.thumbnail;
  }

  const media: WasteMedia = {
    id,
    ownerId,
    reportId,
    kind: pick.kind,
    phase,
    blob,
    fileName: file.name,
    mime,
    ext,
    sizeBytes: blob.size,
    sourceKey,
    durationSeconds,
    thumbnail,
    storagePath: wasteMediaPath(ownerId, reportId, phase, id, ext),
    thumbPath: thumbnail ? wasteThumbPath(ownerId, reportId, phase, id) : null,
    fileUploaded: false,
    thumbUploaded: false,
    tusUrl: null,
    status: 'pending',
    progress: 0,
    lastError: null,
    permanentFailure: false,
    attempts: 0,
    nextAttemptAt: null,
    sortOrder: existing.length,
    createdAt: deps.now().toISOString(),
  };
  await putMedia(media);
  notify();
  kick();
  return { ok: true, media };
}

/** Removes a file from a draft that has not been sent. An uploaded copy is removed from the server too (best effort). */
export async function removeWasteMedia(mediaId: string): Promise<void> {
  const ownerId = requireOwner();
  const media = await getMedia(mediaId);
  if (!media || media.ownerId !== ownerId) return;
  const draft = await getDraft(ownerId, media.reportId);
  if (draft?.submitRequested) throw new Error('This report has been sent, so its photos and videos can’t be changed.');
  controllers.get(mediaId)?.abort(); // stop its upload first
  await deleteMedia(mediaId);
  progressById.delete(mediaId);
  notify();
  const paths = [media.storagePath, media.thumbPath].filter((p): p is string => !!p);
  if (deps.isOnline()) await deps.removeFiles(paths).catch(() => undefined);
}

/** "Try again" on a file that is waiting to retry (or stopped on an older version of the app): it is tried at once. */
export async function retryWasteMedia(mediaId: string): Promise<void> {
  const media = await getMedia(mediaId);
  if (!media || media.permanentFailure || media.status === 'ready') return;
  await updateMediaIfPresent({ ...media, status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null });
  notify();
  kick();
}

/**
 * Tries every file that is waiting to retry at once (rather than at the end of its pause), optionally only one report's. Called when
 * the app opens, when it comes back to the screen, when the phone comes back online, and by "Try now". Files that stopped on an older
 * version of the app after too many attempts (status 'failed' but not refused by the server) are given a fresh start too - that is
 * how a phone left with stopped files recovers by itself. Files the server refused are left alone: they have to be removed.
 */
export async function retryWaitingUploads(reportId?: string): Promise<void> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  let changed = false;
  for (const m of await listMediaForOwner(ownerId)) {
    if (reportId && m.reportId !== reportId) continue;
    const waiting = m.status !== 'ready' && m.status !== 'failed' && m.nextAttemptAt != null;
    const stopped = m.status === 'failed' && !m.permanentFailure;
    if (!waiting && !stopped) continue;
    await updateMediaIfPresent(stopped ? { ...m, status: 'pending', attempts: 0, nextAttemptAt: null } : { ...m, nextAttemptAt: null });
    changed = true;
  }
  if (changed) notify();
  await kick();
}

// ---- the worker: two lanes and one sending pass -------------------------------------------------------------------------------
//
// PHOTO lane and VIDEO lane run side by side (which file each takes next: ./wasteUploadScheduler.ts). Photos come first; reports take
// turns; a video that has run for TURN_MS gives up its turn at a confirmed chunk boundary when another report's video is waiting.
//
// NO RACES BETWEEN THEM. JavaScript runs one step at a time; clashes could only happen across an `await`. So:
//   * each lane is ONE loop: started like the old worker (the flag is set before anything is awaited), a trigger while it runs only
//     asks it for another round - never a second loop;
//   * a file is CLAIMED (in `claimed`) in the same step it is picked, before any await, and the lanes take different kinds of file -
//     so no file is ever worked on twice at once. Across browser tabs a per-file lock (Web Locks, where the browser has them) does the
//     same; a tab that can't get the lock leaves that file alone;
//   * reports are sent by ONE sending pass only (same pattern as the lanes): the lanes just ask for one, and asks during a pass are
//     merged into one more round. A report is sent only when every file is 'ready' (uploaded AND checked); the phone forgets it only
//     after the server confirmed it; and the report id chosen on the phone makes the server return the existing report if it ever
//     arrives twice;
//   * each lane writes only the file it holds, through updateMediaIfPresent (a removed file is never brought back);
//   * removing a file (or discarding a draft) stops its upload first (its AbortController).

interface LaneState {
  running: boolean;
  again: boolean;
  done: Promise<void>;
  lastServedReport: string | null;
}
const lanes: Record<UploadLane, LaneState> = {
  photo: { running: false, again: false, done: Promise.resolve(), lastServedReport: null },
  video: { running: false, again: false, done: Promise.resolve(), lastServedReport: null },
};
/** Files being worked on now (claimed in the same step they are picked). */
const claimed = new Set<string>();
/** The running upload of each claimed file - aborted to pause it (stall) or when the file is removed. */
const controllers = new Map<string, AbortController>();
/** The owner's files as last read - lets a running video decide, between chunks, whether another report is waiting. */
let snapshot: WasteMedia[] = [];

let submitting = false;
let submitAgain = false;
let submitDone: Promise<void> = Promise.resolve();

/** Starts both lanes and a sending pass (each only if not already running; otherwise it is asked for one more round). */
export function kick(): Promise<void> {
  startLane('photo');
  startLane('video');
  requestSubmitPass();
  return waitForWasteWorker();
}

function startLane(lane: UploadLane): void {
  const state = lanes[lane];
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true; // claimed before anything is awaited
  state.done = (async () => {
    try {
      do {
        state.again = false;
        await runLane(lane);
      } while (state.again);
    } finally {
      state.running = false;
    }
  })();
}

/** True while either lane or a sending pass is working. Read-only - a new app version is never loaded meanwhile (lib/appUpdate.ts). */
export function isWasteWorkerBusy(): boolean {
  return lanes.photo.running || lanes.video.running || submitting;
}

/** Test hook (and app-update): resolves once both lanes and the sending pass are idle. */
export async function waitForWasteWorker(): Promise<void> {
  for (let i = 0; i < 1000 && isWasteWorkerBusy(); i++) {
    await Promise.all([lanes.photo.done, lanes.video.done, submitDone]);
  }
}

/** Runs `fn` only if no other tab of this app holds `name` (Web Locks); where the browser has no Web Locks it just runs. */
async function exclusively(name: string, fn: () => Promise<void>): Promise<void> {
  const locks = (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined) ?? undefined;
  if (!locks?.request) return fn();
  await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (lock) await fn();
  });
}

const MAX_ITEMS_PER_ROUND = 500; // a safety net only: every item leaves the queue or waits out a pause

async function runLane(lane: UploadLane): Promise<void> {
  const state = lanes[lane];
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  for (let i = 0; i < MAX_ITEMS_PER_ROUND; i++) {
    if (!deps.isOnline() || getCurrentUserId() !== ownerId) return;
    const [media, drafts] = await Promise.all([listMediaForOwner(ownerId), listDrafts(ownerId)]);
    snapshot = media;
    const next = pickNext(lane, media, drafts.map((d) => d.reportId), state.lastServedReport, deps.now().getTime(), claimed);
    if (!next) return;
    claimed.add(next.id); // same step as the pick: the other lane, and the next pick, can't take it
    state.lastServedReport = next.reportId;
    try {
      await exclusively(`kc-waste-media-${next.id}`, () => processMedia(next, lane));
    } finally {
      claimed.delete(next.id);
      controllers.delete(next.id);
    }
    requestSubmitPass();
    if (lane === 'photo') startLane('video'); // a video may start once no photo is waiting
  }
}

function requestSubmitPass(): void {
  if (submitting) {
    submitAgain = true;
    return;
  }
  submitting = true; // claimed before anything is awaited
  submitDone = (async () => {
    try {
      do {
        submitAgain = false;
        await submitPassOnce();
      } while (submitAgain);
    } finally {
      submitting = false;
    }
  })();
}

async function submitPassOnce(): Promise<void> {
  if (!deps.isOnline()) return;
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  for (const draft of await listDrafts(ownerId)) {
    if (getCurrentUserId() !== ownerId) return;
    if (draft.submitRequested && !draft.permanentFailure) await exclusively(`kc-waste-submit-${draft.reportId}`, () => submitDraft(draft));
  }
}

function backoffIso(attempts: number): string {
  return new Date(deps.now().getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]).toISOString();
}

/** A failure that a later attempt can fix: the file stays queued and is tried again after a pause - it never stops for good. */
async function transientFailure(m: WasteMedia, message: string, patch: Partial<WasteMedia> = {}): Promise<void> {
  const attempts = m.attempts + 1;
  progressById.delete(m.id);
  await updateMediaIfPresent({
    ...m,
    ...patch,
    status: 'pending',
    pausedForTurn: false,
    attempts,
    lastError: attempts >= SLOW_RETRY_AFTER ? `Not uploaded yet after ${attempts} tries - it keeps trying by itself. Check the phone has signal.` : message,
    lastErrorAt: deps.now().toISOString(),
    nextAttemptAt: backoffIso(attempts),
  });
  notify();
}

class StalledError extends Error {}

/**
 * Settles with `work`, or - once deps.stallMs (2 minutes) pass with no answer and no sign of life (`touch`, called on progress,
 * restarts the wait) - STOPS it (aborts `controller`: the request is really cancelled, a video stays resumable on the server) and
 * rejects with StalledError. So an abandoned request never keeps using the connection beside the retry. Should a cancelled photo have
 * reached the server after all, the retry gets a 409 and the server check decides (C1).
 */
function withStallGuard<T>(controller: AbortController, work: (touch: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        reject(new StalledError('stalled'));
        controller.abort();
      }, deps.stallMs);
    };
    arm();
    work(arm, controller.signal).then(
      (v) => {
        clearTimeout(timer);
        if (!stalled) resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!stalled) reject(err);
      },
    );
  });
}

async function permanentFailure(m: WasteMedia, message: string, failureKind: 'refused' | 'unreadable' = 'refused'): Promise<void> {
  progressById.delete(m.id);
  await updateMediaIfPresent({ ...m, status: 'failed', permanentFailure: true, failureKind, pausedForTurn: false, lastError: message, lastErrorAt: deps.now().toISOString(), nextAttemptAt: null });
  notify();
}

export const UNREADABLE_MESSAGE = 'This file can’t be read from your phone. Remove it and add it again.';

/** True when the saved file can still be read from the phone's storage (its first and last byte). */
export async function blobReadable(blob: Blob | null | undefined): Promise<boolean> {
  try {
    if (!blob || blob.size === 0) return false;
    await blob.slice(0, 1).arrayBuffer();
    if (blob.size > 1) await blob.slice(blob.size - 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

function uploadStatus(err: unknown): number | null {
  if (err instanceof UploadError) return err.status;
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

async function processMedia(start: WasteMedia, lane: UploadLane): Promise<void> {
  // A file the phone can no longer read can never upload: say so, instead of retrying it as if the network had failed.
  if (!(await deps.isReadable(start.blob))) return permanentFailure(start, UNREADABLE_MESSAGE, 'unreadable');

  let m: WasteMedia = { ...start, status: 'uploading', pausedForTurn: false };
  if (!(await updateMediaIfPresent(m))) return;
  notify();
  const controller = new AbortController();
  controllers.set(m.id, controller);

  // 1. The poster (optional: a poster that can't be stored is simply dropped).
  if (m.thumbPath && m.thumbnail && !m.thumbUploaded) {
    try {
      const thumbPath = m.thumbPath;
      const thumbnail = m.thumbnail;
      await withStallGuard(controller, (_touch, signal) => deps.uploadSmallFile(thumbPath, thumbnail, 'image/jpeg', signal));
      m = { ...m, thumbUploaded: true };
    } catch (err) {
      const status = uploadStatus(err);
      if (status === 400 || status === 413 || status === 415) m = { ...m, thumbPath: null, thumbnail: null };
      else if (err instanceof StalledError) return transientFailure(m, 'The connection stopped responding. It will carry on by itself.');
      else return transientFailure(m, 'The upload was interrupted. It will carry on by itself.');
    }
  }

  // 2. The file itself. `current` carries the resumable-upload URL as soon as the server gives it, so a failure keeps it.
  // `foundExisting`: the server said a file already exists under this name (HTTP 409) - most likely THIS file, uploaded by an
  // earlier attempt whose finish was never recorded (the app was closed at that moment). That is NOT taken as proof: the file goes
  // to the server check below, and only counts as uploaded if it passes AND is exactly this file's size.
  let foundExisting = false;
  if (!m.fileUploaded) {
    let current = m;
    const turnStartedAt = deps.now().getTime();
    try {
      if (m.kind === 'video') {
        await withStallGuard(controller, (touch, signal) =>
          deps.uploadVideoFile(m.storagePath, m.blob, m.mime, {
            tusUrl: m.tusUrl,
            signal,
            onUploadUrl: (url) => {
              touch();
              current = { ...current, tusUrl: url };
              void updateMediaIfPresent(current);
            },
            onProgress: (sent, total) => {
              touch();
              progressById.set(m.id, total > 0 ? sent / total : 0);
              bytesById.set(m.id, { sent, total });
              notify();
            },
            onChunkComplete: (accepted) => {
              touch();
              current = { ...current, bytesConfirmed: accepted };
              void updateMediaIfPresent(current);
            },
            // Only after its turn, and only if another report's video is waiting - never interrupts a video for nothing.
            pauseAtChunkBoundary: () =>
              lane === 'video' &&
              deps.now().getTime() - turnStartedAt >= deps.videoTurnMs &&
              otherReportHasWaitingVideo(snapshot, m.reportId, deps.now().getTime(), claimed),
          }),
        );
        m = { ...current, fileUploaded: true, tusUrl: null };
      } else {
        await withStallGuard(controller, (_touch, signal) => deps.uploadSmallFile(m.storagePath, m.blob, m.mime, signal));
        m = { ...m, fileUploaded: true };
      }
    } catch (err) {
      if (err instanceof UploadPausedError && err.reason === 'turn') {
        // Its turn is over, not a failure: it carries on from the server's confirmed offset when its report's turn comes round.
        progressById.delete(m.id);
        bytesById.delete(m.id);
        await updateMediaIfPresent({ ...current, status: 'pending', pausedForTurn: true, nextAttemptAt: null });
        notify();
        return;
      }
      if (err instanceof StalledError) return transientFailure(current, 'The connection stopped responding. It will carry on by itself.');
      if (err instanceof UploadPausedError || err instanceof UploadCancelledError || (err as { name?: string } | null)?.name === 'AbortError') {
        return transientFailure(current, 'The upload was stopped.');
      }
      const status = uploadStatus(err);
      if (status === 413) return permanentFailure(current, 'That file is larger than the 150 MB limit.');
      if (status === 415) return permanentFailure(current, 'That file type isn’t accepted.');
      // Not "never": an expired sign-in also answers 401/403 and signing in again fixes it, so the file keeps trying.
      if (status === 401 || status === 403) return transientFailure(current, 'The upload wasn’t allowed just now. If this keeps happening, sign out and back in.');
      if (status === 409) {
        foundExisting = true;
        m = { ...current, fileUploaded: true, tusUrl: null };
      } else if (status === 404 || status === 410) {
        // A resumable upload the server no longer knows: start it again from the beginning.
        return transientFailure(current, 'The upload had to start again.', { tusUrl: null, bytesConfirmed: 0 });
      } else {
        // No answer from the server: the network - unless the phone can no longer read the file, which no retry can fix.
        if (status == null && !(await deps.isReadable(current.blob))) return permanentFailure(current, UNREADABLE_MESSAGE, 'unreadable');
        return transientFailure(current, 'The upload was interrupted. It will carry on by itself.');
      }
    }
  }
  progressById.delete(m.id);
  bytesById.delete(m.id);
  m = { ...m, status: 'checking' };
  if (!(await updateMediaIfPresent(m))) return;
  notify();

  // 3. The server checks what was stored (type, size, a video's real length).
  if (m.thumbPath && m.thumbUploaded) {
    const thumbPath = m.thumbPath;
    const thumb = await withStallGuard(controller, () => deps.checkUploadedFile(thumbPath)).catch(() => ({ result: 'retry', message: 'No connection.' }) as FileCheckOutcome);
    if (thumb.result === 'retry') return transientFailure(m, 'Waiting to check the file. It will carry on by itself.');
    if (thumb.result !== 'ok') m = { ...m, thumbPath: null, thumbnail: null, thumbUploaded: false };
  }
  const storagePath = m.storagePath;
  const outcome = await withStallGuard(controller, () => deps.checkUploadedFile(storagePath)).catch(() => ({ result: 'retry', message: 'No connection.' }) as FileCheckOutcome);
  // The stored file must be exactly this file. A different size means an incomplete or different copy under this name: it is
  // removed (his own unsent file - best effort) and this file is uploaded again under a fresh name, which can't collide with it.
  const wrongCopy = outcome.result === 'ok' && outcome.sizeBytes != null && outcome.sizeBytes !== m.sizeBytes;
  // A found copy the server rejects was not necessarily this file (the server has already removed it): upload this one under a
  // fresh name and let it be checked on its own merits - if it is itself invalid, that check rejects it for good.
  if (wrongCopy || (foundExisting && outcome.result === 'rejected')) {
    if (wrongCopy && deps.isOnline()) await deps.removeFiles([m.storagePath]).catch(() => undefined);
    return transientFailure(m, 'An earlier, incomplete copy was found. The file is being uploaded again.', {
      fileUploaded: false,
      tusUrl: null,
      bytesConfirmed: 0,
      storagePath: wasteMediaPath(m.ownerId, m.reportId, m.phase, deps.newId(), m.ext),
    });
  }
  if (outcome.result === 'ok') {
    await updateMediaIfPresent({
      ...m,
      status: 'ready',
      durationSeconds: outcome.durationSeconds ?? m.durationSeconds,
      lastError: null,
      lastErrorAt: null,
      attempts: 0,
      nextAttemptAt: null,
      bytesConfirmed: m.sizeBytes,
    });
    notify();
    return;
  }
  if (outcome.result === 'rejected') return permanentFailure(m, outcome.reason);
  if (outcome.result === 'missing') return transientFailure(m, 'The file has to be uploaded again.', { fileUploaded: false, tusUrl: null, bytesConfirmed: 0 });
  return transientFailure(m, 'Waiting to check the file. It will carry on by itself.');
}

/** A refusal retrying can never fix (the database said no on purpose), as opposed to a dropped connection or a busy server. */
function isPermanentSubmitError(err: unknown): boolean {
  if (!(err instanceof WasteRpcError) || !err.code) return false;
  return !['08', '40', '53', '54', '55', '57', '58'].includes(err.code.slice(0, 2));
}

async function submitDraft(draft: WasteDraft): Promise<void> {
  const media = await listMediaForReport(draft.ownerId, draft.reportId);
  if (media.some((m) => m.status === 'failed' && m.permanentFailure)) {
    const message = 'A photo or video can’t be sent. Remove it, then send the report again.';
    if (draft.submitError !== message) {
      await updateDraftIfPresent({ ...draft, submitError: message });
      notify();
    }
    return;
  }
  // Never with a file still missing: every file must have been uploaded AND passed the server check.
  if (media.some((m) => m.status !== 'ready')) return;

  try {
    await deps.submitReport({
      reportId: draft.reportId,
      address: draft.address.trim(),
      startDate: draft.startDate,
      endDate: draft.endDate,
      description: draft.description,
      media: media.map((m, i) => ({
        id: m.id,
        kind: m.kind,
        phase: m.phase,
        storagePath: m.storagePath,
        thumbnailPath: m.thumbPath && m.thumbUploaded ? m.thumbPath : null,
        sortOrder: i,
      })),
    });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'The report could not be sent.';
    if (isPermanentSubmitError(err)) {
      await updateDraftIfPresent({ ...draft, submitError: message, permanentFailure: true });
    } else {
      await updateDraftIfPresent({ ...draft, submitError: 'No connection to the server. It will be sent by itself.' });
    }
    notify();
    return;
  }

  // Confirmed by the server: only now is anything removed from the phone.
  for (const m of media) {
    await deleteMedia(m.id);
    progressById.delete(m.id);
    bytesById.delete(m.id);
  }
  await deleteDraft(draft.ownerId, draft.reportId);
  notify();
  for (const fn of sentListeners) fn(draft.reportId);
}

// ---- triggers & status -------------------------------------------------------------------------------------------------------

let started = false;
/** Wires the retry triggers once for the life of the tab - called by WasteShell on mount. */
export function startWasteSyncEngine(): void {
  if (started) return;
  started = true;
  // Coming back online, or back to the app (iOS suspends a page in the background and rarely sends "online"), retries at once.
  window.addEventListener('online', () => void retryWaitingUploads());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void retryWaitingUploads();
  });
  window.addEventListener('pageshow', () => void retryWaitingUploads());
  setInterval(() => void kick(), RETRY_INTERVAL_MS);
  void recoverAfterRestart().then(() => retryWaitingUploads());
}

/**
 * A new page can't have an upload running: a file left 'uploading' or 'checking' (the app was closed, reloaded or killed in the
 * middle) goes back to waiting, so it never shows a stale "Uploading…". A video keeps its resumable upload URL and carries on from
 * the server's confirmed offset. Called once when the engine starts.
 */
export async function recoverAfterRestart(): Promise<void> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  let changed = false;
  for (const m of await listMediaForOwner(ownerId)) {
    if (claimed.has(m.id)) continue;
    if (m.status === 'uploading' || m.status === 'checking' || m.pausedForTurn) {
      await updateMediaIfPresent({ ...m, status: 'pending', pausedForTurn: false });
      changed = true;
    }
  }
  if (changed) notify();
}

/** How one report's files are getting on - one rule for the sending screen and "My reports". */
export interface WasteUploadSummary {
  total: number;
  ready: number;
  /** Waiting to retry after a failed attempt (it keeps trying by itself). */
  retrying: number;
  /** Refused for good by the server: he has to remove them (the report can't be sent with them). */
  needsAttention: number;
  /** The plain-words reasons for those, without repeats. */
  reasons: string[];
}

export function summarizeWasteUploads(media: WasteMedia[]): WasteUploadSummary {
  const refused = media.filter((m) => m.status === 'failed' && m.permanentFailure);
  return {
    total: media.length,
    ready: media.filter((m) => m.status === 'ready').length,
    // A file left 'failed' (not refused) by an older version of the app is retried when this one starts, so it counts as retrying.
    retrying: media.filter((m) => (m.status === 'failed' && !m.permanentFailure) || (m.status !== 'ready' && m.status !== 'failed' && m.lastError != null)).length,
    needsAttention: refused.length,
    reasons: [...new Set(refused.map((m) => m.lastError ?? 'The file was not accepted.'))],
  };
}

export interface WasteSyncStatus {
  online: boolean;
  /** Files still to upload or check. */
  uploading: number;
  /** Files the server refused for good (they have to be removed). */
  failed: number;
  /** Reports sent from this phone but not yet confirmed by the server. */
  waitingReports: number;
  /** Of those, reports the server refused. */
  refusedReports: number;
}

async function computeStatus(): Promise<WasteSyncStatus> {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const ownerId = getCurrentUserId();
  if (!ownerId) return { online, uploading: 0, failed: 0, waitingReports: 0, refusedReports: 0 };
  const [media, drafts] = await Promise.all([listMediaForOwner(ownerId), listDrafts(ownerId)]);
  const waiting = drafts.filter((d) => d.submitRequested);
  return {
    online,
    uploading: media.filter((m) => m.status !== 'ready' && !(m.status === 'failed' && m.permanentFailure)).length,
    failed: media.filter((m) => m.status === 'failed' && m.permanentFailure).length,
    waitingReports: waiting.length,
    refusedReports: waiting.filter((d) => d.permanentFailure).length,
  };
}

export function useWasteSyncStatus(): WasteSyncStatus {
  const [status, setStatus] = useState<WasteSyncStatus>({ online: true, uploading: 0, failed: 0, waitingReports: 0, refusedReports: 0 });
  // Subscribes to the engine (an external store) and to the browser's online/offline events.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void computeStatus().then((s) => {
        if (!cancelled) setStatus(s);
      });
    };
    refresh();
    const unsubscribe = subscribeWasteQueue(refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);
  return status;
}
