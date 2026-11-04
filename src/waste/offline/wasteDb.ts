// The waste reporter's durable on-phone storage: report drafts and the photos/videos waiting to upload.
//
// A SEPARATE IndexedDB database from the technician app's (offline/db.ts and offline/videoDb.ts): nothing here reads or writes
// those, so neither can ever need the other's schema upgrade. Every record belongs to the signed-in user (ownerId) and is only ever
// listed, uploaded or sent for that user.
//
// A draft stays here until the server has confirmed its report (waste_submit_report); only then are the draft and its files
// deleted. Files upload as soon as they are added (big videos get a head start), each one checked by the server afterwards.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
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
 *  failed     stopped: rejected by the server (permanentFailure) or too many failed attempts - retry or remove it
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
}

interface WasteQueueDB extends DBSchema {
  drafts: {
    key: [string, string];
    value: WasteDraft;
    indexes: { 'by-owner': string };
  };
  media: {
    key: string;
    value: WasteMedia;
    indexes: { 'by-owner': string; 'by-owner-report': [string, string] };
  };
}

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

export async function putMedia(media: WasteMedia): Promise<void> {
  await (await getDb()).put('media', media);
}

export async function getMedia(id: string): Promise<WasteMedia | undefined> {
  return (await getDb()).get('media', id);
}

/** Same rule as updateDraftIfPresent: a removed file is never recreated by a late status update. */
export async function updateMediaIfPresent(media: WasteMedia): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction('media', 'readwrite');
  const current = await tx.store.get(media.id);
  if (!current) {
    await tx.done;
    return false;
  }
  await tx.store.put(media);
  await tx.done;
  return true;
}

export async function listMediaForReport(ownerId: string, reportId: string): Promise<WasteMedia[]> {
  const media = await (await getDb()).getAllFromIndex('media', 'by-owner-report', [ownerId, reportId]);
  return media.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

export async function listMediaForOwner(ownerId: string): Promise<WasteMedia[]> {
  return (await getDb()).getAllFromIndex('media', 'by-owner', ownerId);
}

export async function deleteMedia(id: string): Promise<void> {
  await (await getDb()).delete('media', id);
}
