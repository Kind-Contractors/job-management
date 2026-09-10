// The Technician App's durable offline write-queue — IndexedDB via `idb`
// (a thin promise wrapper around the native API, no behavior change from
// raw IndexedDB, just ergonomics). This is the ONLY new persistence layer
// this feature adds; read-side offline access (today/upcoming/visit
// detail) is handled separately by the TanStack Query persister in
// main.tsx, which needs no custom schema.
//
// Two stores:
// - draftReports: at most one row per visit (keyPath visitId) — the
//   in-progress or "ready to submit" report text, mirroring exactly what
//   submitReport()/resubmitReport() already accept, plus queue-only
//   bookkeeping fields (readyToSubmit/submitting) that never leave this
//   device.
// - pendingPhotos: one row per captured photo (keyPath id), indexed by
//   visitId. Holds the actual Blob — durable the instant a photo is
//   captured, regardless of upload outcome. A photo row is only ever
//   deleted after its owning report has been successfully submitted to
//   the server (see syncEngine.ts) — never merely because an upload
//   attempt failed.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PhotoPhase } from '../api';

export type PendingPhotoStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface DraftReport {
  visitId: string;
  mode: 'submit' | 'resubmit';
  /** Only set when mode === 'resubmit' — the existing report being corrected. */
  reportId: string | null;
  workCarriedOut: string | null;
  technicianNotes: string | null;
  issues: string | null;
  /** Only meaningful for mode === 'submit' — a resubmission never re-captures on-site timing. */
  onSiteStart: string | null;
  /**
   * Captured the instant "Complete job" is tapped — not recomputed later
   * when the background sync actually calls the submit RPC, which could be
   * hours after the technician actually left. This is what keeps the
   * arrival/departure record honest under a deferred, background submit.
   */
  onSiteEnd: string | null;
  /** true = specification completed (default); false = technician selected "Something not done". Freely toggleable up until readyToSubmit; never itself blocks submission either way — see technician_submit_report()/technician_resubmit_report(). */
  specMet: boolean;
  /** Set the moment "Complete job" is tapped — from then on this draft is queued for automatic submission, never re-editable by the technician. */
  readyToSubmit: boolean;
  /** In-flight guard — true only while trySubmitIfReady() has an actual submit RPC call in progress for this visit, so a second concurrent trigger (e.g. an 'online' event firing mid-attempt) can't start a duplicate call. */
  submitting: boolean;
  /** The most recent submit attempt's error, if any — shown in the UI; cleared on the next successful attempt (the draft/photos are deleted entirely at that point anyway). */
  submitError: string | null;
  updatedAt: string;
}

export interface PendingPhoto {
  id: string;
  visitId: string;
  phase: PhotoPhase;
  blob: Blob;
  /** Generated once, at capture time — never regenerated on retry, so a retried upload always targets the exact same Storage object (see syncEngine.ts's use of upsert). */
  storagePath: string;
  status: PendingPhotoStatus;
  lastError: string | null;
  createdAt: string;
}

interface TechnicianOfflineDB extends DBSchema {
  draftReports: {
    key: string;
    value: DraftReport;
  };
  pendingPhotos: {
    key: string;
    value: PendingPhoto;
    indexes: { 'by-visit': string };
  };
}

let dbPromise: Promise<IDBPDatabase<TechnicianOfflineDB>> | null = null;

function getDb(): Promise<IDBPDatabase<TechnicianOfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TechnicianOfflineDB>('kind-contractors-technician-offline', 1, {
      upgrade(db) {
        db.createObjectStore('draftReports', { keyPath: 'visitId' });
        const photos = db.createObjectStore('pendingPhotos', { keyPath: 'id' });
        photos.createIndex('by-visit', 'visitId');
      },
    });
  }
  return dbPromise;
}

export async function getDraft(visitId: string): Promise<DraftReport | undefined> {
  return (await getDb()).get('draftReports', visitId);
}

export async function putDraft(draft: DraftReport): Promise<void> {
  await (await getDb()).put('draftReports', draft);
}

export async function deleteDraft(visitId: string): Promise<void> {
  await (await getDb()).delete('draftReports', visitId);
}

export async function listPhotosForVisit(visitId: string): Promise<PendingPhoto[]> {
  return (await getDb()).getAllFromIndex('pendingPhotos', 'by-visit', visitId);
}

export async function putPhoto(photo: PendingPhoto): Promise<void> {
  await (await getDb()).put('pendingPhotos', photo);
}

export async function deletePhotosForVisit(visitId: string): Promise<void> {
  const db = await getDb();
  const photos = await db.getAllFromIndex('pendingPhotos', 'by-visit', visitId);
  const tx = db.transaction('pendingPhotos', 'readwrite');
  await Promise.all(photos.map((p) => tx.store.delete(p.id)));
  await tx.done;
}

/** Every visitId with a draft currently queued for (or already mid-) submission — what the sync engine iterates on each retry tick, and what the header's pending-count badge sums up. */
export async function listReadyDraftVisitIds(): Promise<string[]> {
  const drafts = await (await getDb()).getAll('draftReports');
  return drafts.filter((d) => d.readyToSubmit).map((d) => d.visitId);
}

/** Every queued draft, across every visit — used only for the header's global pending/failed summary badge. */
export async function listAllDrafts(): Promise<DraftReport[]> {
  return (await getDb()).getAll('draftReports');
}

/** Every queued photo not yet uploaded, across every visit — used only for the header's global pending-count badge. */
export async function countUnuploadedPhotos(): Promise<number> {
  const photos = await (await getDb()).getAll('pendingPhotos');
  return photos.filter((p) => p.status !== 'uploaded').length;
}