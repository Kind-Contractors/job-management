// Unfinished "Complete & report" submissions, kept on THIS device (IndexedDB) so that closing the dialog, leaving the page or reloading it
// never loses track of one. Only for the office report workflow - not a general offline layer.
//
// Why: an office save is idempotent per request id (20261124120000_office_reports_idempotency.sql), but only while the app still has that
// id. If the reply to a save is lost and the dialog is closed, a later attempt would carry a NEW id - and if the first had gone through,
// that would record the work twice. So the submission (its request id and exactly what was sent, plus the chosen files where they fit) is
// written here BEFORE it is sent, and removed only when the outcome is settled:
//   * the server definitely refused it (nothing was saved) - removed at once;
//   * it was saved and every chosen file was added - removed;
//   * the manager deliberately gives it up (a confirmed "discard", or "close without these files") - removed.
// Anything else stays, and the app offers to finish it (same request id, same values, the kept files) the next time.
//
// Per signed-in user: every record carries the Supabase user id and is only ever read back for that same user, so on a shared computer one
// manager never sees (or resumes) another's. Nothing secret is kept: no tokens or keys - only what the report itself contains (and the
// photos/videos the manager chose).
//
// Files are written ONCE, each in its own record, and never written again (Safari can lose a stored file whose record is re-written - see
// src/technician/offline/db.ts). Everything that changes later (stage, result, which files are on the report) lives in the small
// submission record. Every write can fail (private browsing, storage full, browser refusing): callers are told, and never claim it was kept.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { OfficeReportInput, OfficeReportResult } from '../repository/officeReportsRepository';
import type { MediaPhase, StagedMedia } from './officeReportMedia';
import type { VideoExt, VideoMime } from './reportVideoRules';

const DB_NAME = 'jms-office-report-pending';
const DB_VERSION = 1;

/** One chosen photo/video, without the file itself (that is in the `files` store, written once). */
export interface PendingMediaEntry {
  id: string;
  kind: 'photo' | 'video';
  phase: MediaPhase;
  include: boolean;
  name: string;
  type: string;
  size: number;
  video?: { mime: VideoMime; ext: VideoExt; durationSeconds: number | null; hasThumbnail: boolean };
  /** Set once this file is on the report - it is never sent again. */
  savedId?: string;
}

/**
 * unconfirmed - written before the save is sent; the outcome is not known (still sending, or the reply was lost).
 * saved       - the save is confirmed (result set); some chosen files may still have to be added.
 */
export type PendingStage = 'unconfirmed' | 'saved';

