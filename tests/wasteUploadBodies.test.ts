// Uploads that arrive EMPTY: Safari 26 can send an empty request body for a picked File or one read back from the phone's storage
// (WebKit bug 319985); a slice of it is sent correctly. So photos/posters are always sent as a slice, videos are given to tus as a
// slice, and a resumable upload whose server offset stops moving is stopped (instead of resending forever) and retried later.
import 'fake-indexeddb/auto';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { supabase } from '../src/lib/supabaseClient';
import { uploadSmallFile } from '../src/waste/wasteApi';
import { inMemoryChunks, noProgressGuard, NO_PROGRESS_LIMIT, UploadNoProgressError } from '../src/waste/wasteTus';
import { setCurrentUserId } from '../src/auth/currentUser';
import {
  addWasteFiles,
  getOrCreateEditingDraft,
  kick,
  listWasteMedia,
  setWasteEngineDepsForTests,
  updateWasteDraftFields,
  waitForWasteWorker,
  type WasteEngineDeps,
} from '../src/waste/offline/wasteSyncEngine';
import { deleteDraft, deleteMedia, listDrafts, listMediaForOwner } from '../src/waste/offline/wasteDb';

test('PHOTO/POSTER BODY: always sent as a slice of the stored file (no copy) - even when its type already matches', async () => {
  (supabase.auth as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ data: { session: { access_token: 'tok' } } });
  const stored = new File([new Uint8Array([1, 2, 3, 4, 5])], 'p.jpg', { type: 'image/jpeg' });
  const sliceCalls: unknown[][] = [];
  const realSlice = Blob.prototype.slice;
  Blob.prototype.slice = function (this: Blob, ...a: unknown[]) {
    if (this === stored) sliceCalls.push(a);
    return realSlice.apply(this, a as []);
  };
  const realFetch = globalThis.fetch;
  let sent: FormData | null = null;
  globalThis.fetch = (async (_url: unknown, init: { body: FormData }) => {
    sent = init.body;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await uploadSmallFile('o/r/before/x.jpg', stored, 'image/jpeg');
  } finally {
    Blob.prototype.slice = realSlice;
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sliceCalls, [[0, 5, 'image/jpeg']], 'one slice of the whole file, with its type');
  const part = (sent as unknown as FormData).get('') as Blob;
  assert.notEqual(part, stored, 'the stored file object itself is never the request body');
  assert.deepEqual([part.size, part.type, Array.from(new Uint8Array(await part.arrayBuffer()))], [5, 'image/jpeg', [1, 2, 3, 4, 5]], 'same bytes');
});

test('VIDEO BODY: the stored video is given to tus as a slice (source check)', () => {
  const api = readFileSync(join(process.cwd(), 'src', 'waste', 'wasteApi.ts'), 'utf8');
  assert.match(api, /file: blob\.slice\(0, blob\.size, contentType\),/);
});

test('VIDEO CHUNKS: tus is given each chunk as an in-memory copy of exactly those bytes (Safari sends a slice of a stored file from its start)', async () => {
  const size = 6 * 1024 * 1024 + 1234;
  const original = Uint8Array.from({ length: size }, (_, i) => (i * 7 + 3) % 256);
  const stored = new File([original], 'v.mp4', { type: 'video/mp4' });
  const source = await inMemoryChunks.openFile(stored);
  assert.equal(source.size, size);
  const C = 6 * 1024 * 1024;
  const first = await source.slice(0, C);
  const second = await source.slice(C, C * 2); // tus asks past the end for the last chunk
  assert.notEqual(first.value, stored);
  assert.deepEqual([first.done, second.done, first.value.size, second.value.size, second.value.type], [false, true, C, 1234, 'video/mp4']);
  assert.deepEqual(new Uint8Array(await first.value.arrayBuffer()), original.subarray(0, C), 'chunk 1: exactly bytes 0..6 MB');
  assert.deepEqual(new Uint8Array(await second.value.arrayBuffer()), original.subarray(C), 'chunk 2: exactly the bytes from its OFFSET, not from the start');
  const mid = await source.slice(1000, 3000);
  assert.deepEqual(new Uint8Array(await mid.value.arrayBuffer()), original.subarray(1000, 3000));
  const tus = readFileSync(join(process.cwd(), 'src', 'waste', 'wasteTus.ts'), 'utf8');
  assert.match(tus, /fileReader: inMemoryChunks,/, 'the uploader uses it');
});

