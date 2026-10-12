// Technician video queue: the REAL queue and engine code over a fake IndexedDB, with the network (upload, database calls, clock) replaced by
// controllable fakes. These are MOCKED tests - they prove the client logic (what is queued, in what order things are sent, what is retried,
// what can never come back); they do not prove the live database / Storage / TUS server, which is checked separately against DEV.
import 'fake-indexeddb/auto';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { setCurrentUserId } from '../src/auth/currentUser';
import { RpcError } from '../src/technician/api';
import { UploadCancelledError, UploadError } from '../src/lib/reportVideoUpload';
import {
  VIDEO_DB_NAME,
  claimVideo,
  deleteVideo,
  getVideo,
  listAllVideos,
  listVideosForVisit,
  updateVideoIfPresent,
  type QueuedVideo,
} from '../src/technician/offline/videoDb';
import {
  VideoRejectedError,
  enqueueVideo,
  getVideoProgress,
  kickVideoQueue,
  normaliseInterrupted,
  removeQueuedVideo,
  retryQueuedVideo,
  setVideoEngineDepsForTests,
  subscribeVideoAttached,
  type VideoEngineDeps,
} from '../src/technician/offline/videoSyncEngine';
import { MAX_AUTO_ATTEMPTS, backoffDelayMs, classifyVideoFailure, videoDisplay } from '../src/technician/offline/videoQueueLogic';
import { putPhoto, getPhoto, type PendingPhoto } from '../src/technician/offline/db';

const nav: { onLine: boolean } = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });

const OWNER = 'tech-1';
setCurrentUserId(OWNER);

// ---- fakes ------------------------------------------------------------------------------------------------------------------------
let clock = Date.parse('2026-10-12T10:00:00.000Z');
let log: string[] = [];
let removedObjects: string[] = [];
let attachCalls: Parameters<VideoEngineDeps['attach']>[0][] = [];
let uploaderArgs: Parameters<VideoEngineDeps['uploader']>[0][] = [];
let serverSeq = 0;
let attached: string[] = [];
let unsubscribe: () => void = () => {};

function fakes(over: Partial<VideoEngineDeps> = {}): void {
  setVideoEngineDepsForTests({
    isOnline: () => nav.onLine,
    now: () => new Date(clock),
    getAccessToken: async () => 'technician-session-token',
    endpoint: () => 'https://tests.invalid/storage/v1/upload/resumable',
    apiKey: () => 'public-anon-key',
    uploadThumbnail: async (path) => { log.push(`thumb:${path}`); },
    uploader: async (a) => {
      uploaderArgs.push(a);
      log.push(`upload:${a.objectName}`);
      a.onUploadUrl?.('https://tests.invalid/upload/abc');
      a.onProgress?.(50, 100);
      a.onProgress?.(100, 100);
    },
    attach: async (i) => {
      attachCalls.push(i);
      log.push(`attach:${i.videoPath}`);
      return `server-${++serverSeq}`;
    },
    deleteServerVideo: async (id) => { log.push(`delete-server:${id}`); },
    removeObjects: async (paths) => { removedObjects.push(...paths); },
    ...over,
  });
}

beforeEach(async () => {
  // Clean up while OFFLINE, so nothing a previous test left queued can be uploaded during setup.
  nav.onLine = false;
  setCurrentUserId(OWNER);
  fakes();
  await kickVideoQueue(); // let any pass still running from the previous test finish
  for (const v of await listAllVideos(OWNER)) await deleteVideo(v.id);
  for (const v of await listAllVideos('tech-2')) await deleteVideo(v.id);
  clock = Date.parse('2026-10-12T10:00:00.000Z');
  log = [];
  removedObjects = [];
  attachCalls = [];
  uploaderArgs = [];
  attached = [];
  serverSeq = 0;
  fakes();
  nav.onLine = true;
  unsubscribe();
  unsubscribe = subscribeVideoAttached((visitId) => attached.push(visitId));
});

