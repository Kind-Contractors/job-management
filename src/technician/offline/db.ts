// The Technician App's durable offline write-queue — IndexedDB via `idb`
// (a thin promise wrapper around the native API, no behavior change from
// raw IndexedDB, just ergonomics). This is the ONLY new persistence layer
// this feature adds; read-side offline access (today/past/visit
// detail) is handled separately by the per-user TanStack Query persister
// (auth/UserScopedQueryProvider.tsx), which needs no custom schema.
//
// OWNERSHIP (schema v2): every record carries `ownerId` — the authenticated
// Supabase user ID that created it — and every read/write below is scoped to
// one owner, so one technician's drafts/photos are never listed, counted or
// synced for another. Records that existed BEFORE this scoping (schema v1)
// have no owner information and can't be safely attributed to anyone, so the
// v1 -> v2 upgrade keeps every one of them under LEGACY_UNATTRIBUTED_OWNER:
// preserved byte-for-byte, but matching no real user, so hidden from and
// never synced by any account. See the upgrade() comments below.
//
// Two stores:
// - draftReports: at most one row per (owner, visit) (keyPath
//   [ownerId, visitId]) — the
//   in-progress or "ready to submit" report text, mirroring exactly what
//   submitReport()/resubmitReport() already accept, plus queue-only
//   bookkeeping fields (readyToSubmit/submitting) that never leave this
//   device.
// - pendingPhotos: one row per captured photo (keyPath id — a random UUID,
//   globally unique), indexed by [ownerId, visitId]. Holds the actual Blob —
//   durable the instant a photo is
//   captured, regardless of upload outcome. A photo row is only ever
//   deleted after its owning report has been successfully submitted to
//   the server (see syncEngine.ts) — never merely because an upload
//   attempt failed.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PhotoPhase } from '../api';

export type PendingPhotoStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

/**
 * Owner recorded for records written before ownership existed (schema v1).
 * Never equal to a real Supabase user ID, so no signed-in user ever matches
 * it: those records are kept, but not shown to or synced by anyone.
 */
export const LEGACY_UNATTRIBUTED_OWNER = '__unattributed_legacy__';

export interface DraftReport {
  /** Authenticated Supabase user ID this draft belongs to. */
  ownerId: string;
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
  /**
   * True only when the server has explicitly, permanently rejected this
   * exact submission for a reason retrying can never fix (e.g. the visit
   * was reassigned away, or a report already exists but isn't the specific
   * "safe to auto-resolve" case syncEngine.ts handles on its own) — see
   * isPermanentSubmitError() there. Excludes this draft from the automatic
   * 30s/online/focus retry loop; never set for a network-shaped failure,
   * which must keep retrying normally. Absent (undefined) on any draft
   * written before this field existed — treated the same as false.
   */
  permanentFailure?: boolean;
  updatedAt: string;
}

export interface PendingPhoto {
  id: string;
  /** Authenticated Supabase user ID this photo belongs to. */
  ownerId: string;
  visitId: string;
  phase: PhotoPhase;
  blob: Blob;
  /** Generated once, at capture time — never regenerated on retry, so a retried upload always targets the exact same Storage object (see syncEngine.ts's use of upsert). */
  storagePath: string;
  status: PendingPhotoStatus;
  lastError: string | null;
  createdAt: string;
  /** Size in bytes of the file as originally picked, before any resize/compression — only for the failure message; absent on photos queued before this field existed. */
  originalSize?: number;
  /** Consecutive failed upload attempts since the last success or manual retry — drives the automatic retry limit. Absent (treated as 0) on older photos. */
  attempts?: number;
  /** ISO time before which the automatic retry must not run again (backoff). Null/absent = due now. */
  nextAttemptAt?: string | null;
}

interface TechnicianOfflineDB extends DBSchema {
  draftReports: {
    key: [string, string]; // [ownerId, visitId]
    value: DraftReport;
  };
  pendingPhotos: {
    key: string;
    value: PendingPhoto;
    indexes: { 'by-owner-visit': [string, string] };
  };
}

const DB_NAME = 'kind-contractors-technician-offline';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<TechnicianOfflineDB>> | null = null;

