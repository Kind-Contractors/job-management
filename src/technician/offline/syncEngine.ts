// The background sync engine — the piece that turns the durable IndexedDB
// queue (offline/db.ts) into "it just eventually reaches the office."
// Nothing in here talks to Supabase except through the EXISTING,
// unchanged repository functions (submitReport/resubmitReport/
// uploadVisitPhotoToPath) — this module only decides WHEN to call them
// and keeps retrying safely until it succeeds.
//
// Idempotency, the central design constraint:
// - Each photo's storage path is generated ONCE, at capture time (see
//   enqueuePhoto), and reused on every retry; a retry that finds a file
//   already there checks that file's SIZE against the photo - a complete
//   copy counts as uploaded, an incomplete one is replaced under a fresh
//   path (the photo's status record carries the new path), so a photo is
//   never counted twice and never counted as uploaded on existence alone.
// - The photo itself is written to IndexedDB once (db.ts): every status
//   change below writes only the photo's separate status record.
// - Every network step of a photo upload has a time limit; a request that
//   hangs is abandoned and its queue place freed (see withTimeLimit).
// - A draft's `submitting` flag is an in-flight guard: two retry triggers
//   firing close together (e.g. the 'online' event and the 30s tick) can
//   never both start a submit RPC call for the same visit.
// - The submit RPC itself is only ever called once per draft — the draft
//   and its photos are deleted from IndexedDB immediately after a
//   successful call, so nothing is left for a later trigger to resubmit.
//   technician_submit_report()/technician_resubmit_report()'s own
//   server-side constraints (reports.visit_id, review_status checks) are
//   an additional backstop, not the primary guard.
// - A photo is NEVER deleted just because an upload attempt failed — only
//   after the owning report has been positively confirmed submitted by
//   the server.
//
// Ownership: every queued draft/photo belongs to one authenticated user
// (see db.ts). This engine only ever lists, uploads and submits records
// whose ownerId is the CURRENT user (auth/currentUser.ts) — so another
// user's queued work, and its failure state, is invisible here — and
// re-checks that the current user is still the record's owner immediately
// before each network call, so a user switch mid-retry can't send one
// user's work under another user's session. Signing out, or in as someone
// else, never deletes anyone's queued work; it is simply left untouched
// until its owner is signed in again.

import { useEffect, useState } from 'react';
import { getCurrentUserId, subscribeCurrentUser } from '../../auth/currentUser';
import {
  countUnattributedRecords,
  deleteDraft,
  deletePhoto,
  deletePhotosForVisit,
  getDraft as getDraftForOwner,
  getPhoto,
  listAllDrafts,
  listPhotosForVisit,
  listReadyDraftVisitIds,
  listUnuploadedPhotos,
  putDraft,
  putPhoto,
  updatePhotoIfPresent,
  type DraftReport,
  type PendingPhoto,
  type PhotoFailureKind,
} from './db';
import { draftMatchesServerReport, type ServerReportForDraft } from './draftReconciliation';
import { formatBytes, preparePhotoForUpload } from './photoCompression';
import {
  PhotoUploadError,
  RpcError,
  checkVisitPhotoOnServer,
  getMyServerReportForVisit,
  newVisitPhotoStoragePath,
  removePhotoObject,
  type UploadProgress,
  resubmitReport,
  submitReport,
  uploadVisitPhotoBytes,
  type PhotoPhase,
  type ServerPhotoCopy,
} from '../api';

const RETRY_INTERVAL_MS = 30_000;

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

/** For useSyncExternalStore-style subscriptions — components re-read whatever IndexedDB state they care about whenever this fires. Fires on every local queue change (photo progress, draft edits, retries) — deliberately generic and high-frequency, unlike subscribeReportSynced below. */
export function subscribeSyncEngine(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

const reportSyncedListeners = new Set<(visitId: string) => void>();
function notifyReportSynced(visitId: string): void {
  for (const fn of reportSyncedListeners) fn(visitId);
}

/**
 * A separate, narrow channel from subscribeSyncEngine above — fires exactly
 * once per visit, only when that visit's report has genuinely reached a
 * server-confirmed end state (either a real successful submit/resubmit, or
 * a confirmed "the server already has this report" resolution — see
 * trySubmitIfReady()). Never fires for photo-upload progress or any other
 * local queue change. This is what the React layer (TechnicianShell.tsx)
 * uses to invalidate exactly the affected TanStack Query keys, instead of
 * refetching on every unrelated IndexedDB write.
 */
export function subscribeReportSynced(callback: (visitId: string) => void): () => void {
  reportSyncedListeners.add(callback);
  return () => reportSyncedListeners.delete(callback);
}

/** The exact, stable message technician_submit_report() raises when a report row already exists for the visit — matched narrowly, only to trigger the specific safe-auto-resolve path below, never as a general classifier. */
const ALREADY_EXISTS_MESSAGE = 'A report already exists for this visit.';

function isAlreadyExistsError(err: unknown): boolean {
  return err instanceof RpcError && err.message === ALREADY_EXISTS_MESSAGE;
}

/** Shown (and kept) when the visit already has a report this phone did not send - e.g. one written by the office. */
export const OFFICE_REPORT_EXISTS_MESSAGE =
  'The office has already written the report for this visit, so this one can’t be sent. It’s kept on this phone — please tell the office if anything in it is missing.';

/**
 * After "A report already exists": is it exactly the report this phone was sending (its own earlier attempt, reply lost)? Uses the same
 * strict match as draft reconciliation (same text and specification, every photo path). Any doubt - no answer, an error - is "no".
 */
async function serverHoldsExactlyThisReport(draft: DraftReport, photos: PendingPhoto[]): Promise<boolean> {
  try {
    const server = await withTimeLimit(uploadDeps.checkTimeoutMs, 'the report check', () => uploadDeps.fetchMyServerReport(draft.visitId));
    return draftMatchesServerReport(draft, photos.map((p) => p.storagePath), server);
  } catch {
    return false;
  }
}

/**
 * True only for a genuine server-side rejection — the RPC actually ran and
 * technician_submit_report()/technician_resubmit_report() explicitly raised
 * an exception (a real PostgREST error with a Postgres SQLSTATE `code`,
 * e.g. 'P0001' for a plain `raise exception`). A network-level failure
 * (offline, DNS, a dropped connection, a timeout) never produces that
 * shape — supabase-js/postgrest-js only report `code` when a response
 * actually came back from the server, so an absent `code` is treated as
 * transient here, never permanent. A handful of Postgres SQLSTATE classes
 * are connection/resource-level even though a code IS present (08
 * connection exception, 40 transaction rollback, 53–58 insufficient
 * resources/system/operator intervention/external errors) — those are
 * still retried like any other transient failure, not treated as a
 * business-rule rejection.
 */
function isPermanentSubmitError(err: unknown): boolean {
  if (!(err instanceof RpcError) || !err.code) return false;
  const transientClasses = ['08', '40', '53', '54', '55', '57', '58'];
  return !transientClasses.includes(err.code.slice(0, 2));
}

const uploadingIds = new Set<string>();
const submittingKeys = new Set<string>();

/**
 * ONE photo uploads at a time. Uploads running side by side share the phone's uplink: on a weak mobile signal each then got a third
 * of it, none finished in time, and every one was cancelled and restarted from zero - nothing got through (reproduced: 0 of 20
 * photos in 8 minutes at 160 kbit/s with 3 at a time; 8 in 6 minutes one at a time). One at a time, every byte sent counts.
 */
const MAX_CONCURRENT_UPLOADS = 1;
let activeUploads = 0;

/** A photo waiting for the upload slot. */
export interface SlotCandidate {
  visitId: string;
  createdAt: string;
  /** When it started waiting (ms). */
  waitingSince: number;
}
interface SlotWaiter extends SlotCandidate {
  resolve: () => void;
}
const slotWaiters: SlotWaiter[] = [];

/** A photo that has waited this long goes next whatever else is waiting - no report can be held back indefinitely. */
const MAX_SLOT_WAIT_MS = 10 * 60_000;

/**
 * Which waiting photo uploads next (index into `waiting`), chosen at the moment the slot frees - not in the order photos were taken,
 * which made a second report wait behind every photo of the first. In order:
 *  1. anything that has waited MAX_SLOT_WAIT_MS or more (longest first) - nothing starves;
 *  2. photos of completed reports before reports still being filled in;
 *  3. the report with the fewest photos still waiting - closest to being sent;
 *  4. the oldest photo.
 * Pure; exported for tests.
 */
export function pickNextUpload(waiting: SlotCandidate[], readyVisits: Set<string>, now: number): number {
  if (waiting.length === 0) return -1;
  const starving = waiting
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => now - w.waitingSince >= MAX_SLOT_WAIT_MS)
    .sort((a, b) => a.w.waitingSince - b.w.waitingSince);
  if (starving.length > 0) return starving[0].i;
  const left = new Map<string, number>();
  for (const w of waiting) left.set(w.visitId, (left.get(w.visitId) ?? 0) + 1);
  let best = 0;
  const rank = (w: SlotCandidate) => [readyVisits.has(w.visitId) ? 0 : 1, left.get(w.visitId) ?? 0] as const;
  for (let i = 1; i < waiting.length; i++) {
    const [ra, la] = rank(waiting[i]);
    const [rb, lb] = rank(waiting[best]);
    if (ra !== rb ? ra < rb : la !== lb ? la < lb : waiting[i].createdAt < waiting[best].createdAt) best = i;
  }
  return best;
}