let fileSeq = 0;
const file = (name = 'clip.mp4', type = 'video/mp4', size = 5000) => new File([new Uint8Array(size)], name, { type, lastModified: ++fileSeq });
const meta = (seconds: number | null = 20, thumb = true) => ({ durationSeconds: seconds, thumbnail: thumb ? new Blob(['jpeg'], { type: 'image/jpeg' }) : null });
const idle = () => kickVideoQueue();
const go = async (pred: () => boolean | Promise<boolean>, ms = 1000) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};
async function one(visitId: string): Promise<QueuedVideo> {
  const rows = await listVideosForVisit(OWNER, visitId);
  assert.equal(rows.length, 1, 'exactly one queued video');
  return rows[0];
}

// ===== what may be queued ============================================================================================================
test('VALIDATION: a valid video is saved on the device straight away (before any network), as pending', async () => {
  nav.onLine = false;
  const v = await enqueueVideo('v-valid', 'before', file(), meta(), []);
  assert.equal(v.status, 'pending');
  assert.equal(v.ownerId, OWNER);
  assert.match(v.videoPath, /^v-valid\/before\/[0-9a-f-]{36}\.mp4$/);
  assert.match(v.thumbPath!, /^v-valid\/before\/[0-9a-f-]{36}\.jpg$/);
  assert.equal((await one('v-valid')).id, v.id, 'it is in IndexedDB');
  assert.deepEqual(log, [], 'nothing was sent');
});

test('VALIDATION: wrong type, over 150 MiB, over 60 s, a full section, a full visit and the same clip twice are all refused with a plain sentence', async () => {
  nav.onLine = false;
  const refuse = async (f: File, phase: any, m: any, server: any[], re: RegExp, visit = 'v-refuse') => {
    await assert.rejects(enqueueVideo(visit, phase, f, m, server), (e: any) => e instanceof VideoRejectedError && re.test(e.message), String(re));
  };
  await refuse(file('notes.txt', 'text/plain'), 'before', meta(), [], /MP4, MOV or WebM/);
  await refuse(file('big.mp4', 'video/mp4', 157_286_401), 'before', meta(), [], /150 MB/);
  await refuse(file(), 'before', meta(75), [], /1:15 long\. The limit is 1:00/);
  await refuse(file(), 'before', meta(), [{ phase: 'before' }, { phase: 'before' }, { phase: 'before' }], /Before section already has 3 videos/);
  await refuse(file(), 'after', meta(), Array.from({ length: 8 }, (_, i) => ({ phase: (['before', 'during'] as const)[i % 2] })), /already has 8 videos/);
  assert.equal((await listVideosForVisit(OWNER, 'v-refuse')).length, 0, 'nothing was queued by any refusal');
  const f = file('same.mp4');
  await enqueueVideo('v-dup', 'during', f, meta(), []);
  await refuse(f, 'during', meta(), [], /already waiting to upload/, 'v-dup');
  assert.equal((await listVideosForVisit(OWNER, 'v-dup')).length, 1);
});

test('VALIDATION: the limits count the technician\'s videos already with the office PLUS the ones queued here', async () => {
  nav.onLine = false;
  const server = [{ phase: 'before' as const }, { phase: 'before' as const }];
  await enqueueVideo('v-count', 'before', file(), meta(), server); // 2 + 1 = 3
  await assert.rejects(enqueueVideo('v-count', 'before', file(), meta(), server), /Before section already has 3 videos/);
  await enqueueVideo('v-count', 'during', file(), meta(), server); // another section is fine
});

test('DUPLICATE PREVENTION: two simultaneous picks of the same clip (a double tap) queue it once; two simultaneous picks cannot both slip past a limit', async () => {
  nav.onLine = false;
  const f = file('double.mp4');
  const results = await Promise.allSettled([enqueueVideo('v-race', 'before', f, meta(), []), enqueueVideo('v-race', 'before', f, meta(), [])]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await listVideosForVisit(OWNER, 'v-race')).length, 1);
  const server = [{ phase: 'during' as const }, { phase: 'during' as const }];
  const two = await Promise.allSettled([enqueueVideo('v-race2', 'during', file(), meta(), server), enqueueVideo('v-race2', 'during', file(), meta(), server)]);
  assert.equal(two.filter((r) => r.status === 'fulfilled').length, 1, 'only one fits in the third slot');
});