function getDb(): Promise<IDBPDatabase<TechnicianOfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TechnicianOfflineDB>(DB_NAME, DB_VERSION, {
      /**
       * v0 -> v2 (brand-new install): just creates the v2 stores.
       *
       * v1 -> v2 (existing users, possibly holding unsynced work) runs as ONE
       * versionchange transaction, so it is all-or-nothing: if any step
       * throws, the whole upgrade aborts and the database stays at v1
       * exactly as it was — nothing can be half-migrated or lost.
       *  - pendingPhotos: same store, same keyPath ('id'); every existing row
       *    (Blob included) is updated IN PLACE with
       *    ownerId = LEGACY_UNATTRIBUTED_OWNER, then the old 'by-visit' index
       *    is replaced by 'by-owner-visit'. No photo is copied or re-read.
       *  - draftReports: its keyPath must change (visitId -> [ownerId,
       *    visitId]) and IndexedDB can't alter a keyPath, so all rows are
       *    read (small text records, no Blobs), the store is recreated with
       *    the new keyPath, and every row is written back with
       *    ownerId = LEGACY_UNATTRIBUTED_OWNER — all inside the same
       *    transaction as the delete.
       * Legacy rows are NOT guessed onto whichever user happens to sign in
       * first; see LEGACY_UNATTRIBUTED_OWNER.
       */
      async upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          db.createObjectStore('draftReports', { keyPath: ['ownerId', 'visitId'] });
          const photos = db.createObjectStore('pendingPhotos', { keyPath: 'id' });
          photos.createIndex('by-owner-visit', ['ownerId', 'visitId']);
          return;
        }

        // oldVersion === 1
        const photoStore = transaction.objectStore('pendingPhotos');
        // The v1 index name isn't in the v2 typed schema; it's a plain string at runtime.
        photoStore.deleteIndex('by-visit' as never);
        photoStore.createIndex('by-owner-visit', ['ownerId', 'visitId']);
        let cursor = await photoStore.openCursor();
        while (cursor) {
          await cursor.update({ ...cursor.value, ownerId: LEGACY_UNATTRIBUTED_OWNER });
          cursor = await cursor.continue();
        }

        const legacyDrafts = (await transaction.objectStore('draftReports').getAll()) as Omit<DraftReport, 'ownerId'>[];
        db.deleteObjectStore('draftReports');
        const draftStore = db.createObjectStore('draftReports', { keyPath: ['ownerId', 'visitId'] });
        for (const draft of legacyDrafts) {
          await draftStore.put({ ...draft, ownerId: LEGACY_UNATTRIBUTED_OWNER });
        }
      },
      blocked() {
        console.warn('[offline queue] Upgrading the offline queue is waiting for another open tab of this app to close or reload.');
      },
      blocking() {
        // A newer version of the app in another tab wants to upgrade — get out of its way.
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

/** Key range spanning every visit belonging to one owner, for the compound [ownerId, visitId] keys/index ('' sorts before any real visit id, '￿' after). */
function ownerRange(ownerId: string): IDBKeyRange {
  return IDBKeyRange.bound([ownerId, ''], [ownerId, '￿']);
}

export async function getDraft(ownerId: string, visitId: string): Promise<DraftReport | undefined> {
  return (await getDb()).get('draftReports', [ownerId, visitId]);
}

/** The draft's own ownerId is the first half of its storage key — a draft can only ever be written under its owner. */
export async function putDraft(draft: DraftReport): Promise<void> {
  await (await getDb()).put('draftReports', draft);
}

export async function deleteDraft(ownerId: string, visitId: string): Promise<void> {
  await (await getDb()).delete('draftReports', [ownerId, visitId]);
}

export async function listPhotosForVisit(ownerId: string, visitId: string): Promise<PendingPhoto[]> {
  return (await getDb()).getAllFromIndex('pendingPhotos', 'by-owner-visit', [ownerId, visitId]);
}

export async function putPhoto(photo: PendingPhoto): Promise<void> {
  await (await getDb()).put('pendingPhotos', photo);
}

export async function deletePhotosForVisit(ownerId: string, visitId: string): Promise<void> {
  const db = await getDb();
  const photos = await db.getAllFromIndex('pendingPhotos', 'by-owner-visit', [ownerId, visitId]);
  const tx = db.transaction('pendingPhotos', 'readwrite');
  await Promise.all(photos.map((p) => tx.store.delete(p.id)));
  await tx.done;
}

/** This owner's queued drafts only (key-range on the owner half of the compound key). */
async function draftsForOwner(ownerId: string): Promise<DraftReport[]> {
  return (await getDb()).getAll('draftReports', ownerRange(ownerId));
}

/** Every visitId with a draft, belonging to this owner, currently queued for (or already mid-) submission — what the sync engine iterates on each retry tick. */
export async function listReadyDraftVisitIds(ownerId: string): Promise<string[]> {
  const drafts = await draftsForOwner(ownerId);
  return drafts.filter((d) => d.readyToSubmit).map((d) => d.visitId);
}

/** This owner's queued drafts, across every visit — used only for the header's global pending/failed summary badge. */
export async function listAllDrafts(ownerId: string): Promise<DraftReport[]> {
  return draftsForOwner(ownerId);
}

/** This owner's queued photos not yet uploaded, across every visit — used only for the header's global pending-count badge. */
export async function countUnuploadedPhotos(ownerId: string): Promise<number> {
  const photos = await (await getDb()).getAllFromIndex('pendingPhotos', 'by-owner-visit', ownerRange(ownerId));
  return photos.filter((p) => p.status !== 'uploaded').length;
}

/** This owner's photos that haven't finished uploading, across every visit and whether or not their report has been completed yet — what the retry sweep walks. */
export async function listUnuploadedPhotos(ownerId: string): Promise<PendingPhoto[]> {
  const photos = await (await getDb()).getAllFromIndex('pendingPhotos', 'by-owner-visit', ownerRange(ownerId));
  return photos.filter((p) => p.status !== 'uploaded');
}

/** How many pre-ownership (schema v1) records are preserved but attributed to no one — surfaced only as a startup console warning, never shown to a user. */
export async function countUnattributedRecords(): Promise<{ drafts: number; photos: number }> {
  const db = await getDb();
  const [drafts, photos] = await Promise.all([
    db.count('draftReports', ownerRange(LEGACY_UNATTRIBUTED_OWNER)),
    db.countFromIndex('pendingPhotos', 'by-owner-visit', ownerRange(LEGACY_UNATTRIBUTED_OWNER)),
  ]);
  return { drafts, photos };
}
