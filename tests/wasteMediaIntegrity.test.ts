// A saved photo/video is written to the phone's storage ONCE and never written again (src/waste/offline/wasteDb.ts). Safari can lose a
// file when a record holding it is put again with the file it read back after a reload (WebKit bugs 235687 / 240216 - reproduced with
// the app's old pattern), so every later change (status, attempts, upload URL, errors, a skipped poster) goes to a separate record
// with no file in it. These tests count every IndexedDB write that carries a Blob, through whole upload lifecycles.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';

import { setCurrentUserId } from '../src/auth/currentUser';
import {
  addWasteFiles,
  getOrCreateEditingDraft,
  kick,
  listWasteMedia,
  recoverAfterRestart,
  removeWasteMedia,
  retryWaitingUploads,
  retryWasteMedia,
  setWasteEngineDepsForTests,
  updateWasteDraftFields,
  waitForWasteWorker,
  type WasteEngineDeps,
} from '../src/waste/offline/wasteSyncEngine';
import { deleteDraft, deleteMedia, getMedia, listDrafts, listMediaForOwner, putMedia, updateMediaIfPresent, WASTE_DB_NAME, type WasteMedia } from '../src/waste/offline/wasteDb';
import type { VideoUploadOptions } from '../src/waste/wasteApi';
import { UploadError } from '../src/lib/reportVideoUpload';

const OWNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
let ids = 0;
let clock = Date.parse('2026-11-13T10:00:00Z');
const calls = { small: [] as string[], video: [] as { path: string; tusUrl: string | null }[] };
let smallUpload: (path: string) => Promise<void>;
let videoUpload: (o: VideoUploadOptions) => Promise<void>;

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);
const photo = (name: string, n = 1000, seed = 1) => new File([bytes(n, seed)], name, { type: 'image/jpeg', lastModified: seed });
const video = (name: string, n = 4000, seed = 9) => new File([bytes(n, seed)], name, { type: 'video/mp4', lastModified: seed });
const POSTER = new Blob([bytes(300, 5)], { type: 'image/jpeg' });

function deps(over: Partial<WasteEngineDeps> = {}): Partial<WasteEngineDeps> {
  return {
    isOnline: () => true,
    now: () => new Date(clock),
    newId: () => `0000000${++ids}`.slice(-8) + '-0000-4000-8000-000000000000',
    uploadSmallFile: async (path) => { calls.small.push(path); await smallUpload(path); },
    uploadVideoFile: async (path, _b, _t, o) => { calls.video.push({ path, tusUrl: o.tusUrl }); await videoUpload(o); },
    checkUploadedFile: async (path) => ({ result: 'ok', durationSeconds: /\.mp4$/.test(path) ? 12 : null, sizeBytes: null }),
    removeFiles: async () => undefined,
    submitReport: async () => ({ created: true }),
    preparePhoto: async (file) => ({ blob: file, filename: file.name }),
    readVideoMetadata: async () => ({ durationSeconds: 12, thumbnail: POSTER }),
    stallMs: 40,
    videoTurnMs: 60_000,
    isReadable: async () => true,
    ...over,
  };
}

/** Counts every put() on the media store, and how many of them carried a Blob anywhere in the value. */
let puts = { all: 0, withBlob: 0 };
let restorePut: (() => void) | null = null;
function countPuts() {
  const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: (...a: unknown[]) => unknown } } }).IDBObjectStore.prototype;
  const put = proto.put;
  proto.put = function (this: { name: string }, ...args: unknown[]) {
    if (this.name === 'media') {
      puts.all++;
      const hasBlob = (v: unknown): boolean => v instanceof Blob || (!!v && typeof v === 'object' && Object.values(v as object).some(hasBlob));
      if (hasBlob(args[0])) puts.withBlob++;
    }
    return put.apply(this, args);
  };
  restorePut = () => { proto.put = put; };
}