// ===== offline queuing and a normal upload ========================================================================================
test('OFFLINE: a video added offline waits, says so, sends nothing - and goes up on its own once the device is back online', async () => {
  nav.onLine = false;
  const v = await enqueueVideo('v-offline', 'after', file(), meta(), []);
  await idle();
  assert.deepEqual(log, []);
  assert.equal(videoDisplay(v, false, null).label, 'Saved on this device · waiting for a connection');
  nav.onLine = true;
  await idle();
  assert.equal(await getVideo(v.id), undefined, 'confirmed by the server: the local copy is gone');
  assert.deepEqual(attached, ['v-offline'], 'the screen is told to re-read the server list');
  assert.deepEqual(log.map((l) => l.split(':')[0]), ['thumb', 'upload', 'attach']);
});

test('UPLOAD ORDER AND PAYLOAD: poster, then the resumable file with the technician\'s own token, then the attach with exactly what was uploaded', async () => {
  const v = await enqueueVideo('v-order', 'during', file('site.mov', 'video/quicktime', 7000), meta(33.5), []);
  await idle();
  const [u] = uploaderArgs;
  assert.equal(u.bucket, 'report-videos', 'the private bucket');
  assert.equal(u.objectName, v.videoPath);
  assert.equal(u.contentType, 'video/quicktime');
  assert.equal(u.apiKey, 'public-anon-key', 'only the public anon key');
  assert.equal(await u.getAccessToken(), 'technician-session-token', 'the technician\'s own session');
  assert.equal(u.file instanceof File, true);
  assert.equal(u.uploadUrl ?? null, null, 'a first attempt starts fresh');
  assert.deepEqual(attachCalls, [{ visitId: 'v-order', phase: 'during', videoPath: v.videoPath, thumbnailPath: v.thumbPath, mime: 'video/quicktime', sizeBytes: 7000, durationSeconds: 33.5 }]);
  assert.match(v.videoPath, /\.mov$/);
});

test('PROGRESS: progress is reported while the file is being sent and cleared when it is done', async () => {
  let seen: number | null = null;
  fakes({ uploader: async (a) => { a.onProgress?.(30, 100); seen = getVideoProgress((await listAllVideos(OWNER))[0].id); } });
  await enqueueVideo('v-progress', 'before', file(), meta(), []);
  await idle();
  assert.equal(seen, 0.3);
  assert.equal(getVideoProgress('anything'), null);
  assert.equal((await listVideosForVisit(OWNER, 'v-progress')).length, 0);
});

test('POSTER FALLBACK: no poster (the browser could not make one) -> uploads and attaches without one; a poster that fails to upload never blocks the video', async () => {
  await enqueueVideo('v-nothumb', 'before', file(), meta(12, false), []);
  await idle();
  assert.equal(attachCalls[0].thumbnailPath, null);
  assert.equal(log.some((l) => l.startsWith('thumb:')), false);
  fakes({ uploadThumbnail: async () => { throw new Error('poster upload failed'); } });
  await enqueueVideo('v-thumbfail', 'before', file(), meta(12, true), []);
  await idle();
  assert.equal(attachCalls[1].visitId, 'v-thumbfail');
  assert.equal(attachCalls[1].thumbnailPath, null, 'attached without the poster');
});