/** Visits whose report is completed and waiting only for its photos - kept up to date by the sweep and by "Complete job". */
const readyVisitsHint = new Set<string>();

function acquireUploadSlot(photo: PendingPhoto): Promise<void> {
  if (activeUploads < MAX_CONCURRENT_UPLOADS) {
    activeUploads += 1;
    return Promise.resolve();
  }
  // The chosen waiter inherits the releasing upload's slot, so activeUploads is unchanged on hand-off.
  return new Promise((resolve) => slotWaiters.push({ visitId: photo.visitId, createdAt: photo.createdAt, waitingSince: Date.now(), resolve }));
}

function releaseUploadSlot(): void {
  const i = pickNextUpload(slotWaiters, readyVisitsHint, Date.now());
  if (i < 0) {
    activeUploads -= 1;
    return;
  }
  const [next] = slotWaiters.splice(i, 1);
  next.resolve();
}

/**
 * After an upload fails because of the connection, the next one waits a moment (2 s, doubling per failure in a row, at most 30 s;
 * reset by any success): with no usable signal, photos would otherwise fail one after another in seconds and use up all their
 * automatic tries before the signal is back.
 */
let connectionFailuresInARow = 0;
function connectionCoolDownMs(): number {
  if (connectionFailuresInARow === 0) return 0;
  return Math.min(uploadDeps.coolDownBaseMs * 2 ** (connectionFailuresInARow - 1), uploadDeps.coolDownMaxMs);
}

/**
 * Automatic retries for a failed upload: the first attempt plus up to three
 * more, spaced out so a brief signal drop (lift, stairwell, cell hand-off) has
 * time to clear. After that the photo shows "Failed — tap to retry" with the
 * reason; a manual tap starts a fresh round, and the sweep keeps trying photos
 * whose report has already been completed - at growing intervals
 * (FAILED_RETRY_MS), never every few seconds.
 */
const MAX_UPLOAD_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = [2_000, 6_000, 15_000];
// At most 5 minutes apart (was 10): a photo stuck behind a long wait while the signal is fine again keeps the report from the office.
// Any successful upload, or the phone coming back online, retries the waiting photos at once anyway (see recoverWaitingUploads).
const FAILED_RETRY_MS = [60_000, 3 * 60_000, 5 * 60_000];

function backoffDelayMs(attemptsSoFar: number): number {
  const base = RETRY_BACKOFF_MS[Math.min(attemptsSoFar, RETRY_BACKOFF_MS.length) - 1];
  return base + Math.round(Math.random() * 500); // jitter so several photos don't retry in lockstep
}

function failedRetryDelayMs(attemptsSoFar: number, kind: PhotoFailureKind): number {
  if (kind === 'rejected') return FAILED_RETRY_MS[FAILED_RETRY_MS.length - 1]; // a refusal rarely clears by itself
  const beyond = Math.max(0, attemptsSoFar - MAX_UPLOAD_ATTEMPTS);
  return FAILED_RETRY_MS[Math.min(beyond, FAILED_RETRY_MS.length - 1)] + Math.round(Math.random() * 2_000);
}

/** Server-side rejections that retrying can't fix (not allowed / too large) — these go straight to Failed instead of burning retries. */
function isPermanentUploadFailure(err: unknown): boolean {
  if (err instanceof PhotoUploadError && (err.status === 413 || err.status === 415)) return true;
  const message = err instanceof Error ? err.message : '';
  return /row-level security|exceeded the maximum|payload too large|invalid mime|not allowed/i.test(message);
}