async function rawRows(): Promise<{ key: string; hasBlob: boolean; hasOwner: boolean }[]> {
  const db = await openDB(WASTE_DB_NAME);
  const rows = await db.getAll('media');
  const keys = await db.getAllKeys('media');
  db.close();
  return rows.map((r, i) => ({ key: String(keys[i]), hasBlob: Object.values(r).some((v) => v instanceof Blob), hasOwner: 'ownerId' in r }));
}
const text = async (b: Blob) => Array.from(new Uint8Array(await b.arrayBuffer())).join(',');

beforeEach(async () => {
  setCurrentUserId(OWNER);
  await waitForWasteWorker();
  for (const d of await listDrafts(OWNER)) await deleteDraft(OWNER, d.reportId);
  for (const m of await listMediaForOwner(OWNER)) await deleteMedia(m.id);
  calls.small = [];
  calls.video = [];
  smallUpload = async () => undefined;
  videoUpload = async (o) => { o.onUploadUrl('https://tus/u1'); o.onChunkComplete?.(2000, 4000); o.onProgress(4000, 4000); o.onChunkComplete?.(4000, 4000); };
  setWasteEngineDepsForTests(deps());
  puts = { all: 0, withBlob: 0 };
  countPuts();
});
afterEach(() => { restorePut?.(); restorePut = null; });

async function draft() {
  const d = await getOrCreateEditingDraft();
  await updateWasteDraftFields(d.reportId, { address: '1 Test St' });
  return d.reportId;
}
async function settle() {
  await kick();
  await waitForWasteWorker();
  await new Promise((r) => setTimeout(r, 10));
}

test('ONE WRITE PER FILE: 2 photos + 1 video through the whole upload (TUS URL, chunks, checks, ready) - the files are written once each', async () => {
  const reportId = await draft();
  assert.equal(await addWasteFiles(reportId, 'before', 'photo', [photo('a.jpg', 1000, 1), photo('b.jpg', 1200, 2)]), null);
  assert.equal(await addWasteFiles(reportId, 'after', 'video', [video('v.mp4')]), null);
  await settle();
  const media = await listWasteMedia(reportId);
  assert.deepEqual(media.map((m) => m.status), ['ready', 'ready', 'ready']);
  assert.equal(puts.withBlob, 3, 'exactly one write with a file in it per file (the add)');
  assert.ok(puts.all > 10, `the many status writes still happen (${puts.all}) - just without the files`);
  const v = media.find((m) => m.kind === 'video')!;
  assert.equal(v.thumbUploaded, true);
  assert.equal(await text(v.blob), await text(video('v.mp4')), 'the video reads back byte for byte');
  assert.equal(await text(v.thumbnail!), await text(POSTER), 'and its poster');
});

test('ONE WRITE PER FILE: failures, pauses, retries, "Try again", app restart and coming back - still never rewritten', async () => {
  const reportId = await draft();
  let fail = 3;
  smallUpload = async () => { if (fail-- > 0) throw new UploadError('Bad gateway', 502); };
  videoUpload = async (o) => { o.onUploadUrl('https://tus/u2'); o.onChunkComplete?.(2000, 4000); if (fail-- > 0) throw Object.assign(new TypeError('Load failed'), {}); o.onProgress(4000, 4000); };
  await addWasteFiles(reportId, 'before', 'photo', [photo('p.jpg')]);
  await addWasteFiles(reportId, 'before', 'video', [video('v.mp4')]);
  for (let i = 0; i < 8; i++) {
    await settle();
    await recoverAfterRestart();
    await retryWaitingUploads(undefined, { manual: true });
    for (const m of await listWasteMedia(reportId)) if (m.status !== 'ready') await retryWasteMedia(m.id);
    clock += 15 * 60_000;
  }
  await settle();
  const media = await listWasteMedia(reportId);
  assert.deepEqual(media.map((m) => m.status), ['ready', 'ready'], JSON.stringify(media.map((m) => [m.status, m.lastError])));
  assert.equal(puts.withBlob, 2, 'still exactly one file write per file');
  assert.ok(calls.video.some((c) => c.tusUrl === 'https://tus/u2'), 'the video resumed with its saved upload URL (state kept)');
  assert.equal(await text(media[1].blob), await text(video('v.mp4')));
});