// ===== retries ======================================================================================================================
test('TRANSIENT FAILURE: backs off (15 s), does not retry early, then retries and succeeds - continuing the SAME resumable upload', async () => {
  let n = 0;
  fakes({
    uploader: async (a) => {
      uploaderArgs.push(a);
      n += 1;
      if (n === 1) {
        a.onUploadUrl?.('https://tests.invalid/upload/abc');
        throw new UploadError('server hiccup', 503);
      }
    },
  });
  const v = await enqueueVideo('v-retry', 'before', file(), meta(), []);
  await idle();
  let rec = await getVideo(v.id);
  assert.equal(rec!.status, 'pending');
  assert.equal(rec!.attempts, 1);
  assert.equal(rec!.nextAttemptAt, new Date(clock + 15_000).toISOString());
  assert.equal(rec!.tusUrl, 'https://tests.invalid/upload/abc', 'the unfinished upload is remembered');
  assert.equal(rec!.videoPath, v.videoPath, 'same file names while the same upload is being continued');
  await idle();
  assert.equal(n, 1, 'not retried before it is due');
  clock += 16_000;
  await idle();
  assert.equal(n, 2);
  assert.equal(uploaderArgs[1].uploadUrl, 'https://tests.invalid/upload/abc', 'the retry resumes the earlier upload');
  assert.equal(await getVideo(v.id), undefined, 'and then succeeds');
});

test('OFFLINE FAILURE IS NOT COUNTED: a drop while offline leaves attempts at 0 and the video waiting', async () => {
  fakes({ uploader: async () => { nav.onLine = false; throw new Error('Failed to fetch'); } });
  const v = await enqueueVideo('v-dropped', 'before', file(), meta(), []);
  await idle();
  const rec = await getVideo(v.id);
  assert.equal(rec!.attempts, 0);
  assert.equal(rec!.status, 'pending');
  assert.equal(rec!.permanentFailure, false);
});

test('GIVES UP AFTER MAX ATTEMPTS for a manual "Try again", which starts fresh and succeeds', async () => {
  let fail = true;
  fakes({ uploader: async () => { if (fail) throw new UploadError('boom', 500); } });
  const v = await enqueueVideo('v-giveup', 'before', file(), meta(), []);
  for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) {
    await idle();
    clock += 31 * 60_000;
  }
  const rec = await getVideo(v.id);
  assert.equal(rec!.status, 'failed');
  assert.equal(rec!.attempts, MAX_AUTO_ATTEMPTS);
  assert.equal(rec!.permanentFailure, false);
  assert.equal(videoDisplay(rec!, true, null).label, 'Failed — tap to retry');
  assert.equal(videoDisplay(rec!, true, null).retryable, true);
  clock += 60 * 60_000;
  await idle();
  assert.equal((await getVideo(v.id))!.attempts, MAX_AUTO_ATTEMPTS, 'no automatic retry once it has given up');
  fail = false;
  await retryQueuedVideo(rec!);
  await idle();
  assert.equal(await getVideo(v.id), undefined, 'manual retry succeeded');
});

test('PERMANENT REFUSAL (report Completed / visit cancelled / not yours / limit): stops at once, says why, no automatic retry; "Try again" is still available', async () => {
  fakes({ attach: async () => { throw new RpcError('This report has been marked Completed, so videos can no longer be added. Ask the office to reopen it.', 'P0001'); } });
  const v = await enqueueVideo('v-completed', 'before', file(), meta(), []);
  await idle();
  const rec = await getVideo(v.id);
  assert.equal(rec!.status, 'failed');
  assert.equal(rec!.permanentFailure, true);
  assert.match(rec!.lastError!, /marked Completed[\s\S]*Reopen it first/);
  assert.equal(rec!.videoUploaded, true, 'the file is up; only the attach was refused');
  clock += 3_600_000;
  const before = log.filter((l) => l.startsWith('attach')).length;
  await idle();
  assert.equal(log.filter((l) => l.startsWith('attach')).length, before, 'never retried by itself');
  assert.equal(videoDisplay(rec!, true, null).label, 'Could not be sent');
  // once the office reopens the report the technician can retry; only the (cheap) attach is repeated, not the upload
  fakes();
  await retryQueuedVideo(rec!);
  await idle();
  assert.equal(await getVideo(v.id), undefined);
  assert.equal(log.filter((l) => l.startsWith('upload')).length, 1, 'the file was not uploaded a second time');
});