// ---- time limits: a request that hangs never holds a queue place for long ------------------------------------------------------------
// An upload is never cancelled just for being slow - only for having STOPPED (see withProgressLimit). The old fixed 90 s limit for the
// whole upload cancelled slow uploads that were still moving, and each restart began again from zero.
/** No bytes sent for this long = the upload has stopped (signal lost; a slow upload still sends something every few seconds). */
const PHOTO_UPLOAD_STALL_MS = 60_000;
/** Everything was handed over but no answer came for this long (on top of the allowance below). */
const PHOTO_UPLOAD_RESPONSE_MS = 60_000;
/**
 * The slowest uplink still treated as usable (32 kbit/s). "Sent" in upload progress means handed to the phone's network buffers, not
 * received: WebKit reported ~97% of a 720 KB photo as sent within ~40 s on a 64 kbit/s link, then nothing more while it drained -
 * a pure "no progress for 60 s" rule cancelled it just before it finished, every time. So an upload is always given at least the time
 * to deliver what it has handed over at this rate (about 3 minutes for a 740 KB photo) before it can count as stopped.
 */
const PHOTO_UPLOAD_MIN_BYTES_PER_SEC = 4 * 1024;
/** A generous ceiling for one photo even while it keeps moving (a 1 MB photo at 16 kbit/s still fits). */
const PHOTO_UPLOAD_MAX_MS = 10 * 60_000;
/** Reading the server's copy of one photo (a small request). */
const PHOTO_CHECK_TIMEOUT_MS = 20_000;

class UploadTimeoutError extends Error {
  constructor(what: string, why?: string) {
    super(why ?? `No answer from the server (${what} took too long)`);
    this.name = 'UploadTimeoutError';
  }
}
/**
 * Runs an upload with progress-aware limits: it is cancelled (request aborted) and rejected only when
 *  - no bytes have been handed over for `stallMs` (it has stopped),
 *  - everything was handed over but no answer came within `responseMs`, or
 *  - it is still going after `maxMs` (a ceiling - a stalled upload never holds the queue for long);
 * and never before it has had the time to deliver what it handed over at `minBytesPerSec` (buffered bytes still draining over a slow
 * link are progress the browser does not report). A slow upload that keeps moving is never cancelled for being slow.
 */
async function withProgressLimit<T>(
  limits: { stallMs: number; responseMs: number; maxMs: number; minBytesPerSec: number },
  work: (signal: AbortSignal, onProgress: (sent: number, total: number) => void) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let fail: (err: Error) => void = () => {};
  const limit = new Promise<never>((_, reject) => {
    fail = (err) => {
      controller.abort();
      reject(err);
    };
  });
  let idle: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  const arm = (ms: number, why: string, handedOver = 0) => {
    clearTimeout(idle);
    const drainBy = startedAt + (handedOver / limits.minBytesPerSec) * 1000; // what was handed over may still be on its way
    const wait = Math.max(ms, drainBy - Date.now());
    idle = unrefTimer(setTimeout(() => fail(new UploadTimeoutError('the upload', why)), wait));
  };
  const ceiling = unrefTimer(setTimeout(() => fail(new UploadTimeoutError('the upload', `The upload was still not finished after ${Math.round(limits.maxMs / 60_000)} minutes`)), limits.maxMs));
  const stalled = `The upload stopped - nothing sent for ${Math.round(limits.stallMs / 1000)} s (weak or no signal)`;
  arm(limits.stallMs, stalled);
  let lastSent = -1;
  const onProgress = (sent: number, total: number) => {
    if (sent <= lastSent) return;
    lastSent = sent;
    if (total > 0 && sent >= total) arm(limits.responseMs, 'The photo was sent but the server did not answer', sent);
    else arm(limits.stallMs, stalled, sent);
  };
  try {
    return await Promise.race([work(controller.signal, onProgress), limit]);
  } finally {
    clearTimeout(idle);
    clearTimeout(ceiling);
  }
}

/** The upload went through but the server's copy isn't this exact photo (or couldn't be confirmed) - never counted as uploaded. */
class UploadNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadNotConfirmedError';
  }
}

/**
 * Runs `work` with a cancel signal and settles within `ms` whatever happens: on time-out the request is cancelled (aborted) AND the
 * promise rejects at once, even if the browser keeps the request open - so the caller's queue place is always freed.
 */
async function withTimeLimit<T>(ms: number, what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new UploadTimeoutError(what));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The network side of the queue (photo upload, and checking a failed report against the server) - real by default, replaced in tests. */
export interface TechnicianUploadDeps {
  checkOnServer: (storagePath: string, signal: AbortSignal) => Promise<ServerPhotoCopy>;
  uploadBytes: (storagePath: string, body: Blob, contentType: string, signal: AbortSignal, onProgress?: UploadProgress) => Promise<'created' | 'exists'>;
  removeObject: (storagePath: string) => Promise<void>;
  fetchMyServerReport: (visitId: string) => Promise<ServerReportForDraft | null>;
  uploadStallMs: number;
  uploadResponseMs: number;
  uploadMaxMs: number;
  uploadMinBytesPerSec: number;
  checkTimeoutMs: number;
  coolDownBaseMs: number;
  coolDownMaxMs: number;
}
const defaultUploadDeps: TechnicianUploadDeps = {
  checkOnServer: checkVisitPhotoOnServer,
  uploadBytes: uploadVisitPhotoBytes,
  removeObject: removePhotoObject,
  fetchMyServerReport: getMyServerReportForVisit,
  uploadStallMs: PHOTO_UPLOAD_STALL_MS,
  uploadResponseMs: PHOTO_UPLOAD_RESPONSE_MS,
  uploadMaxMs: PHOTO_UPLOAD_MAX_MS,
  uploadMinBytesPerSec: PHOTO_UPLOAD_MIN_BYTES_PER_SEC,
  checkTimeoutMs: PHOTO_CHECK_TIMEOUT_MS,
  coolDownBaseMs: 2_000,
  coolDownMaxMs: 30_000,
};
let uploadDeps: TechnicianUploadDeps = defaultUploadDeps;
/** Test hook. */
export function setTechnicianUploadDepsForTests(over: Partial<TechnicianUploadDeps> | null): void {
  uploadDeps = over ? { ...defaultUploadDeps, ...over } : defaultUploadDeps;
}

/** A fresh storage path for the same photo (same visit, phase and extension) - used when the old path holds an incomplete copy. */
function freshStoragePath(photo: PendingPhoto): string {
  const ext = photo.storagePath.includes('.') ? photo.storagePath.split('.').pop() : 'jpg';
  return newVisitPhotoStoragePath(photo.visitId, photo.phase, `photo.${ext}`);
}