test('STATE: the latest status is what is read back; the file is the one first saved; a late write never brings a removed file back', async () => {
  const reportId = await draft();
  setWasteEngineDepsForTests(deps({ isOnline: () => false }));
  await addWasteFiles(reportId, 'before', 'photo', [photo('s.jpg')]);
  const [m] = await listWasteMedia(reportId);
  await updateMediaIfPresent({ ...m, status: 'checking', attempts: 4, lastError: 'x', tusUrl: 'https://tus/s' });
  const back = (await getMedia(m.id))!;
  assert.deepEqual([back.status, back.attempts, back.lastError, back.tusUrl, back.ownerId, back.reportId], ['checking', 4, 'x', 'https://tus/s', OWNER, reportId]);
  assert.equal(await text(back.blob), await text(photo('s.jpg')));
  // A status update can't replace the saved file, even if handed a different one.
  await updateMediaIfPresent({ ...back, blob: new Blob([]), status: 'pending' } as WasteMedia);
  assert.equal((await getMedia(m.id))!.blob.size, 1000);
  await removeWasteMedia(m.id);
  assert.equal(await updateMediaIfPresent({ ...back, status: 'ready' }), false);
  assert.equal(await getMedia(m.id), undefined);
  assert.deepEqual(await rawRows(), [], 'both the file record and its state record are gone');
});

test('STATE RECORDS: no file, no owner (so never listed by the indexes); a skipped poster reads as none while the stored poster is left alone', async () => {
  const reportId = await draft();
  smallUpload = async (path) => { if (/\.thumb\.jpg$/.test(path)) throw new UploadError('poster refused', 400); };
  await addWasteFiles(reportId, 'before', 'video', [video('v.mp4')]);
  await settle();
  const rows = await rawRows();
  assert.equal(rows.length, 2);
  const state = rows.find((r) => r.key.endsWith('::state'))!;
  assert.deepEqual([state.hasBlob, state.hasOwner], [false, false]);
  const fileRow = rows.find((r) => !r.key.endsWith('::state'))!;
  assert.deepEqual([fileRow.hasBlob, fileRow.hasOwner], [true, true]);
  assert.equal((await listMediaForOwner(OWNER)).length, 1, 'the state record is never listed as a file');
  const [v] = await listWasteMedia(reportId);
  assert.deepEqual([v.status, v.thumbnail, v.thumbPath, typeof v.posterSkipped], ['ready', null, null, 'string'], 'poster skipped, video sent');
  assert.equal(puts.withBlob, 1);
});

test('OLDER RECORDS (saved by the previous version, status inside the file record): read as before and carried on - never rewritten', async () => {
  const reportId = await draft();
  // As the previous version left it: one record with everything, left 'uploading' by a closed app.
  const legacy: WasteMedia = {
    id: '11111111-0000-4000-8000-000000000000', ownerId: OWNER, reportId, kind: 'photo', phase: 'before', blob: photo('old.jpg', 900, 3),
    fileName: 'old.jpg', mime: 'image/jpeg', ext: 'jpg', sizeBytes: 900, sourceKey: 'old.jpg|900|3', durationSeconds: null, thumbnail: null,
    storagePath: `${OWNER}/${reportId}/before/11111111-0000-4000-8000-000000000000.jpg`, thumbPath: null, fileUploaded: false, thumbUploaded: false,
    tusUrl: null, status: 'uploading', progress: 0.4, lastError: 'old', permanentFailure: false, attempts: 2, nextAttemptAt: null, sortOrder: 0,
    createdAt: new Date(clock).toISOString(),
  };
  await putMedia(legacy);
  puts = { all: 0, withBlob: 0 };
  assert.equal((await listWasteMedia(reportId))[0].status, 'uploading', 'read exactly as before');
  await recoverAfterRestart();
  assert.equal((await listWasteMedia(reportId))[0].status, 'pending');
  await settle();
  const [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'ready');
  assert.equal(puts.withBlob, 0, 'the old record (with its file) was never written again');
  assert.equal(await text(m.blob), await text(photo('old.jpg', 900, 3)));
});