test('SERVER REFUSALS BY STATUS: 400/403/413/415 are permanent; 401/408/429/5xx and no answer are retried', () => {
  for (const s of [400, 403, 413, 415]) assert.equal(classifyVideoFailure(new UploadError('x', s), true), 'permanent', String(s));
  for (const s of [401, 408, 429, 500, 502, 503]) assert.equal(classifyVideoFailure(new UploadError('x', s), true), 'transient', String(s));
  for (const s of [404, 409, 410, 423]) assert.equal(classifyVideoFailure(new UploadError('x', s), true), 'restart', String(s));
  assert.equal(classifyVideoFailure(new UploadError('no answer', null), true), 'transient');
  assert.equal(classifyVideoFailure(new Error('Failed to fetch'), true), 'transient');
  assert.equal(classifyVideoFailure(new Error('anything'), false), 'offline');
  assert.equal(classifyVideoFailure(new UploadCancelledError(), false), 'cancelled');
});

test('DATABASE REFUSALS: a coded refusal is permanent, a connection-class code or no code is retried, "file not found" re-uploads', () => {
  assert.equal(classifyVideoFailure(new RpcError('Only 3 videos can be added to each section', 'P0001'), true), 'permanent');
  assert.equal(classifyVideoFailure(new RpcError('Not authorized.', 'P0001'), true), 'permanent');
  assert.equal(classifyVideoFailure(new RpcError('connection failure', '08006'), true), 'transient');
  assert.equal(classifyVideoFailure(new RpcError('TypeError: Failed to fetch'), true), 'transient');
  assert.equal(classifyVideoFailure(new RpcError('The video file was not found in storage.', 'P0001'), true), 'reupload');
});

test('RESTART: when the server no longer knows the unfinished upload (404/410) the next attempt uses brand-new file names and starts from the beginning', async () => {
  let n = 0;
  fakes({ uploader: async (a) => { uploaderArgs.push(a); n += 1; if (n === 1) throw new UploadError('upload not found', 404); } });
  const v = await enqueueVideo('v-restart', 'before', file(), meta(), []);
  await idle();
  const rec = await getVideo(v.id);
  assert.notEqual(rec!.videoPath, v.videoPath);
  assert.notEqual(rec!.thumbPath, v.thumbPath);
  assert.equal(rec!.tusUrl, null);
  assert.equal(rec!.videoUploaded, false);
  clock += 20_000;
  await idle();
  assert.equal(uploaderArgs[1].objectName, rec!.videoPath);
  assert.equal(uploaderArgs[1].uploadUrl ?? null, null);
});

test('REUPLOAD: the database could not find the file -> uploaded again under new names, and the old stored files are cleaned up', async () => {
  let n = 0;
  fakes({ attach: async (i) => { attachCalls.push(i); n += 1; if (n === 1) throw new RpcError('The video file was not found in storage.', 'P0001'); return 'srv-ok'; } });
  const v = await enqueueVideo('v-reup', 'before', file(), meta(), []);
  await idle();
  const rec = await getVideo(v.id);
  assert.equal(rec!.videoUploaded, false);
  assert.notEqual(rec!.videoPath, v.videoPath);
  assert.ok(removedObjects.includes(v.videoPath), 'the old file is removed');
  clock += 20_000;
  await idle();
  assert.equal(await getVideo(v.id), undefined);
});