/**
 * Reads the saved photo completely into memory. That copy - not the stored Blob itself - is what gets sent: Safari can send a stored
 * file's body empty or wrong (WebKit bugs 319985 and others), a copy in memory is sent correctly. It doubles as the readability check:
 * a photo the phone can no longer read fails here, plainly, instead of as a confusing network error.
 */
async function readPhotoForUpload(photo: PendingPhoto): Promise<Blob> {
  const bytes = await photo.blob.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength !== photo.blob.size) {
    throw new Error(`The saved photo could not be read in full (${bytes.byteLength} of ${photo.blob.size} bytes)`);
  }
  return new Blob([bytes], { type: photo.blob.type || 'image/jpeg' });
}

/** Holds the photo as it changes during one attempt (its storage path can move), so a failure records the latest version. */
interface AttemptState {
  photo: PendingPhoto;
}

/**
 * Makes sure the server holds THIS photo, complete, at the photo's storage path - uploading it if needed - and only then returns.
 * Every step is time-limited. A file found at the path counts only if its size equals the photo's; an incomplete copy is removed
 * (best effort) and the photo moves to a fresh path, so the report can only ever reference a complete copy.
 */
async function uploadAndConfirm(attempt: AttemptState, body: Blob): Promise<void> {
  const contentType = body.type || 'image/jpeg';
  const check = (path: string) => withTimeLimit(uploadDeps.checkTimeoutMs, 'the check', (signal) => uploadDeps.checkOnServer(path, signal));
  const moveToFreshPath = async (reason: string) => {
    const old = attempt.photo.storagePath;
    void withTimeLimit(uploadDeps.checkTimeoutMs, 'the clean-up', () => uploadDeps.removeObject(old)).catch(() => {});
    attempt.photo = { ...attempt.photo, storagePath: freshStoragePath(attempt.photo) };
    if (!(await updatePhotoIfPresent(attempt.photo))) throw new UploadNotConfirmedError('The photo was removed meanwhile');
    return reason;
  };

  const before = await check(attempt.photo.storagePath);
  if (before.found) {
    if (before.sizeBytes === body.size) return; // an earlier attempt did arrive, complete
    if (before.sizeBytes == null) throw new UploadNotConfirmedError('The server did not report the size of its copy');
    await moveToFreshPath(`An incomplete copy (${before.sizeBytes} of ${body.size} bytes) was found and replaced`);
  }

  const limits = { stallMs: uploadDeps.uploadStallMs, responseMs: uploadDeps.uploadResponseMs, maxMs: uploadDeps.uploadMaxMs, minBytesPerSec: uploadDeps.uploadMinBytesPerSec };
  await withProgressLimit(limits, (signal, onProgress) =>
    uploadDeps.uploadBytes(attempt.photo.storagePath, body, contentType, signal, onProgress),
  );

  const after = await check(attempt.photo.storagePath);
  if (after.found && after.sizeBytes === body.size) return;
  if (!after.found) throw new UploadNotConfirmedError('The server did not keep the photo');
  if (after.sizeBytes == null) throw new UploadNotConfirmedError('The server did not report the size of its copy');
  const stored = after.sizeBytes;
  await moveToFreshPath('incomplete');
  throw new UploadNotConfirmedError(`The server kept an incomplete copy (${stored} of ${body.size} bytes); it will be uploaded again`);
}

function failureKindOf(err: unknown): PhotoFailureKind {
  if (err instanceof UploadTimeoutError) return 'timeout';
  if (err instanceof UploadNotConfirmedError) return 'verify';
  if (isPermanentUploadFailure(err)) return 'rejected';
  return 'network';
}

/** The text stored on a photo (and shown to the technician) when an upload fails: the real reason plus the size of what was being uploaded. */
function describeUploadFailure(err: unknown, photo: PendingPhoto, attempts: number, final: boolean): string {
  const reason = err instanceof Error && err.message ? err.message : 'Unknown error';
  const size = formatBytes(photo.blob.size);
  const original = photo.originalSize && photo.originalSize > photo.blob.size + 1024 ? `, resized from ${formatBytes(photo.originalSize)}` : '';
  const tail = final ? ` Tried ${attempts} time${attempts === 1 ? '' : 's'}.` : '';
  return `${reason} (${size}${original}).${tail}`;
}

