// The waste reporter's durable on-phone storage: report drafts and the photos/videos waiting to upload.
//
// A SEPARATE IndexedDB database from the technician app's (offline/db.ts and offline/videoDb.ts): nothing here reads or writes
// those, so neither can ever need the other's schema upgrade. Every record belongs to the signed-in user (ownerId) and is only ever
// listed, uploaded or sent for that user.
//
// A draft stays here until the server has confirmed its report (waste_submit_report); only then are the draft and its files
// deleted. Files upload as soon as they are added (big videos get a head start), each one checked by the server afterwards.
import { openDB, unwrap, type DBSchema, type IDBPDatabase } from 'idb';
import type { WasteMediaKind, WastePhase } from '../wasteRules';

export interface WasteDraft {
  ownerId: string;
  /** Chosen on the phone when the draft starts; also the report's id on the server, so sending twice can never make two reports. */
  reportId: string;
  address: string;
  startDate: string;
  endDate: string;
  description: string;
  /** "Send report" was pressed: the report goes as soon as every file has uploaded and passed its check. Fields are locked. */
  submitRequested: boolean;
  submitError: string | null;
  /** The server refused the report in a way retrying can't fix; it needs Jack to act (the message says what). */
  permanentFailure: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 *  pending    waiting for its turn / a connection / the next retry
 *  uploading  being sent (videos resume where they stopped)
 *  checking   uploaded; the server is checking it
 *  ready      uploaded and passed the server's check
 *  failed     stopped for good: refused by the server, or unreadable on the phone (permanentFailure) - remove it
 */
export type WasteMediaStatus = 'pending' | 'uploading' | 'checking' | 'ready' | 'failed';

export interface WasteMedia {
  id: string;
  ownerId: string;
  reportId: string;
  kind: WasteMediaKind;
  phase: WastePhase;
  blob: Blob;
  fileName: string;
  mime: string;
  ext: string;
  sizeBytes: number;
  /** name|size|lastModified of the picked file - stops the same file being added twice to one section. */
  sourceKey: string;
  /** What the phone could read (videos); the server's own figure replaces it once checked. */
  durationSeconds: number | null;
  /** A JPEG poster made on the phone for a video, or null. */
  thumbnail: Blob | null;
  storagePath: string;
  thumbPath: string | null;
  fileUploaded: boolean;
  thumbUploaded: boolean;
  /** Resumable-upload URL of an unfinished video upload, so the next attempt carries on from the last accepted chunk. */
  tusUrl: string | null;
  status: WasteMediaStatus;
  /** 0..1 while uploading. */
  progress: number;
  lastError: string | null;
  permanentFailure: boolean;
  attempts: number;
  nextAttemptAt: string | null;
  sortOrder: number;
  createdAt: string;
  // ---- added 2026-11 (optional: records saved before have none, and need no database upgrade) ----
  /** Why a stopped file stopped: refused by the server, or the phone can no longer read it. */
  failureKind?: 'refused' | 'unreadable' | null;
  /** Bytes of a video the server has CONFIRMED (shown after the app is reopened; the upload resumes from the server's own offset). */
  bytesConfirmed?: number;
  /** Paused to give another report's video its turn - not a failure. */
  pausedForTurn?: boolean;
  /** When lastError happened. */
  lastErrorAt?: string | null;
  /** The technical detail behind lastError (HTTP status, browser message) - for troubleshooting; shown in small print. */
  lastErrorDetail?: string | null;
  /** Failed readability checks in a row, and when the first of them happened (a file is only given up after several, over time). */
  readFailures?: number;
  firstReadFailureAt?: string | null;
  /** Why a video's optional preview image was skipped (the video itself was sent without it). */
  posterSkipped?: string | null;
}

// ---- a saved file is written ONCE; its progress is kept beside it ----------------------------------------------------------------
//
// Safari (WebKit) can lose a saved photo or video when a record holding it is written again with the file it read back: after the
// page has been reloaded or reopened, putting that file back under the same key can make it unreadable - the copy in storage too
// (WebKit bugs 235687 / 240216, reproduced with the app's own pattern). Every status change used to write the whole record again,
// files included, so a file could be lost while it was waiting or uploading.
//
// So the record with the file(s) is written once, when the file is added, and never again. Everything that changes afterwards (status,
// attempts, upload URL, errors...) is written to a separate small record in the same store - key `<id>::state`, no files, no ownerId
// (so the existing indexes never list it; no database upgrade). Reading a file merges the two. The files themselves can only be
// dropped from use (a skipped poster), never replaced, after the first save.
const STATE_SUFFIX = '::state';
const stateKey = (id: string) => `${id}${STATE_SUFFIX}`;

/** The changing part of a file's record (never a Blob, never the owner/report that the indexes use). */
type MediaState = Omit<WasteMedia, 'id' | 'ownerId' | 'reportId' | 'blob' | 'thumbnail'> & {
  /** The poster was dropped (skipped): read as thumbnail null. The stored poster itself is never rewritten. */
  noThumbnail: boolean;
};
interface MediaStateRow {
  id: string;
  state: MediaState;
}

interface WasteQueueDB extends DBSchema {
  drafts: {
    key: [string, string];
    value: WasteDraft;
    indexes: { 'by-owner': string };
  };
  media: {
    key: string;
    value: WasteMedia | MediaStateRow;
    indexes: { 'by-owner': string; 'by-owner-report': [string, string] };
  };
}

function stateOf(media: WasteMedia): MediaState {
  const { id: _id, ownerId: _owner, reportId: _report, blob: _blob, thumbnail, ...rest } = media;
  const state: Record<string, unknown> = { ...rest, noThumbnail: thumbnail == null };
  // Defensive: a Blob is never written again after the first save.
  for (const [k, v] of Object.entries(state)) if (typeof Blob !== 'undefined' && v instanceof Blob) delete state[k];
  return state as MediaState;
}

function merged(base: WasteMedia, row: MediaStateRow | undefined): WasteMedia {
  if (!row) return base;
  const { noThumbnail, ...state } = row.state;
  return { ...base, ...state, id: base.id, ownerId: base.ownerId, reportId: base.reportId, blob: base.blob, thumbnail: noThumbnail ? null : base.thumbnail };
}

const isFileRecord = (v: WasteMedia | MediaStateRow | undefined): v is WasteMedia => !!v && !v.id.endsWith(STATE_SUFFIX);

export const WASTE_DB_NAME = 'kind-contractors-waste-reports';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<WasteQueueDB>> | null = null;

function getDb(): Promise<IDBPDatabase<WasteQueueDB>> {
  if (!dbPromise) {
    dbPromise = openDB<WasteQueueDB>(WASTE_DB_NAME, DB_VERSION, {
      upgrade(db) {
        const drafts = db.createObjectStore('drafts', { keyPath: ['ownerId', 'reportId'] });
        drafts.createIndex('by-owner', 'ownerId');
        const media = db.createObjectStore('media', { keyPath: 'id' });
        media.createIndex('by-owner', 'ownerId');
        media.createIndex('by-owner-report', ['ownerId', 'reportId']);
      },
    });
  }
  return dbPromise;
}

/**
 * The app's own database connection (opened - and created if new - exactly as the app does), for the device compatibility check only:
 * it writes its own test records, never linked to anyone (no ownerId, so no list ever returns them), and removes them again.
 */
export async function wasteDbForDeviceCheck(): Promise<IDBDatabase> {
  return unwrap(await getDb()) as IDBDatabase;
}

export async function putDraft(draft: WasteDraft): Promise<void> {
  await (await getDb()).put('drafts', draft);
}

export async function getDraft(ownerId: string, reportId: string): Promise<WasteDraft | undefined> {
  return (await getDb()).get('drafts', [ownerId, reportId]);
}

export async function listDrafts(ownerId: string): Promise<WasteDraft[]> {
  const drafts = await (await getDb()).getAllFromIndex('drafts', 'by-owner', ownerId);
  return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Writes the draft only if it still exists - a late status write can never bring back a draft that was sent or discarded. */
export async function updateDraftIfPresent(draft: WasteDraft): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction('drafts', 'readwrite');
  const current = await tx.store.get([draft.ownerId, draft.reportId]);
  if (!current) {
    await tx.done;
    return false;
  }
  await tx.store.put(draft);
  await tx.done;
  return true;
}

export async function deleteDraft(ownerId: string, reportId: string): Promise<void> {
  await (await getDb()).delete('drafts', [ownerId, reportId]);
}

/** The FIRST and only write of a file's record, with its file(s) - when it is added. Later changes: updateMediaIfPresent. */
export async function putMedia(media: WasteMedia): Promise<void> {
  await (await getDb()).put('media', media);
}

export async function getMedia(id: string): Promise<WasteMedia | undefined> {
  const tx = (await getDb()).transaction('media', 'readonly');
  const [base, row] = await Promise.all([tx.store.get(id), tx.store.get(stateKey(id))]);
  await tx.done;
  return isFileRecord(base) ? merged(base, row as MediaStateRow | undefined) : undefined;
}

/**
 * Saves what changed about a file (status, attempts, upload URL, errors...) - never the file itself (see above). Same rule as
 * updateDraftIfPresent: a removed file is never recreated by a late status update.
 */
export async function updateMediaIfPresent(media: WasteMedia): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction('media', 'readwrite');
  const current = await tx.store.get(media.id);
  if (!isFileRecord(current)) {
    await tx.done;
    return false;
  }
  await tx.store.put({ id: stateKey(media.id), state: stateOf(media) });
  await tx.done;
  return true;
}

async function withState(bases: (WasteMedia | MediaStateRow)[]): Promise<WasteMedia[]> {
  const files = bases.filter(isFileRecord);
  if (files.length === 0) return [];
  const tx = (await getDb()).transaction('media', 'readonly');
  const rows = await Promise.all(files.map((m) => tx.store.get(stateKey(m.id))));
  await tx.done;
  return files.map((m, i) => merged(m, rows[i] as MediaStateRow | undefined));
}

export async function listMediaForReport(ownerId: string, reportId: string): Promise<WasteMedia[]> {
  const media = await withState(await (await getDb()).getAllFromIndex('media', 'by-owner-report', [ownerId, reportId]));
  return media.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

export async function listMediaForOwner(ownerId: string): Promise<WasteMedia[]> {
  return withState(await (await getDb()).getAllFromIndex('media', 'by-owner', ownerId));
}

export async function deleteMedia(id: string): Promise<void> {
  const tx = (await getDb()).transaction('media', 'readwrite');
  await Promise.all([tx.store.delete(id), tx.store.delete(stateKey(id))]);
  await tx.done;
}