// ===== cancel, removal, stale retries ===================================================================================================
test('CANCEL while uploading: the upload is aborted, the record is gone, no attach, no failure recorded, and the files it stored are cleaned up', async () => {
  let aborted = false;
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  fakes({
    uploader: (a) =>
      new Promise((_res, rej) => {
        started();
        a.signal!.addEventListener('abort', () => { aborted = true; rej(new UploadCancelledError()); });
      }),
  });
  const v = await enqueueVideo('v-cancel', 'before', file(), meta(), []);
  await startedP;
  await removeQueuedVideo((await getVideo(v.id))!);
  await idle();
  assert.equal(aborted, true);
  assert.equal(await getVideo(v.id), undefined);
  assert.equal(attachCalls.length, 0);
  assert.ok(removedObjects.includes(v.thumbPath!), 'the poster it had already stored is cleaned up');
  assert.deepEqual(await listVideosForVisit(OWNER, 'v-cancel'), []);
});

test('STALE RETRY: a video removed while its ATTACH is in flight is NOT left on the server - the engine undoes it - and no record comes back', async () => {
  let releaseAttach!: () => void;
  const gate = new Promise<void>((r) => (releaseAttach = r));
  let attachStarted!: () => void;
  const started = new Promise<void>((r) => (attachStarted = r));
  fakes({ attach: async (i) => { attachCalls.push(i); attachStarted(); await gate; return 'server-stale'; } });
  const v = await enqueueVideo('v-stale', 'before', file(), meta(), []);
  await started;
  await removeQueuedVideo((await getVideo(v.id))!); // the technician removes it while the database call is running
  releaseAttach();
  await idle();
  assert.ok(log.includes('delete-server:server-stale'), 'the video the server just recorded is removed again');
  assert.equal(await getVideo(v.id), undefined, 'and nothing was resurrected locally');
  assert.deepEqual(attached, ['v-stale'], 'the screen re-reads the server list (which no longer has it)');
});

test('STALE UPDATE: a late status update for a removed video does nothing - it can never re-create the record', async () => {
  nav.onLine = false;
  const v = await enqueueVideo('v-late', 'before', file(), meta(), []);
  await deleteVideo(v.id);
  assert.equal(await updateVideoIfPresent(v.id, (r) => ({ ...r, status: 'uploading' })), undefined);
  assert.equal(await claimVideo(v.id, new Date(clock).toISOString(), new Date(clock + 1000).toISOString()), undefined);
  assert.equal(await getVideo(v.id), undefined);
});

test('REMOVE a video that already uploaded but was not yet attached: its stored files are cleaned up (best effort)', async () => {
  fakes({ attach: async () => { throw new RpcError('Not authorized.', 'P0001'); } });
  const v = await enqueueVideo('v-leftover', 'before', file(), meta(), []);
  await idle();
  const failed = (await getVideo(v.id))!;
  assert.equal(failed.videoUploaded, true);
  await removeQueuedVideo(failed);
  assert.ok(removedObjects.includes(failed.videoPath) && removedObjects.includes(failed.thumbPath!));
  assert.equal(await getVideo(v.id), undefined);
});

// ===== several tabs, several users ========================================================================================================
test('TWO TABS: a video another tab is working on (an unexpired lease) is left alone; once the lease expires it is taken over', async () => {
  nav.onLine = false;
  const v = await enqueueVideo('v-lease', 'before', file(), meta(), []);
  const otherTab = await claimVideo(v.id, new Date(clock).toISOString(), new Date(clock + 120_000).toISOString());
  assert.equal(otherTab!.status, 'uploading');
  assert.equal(await claimVideo(v.id, new Date(clock).toISOString(), new Date(clock + 120_000).toISOString()), undefined, 'a second claim fails');
  nav.onLine = true;
  await idle();
  assert.equal(log.length, 0, 'this tab does not touch it');
  await normaliseInterrupted();
  assert.equal((await getVideo(v.id))!.status, 'uploading', 'not reset while the other tab\'s lease is live');
  clock += 121_000;
  await normaliseInterrupted();
  assert.equal((await getVideo(v.id))!.status, 'pending', 'a crashed tab\'s video is waiting again');
  await idle();
  assert.equal(await getVideo(v.id), undefined, 'and is uploaded');
});

