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
  uploadSmallFile: (path: string, blob: Blob, contentType: string) => Promise<void>;
  uploadVideoFile: (path: string, blob: Blob, contentType: string, options: VideoUploadOptions) => Promise<void>;
  checkUploadedFile: (path: string) => Promise<FileCheckOutcome>;
  removeFiles: (paths: string[]) => Promise<void>;
  submitReport: (input: SubmitWasteReportInput) => Promise<{ created: boolean }>;
  preparePhoto: (file: File) => Promise<{ blob: Blob; filename: string }>;
  readVideoMetadata: (file: File) => Promise<VideoMetadata>;
  /** How long a request may go without an answer (or progress) before it is abandoned and retried. */
  stallMs: number;
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

// ---- the worker --------------------------------------------------------------------------------------------------------------

let running = false;
let again = false;
let idle: Promise<void> = Promise.resolve();

/** Starts a worker pass, or - if one is running - asks it for one more pass. Never two at once. */
export function kick(): Promise<void> {
  if (running) {
    again = true;
    return idle;
  }
  running = true; // claimed before anything is awaited
  idle = (async () => {
    try {
      do {
        again = false;
        await workOnce();
      } while (again);
    } finally {
      running = false;
    }
  })();
  return idle;
}

/** True while a worker pass is running (files being uploaded, checked or a report sent). Read-only - used so a new app version is
 * never loaded in the middle of an upload (src/lib/appUpdate.ts). */
export function isWasteWorkerBusy(): boolean {
  return running;
}

/** Test hook: resolves when the current worker (if any) has finished. */
export function waitForWasteWorker(): Promise<void> {
  return idle;
}

async function workOnce(): Promise<void> {
  if (!deps.isOnline()) return;
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  const now = deps.now().getTime();

  const media = (await listMediaForOwner(ownerId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const m of media) {
    if (getCurrentUserId() !== ownerId) return;
    if (m.status === 'ready' || m.status === 'failed') continue;
    if (m.nextAttemptAt && Date.parse(m.nextAttemptAt) > now) continue;
    await processMedia(m);
  }

  for (const draft of await listDrafts(ownerId)) {
    if (getCurrentUserId() !== ownerId) return;
    if (draft.submitRequested && !draft.permanentFailure) await submitDraft(draft);
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
    attempts,
    lastError: attempts >= SLOW_RETRY_AFTER ? `Not uploaded yet after ${attempts} tries - it keeps trying by itself. Check the phone has signal.` : message,
    nextAttemptAt: backoffIso(attempts),
  });
  notify();
}

class StalledError extends Error {}

/**
 * Settles with `work`, or rejects with StalledError once deps.stallMs (2 minutes) pass with no answer and no sign of life (`touch`, called on
 * progress, restarts the wait). The abandoned request may still finish later; the next attempt then finds the file (409) and the
 * server check decides whether it is complete (see processMedia), so nothing is counted twice or counted unchecked.
 */
function withStallGuard<T>(work: (touch: () => void) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(new StalledError('stalled')), deps.stallMs);
    };
    arm();
    work(arm).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function permanentFailure(m: WasteMedia, message: string): Promise<void> {
  progressById.delete(m.id);
  await updateMediaIfPresent({ ...m, status: 'failed', permanentFailure: true, lastError: message, nextAttemptAt: null });
  notify();
}

