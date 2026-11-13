// A picked photo or video that can't be SAVED on the phone (IndexedDB refuses it - e.g. a private browsing tab, where WebKit can't
// keep Blobs, or a full phone): it is not added, nothing is queued or uploaded, the reporter is told in plain words, and no promise
// is left rejected. Photos and videos that save normally behave exactly as before. (src/waste/offline/wasteSyncEngine.ts +
// src/waste/NewWasteReportPage.tsx)
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { setCurrentUserId } from '../src/auth/currentUser';
import {
  addWasteFiles,
  addWasteMedia,
  getOrCreateEditingDraft,
  kick,
  listWasteMedia,
  mediaNotSavedMessage,
  setWasteEngineDepsForTests,
  updateWasteDraftFields,
  waitForWasteWorker,
  type WasteEngineDeps,
} from '../src/waste/offline/wasteSyncEngine';
import { deleteDraft, deleteMedia, getDraft, listDrafts, listMediaForOwner } from '../src/waste/offline/wasteDb';

const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PRIVATE_TAB = 'Error preparing Blob/File data to be stored in object store'; // WebKit's own message (ephemeral session)
let ids = 0;
const calls = { small: [] as string[], video: [] as string[] };

const photo = (name = 'a.jpg', size = 1000) => new File([new Uint8Array(size)], name, { type: 'image/jpeg', lastModified: 1 });
const video = (name = 'clip.mp4', size = 4000) => new File([new Uint8Array(size)], name, { type: 'video/mp4', lastModified: 2 });

const deps: Partial<WasteEngineDeps> = {
  isOnline: () => true,
  now: () => new Date('2026-11-13T10:00:00Z'),
  newId: () => `0000000${++ids}`.slice(-8) + '-0000-4000-8000-000000000000',
  uploadSmallFile: async (path) => { calls.small.push(path); },
  uploadVideoFile: async (path, _b, _t, opts) => { calls.video.push(path); opts.onUploadUrl('https://tus/u'); opts.onProgress(1); },
  checkUploadedFile: async (path) => ({ result: 'ok', durationSeconds: /\.mp4$/.test(path) ? 12 : null, sizeBytes: null }),
  removeFiles: async () => undefined,
  submitReport: async () => ({ created: true }),
  preparePhoto: async (file) => ({ blob: file, filename: file.name }),
  readVideoMetadata: async () => ({ durationSeconds: 12, thumbnail: new Blob([new Uint8Array(10)], { type: 'image/jpeg' }) }),
  stallMs: 40,
  videoTurnMs: 60_000,
  isReadable: async () => true,
};

/** Makes IndexedDB refuse every write to the `media` store the way the browser does (drafts still save, as in the real case). */
function refuseMediaWrites(name: 'UnknownError' | 'QuotaExceededError', message: string) {
  const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: (...a: unknown[]) => unknown } } }).IDBObjectStore.prototype;
  const put = proto.put;
  proto.put = function (this: { name: string }, ...args: unknown[]) {
    if (this.name === 'media') throw new DOMException(message, name);
    return put.apply(this, args);
  };
  return () => { proto.put = put; };
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(async () => {
  setCurrentUserId(OWNER);
  await waitForWasteWorker();
  for (const d of await listDrafts(OWNER)) await deleteDraft(OWNER, d.reportId);
  for (const m of await listMediaForOwner(OWNER)) await deleteMedia(m.id);
  calls.small = [];
  calls.video = [];
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  setWasteEngineDepsForTests(deps);
});
afterEach(() => { process.off('unhandledRejection', onUnhandled); });

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

test('PHOTO not saved: not added, nothing queued or uploaded, a plain message - and the draft is kept', async () => {
  const reportId = await draft();
  const restore = refuseMediaWrites('UnknownError', PRIVATE_TAB);
  let result;
  try {
    result = await addWasteMedia(reportId, 'before', 'photo', photo());
  } finally {
    restore();
  }
  assert.deepEqual(result, {
    ok: false,
    message: 'This photo couldn’t be saved on this phone, so it hasn’t been added. If you’re using a private browsing tab, open the app in a normal tab and add it again.',
  });
  await settle();
  assert.deepEqual(await listWasteMedia(reportId), [], 'no partly created record');
  assert.equal(calls.small.length, 0, 'nothing uploaded');
  assert.equal((await getDraft(OWNER, reportId))?.address, '1 Test St', 'the draft and its text are kept');
  assert.deepEqual(unhandled, []);
});