export interface PendingOfficeReport {
  requestId: string;
  /** Supabase auth user id of the manager who made it. Only ever read back for that user. */
  userId: string;
  jobId: string;
  /** For the "awaiting confirmation" notice and the summary - what the manager would recognise. */
  buildingName: string;
  jobSummary: string;
  visitLabel: string;
  /** True when the chosen visit was already completed (the report-only case). */
  visitWasCompleted: boolean;
  stage: PendingStage;
  /** Exactly what is sent (re-sent unchanged, with requestId). */
  input: Omit<OfficeReportInput, 'requestId'>;
  result: OfficeReportResult | null;
  media: PendingMediaEntry[];
  /** True when the files could not be kept (only the submission itself was) - shown honestly when it is resumed. */
  filesNotKept: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PendingFile {
  /** `${requestId}:${mediaId}` or `${requestId}:${mediaId}:thumb` */
  key: string;
  requestId: string;
  blob: Blob;
}

interface PendingDb extends DBSchema {
  submissions: { key: string; value: PendingOfficeReport; indexes: { 'by-user': string; 'by-user-job': [string, string] } };
  files: { key: string; value: PendingFile; indexes: { 'by-request': string } };
}

let dbPromise: Promise<IDBPDatabase<PendingDb>> | null = null;
function db(): Promise<IDBPDatabase<PendingDb>> {
  dbPromise ??= openDB<PendingDb>(DB_NAME, DB_VERSION, {
    upgrade(d) {
      const s = d.createObjectStore('submissions', { keyPath: 'requestId' });
      s.createIndex('by-user', 'userId');
      s.createIndex('by-user-job', ['userId', 'jobId']);
      const f = d.createObjectStore('files', { keyPath: 'key' });
      f.createIndex('by-request', 'requestId');
    },
  }).catch((e) => {
    dbPromise = null; // let a later call try again
    throw e;
  });
  return dbPromise;
}

/** For tests: forget the open connection (fake-indexeddb is reset between some tests). */
export function resetOfficePendingDbForTests(): void {
  dbPromise = null;
}

const fileKey = (requestId: string, mediaId: string, thumb = false) => `${requestId}:${mediaId}${thumb ? ':thumb' : ''}`;

export function mediaEntryOf(m: StagedMedia): PendingMediaEntry {
  return {
    id: m.id,
    kind: m.kind,
    phase: m.phase,
    include: m.include,
    name: m.file.name,
    type: m.file.type,
    size: m.file.size,
    video: m.video ? { mime: m.video.mime, ext: m.video.ext, durationSeconds: m.video.durationSeconds, hasThumbnail: m.video.thumbnail != null } : undefined,
    savedId: m.savedId,
  };
}

/** What a first write managed to keep. 'none' = nothing at all (the caller must not say it was kept). */
export type KeptLevel = 'all' | 'withoutFiles' | 'none';

/**
 * Writes a NEW unfinished submission (before it is sent): the record and, separately and once each, the chosen files. If the files don't
 * fit (storage full) the submission itself is still kept without them - the request id matters most. Never throws.
 */
export async function savePendingSubmission(rec: Omit<PendingOfficeReport, 'filesNotKept'>, media: StagedMedia[]): Promise<KeptLevel> {
  let d: IDBPDatabase<PendingDb>;
  try {
    d = await db();
  } catch {
    return 'none';
  }
  const tx = d.transaction(['submissions', 'files'], 'readwrite');
  tx.done.catch(() => undefined); // a failure is handled below; never an unhandled rejection
  try {
    await tx.objectStore('submissions').put({ ...rec, filesNotKept: false });
    for (const m of media) {
      await tx.objectStore('files').put({ key: fileKey(rec.requestId, m.id), requestId: rec.requestId, blob: m.file });
      if (m.video?.thumbnail) await tx.objectStore('files').put({ key: fileKey(rec.requestId, m.id, true), requestId: rec.requestId, blob: m.video.thumbnail });
    }
    await tx.done;
    return 'all';
  } catch {
    // Most likely the files did not fit. Keep the submission itself (the transaction above was rolled back as a whole).
    try {
      await d.put('submissions', { ...rec, filesNotKept: media.length > 0 });
      return media.length > 0 ? 'withoutFiles' : 'all';
    } catch {
      return 'none';
    }
  }
}

/** Updates the small record only (stage, result, which files are on the report) - the files are never written again. Never throws. */
export async function updatePendingSubmission(requestId: string, change: Partial<Pick<PendingOfficeReport, 'stage' | 'result' | 'media'>>): Promise<boolean> {
  try {
    const d = await db();
    const tx = d.transaction('submissions', 'readwrite');
    const cur = await tx.store.get(requestId);
    if (!cur) {
      await tx.done;
      return false;
    }
    await tx.store.put({ ...cur, ...change, updatedAt: new Date().toISOString() });
    await tx.done;
    return true;
  } catch {
    return false;
  }
}

/** Removes a submission and its files (outcome settled, or deliberately given up). Never throws; false = it could not be removed. */
export async function removePendingSubmission(requestId: string): Promise<boolean> {
  try {
    const d = await db();
    const tx = d.transaction(['submissions', 'files'], 'readwrite');
    await tx.objectStore('submissions').delete(requestId);
    const keys = await tx.objectStore('files').index('by-request').getAllKeys(requestId);
    for (const k of keys) await tx.objectStore('files').delete(k);
    await tx.done;
    return true;
  } catch {
    return false;
  }
}

/** This user's unfinished submission for this job, if any (oldest first if, unusually, there are several). Throws if storage can't be read. */
export async function getPendingSubmission(userId: string, jobId: string): Promise<PendingOfficeReport | null> {
  const d = await db();
  const all = await d.getAllFromIndex('submissions', 'by-user-job', [userId, jobId]);
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** Every unfinished submission of this user (for the "awaiting confirmation" notice). Throws if storage can't be read. */
export async function listPendingSubmissions(userId: string): Promise<PendingOfficeReport[]> {
  const d = await db();
  return (await d.getAllFromIndex('submissions', 'by-user', userId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The kept files of a submission, back as chosen photos/videos (a file that could not be read back is left out and reported in
 * `missing`). Files already on the report come back as 'added'; the rest as 'ready' to send.
 */
export async function restorePendingMedia(rec: PendingOfficeReport): Promise<{ items: StagedMedia[]; missing: PendingMediaEntry[] }> {
  const items: StagedMedia[] = [];
  const missing: PendingMediaEntry[] = [];
  let d: IDBPDatabase<PendingDb> | null = null;
  try {
    d = await db();
  } catch {
    d = null;
  }
  for (const e of rec.media) {
    if (e.savedId) {
      // Already on the report: nothing to send, the file itself is not needed.
      items.push({ id: e.id, kind: e.kind, phase: e.phase, include: e.include, status: 'added', savedId: e.savedId, previewUrl: null, file: new File([], e.name, { type: e.type }), video: e.video ? { mime: e.video.mime, ext: e.video.ext, durationSeconds: e.video.durationSeconds, thumbnail: null } : undefined });
      continue;
    }
    const row = d ? await d.get('files', fileKey(rec.requestId, e.id)).catch(() => undefined) : undefined;
    if (!row?.blob || row.blob.size !== e.size) {
      missing.push(e);
      continue;
    }
    const thumb = e.video?.hasThumbnail && d ? (await d.get('files', fileKey(rec.requestId, e.id, true)).catch(() => undefined))?.blob ?? null : null;
    items.push({
      id: e.id,
      kind: e.kind,
      phase: e.phase,
      include: e.include,
      status: 'ready',
      previewUrl: null,
      file: new File([row.blob], e.name, { type: e.type }),
      video: e.video ? { mime: e.video.mime, ext: e.video.ext, durationSeconds: e.video.durationSeconds, thumbnail: thumb } : undefined,
    });
  }
  return { items, missing };
}