/** The sweep also runs after a backoff delay elapses — due photos are picked up from storage, so nothing is lost if the page reloads in between. */
/** In Node (tests) a pending queue timer must not keep the process alive; browsers have no unref and are unaffected. */
function unrefTimer<T>(timer: T): T {
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

function scheduleRetrySweep(delayMs: number): void {
  const timer = setTimeout(() => {
    void retryEverything();
  }, delayMs + 250);
  // In Node (tests) a pending retry must not keep the process alive; browsers have no unref and are unaffected.
  (timer as unknown as { unref?: () => void }).unref?.();
}

async function recordUploadFailure(photo: PendingPhoto, err: unknown, kind: PhotoFailureKind = failureKindOf(err)): Promise<void> {
  const attempts = (photo.attempts ?? 0) + 1;
  const giveUp = attempts >= MAX_UPLOAD_ATTEMPTS || kind === 'rejected' || kind === 'unreadable';
  if (giveUp) {
    // Shown as failed, but still tried again by itself (spaced out) while its report waits - see retryEverything().
    const delay = failedRetryDelayMs(attempts, kind);
    const kept = await updatePhotoIfPresent({
      ...photo,
      status: 'failed',
      attempts,
      failureKind: kind,
      lastError: describeUploadFailure(err, photo, attempts, true),
      nextAttemptAt: new Date(Date.now() + delay).toISOString(),
    });
    if (kept) scheduleRetrySweep(delay);
    return;
  }
  const delay = backoffDelayMs(attempts);
  // Back to 'pending' (not 'failed'): it is still going to upload by itself.
  const stillQueued = await updatePhotoIfPresent({
    ...photo,
    status: 'pending',
    attempts,
    failureKind: kind,
    lastError: describeUploadFailure(err, photo, attempts, false),
    nextAttemptAt: new Date(Date.now() + delay).toISOString(),
  });
  if (stillQueued) scheduleRetrySweep(delay); // deleted meanwhile: nothing to retry
}

/** The signed-in user's ID, or a thrown error — for actions that CREATE queued work, which must always belong to someone. */
function requireCurrentUserId(): string {
  const userId = getCurrentUserId();
  if (!userId) throw new Error('You are not signed in.');
  return userId;
}

/** True only while `ownerId` is still the signed-in user — checked right before every network call made on a queued record's behalf. */
function isStillCurrentOwner(ownerId: string): boolean {
  return getCurrentUserId() === ownerId;
}

async function attemptUploadPhoto(photo: PendingPhoto): Promise<void> {
  if (photo.status === 'uploaded' || uploadingIds.has(photo.id)) return;
  if (!navigator.onLine) return;
  if (!isStillCurrentOwner(photo.ownerId)) return;

  // Claimed synchronously (before any await) so two triggers can never both start this photo.
  uploadingIds.add(photo.id);
  try {
    await acquireUploadSlot(photo);
    let coolDown = 0;
    try {
      // Time may have passed waiting for a slot — re-check before touching the network.
      if (!navigator.onLine || !isStillCurrentOwner(photo.ownerId)) return;
      // A photo the technician deleted while it waited for a slot must never be uploaded: the write
      // only happens if the record still exists, and its absence ends the attempt here.
      // Only the photo's status record is written - never the photo itself (db.ts).
      if (!(await updatePhotoIfPresent({ ...photo, status: 'uploading' }))) return;
      notify();
      const attempt: AttemptState = { photo };
      try {
        if (!isStillCurrentOwner(photo.ownerId)) {
          // The user changed between claiming this photo and uploading it — put it back untouched for its owner's next retry.
          await updatePhotoIfPresent(photo);
          return;
        }
        let body: Blob | null = null;
        try {
          body = await readPhotoForUpload(photo);
        } catch (readErr) {
          // The phone can't read the saved photo: not a network problem and not counted as one. It is checked again later
          // (it can be a passing problem) and kept - never deleted.
          await recordUploadFailure(photo, readErr, 'unreadable');
        }
        if (body) {
          await uploadAndConfirm(attempt, body);
          if (connectionFailuresInARow > 0) recoverWaitingUploads(); // the connection works again: don't leave photos waiting out a long retry
          connectionFailuresInARow = 0;
          const kept = await updatePhotoIfPresent({ ...attempt.photo, status: 'uploaded', lastError: null, failureKind: null, attempts: 0, nextAttemptAt: null });
          if (!kept) {
            // Deleted while the upload was in flight: the file now exists but nothing will ever reference
            // it, so remove it again rather than leave an orphan. Best effort - it cannot affect the UI.
            void removePhotoObject(attempt.photo.storagePath).catch(() => {});
          }
        }
      } catch (err) {
        const kind = failureKindOf(err);
        if (kind === 'network' || kind === 'timeout') {
          connectionFailuresInARow += 1;
          coolDown = connectionCoolDownMs();
        }
        await recordUploadFailure(attempt.photo, err, kind);
      }
      notify();
    } finally {
      if (coolDown > 0) await new Promise<void>((r) => unrefTimer(setTimeout(r, coolDown))); // the slot stays taken: nothing else starts meanwhile
      releaseUploadSlot();
    }
  } finally {
    uploadingIds.delete(photo.id);
  }

  await submitIfReadyForOwner(photo.ownerId, photo.visitId);
}

/**
 * Attempts the actual, final submit/resubmit RPC for a visit — only when
 * every one of its photos has genuinely finished uploading. Safe to call as
 * often as you like; it's a no-op unless the draft is ready, not already
 * mid-submit, online, fully uploaded, and — since a permanently-rejected
 * draft can never succeed by retrying — not already marked
 * `permanentFailure` (see isPermanentSubmitError()). Always acts for the
 * currently signed-in user; a no-op when nobody is.
 */
export async function trySubmitIfReady(visitId: string): Promise<void> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  await submitIfReadyForOwner(ownerId, visitId);
}

async function submitIfReadyForOwner(ownerId: string, visitId: string): Promise<void> {
  const submitKey = `${ownerId}:${visitId}`;
  if (submittingKeys.has(submitKey)) return;
  if (!isStillCurrentOwner(ownerId)) return;
  // Claimed in the same step as the check (before any await): two photos of one report finishing together used to both pass the
  // check above while the other was still reading the database, and send the report twice.
  submittingKeys.add(submitKey);
  try {
    const draft = await getDraftForOwner(ownerId, visitId);
    if (!draft || !draft.readyToSubmit || draft.submitting || draft.permanentFailure || draft.serverConfirmedAt) return;
    if (!navigator.onLine) return;

    const photos = await listPhotosForVisit(ownerId, visitId);
    // A first report needs at least one photo (the server requires it too). A resubmission of a returned report does not:
    // a text-only correction is valid, and technician_resubmit_report accepts zero additional photos.
    if (draft.mode === 'submit' && photos.length === 0) return;
    // Whatever photos are queued must have finished uploading first.
    if (photos.some((p) => p.status !== 'uploaded')) return;
    await sendReport(ownerId, visitId, draft, photos);
  } finally {
    submittingKeys.delete(submitKey);
    notify();
  }
}