test('OWNERSHIP: another technician\'s queued videos are never listed, counted or uploaded by this user', async () => {
  nav.onLine = false;
  setCurrentUserId('tech-2');
  await enqueueVideo('v-shared', 'before', file(), meta(), []);
  setCurrentUserId(OWNER);
  nav.onLine = true;
  await idle();
  assert.deepEqual(log, [], 'tech-1 uploads nothing of tech-2\'s');
  assert.equal((await listVideosForVisit(OWNER, 'v-shared')).length, 0);
  assert.equal((await listVideosForVisit('tech-2', 'v-shared')).length, 1);
  setCurrentUserId('tech-2');
  await idle();
  assert.equal((await listVideosForVisit('tech-2', 'v-shared')).length, 0, 'it goes up when its owner is signed in');
  setCurrentUserId(OWNER);
});

test('SIGNED OUT: nothing is uploaded and nothing is lost', async () => {
  nav.onLine = false;
  const v = await enqueueVideo('v-signedout', 'before', file(), meta(), []);
  nav.onLine = true;
  setCurrentUserId(null);
  await idle();
  assert.deepEqual(log, []);
  setCurrentUserId(OWNER);
  assert.ok(await getVideo(v.id));
});

// ===== isolation from the photo queue ===========================================================================================================
test('ISOLATION: videos live in their OWN IndexedDB database; the photo queue\'s database (name, version, stores, data) is untouched', async () => {
  const photo: PendingPhoto = { id: 'ph-iso', ownerId: OWNER, visitId: 'v-iso', phase: 'before', blob: new Blob(['x']), storagePath: 'v-iso/before/ph-iso.jpg', status: 'pending', lastError: null, createdAt: '2026-10-12T09:00:00.000Z' };
  await putPhoto(photo);
  nav.onLine = false;
  await enqueueVideo('v-iso', 'before', file(), meta(), []);
  const dbs = await indexedDB.databases();
  const byName = Object.fromEntries(dbs.map((d) => [d.name, d.version]));
  assert.equal(byName[VIDEO_DB_NAME], 1);
  assert.equal(byName['kind-contractors-technician-offline'], 2, 'the photo/draft database is still at its own version');
  assert.notEqual(VIDEO_DB_NAME, 'kind-contractors-technician-offline');
  const photoDb = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('kind-contractors-technician-offline'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  assert.deepEqual([...photoDb.objectStoreNames].sort(), ['draftReports', 'pendingPhotos'], 'no video store was added to the photo database');
  photoDb.close();
  assert.equal((await getPhoto('ph-iso'))!.storagePath, 'v-iso/before/ph-iso.jpg', 'the queued photo is exactly as it was');
});

// ===== screen wording ===========================================================================================================================
test('WORDING: waiting, uploading with a percentage, finishing, retrying, offline and failed each have their own plain label', () => {
  const base = { status: 'pending' as const, attempts: 0, permanentFailure: false, lastError: null };
  assert.equal(videoDisplay(base, true, null).label, 'Saved on this device · waiting to upload');
  assert.equal(videoDisplay(base, false, null).label, 'Saved on this device · waiting for a connection');
  assert.equal(videoDisplay({ ...base, attempts: 2 }, true, null).label, 'Will retry shortly…');
  assert.equal(videoDisplay({ ...base, status: 'uploading' }, true, 0.42).label, 'Uploading… 42%');
  assert.equal(videoDisplay({ ...base, status: 'uploading' }, true, null).label, 'Uploading…');
  assert.equal(videoDisplay({ ...base, status: 'attaching' }, true, 1).label, 'Finishing…');
  assert.equal(videoDisplay({ ...base, status: 'failed' }, true, null).retryable, true);
  assert.equal(videoDisplay({ ...base, status: 'failed' }, false, null).retryable, false, 'offline failures are just waiting for a connection');
  assert.equal(videoDisplay({ ...base, status: 'failed', permanentFailure: true }, false, null).label, 'Could not be sent');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 99].map(backoffDelayMs), [15_000, 60_000, 180_000, 600_000, 1_800_000, 1_800_000, 1_800_000]);
});
