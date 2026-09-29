// The background sync engine — the piece that turns the durable IndexedDB
// queue (offline/db.ts) into "it just eventually reaches the office."
// Nothing in here talks to Supabase except through the EXISTING,
// unchanged repository functions (submitReport/resubmitReport/
// uploadVisitPhotoToPath) — this module only decides WHEN to call them
// and keeps retrying safely until it succeeds.
//
// Idempotency, the central design constraint:
// - Each photo's storage path is generated ONCE, at capture time (see
//   enqueuePhoto), and reused on every retry — combined with
//   uploadVisitPhotoToPath's upsert:true, a retried upload is a harmless
//   overwrite of the same object, never a duplicate.
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
  countUnuploadedPhotos,
  deleteDraft,
  deletePhotosForVisit,
  getDraft as getDraftForOwner,
  listAllDrafts,
  listPhotosForVisit,
  listReadyDraftVisitIds,
  putDraft,
  putPhoto,
  type DraftReport,
  type PendingPhoto,
} from './db';
import { RpcError, newVisitPhotoStoragePath, resubmitReport, submitReport, uploadVisitPhotoToPath, type PhotoPhase } from '../api';

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

  uploadingIds.add(photo.id);
  try {
    await putPhoto({ ...photo, status: 'uploading' });
    notify();
    try {
      if (!isStillCurrentOwner(photo.ownerId)) {
        // The user changed between claiming this photo and uploading it — put it back untouched for its owner's next retry.
        await putPhoto(photo);
        return;
      }
      await uploadVisitPhotoToPath(photo.storagePath, photo.blob);
      await putPhoto({ ...photo, status: 'uploaded', lastError: null });
    } catch (err) {
      await putPhoto({ ...photo, status: 'failed', lastError: err instanceof Error ? err.message : 'Upload failed.' });
    }
    notify();
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
  const draft = await getDraftForOwner(ownerId, visitId);
  if (!draft || !draft.readyToSubmit || draft.submitting || draft.permanentFailure) return;
  if (!navigator.onLine) return;

  const photos = await listPhotosForVisit(ownerId, visitId);
  if (photos.length === 0) return;
  if (photos.some((p) => p.status !== 'uploaded')) return;

  submittingKeys.add(submitKey);
  try {
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
      await deletePhotosForVisit(ownerId, visitId);
      notifyReportSynced(visitId);
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        // The server already has a report for this visit — this local
        // draft is a redundant duplicate (most likely this very submission
        // having actually succeeded on an earlier attempt whose success
        // response never made it back, e.g. the connection dropped right
        // after). The real report is the server's; this branch never
        // created it and must never try to. Safe to drop the local
        // duplicate outright and tell the UI to treat this visit as
        // synced, exactly like a genuine success — never touches the
        // existing server-side report.
        await deleteDraft(ownerId, visitId);
        await deletePhotosForVisit(ownerId, visitId);
        notifyReportSynced(visitId);
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
  } finally {
    submittingKeys.delete(submitKey);
    notify();
  }
}

/** Retries every queued photo and every ready draft across every visit — the one function every retry trigger below calls. */
async function retryEverything(): Promise<void> {
  if (!navigator.onLine) return;
  // Only the signed-in user's own queued work — nobody signed in, nothing to retry.
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  const visitIds = await listReadyDraftVisitIds(ownerId);
  for (const visitId of visitIds) {
    if (!isStillCurrentOwner(ownerId)) return;
    const photos = await listPhotosForVisit(ownerId, visitId);
    for (const photo of photos) {
      // 'uploading' is deliberately retried too, not just 'pending'/'failed'
      // — a photo can be left stuck at 'uploading' forever if the page
      // dies (reload, closed, killed) mid-request, after the status write
      // but before the actual upload settles. Without this, that single
      // row would silently block its report's sync indefinitely, with no
      // error ever surfacing (the exact "stuck on Syncing" bug). Safe to
      // retry unconditionally: uploadVisitPhotoToPath() is idempotent
      // (checks existence before uploading), and the in-memory
      // `uploadingIds` guard below still prevents a duplicate concurrent
      // attempt within this same page session.
      if (photo.status === 'pending' || photo.status === 'failed' || photo.status === 'uploading') {
        await attemptUploadPhoto(photo);
      }
    }
    await submitIfReadyForOwner(ownerId, visitId);
  }
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

  window.addEventListener('online', () => {
    void retryEverything();
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
  const storagePath = newVisitPhotoStoragePath(visitId, phase, file.name);
  const photo: PendingPhoto = {
    id: crypto.randomUUID(),
    ownerId,
    visitId,
    phase,
    blob: file,
    storagePath,
    status: 'pending',
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  await putPhoto(photo);
  notify();
  void attemptUploadPhoto(photo);
  return photo;
}

/** Manual retry — the UI's "Retry" button on a failed chip. */
export async function retryPhoto(photo: PendingPhoto): Promise<void> {
  await attemptUploadPhoto(photo);
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
  pendingPhotoCount: number;
  failedDraftCount: number;
}

/** Counts only the signed-in user's own queued work — another user's failed draft never shows up here. */
async function computeSyncStatus(): Promise<SyncStatus> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return { online: navigator.onLine, pendingPhotoCount: 0, failedDraftCount: 0 };
  const [pendingPhotoCount, drafts] = await Promise.all([countUnuploadedPhotos(ownerId), listAllDrafts(ownerId)]);
  return {
    online: navigator.onLine,
    pendingPhotoCount,
    failedDraftCount: drafts.filter((d) => d.readyToSubmit && !!d.submitError).length,
  };
}

/** For TechnicianShell.tsx's header badge — the only consumer of a truly global (cross-visit) summary. */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>({ online: navigator.onLine, pendingPhotoCount: 0, failedDraftCount: 0 });

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