async function sendReport(ownerId: string, visitId: string, draft: DraftReport, photos: PendingPhoto[]): Promise<void> {
  if (!isStillCurrentOwner(ownerId)) return;
  await putDraft({ ...draft, submitting: true, submitError: null });
  notify();

  try {
    // Last check before the network: never submit one user's work under another user's session.
    if (!isStillCurrentOwner(ownerId)) {
      await putDraft({ ...draft, submitting: false });
      return;
    }
    if (draft.mode === 'submit') {
      await submitReport({
        visitId: draft.visitId,
        workCarriedOut: draft.workCarriedOut,
        technicianNotes: draft.technicianNotes,
        issues: draft.issues,
        onSiteStart: draft.onSiteStart!,
        onSiteEnd: draft.onSiteEnd!,
        photos: photos.map((p) => ({ storagePath: p.storagePath, phase: p.phase })),
        specMet: draft.specMet,
      });
    } else {
      await resubmitReport({
        reportId: draft.reportId!,
        workCarriedOut: draft.workCarriedOut,
        technicianNotes: draft.technicianNotes,
        issues: draft.issues,
        additionalPhotos: photos.map((p) => ({ storagePath: p.storagePath, phase: p.phase })),
        specMet: draft.specMet,
      });
    }

    // Positively confirmed by the server — only now is it safe to clear
    // the local queue. Never delete a photo's blob before this point.
    await deleteDraft(ownerId, visitId);
    readyVisitsHint.delete(visitId);
    await deletePhotosForVisit(ownerId, visitId);
    notifyReportSynced(visitId);
  } catch (err) {
    if (isAlreadyExistsError(err) && (await serverHoldsExactlyThisReport(draft, photos))) {
      // The server already has THIS report - this very submission succeeded on an earlier attempt whose reply never came back (e.g. the
      // connection dropped right after). The local copy is a duplicate: drop it and treat the visit as sent, exactly like a success.
      await deleteDraft(ownerId, visitId);
      readyVisitsHint.delete(visitId);
      await deletePhotosForVisit(ownerId, visitId);
      notifyReportSynced(visitId);
    } else if (isAlreadyExistsError(err)) {
      // A DIFFERENT report already exists - written by the office (or the check couldn't be made). Never discard the technician's
      // work: keep the draft and its photos on the phone, never retry, and say plainly why it can't be sent.
      await putDraft({
        ...draft,
        submitting: false,
        submitError: OFFICE_REPORT_EXISTS_MESSAGE,
        permanentFailure: true,
        updatedAt: new Date().toISOString(),
      });
    } else if (isPermanentSubmitError(err)) {
      // A definitive server rejection that retrying can never fix (e.g.
      // the visit was reassigned away). Stop the automatic retry loop —
      // trySubmitIfReady()'s own guard above skips permanentFailure
      // drafts — but keep the technician's typed work in place rather
      // than silently discarding it; they (or the office) need to act on
      // this deliberately, not have it vanish.
      await putDraft({
        ...draft,
        submitting: false,
        submitError: err instanceof Error ? err.message : 'Failed to submit report.',
        permanentFailure: true,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // Transient (network/connection/timeout) — leave it exactly as
      // before, retried by every future trigger until it succeeds.
      await putDraft({
        ...draft,
        submitting: false,
        submitError: err instanceof Error ? err.message : 'Failed to submit report.',
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * Retries the signed-in user's queued uploads, then every ready draft — the one
 * function every retry trigger calls.
 *
 * Photos that are still waiting ('pending', or 'uploading' left behind by a
 * page that died mid-request) are picked up for EVERY visit, whether or not
 * its report has been completed yet — so photos taken offline upload on
 * reconnect, and a photo stranded mid-upload doesn't sit there until
 * "Complete job". A photo in backoff is skipped until its time is due.
 * Photos that have ultimately 'failed' are only re-tried automatically when
 * their report is completed (as before) or when `includeFailed` is set (the
 * device just came back online); otherwise they wait for a manual tap.
 */
async function retryEverything(includeFailed = false): Promise<void> {
  if (!navigator.onLine) return;
  // Only the signed-in user's own queued work — nobody signed in, nothing to retry.
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  const [readyVisitIds, unuploaded] = await Promise.all([listReadyDraftVisitIds(ownerId), listUnuploadedPhotos(ownerId)]);
  const readyVisits = new Set(readyVisitIds);
  readyVisitsHint.clear();
  for (const id of readyVisitIds) readyVisitsHint.add(id);
  const now = Date.now();

  // includeFailed = the connection is (back) up - the phone came online, or an upload just succeeded after failures: every waiting
  // photo is tried now, whatever its schedule said.
  const due = unuploaded.filter((photo) => {
    if (!includeFailed && photo.nextAttemptAt && Date.parse(photo.nextAttemptAt) > now) return false;
    if (photo.status === 'failed') return includeFailed || readyVisits.has(photo.visitId);
    return true;
  });
  // The upload slot limiter inside attemptUploadPhoto keeps this to a few at a time, in the order started here: reports take turns
  // (completed reports first), so one report with many photos can't keep the others waiting.
  await Promise.all(takeTurnsByVisit(due, readyVisits).map((photo) => attemptUploadPhoto(photo)));

  for (const visitId of readyVisitIds) {
    if (!isStillCurrentOwner(ownerId)) return;
    await submitIfReadyForOwner(ownerId, visitId);
  }

  await reconcilePermanentFailures(ownerId);
}

/** Test hook: the queue's in-memory state as at app start (no failures in a row, no readiness hints). */
export function resetUploadQueueStateForTests(): void {
  connectionFailuresInARow = 0;
  readyVisitsHint.clear();
}

let recoverySweepQueued = false;
/** One sweep that tries every waiting photo now (connection evidently working again); never more than one queued at a time. */
function recoverWaitingUploads(): void {
  if (recoverySweepQueued) return;
  recoverySweepQueued = true;
  setTimeout(() => {
    recoverySweepQueued = false;
    void retryEverything(true);
  }, 0);
}

/** Permanently failed drafts already checked against the server in this app session (owner:visit) - one check each per session. */
const reconciledKeys = new Set<string>();

/**
 * Checks each of this owner's permanently failed drafts against what the server holds for them (see draftReconciliation.ts) and marks
 * the draft as confirmed when - and only when - the server already has exactly that report; a later check that no longer matches clears
 * the mark. Never deletes a draft, never touches its photos, never sends anything. A check that can't be made (offline, time-out,
 * server error) changes nothing and is tried again on a later sweep.
 */
async function reconcilePermanentFailures(ownerId: string): Promise<void> {
  const drafts = (await listAllDrafts(ownerId)).filter((d) => d.readyToSubmit && d.permanentFailure && !d.submitting);
  for (const draft of drafts) {
    const key = `${ownerId}:${draft.visitId}`;
    if (reconciledKeys.has(key) || !navigator.onLine || !isStillCurrentOwner(ownerId)) continue;
    reconciledKeys.add(key); // claimed before the request, so two overlapping sweeps never check the same draft twice
    let server: ServerReportForDraft | null;
    try {
      server = await withTimeLimit(uploadDeps.checkTimeoutMs, 'the report check', () => uploadDeps.fetchMyServerReport(draft.visitId));
    } catch {
      reconciledKeys.delete(key); // not known - assume nothing, and check again on a later sweep
      continue;
    }
    const photoPaths = (await listPhotosForVisit(ownerId, draft.visitId)).map((p) => p.storagePath);
    const matches = draftMatchesServerReport(draft, photoPaths, server);
    const current = await getDraftForOwner(ownerId, draft.visitId);
    if (!current || current.updatedAt !== draft.updatedAt || !isStillCurrentOwner(ownerId)) continue; // changed meanwhile: leave it
    if (matches === !!current.serverConfirmedAt) continue;
    await putDraft({ ...current, serverConfirmedAt: matches ? new Date().toISOString() : null });
    notify();
  }
}

/** Test hook: forget which drafts were checked (= a new app session). */
export function resetDraftReconciliationForTests(): void {
  reconciledKeys.clear();
}

/**
 * Orders photos so reports take turns - one photo of each report, then the next of each, and so on - with completed reports (whose
 * report is waiting only for its photos) first and each report's photos oldest first. Exported for tests.
 */
export function takeTurnsByVisit(photos: PendingPhoto[], readyVisits: Set<string>): PendingPhoto[] {
  const byVisit = new Map<string, PendingPhoto[]>();
  for (const p of [...photos].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const list = byVisit.get(p.visitId) ?? [];
    list.push(p);
    byVisit.set(p.visitId, list);
  }
  const queues = [...byVisit.entries()].sort(([a], [b]) => Number(readyVisits.has(b)) - Number(readyVisits.has(a))).map(([, list]) => list);
  const ordered: PendingPhoto[] = [];
  for (let round = 0; ordered.length < photos.length; round++) {
    for (const q of queues) if (round < q.length) ordered.push(q[round]);
  }
  return ordered;
}

/** Test hook: one sweep, exactly as the 30 s timer / coming back online / reopening the app runs it. */
export function runSyncSweepForTests(includeFailed = false): Promise<void> {
  return retryEverything(includeFailed);
}

let engineStarted = false;

/** Wires the three retry triggers exactly once for the life of the tab — call from TechnicianShell.tsx on mount. Deliberately separate from AuthProvider.tsx's own visibilitychange handling; this never touches auth/session state. */
export function startSyncEngine(): void {
  if (engineStarted) return;
  engineStarted = true;

  // Queued work from before ownership existed (schema v1) can't be attributed
  // to anyone, so it is preserved but hidden from and never synced by every
  // account — flagged here, once, so it isn't invisible to a developer.
  void countUnattributedRecords()
    .then(({ drafts, photos }) => {
      if (drafts > 0 || photos > 0) {
        console.warn(
          `[offline queue] ${drafts} draft(s) and ${photos} photo(s) queued before per-user ownership are preserved but not attributed to any account, so they are not shown or synced.`,
        );
      }
    })
    .catch(() => undefined);

  // Ask the browser to keep this app's storage (queued reports and photos) rather than clear it when space runs low. Best effort:
  // some browsers grant it silently, some only for an installed (home-screen) app, some never - nothing depends on the answer.
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* not supported */
  }

  window.addEventListener('online', () => {
    void retryEverything(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void retryEverything();
  });
  setInterval(() => {
    void retryEverything();
  }, RETRY_INTERVAL_MS);

  void retryEverything();
}

/**
 * Queues a photo the instant it's captured — before any network attempt.
 * Returns the durable record synchronously enough for the UI to render a
 * chip immediately; kicks off a background upload attempt but never waits
 * for it (capture must never block on the network).
 */
export async function enqueuePhoto(visitId: string, phase: PhotoPhase, file: File): Promise<PendingPhoto> {
  const ownerId = requireCurrentUserId();
  // Shrink before saving (see photoCompression.ts) — and if that fails for any reason this is the untouched original, never nothing.
  const prepared = await preparePhotoForUpload(file);
  const storagePath = newVisitPhotoStoragePath(visitId, phase, prepared.filename);
  const photo: PendingPhoto = {
    id: crypto.randomUUID(),
    ownerId,
    visitId,
    phase,
    blob: prepared.blob,
    storagePath,
    status: 'pending',
    lastError: null,
    createdAt: new Date().toISOString(),
    originalSize: prepared.originalSize,
    attempts: 0,
    nextAttemptAt: null,
  };
  await putPhoto(photo);
  notify();
  void attemptUploadPhoto(photo);
  return photo;
}

/**
 * Deletes a photo the technician queued or uploaded but has NOT yet submitted.
 *
 *  - Never while the report is being sent (draft marked ready / submitting).
 *  - Already uploaded: the file is removed from Storage first (Storage itself refuses anything
 *    that is not the technician own, unsubmitted photo). Only when that succeeds is the local
 *    record dropped, so a failure leaves the photo exactly as it was and the error is thrown.
 *  - Not uploaded yet: the queue record is deleted first, which cancels the upload for good (every
 *    status write in this file only happens while the record exists). Then the file, in case an
 *    interrupted upload had already created it, is removed on a best-effort basis.
 */
export async function removeQueuedPhoto(photo: PendingPhoto): Promise<void> {
  const ownerId = requireCurrentUserId();
  if (photo.ownerId !== ownerId) throw new Error('This photo belongs to a different account.');

  const draft = await getDraftForOwner(ownerId, photo.visitId);
  const current = await getPhoto(photo.id);
  if (draft?.submitting) throw new Error('This report is being sent right now, so its photos can’t be changed.');
  if (draft?.readyToSubmit) {
    // A completed report's photos are fixed - except one this phone can no longer read: it can never upload, and would hold the whole
    // report back for good. That one may be removed, as long as the report keeps at least one photo (the office needs one).
    if (!current || current.status === 'uploaded' || current.failureKind !== 'unreadable') {
      throw new Error('This report is already being sent, so its photos can no longer be changed.');
    }
    const others = (await listPhotosForVisit(ownerId, photo.visitId)).filter((p) => p.id !== current.id);
    if (draft.mode === 'submit' && others.length === 0) {
      throw new Error('This is the report’s only photo, so it can’t be removed. Please contact the office about this visit.');
    }
  }

  if (!current) return; // already gone

  if (current.status === 'uploaded') {
    if (!navigator.onLine) throw new Error('You need a connection to delete a photo that has already uploaded.');
    await removePhotoObject(current.storagePath); // throws on failure - the record below is then kept
    await deletePhoto(current.id);
  } else {
    await deletePhoto(current.id);
    if (navigator.onLine) void removePhotoObject(current.storagePath).catch(() => {});
  }
  notify();
  if (draft?.readyToSubmit) void trySubmitIfReady(photo.visitId); // the removed photo may have been the last one it waited for
}

/** Manual retry — the UI's "Retry" button on a failed chip. */
export async function retryPhoto(photo: PendingPhoto): Promise<void> {
  // A manual tap gets the full automatic-retry sequence again.
  await attemptUploadPhoto({ ...photo, attempts: 0, nextAttemptAt: null });
}

export interface DraftSeed {
  mode: DraftReport['mode'];
  reportId: string | null;
  onSiteStart: string | null;
  /** Seeded from the visit's real, existing report on resubmission (defaulting to true if that report somehow has none yet); always true for a brand-new report — matches "default it to the normal/completed state". */
  specMet: boolean;
}

/** Rehydrates an existing draft, or creates a fresh one seeded from the visit's real data — called once on JobReportPage mount. */
export async function getOrInitDraft(visitId: string, seed: DraftSeed): Promise<DraftReport> {
  const ownerId = requireCurrentUserId();
  const existing = await getDraftForOwner(ownerId, visitId);
  if (existing) return existing;

  const draft: DraftReport = {
    ownerId,
    visitId,
    mode: seed.mode,
    reportId: seed.reportId,
    workCarriedOut: null,
    technicianNotes: null,
    issues: null,
    onSiteStart: seed.onSiteStart,
    onSiteEnd: null,
    specMet: seed.specMet,
    readyToSubmit: false,
    submitting: false,
    submitError: null,
    updatedAt: new Date().toISOString(),
  };
  await putDraft(draft);
  return draft;
}

/** Persists an in-progress edit — called on every field change, before "Complete job" is ever tapped. Cheap: this is short text/a boolean, not a photo. */
export async function updateDraftFields(
  visitId: string,
  fields: Partial<Pick<DraftReport, 'workCarriedOut' | 'technicianNotes' | 'issues' | 'specMet'>>,
): Promise<void> {
  const ownerId = requireCurrentUserId();
  const draft = await getDraftForOwner(ownerId, visitId);
  if (!draft || draft.readyToSubmit) return; // never edit a draft that's already queued for submission
  await putDraft({ ...draft, ...fields, updatedAt: new Date().toISOString() });
}

/**
 * "Complete job" — the local completion action. Immediate: marks the
 * draft ready and returns right away, WITHOUT waiting for any photo
 * upload or the actual submit RPC. Background sync (retryEverything/
 * trySubmitIfReady) takes it from here, automatically, whenever every
 * photo has finished uploading and the device is online.
 */
export async function markReadyToSubmit(visitId: string): Promise<DraftReport> {
  const ownerId = requireCurrentUserId();
  const draft = await getDraftForOwner(ownerId, visitId);
  if (!draft) throw new Error('No draft found for this visit.');
  const updated: DraftReport = {
    ...draft,
    readyToSubmit: true,
    onSiteEnd: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await putDraft(updated);
  readyVisitsHint.add(visitId); // its photos now go ahead of reports still being filled in
  notify();
  void trySubmitIfReady(visitId);
  return updated;
}

/** The signed-in user's own queued photos for this visit (empty when nobody is signed in). */
export async function getVisitPhotos(visitId: string): Promise<PendingPhoto[]> {
  const ownerId = getCurrentUserId();
  return ownerId ? listPhotosForVisit(ownerId, visitId) : [];
}

export interface SyncStatus {
  online: boolean;
  /** Photos not uploaded yet - waiting, uploading, or failed (failed ones are counted in failedPhotoCount too). */
  pendingPhotoCount: number;
  /** Photos that failed their automatic attempts (still tried again, spaced out, while their report waits). */
  failedPhotoCount: number;
  /** Completed reports whose SEND to the server failed (photos all uploaded; the report itself was not accepted / not delivered). */
  failedDraftCount: number;
  /** Completed reports still waiting to reach the office (for any reason). */
  waitingReportCount: number;
}

const EMPTY_STATUS = (online: boolean): SyncStatus => ({ online, pendingPhotoCount: 0, failedPhotoCount: 0, failedDraftCount: 0, waitingReportCount: 0 });

/** Counts only the signed-in user's own queued work — another user's failed draft never shows up here. */
async function computeSyncStatus(): Promise<SyncStatus> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return EMPTY_STATUS(navigator.onLine);
  const [unuploaded, drafts] = await Promise.all([listUnuploadedPhotos(ownerId), listAllDrafts(ownerId)]);
  return {
    online: navigator.onLine,
    pendingPhotoCount: unuploaded.length,
    failedPhotoCount: unuploaded.filter((p) => p.status === 'failed').length,
    failedDraftCount: drafts.filter((d) => d.readyToSubmit && !!d.submitError && !d.serverConfirmedAt).length,
    waitingReportCount: drafts.filter((d) => d.readyToSubmit && !d.serverConfirmedAt).length,
  };
}

/** Test hook: the header's counts, as useSyncStatus() would report them now. */
export const readSyncStatusForTests = (): Promise<SyncStatus> => computeSyncStatus();

/** Where one completed report's photos are on this phone - for the job card on My day (see dayUploadStatus.ts). */
export interface VisitPhotoUpload {
  visitId: string;
  /** Photos queued with the report (they stay, marked uploaded, until the report has been sent). */
  total: number;
  uploaded: number;
  /** Being sent right now. */
  uploading: number;
  /** Waiting for their turn (one photo uploads at a time). */
  waiting: number;
  /** Tried and failed; tried again automatically (the queue spaces these out). */
  retrying: number;
  /** The report itself: still to be sent / its last send failed and is retried / refused for good (contact the office). */
  report: 'waiting' | 'send-failed' | 'refused';
}

/**
 * Per completed report (draft marked "Complete job" and not yet sent), how far its photos are - read from the same local queue the
 * engine works from; nothing extra is stored or fetched. A report the server is confirmed to hold already is left out.
 */
export async function listPhotoUploadsByVisit(): Promise<VisitPhotoUpload[]> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return [];
  const drafts = (await listAllDrafts(ownerId)).filter((d) => d.readyToSubmit && !d.serverConfirmedAt);
  return Promise.all(
    drafts.map(async (d) => {
      const photos = await listPhotosForVisit(ownerId, d.visitId);
      const count = (pick: (p: PendingPhoto) => boolean) => photos.filter(pick).length;
      return {
        visitId: d.visitId,
        total: photos.length,
        uploaded: count((p) => p.status === 'uploaded'),
        uploading: count((p) => p.status === 'uploading'),
        waiting: count((p) => p.status === 'pending' && !(p.attempts ?? 0)),
        retrying: count((p) => p.status === 'failed' || (p.status === 'pending' && (p.attempts ?? 0) > 0)),
        report: d.permanentFailure ? 'refused' : d.submitError ? 'send-failed' : 'waiting',
      };
    }),
  );
}

/** For TechnicianShell.tsx's header badge — the only consumer of a truly global (cross-visit) summary. */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(EMPTY_STATUS(navigator.onLine));

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void computeSyncStatus().then((next) => {
        if (!cancelled) setStatus(next);
      });
    };
    refresh();
    const unsubscribe = subscribeSyncEngine(refresh);
    // Re-count immediately when the signed-in user changes, so the badge can't keep showing the previous user's numbers.
    const unsubscribeUser = subscribeCurrentUser(refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeUser();
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  return status;
}

/** The signed-in user's own draft for this visit — undefined when there is none, or nobody is signed in. Never returns another user's draft. */
export async function getDraft(visitId: string): Promise<DraftReport | undefined> {
  const ownerId = getCurrentUserId();
  return ownerId ? getDraftForOwner(ownerId, visitId) : undefined;
}