function uploadStatus(err: unknown): number | null {
  if (err instanceof UploadError) return err.status;
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

async function processMedia(start: WasteMedia): Promise<void> {
  let m: WasteMedia = { ...start, status: 'uploading' };
  if (!(await updateMediaIfPresent(m))) return;
  notify();

  // 1. The poster (optional: a poster that can't be stored is simply dropped).
  if (m.thumbPath && m.thumbnail && !m.thumbUploaded) {
    try {
      const thumbPath = m.thumbPath;
      const thumbnail = m.thumbnail;
      await withStallGuard(() => deps.uploadSmallFile(thumbPath, thumbnail, 'image/jpeg'));
      m = { ...m, thumbUploaded: true };
    } catch (err) {
      const status = uploadStatus(err);
      if (status === 400 || status === 413 || status === 415) m = { ...m, thumbPath: null, thumbnail: null };
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
    try {
      if (m.kind === 'video') {
        await withStallGuard((touch) =>
          deps.uploadVideoFile(m.storagePath, m.blob, m.mime, {
            tusUrl: m.tusUrl,
            onUploadUrl: (url) => {
              touch();
              current = { ...current, tusUrl: url };
              void updateMediaIfPresent(current);
            },
            onProgress: (fraction) => {
              touch();
              progressById.set(m.id, fraction);
              notify();
            },
          }),
        );
        m = { ...current, fileUploaded: true, tusUrl: null };
      } else {
        await withStallGuard(() => deps.uploadSmallFile(m.storagePath, m.blob, m.mime));
        m = { ...m, fileUploaded: true };
      }
    } catch (err) {
      if (err instanceof UploadCancelledError) return transientFailure(current, 'The upload was stopped.');
      if (err instanceof StalledError) return transientFailure(current, 'The connection stopped responding. It will carry on by itself.');
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
        return transientFailure(current, 'The upload had to start again.', { tusUrl: null });
      } else {
        return transientFailure(current, 'The upload was interrupted. It will carry on by itself.');
      }
    }
  }
  progressById.delete(m.id);
  m = { ...m, status: 'checking' };
  if (!(await updateMediaIfPresent(m))) return;
  notify();

  // 3. The server checks what was stored (type, size, a video's real length).
  if (m.thumbPath && m.thumbUploaded) {
    const thumbPath = m.thumbPath;
    const thumb = await withStallGuard(() => deps.checkUploadedFile(thumbPath)).catch(() => ({ result: 'retry', message: 'No connection.' }) as FileCheckOutcome);
    if (thumb.result === 'retry') return transientFailure(m, 'Waiting to check the file. It will carry on by itself.');
    if (thumb.result !== 'ok') m = { ...m, thumbPath: null, thumbnail: null, thumbUploaded: false };
  }
  const storagePath = m.storagePath;
  const outcome = await withStallGuard(() => deps.checkUploadedFile(storagePath)).catch(() => ({ result: 'retry', message: 'No connection.' }) as FileCheckOutcome);
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
      storagePath: wasteMediaPath(m.ownerId, m.reportId, m.phase, deps.newId(), m.ext),
    });
  }
  if (outcome.result === 'ok') {
    await updateMediaIfPresent({
      ...m,
      status: 'ready',
      durationSeconds: outcome.durationSeconds ?? m.durationSeconds,
      lastError: null,
      attempts: 0,
      nextAttemptAt: null,
    });
    notify();
    return;
  }
  if (outcome.result === 'rejected') return permanentFailure(m, outcome.reason);
  if (outcome.result === 'missing') return transientFailure(m, 'The file has to be uploaded again.', { fileUploaded: false, tusUrl: null });
  return transientFailure(m, 'Waiting to check the file. It will carry on by itself.');
}

/** A refusal retrying can never fix (the database said no on purpose), as opposed to a dropped connection or a busy server. */
function isPermanentSubmitError(err: unknown): boolean {
  if (!(err instanceof WasteRpcError) || !err.code) return false;
  return !['08', '40', '53', '54', '55', '57', '58'].includes(err.code.slice(0, 2));
}

async function submitDraft(draft: WasteDraft): Promise<void> {
  const media = await listMediaForReport(draft.ownerId, draft.reportId);
  if (media.some((m) => m.status === 'failed')) {
    const message = 'A photo or video wasn’t accepted. Remove it, then send the report again.';
    if (draft.submitError !== message) {
      await updateDraftIfPresent({ ...draft, submitError: message });
      notify();
    }
    return;
  }
  if (media.some((m) => m.status !== 'ready')) return; // still uploading or checking

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
  void retryWaitingUploads();
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