test('VIDEO not saved: not added, nothing queued or uploaded, the video message', async () => {
  const reportId = await draft();
  const restore = refuseMediaWrites('UnknownError', PRIVATE_TAB);
  let result;
  try {
    result = await addWasteMedia(reportId, 'before', 'video', video());
  } finally {
    restore();
  }
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /^This video couldn’t be saved on this phone, so it hasn’t been added\. If you’re using a private browsing tab/);
  await settle();
  assert.deepEqual(await listWasteMedia(reportId), []);
  assert.deepEqual([calls.small.length, calls.video.length], [0, 0], 'neither the video nor its poster is uploaded');
  assert.deepEqual(unhandled, []);
});

test('OUT OF SPACE: says so (not the private-tab advice)', async () => {
  assert.equal(
    mediaNotSavedMessage('video', new DOMException('quota', 'QuotaExceededError')),
    'This video couldn’t be saved on this phone, so it hasn’t been added: the phone is out of storage space. Free up some space and add it again.',
  );
  const reportId = await draft();
  const restore = refuseMediaWrites('QuotaExceededError', 'The quota has been exceeded.');
  try {
    assert.match(await addWasteFiles(reportId, 'after', 'photo', [photo()]) ?? '', /^This photo couldn’t be saved on this phone, so it hasn’t been added: the phone is out of storage space/);
  } finally {
    restore();
  }
});

test('PICKER (what the page calls): never rejects - a save failure comes back as the message; no false success; no unhandled rejection', async () => {
  const reportId = await draft();
  const restore = refuseMediaWrites('UnknownError', PRIVATE_TAB);
  let problem: string | null = null;
  try {
    problem = await addWasteFiles(reportId, 'before', 'video', [video('a.mp4'), video('b.mp4')]);
  } finally {
    restore();
  }
  assert.match(problem ?? '', /^This video couldn’t be saved on this phone/);
  await settle();
  assert.deepEqual(await listWasteMedia(reportId), [], 'neither file was added (it stops at the first)');
  assert.deepEqual(unhandled, []);
});

test('PICKER: an unexpected failure anywhere in adding (not just the save) also becomes a message, never a rejection', async () => {
  const reportId = await draft();
  setWasteEngineDepsForTests({ ...deps, preparePhoto: async () => { throw new Error('canvas exploded'); } });
  const problem = await addWasteFiles(reportId, 'before', 'photo', [photo()]);
  assert.match(problem ?? '', /^This photo couldn’t be saved on this phone/);
  assert.deepEqual(await listWasteMedia(reportId), []);
  assert.deepEqual(unhandled, []);
});

test('UNCHANGED: photos and videos that save are added, uploaded and checked as before; the picker answers null', async () => {
  const reportId = await draft();
  assert.equal(await addWasteFiles(reportId, 'before', 'photo', [photo('p1.jpg'), photo('p2.jpg', 1200)]), null);
  assert.equal(await addWasteFiles(reportId, 'after', 'video', [video()]), null);
  const added = await listWasteMedia(reportId);
  // Added and saved at once (their uploads start in the background straight away, as before).
  assert.deepEqual(added.map((m) => [m.kind, m.phase, m.blob.size]), [['photo', 'before', 1000], ['photo', 'before', 1200], ['video', 'after', 4000]]);
  await settle();
  const after = await listWasteMedia(reportId);
  assert.ok(after.every((m) => m.status === 'ready'), JSON.stringify(after.map((m) => m.status)));
  assert.equal(calls.small.filter((p) => /\/before\//.test(p)).length, 2, 'both photos uploaded');
  assert.equal(calls.video.length, 1, 'the video uploaded');
  assert.deepEqual(unhandled, []);
});

test('UNCHANGED: a refused pick (same file twice) still comes back as its own message, as before', async () => {
  const reportId = await draft();
  assert.equal(await addWasteFiles(reportId, 'before', 'photo', [photo()]), null);
  assert.equal(await addWasteFiles(reportId, 'before', 'photo', [photo()]), 'That file is already in this section.');
});

test('PAGE: the picker handler uses the never-rejecting add and shows its message under the section (role=alert)', () => {
  const page = readFileSync(join(process.cwd(), 'src', 'waste', 'NewWasteReportPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const handler = page.slice(page.indexOf('const handleAdd = async'), page.indexOf('const send = async'));
  assert.match(handler, /const problem = await addWasteFiles\(draft\.reportId, phase, kind, files\);/);
  assert.match(handler, /if \(problem\) setAddErrors\(\(e\) => \(\{ \.\.\.e, \[phase\]: problem \}\)\);/);
  assert.doesNotMatch(page, /\baddWasteMedia\b/, 'the page no longer calls the add that can reject');
  const section = readFileSync(join(process.cwd(), 'src', 'waste', 'WasteMediaSection.tsx'), 'utf8');
  assert.match(section, /\{addError && \(\s*<p role="alert"[^>]*>\s*\{addError\}/);
});
