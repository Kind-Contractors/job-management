// The technician's durable offline queue for VIDEOS - a SEPARATE IndexedDB database from the photo/draft queue (offline/db.ts).
//
// Why separate: the photo queue is in daily use on technicians' phones and has a carefully migrated schema. A video queue added to
// that database would force a schema upgrade of it (a versionchange that every open tab must wait for). A database of its own can
// be created, upgraded or even deleted without ever touching a queued photo or draft - nothing here imports from, or writes to, it.
//
// What a record is: one video the technician picked, kept on the device until the server has confirmed it ("attached"), at which
// point the record - and its large Blob - is deleted and the server's own list takes over. Records are scoped to the signed-in
// user (ownerId), exactly like photos: one technician's videos are never listed, uploaded or counted for another.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { VideoMime, VideoPhase } from '../../lib/reportVideoRules';

/**
 *  pending    waiting for its turn / for a connection / for the next retry
 *  uploading  the file (or its poster) is being sent
 *  attaching  the file is up; the database is being asked to record it against the visit
 *  failed     stopped: either a permanent refusal (see permanentFailure) or too many failed attempts - needs a manual retry or removal
 */
export type QueuedVideoStatus = 'pending' | 'uploading' | 'attaching' | 'failed';

export interface QueuedVideo {
  id: string;
  /** Authenticated Supabase user ID this video belongs to. */
  ownerId: string;
  visitId: string;
  phase: VideoPhase;
  /** The video exactly as picked (never re-encoded). */
  blob: Blob;
  fileName: string;
  mime: VideoMime;
  ext: 'mp4' | 'mov' | 'webm';
  sizeBytes: number;
  /** name|size|lastModified of the picked file - stops the same clip being queued twice in one section. */
  sourceKey: string;
  durationSeconds: number | null;
  /** A JPEG poster made on this device, or null (the UI then shows a plain placeholder). */
  thumbnail: Blob | null;
  status: QueuedVideoStatus;
  /**
   * Where this attempt's files go: {visit}/{phase}/{uuid}.{ext} (and .jpg). Chosen at capture time and kept while the SAME upload
   * is being continued or the file is already up (so the attach step is a harmless repeat); replaced with fresh names when an
   * upload has to start over, so a retry can never collide with a half-finished earlier one.
   */
  videoPath: string;
  thumbPath: string | null;
  videoUploaded: boolean;
  thumbUploaded: boolean;
  /** The resumable-upload URL of the unfinished upload, so the next attempt continues from the last accepted chunk. */
  tusUrl: string | null;
  lastError: string | null;
  /** True only for a refusal retrying can never fix (visit cancelled, report Completed, not your visit, a limit...). Excluded from automatic retries. */
  permanentFailure: boolean;
  /** Failed attempts since the last success or manual retry (attempts made while offline are not counted). */
  attempts: number;
  /** ISO time before which the automatic retry must not run again (backoff). */
  nextAttemptAt: string | null;
  /**
   * IndexedDB is shared by every open tab of the app, so two tabs could both pick up the same video. The tab that is working on a
   * video holds a short lease (taken atomically by claimVideo, extended while it uploads); other tabs leave it alone until it ends.
   */
  leaseUntil: string | null;
  createdAt: string;
}

interface VideoQueueDB extends DBSchema {
  pendingVideos: {
    key: string;
    value: QueuedVideo;
    indexes: { 'by-owner-visit': [string, string] };
  };
}

export const VIDEO_DB_NAME = 'kind-contractors-technician-videos';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<VideoQueueDB>> | null = null;

function getDb(): Promise<IDBPDatabase<VideoQueueDB>> {
  if (!dbPromise) {
    dbPromise = openDB<VideoQueueDB>(VIDEO_DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('pendingVideos', { keyPath: 'id' });
        store.createIndex('by-owner-visit', ['ownerId', 'visitId']);
      },
      blocking() {
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

/** Test hook: forget the cached connection so a test can start from a fresh database. */
export function resetVideoDbConnection(): void {
  void dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = null;
}

/** Key range covering every visit of one owner ('' sorts before any real visit id, '￿' after). */
function ownerRange(ownerId: string): IDBKeyRange {
  return IDBKeyRange.bound([ownerId, ''], [ownerId, '￿']);
}

export async function putVideo(video: QueuedVideo): Promise<void> {
  await (await getDb()).put('pendingVideos', video);
}

export async function getVideo(id: string): Promise<QueuedVideo | undefined> {
  return (await getDb()).get('pendingVideos', id);
}

export async function deleteVideo(id: string): Promise<void> {
  await (await getDb()).delete('pendingVideos', id);
}

/**
 * Applies a change to a record ONLY if it still exists, in one transaction, and returns the updated record (or undefined when it
 * has been removed). Every status update the engine makes goes through this instead of a plain put: a put would re-create a record
 * the technician removed while its upload was in flight, bringing a removed video back to life. This is the guard that makes a stale
 * retry harmless.
 */
export async function updateVideoIfPresent(id: string, change: (current: QueuedVideo) => QueuedVideo): Promise<QueuedVideo | undefined> {
  const tx = (await getDb()).transaction('pendingVideos', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return undefined;
  }
  const next = change(existing);
  await tx.store.put(next);
  await tx.done;
  return next;
}

/**
 * Takes the lease on a video for this tab, atomically: succeeds (returning the updated record, now 'uploading') only when the record
 * still exists and nobody else holds an unexpired lease. Returns undefined when it was removed or another tab is working on it.
 */
export async function claimVideo(id: string, nowIso: string, leaseUntilIso: string): Promise<QueuedVideo | undefined> {
  const tx = (await getDb()).transaction('pendingVideos', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing || (existing.leaseUntil && existing.leaseUntil > nowIso)) {
    await tx.done;
    return undefined;
  }
  const next: QueuedVideo = { ...existing, status: 'uploading', lastError: null, leaseUntil: leaseUntilIso };
  await tx.store.put(next);
  await tx.done;
  return next;
}

export async function listVideosForVisit(ownerId: string, visitId: string): Promise<QueuedVideo[]> {
  const rows = await (await getDb()).getAllFromIndex('pendingVideos', 'by-owner-visit', [ownerId, visitId]);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every queued video of this owner, across visits, oldest first - what the engine walks. */
export async function listAllVideos(ownerId: string): Promise<QueuedVideo[]> {
  const rows = await (await getDb()).getAllFromIndex('pendingVideos', 'by-owner-visit', ownerRange(ownerId));
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