test('VIDEO CHUNKS: a chunk that can no longer be read rejects (tus reports an error; never sent as wrong or empty bytes)', async () => {
  const broken = new Blob([new Uint8Array(10)]);
  Object.defineProperty(broken, 'slice', { value: () => ({ arrayBuffer: () => Promise.reject(new DOMException('The I/O read operation failed.', 'NotReadableError')) }) });
  const source = await inMemoryChunks.openFile(broken);
  await assert.rejects(source.slice(0, 10), { name: 'NotReadableError' });
});

test('NO PROGRESS: an offset that stops moving trips after NO_PROGRESS_LIMIT confirmations; a moving one never does', () => {
  assert.equal(NO_PROGRESS_LIMIT, 2);
  const stuck = noProgressGuard();
  assert.deepEqual([0, 0, 0].map(stuck), [false, false, true], 'empty requests: the server stays at 0');
  const stuckLater = noProgressGuard();
  assert.deepEqual([6291456, 6291456, 6291456].map(stuckLater), [false, false, true], 'stuck after the first chunk');
  const moving = noProgressGuard();
  assert.deepEqual([6291456, 12582912, 18874368, 20000000].map(moving), [false, false, false, false]);
  const blip = noProgressGuard();
  assert.deepEqual([6291456, 6291456, 12582912, 12582912, 18874368].map(blip), [false, false, false, false, false], 'one repeat (a retried chunk) is fine');
});

// ---- the engine: a no-progress attempt is a normal, retried failure with an honest reason -----------------------------------------
const OWNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
let ids = 0;
let clock = Date.parse('2026-11-13T12:00:00Z');
let videoCalls = 0;
const deps = (): Partial<WasteEngineDeps> => ({
  isOnline: () => true,
  now: () => new Date(clock),
  newId: () => `0000000${++ids}`.slice(-8) + '-0000-4000-8000-000000000000',
  uploadSmallFile: async () => undefined,
  uploadVideoFile: async (_p, _b, _t, o) => {
    videoCalls++;
    o.onUploadUrl('https://tus/np');
    if (videoCalls === 1) throw new UploadNoProgressError(0);
    o.onProgress(4000, 4000);
  },
  checkUploadedFile: async () => ({ result: 'ok', durationSeconds: 12, sizeBytes: null }),
  removeFiles: async () => undefined,
  submitReport: async () => ({ created: true }),
  preparePhoto: async (file) => ({ blob: file, filename: file.name }),
  readVideoMetadata: async () => ({ durationSeconds: 12, thumbnail: null }),
  stallMs: 40,
  videoTurnMs: 60_000,
  isReadable: async () => true,
});
beforeEach(async () => {
  setCurrentUserId(OWNER);
  await waitForWasteWorker();
  for (const d of await listDrafts(OWNER)) await deleteDraft(OWNER, d.reportId);
  for (const m of await listMediaForOwner(OWNER)) await deleteMedia(m.id);
  videoCalls = 0;
  setWasteEngineDepsForTests(deps());
});

test('ENGINE: "no data reached the server" waits and retries (resuming the same upload), then uploads - never marked uploaded early', async () => {
  const d = await getOrCreateEditingDraft();
  await updateWasteDraftFields(d.reportId, { address: '1 Test St' });
  await addWasteFiles(d.reportId, 'before', 'video', [new File([new Uint8Array(4000)], 'v.mp4', { type: 'video/mp4', lastModified: 1 })]);
  await kick();
  await waitForWasteWorker();
  let [m] = await listWasteMedia(d.reportId);
  assert.deepEqual([m.status, m.fileUploaded, m.lastError, m.attempts, m.tusUrl], ['pending', false, 'No data reached the server. The upload will be tried again.', 1, 'https://tus/np']);
  assert.match(m.lastErrorDetail ?? '', /received no data/);
  clock += 10 * 60_000;
  await kick();
  await waitForWasteWorker();
  [m] = await listWasteMedia(d.reportId);
  assert.deepEqual([m.status, m.fileUploaded, videoCalls], ['ready', true, 2]);
});
