// The technician photo queue on a slow mobile uplink (Nov 2026): three uploads side by side split a weak uplink so none finished
// within the old fixed 90 s limit, each was cancelled and restarted from zero, and nothing got through. Now:
//   - ONE upload at a time, the next photo chosen when the slot frees (completed reports first, then the report closest to done, then
//     the oldest; nothing waits for ever);
//   - an upload is cancelled only when it has STOPPED (no bytes sent for the stall limit), when everything was sent but no answer
//     came, or at a generous ceiling - never just for being slow;
//   - after connection failures the next upload waits a moment (growing); any success, or coming back online, retries waiting photos.
// The real engine over a fake IndexedDB; the network is faked (with upload progress) - nothing real. Also the real XHR uploader.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';

import { setCurrentUserId } from '../src/auth/currentUser';
import { getDraft, getPhoto, listPhotosForVisit, putDraft, putPhoto, type DraftReport, type PendingPhoto } from '../src/technician/offline/db';
import {
  enqueuePhoto,
  markReadyToSubmit,
  pickNextUpload,
  resetUploadQueueStateForTests,
  runSyncSweepForTests,
  setTechnicianUploadDepsForTests,
  type SlotCandidate,
} from '../src/technician/offline/syncEngine';
import { PhotoUploadError, uploadVisitPhotoBytes, type UploadProgress } from '../src/technician/api';

const online = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: online, configurable: true });
const OWNER = 'slow-uplink-owner';

let rpcCalls: string[] = [];
globalThis.fetch = (async (input: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.pathname.startsWith('/rest/v1/rpc/')) rpcCalls.push(url.pathname.slice(13));
  return new Response(null, { status: 204 });
}) as typeof fetch;

// ---- fake Storage with upload progress ----------------------------------------------------------------------------------------------
let server: Map<string, number>;
let started: { path: string; at: number }[];
let inFlight = 0;
let maxInFlight = 0;
type Upload = (path: string, body: Blob, signal: AbortSignal, onProgress?: UploadProgress) => Promise<'created' | 'exists'>;
let uploadImpl: Upload;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abortable = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
/** Sends `size` bytes in `steps` progress steps, `stepMs` apart, then stores the photo - like a slow link that keeps moving. */
const moving = (stepMs: number, steps: number): Upload => async (path, body, signal, onProgress) => {
  for (let i = 1; i <= steps; i++) {
    await Promise.race([wait(stepMs), abortable(signal)]);
    onProgress?.(Math.round((body.size * i) / steps), body.size);
  }
  server.set(path, body.size);
  return 'created';
};
const instant: Upload = async (path, body) => { server.set(path, body.size); return 'created'; };

function deps(over: Record<string, unknown> = {}) {
  setTechnicianUploadDepsForTests({
    checkOnServer: async (path) => (server.has(path) ? { found: true, sizeBytes: server.get(path)! } : { found: false }),
    uploadBytes: async (path, body, _type, signal, onProgress) => {
      started.push({ path, at: Date.now() });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await uploadImpl(path, body, signal, onProgress); } finally { inFlight -= 1; }
    },
    removeObject: async (path) => { server.delete(path); },
    fetchMyServerReport: async () => null,
    uploadStallMs: 60,
    uploadResponseMs: 80,
    uploadMaxMs: 3000,
    uploadMinBytesPerSec: 1e9, // no drain allowance unless a test sets one
    checkTimeoutMs: 100,
    coolDownBaseMs: 1,
    coolDownMaxMs: 4,
    ...over,
  });
}
const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 255);
const jpeg = (n = 1000, seed = 1) => new File([bytes(n, seed)], `IMG_${seed}.jpg`, { type: 'image/jpeg', lastModified: seed });
function draft(visitId: string, over: Partial<DraftReport> = {}): DraftReport {
  return { ownerId: OWNER, visitId, mode: 'submit', reportId: null, workCarriedOut: 'Work', technicianNotes: null, issues: null, onSiteStart: '2026-11-23T08:00:00.000Z', onSiteEnd: null, specMet: true, readyToSubmit: false, submitting: false, submitError: null, updatedAt: '2026-11-23T08:00:00.000Z', ...over };
}
async function until(check: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await wait(10); }
  return false;
}
const uploadedCount = async (visitId: string) => (await listPhotosForVisit(OWNER, visitId)).filter((p) => p.status === 'uploaded').length;

beforeEach(async () => {
  online.onLine = true;
  setCurrentUserId(OWNER);
  resetUploadQueueStateForTests();
  await listPhotosForVisit(OWNER, 'none');
  const db = await openDB('kind-contractors-technician-offline');
  await db.clear('pendingPhotos');
  await db.clear('draftReports');
  db.close();
  server = new Map();
  started = [];
  inFlight = 0;
  maxInFlight = 0;
  rpcCalls = [];
  uploadImpl = instant;
  deps();
});
afterEach(() => setTechnicianUploadDepsForTests(null));

test('ONE AT A TIME: two reports of several photos never upload side by side', async () => {
  uploadImpl = moving(5, 4);
  await putDraft(draft('A'));
  await putDraft(draft('B'));
  for (let i = 0; i < 3; i++) { await enqueuePhoto('A', 'after', jpeg(900, i)); await enqueuePhoto('B', 'after', jpeg(900, 10 + i)); }
  assert.ok(await until(async () => (await uploadedCount('A')) === 3 && (await uploadedCount('B')) === 3, 3000), 'all uploaded');
  assert.equal(maxInFlight, 1, 'never more than one upload at once (three at a time starved each other on a weak uplink)');
});

test('SLOW BUT MOVING: an upload that takes far longer than the stall limit but keeps sending is NOT cancelled', async () => {
  uploadImpl = moving(25, 20); // ~500 ms in total - over 8x the 60 ms stall limit, progress every 25 ms
  await putDraft(draft('S'));
  const p = await enqueuePhoto('S', 'after', jpeg(1200));
  assert.ok(await until(async () => (await getPhoto(p.id))?.status === 'uploaded', 3000), 'uploaded');
  assert.equal(started.length, 1, 'in one go - never cancelled and restarted from zero');
  assert.equal(server.get((await getPhoto(p.id))!.storagePath), 1200, 'verified complete');
});

test('STALLED: an upload that stops sending is cancelled after the stall limit, kept as "stopped", and the slot goes to the next photo', async () => {
  let aborted = false;
  uploadImpl = async (path, body, signal, onProgress) => {
    if (path.startsWith('stall/')) {
      signal.addEventListener('abort', () => { aborted = true; });
      onProgress?.(100, body.size); // a little, then nothing
      return abortable(signal);
    }
    return instant(path, body, signal);
  };
  await putDraft(draft('stall'));
  await putDraft(draft('next'));
  const s = await enqueuePhoto('stall', 'after', jpeg(1000, 1));
  const n = await enqueuePhoto('next', 'after', jpeg(1000, 2));
  assert.ok(await until(async () => (await getPhoto(n.id))?.status === 'uploaded', 2000), 'the next photo got the slot');
  const after = await getPhoto(s.id);
  assert.equal(after?.failureKind, 'timeout');
  assert.match(after?.lastError ?? '', /stopped - nothing sent/);
  assert.notEqual(after?.status, 'uploaded');
  assert.ok(aborted, 'the stalled request itself was cancelled (connection freed)');
});

test('SENT, NO ANSWER: everything handed over but the server never answers - cancelled after the answer limit, not counted', async () => {
  uploadImpl = async (_path, body, signal, onProgress) => { onProgress?.(body.size, body.size); return abortable(signal); };
  await putDraft(draft('quiet'));
  const p = await enqueuePhoto('quiet', 'after', jpeg(800));
  assert.ok(await until(async () => (await getPhoto(p.id))?.failureKind === 'timeout', 2000));
  assert.match((await getPhoto(p.id))!.lastError ?? '', /server did not answer/);
});

test('BUFFERED: nearly all handed to the network at once, then silence while it drains - not cancelled within the minimum-rate allowance; a dead one is', async () => {
  // As WebKit did on a 64 kbit/s link: ~97% reported "sent" within seconds, then no more progress until the server answered.
  deps({ uploadMinBytesPerSec: 20_000 }); // 9 500 bytes handed over -> allowance ~475 ms (the stall limit alone is 60 ms)
  uploadImpl = async (path, body, signal, onProgress) => {
    onProgress?.(Math.round(body.size * 0.95), body.size);
    await Promise.race([wait(300), abortable(signal)]); // still draining over the slow link
    server.set(path, body.size);
    return 'created';
  };
  await putDraft(draft('buf'));
  const p = await enqueuePhoto('buf', 'after', jpeg(10_000));
  assert.ok(await until(async () => (await getPhoto(p.id))?.status === 'uploaded', 2000), 'uploaded - a stall-only rule cancelled it at 60 ms');
  assert.equal(started.length, 1, 'in one go');

  let cancelledAt = 0;
  const t0 = Date.now();
  uploadImpl = async (_path, body, signal, onProgress) => {
    signal.addEventListener('abort', () => { cancelledAt = Date.now() - t0; });
    onProgress?.(Math.round(body.size * 0.95), body.size);
    return abortable(signal); // the connection died after the hand-over
  };
  const dead = await enqueuePhoto('buf', 'before', jpeg(10_000, 2));
  assert.ok(await until(async () => (await getPhoto(dead.id))?.failureKind === 'timeout', 3000), 'a dead upload is still cancelled');
  assert.ok(cancelledAt >= 400 && cancelledAt < 1500, `after the allowance, not before and not much later (${cancelledAt} ms)`);
});

test('CEILING: an upload that trickles on for ever is still cancelled at the overall limit - nothing holds the queue indefinitely', async () => {
  deps({ uploadMaxMs: 250 });
  uploadImpl = async (_path, body, signal, onProgress) => {
    for (let sent = 1; ; sent++) { await Promise.race([wait(20), abortable(signal)]); onProgress?.(Math.min(sent, body.size - 1), body.size); }
  };
  await putDraft(draft('trickle'));
  const p = await enqueuePhoto('trickle', 'after', jpeg(5000));
  assert.ok(await until(async () => (await getPhoto(p.id))?.failureKind === 'timeout', 2000));
  assert.match((await getPhoto(p.id))!.lastError ?? '', /still not finished/);
});

test('CHOICE of the next photo: completed reports first, then the report closest to done, then oldest; nothing waits for ever', () => {
  const now = 1_000_000;
  const c = (visitId: string, createdAt: string, waitingSince = now - 1000): SlotCandidate => ({ visitId, createdAt, waitingSince });
  // B is completed (ready): its photo goes first even though A's is older
  assert.equal(pickNextUpload([c('A', '01'), c('B', '05')], new Set(['B']), now), 1);
  // both completed: B has 1 photo left, A has 3 -> B
  assert.equal(pickNextUpload([c('A', '01'), c('A', '02'), c('A', '03'), c('B', '09')], new Set(['A', 'B']), now), 3);
  // same report: the oldest photo
  assert.equal(pickNextUpload([c('A', '03'), c('A', '01'), c('A', '02')], new Set(), now), 1);
  // a photo waiting 10 minutes goes first whatever else is waiting
  assert.equal(pickNextUpload([c('B', '09', now - 1000), c('A', '01', now - 11 * 60_000), c('A', '02', now - 12 * 60_000)], new Set(['B']), now), 2);
  assert.equal(pickNextUpload([], new Set(), now), -1);
});

test('FAIRNESS: a completed 2-photo report is not stuck behind a 5-photo report that was photographed first', async () => {
  uploadImpl = moving(4, 3);
  await putDraft(draft('big'));
  await putDraft(draft('small'));
  for (let i = 0; i < 5; i++) await enqueuePhoto('big', 'after', jpeg(700, i));
  await enqueuePhoto('small', 'after', jpeg(700, 20));
  await enqueuePhoto('small', 'after', jpeg(700, 21));
  await markReadyToSubmit('small');
  assert.ok(await until(async () => (await getDraft(OWNER, 'small')) === undefined, 3000), 'the small report was sent');
  const bigDoneWhenSmallSent = started.filter((s) => s.path.startsWith('big/')).length;
  assert.ok(bigDoneWhenSmallSent <= 2, `the completed small report went ahead (big had only ${bigDoneWhenSmallSent} started) - in capture order it would wait for all 5`);
  assert.ok(await until(async () => (await uploadedCount('big')) === 5, 3000), 'and the big report still finishes');
});

test('PART-UPLOADED report: only the missing photos are sent; the report goes once, after every photo is confirmed', async () => {
  await putDraft(draft('mix', { readyToSubmit: true }));
  for (const [id, done] of [['m1', true], ['m2', true], ['m3', false], ['m4', false]] as const) {
    const path = `mix/after/${id}.jpg`;
    if (done) server.set(path, 600);
    await putPhoto({ id, ownerId: OWNER, visitId: 'mix', phase: 'after', blob: new Blob([bytes(600)], { type: 'image/jpeg' }), storagePath: path, status: done ? 'uploaded' : 'pending', lastError: null, createdAt: `2026-11-23T08:0${id.slice(1)}:00.000Z` });
  }
  uploadImpl = moving(10, 5);
  const sweep = runSyncSweepForTests();
  await wait(30);
  assert.equal(rpcCalls.filter((c) => c === 'technician_submit_report').length, 0, 'not sent while photos are still uploading');
  await sweep;
  assert.ok(await until(async () => (await getDraft(OWNER, 'mix')) === undefined, 2000), 'sent');
  assert.deepEqual(started.map((s) => s.path).sort(), ['mix/after/m3.jpg', 'mix/after/m4.jpg'], 'the already-uploaded photos were not sent again');
  assert.equal(rpcCalls.filter((c) => c === 'technician_submit_report').length, 1, 'sent exactly once');
});

test('COOL-DOWN: with no usable signal, the next upload waits a little longer after each failure in a row', async () => {
  deps({ coolDownBaseMs: 40, coolDownMaxMs: 400 });
  uploadImpl = async () => { throw new TypeError('Load failed'); };
  await putDraft(draft('dead'));
  for (let i = 0; i < 4; i++) await enqueuePhoto('dead', 'after', jpeg(500, i));
  assert.ok(await until(async () => started.length >= 4, 3000));
  const gaps = started.slice(1, 4).map((s, i) => s.at - started[i].at);
  assert.ok(gaps[0] >= 35 && gaps[1] >= 75 && gaps[2] >= 150, `gaps grow (~40, 80, 160 ms): ${gaps.join(', ')}`);
});

test('RECOVERY: once an upload succeeds after failures, photos waiting out a long retry are tried at once', async () => {
  await putDraft(draft('rec', { readyToSubmit: true }));
  // a photo that already used its quick tries and is scheduled 5 minutes out
  await putPhoto({ id: 'waiting', ownerId: OWNER, visitId: 'rec', phase: 'after', blob: new Blob([bytes(500)], { type: 'image/jpeg' }), storagePath: 'rec/after/waiting.jpg', status: 'failed', failureKind: 'network', lastError: 'Load failed', createdAt: '2026-11-23T08:00:00.000Z', attempts: 4, nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  let fail = true;
  uploadImpl = async (path, body, signal) => { if (fail) { fail = false; throw new TypeError('Load failed'); } return instant(path, body, signal); };
  const p = await enqueuePhoto('rec', 'after', jpeg(700)); // fails once (signal gone), then its retry succeeds (signal back)
  assert.ok(await until(async () => (await getPhoto(p.id))?.status === 'uploaded' || (await getDraft(OWNER, 'rec')) === undefined, 4000));
  assert.ok(await until(async () => (await getDraft(OWNER, 'rec')) === undefined, 2000), 'the waiting photo went at once and the report was sent - no 5-minute wait');
});

test('BACK ONLINE: a sweep after coming back online tries every waiting photo regardless of its schedule; a normal sweep respects it', async () => {
  await putDraft(draft('on', { readyToSubmit: true }));
  await putPhoto({ id: 'sched', ownerId: OWNER, visitId: 'on', phase: 'after', blob: new Blob([bytes(500)], { type: 'image/jpeg' }), storagePath: 'on/after/sched.jpg', status: 'failed', failureKind: 'network', lastError: 'Load failed', createdAt: '2026-11-23T08:00:00.000Z', attempts: 4, nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  await runSyncSweepForTests();
  assert.equal(started.length, 0, 'normal sweep: waits for its time');
  await runSyncSweepForTests(true);
  assert.ok(await until(async () => (await getDraft(OWNER, 'on')) === undefined, 2000), 'online: tried at once, report sent');
});

// ---- the real uploader (src/technician/api.ts) over a fake XMLHttpRequest ------------------------------------------------------------
class FakeXhr {
  static last: FakeXhr;
  static respond: (x: FakeXhr) => void = () => {};
  method = ''; url = ''; headers: Record<string, string> = {}; body: unknown; status = 0; responseText = ''; aborted = false;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  constructor() { FakeXhr.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(n: string, v: string) { this.headers[n] = v; }
  send(body: unknown) { this.body = body; queueMicrotask(() => FakeXhr.respond(this)); }
  abort() { this.aborted = true; this.onabort?.(); }
}

test('XHR UPLOADER: same request as before (POST, auth headers, no overwrite), progress reported, answers mapped like fetch', async () => {
  (globalThis as any).XMLHttpRequest = FakeXhr;
  const seen: number[] = [];
  FakeXhr.respond = (x) => { x.upload.onprogress?.({ loaded: 50, total: 100, lengthComputable: true }); x.upload.onprogress?.({ loaded: 100, total: 100, lengthComputable: true }); x.status = 200; x.responseText = '{"Key":"k"}'; x.onload?.(); };
  assert.equal(await uploadVisitPhotoBytes('v/after/a b.jpg', new Blob([bytes(100)], { type: 'image/jpeg' }), 'image/jpeg', undefined, (s) => seen.push(s)), 'created');
  const x = FakeXhr.last;
  assert.equal(x.method, 'POST');
  assert.match(x.url, /\/storage\/v1\/object\/visit-photos\/v\/after\/a%20b\.jpg$/);
  assert.equal(x.headers['x-upsert'], 'false', 'technicians may only add files');
  assert.ok(x.headers.apikey && /^Bearer /.test(x.headers.Authorization), 'the same apikey + Authorization headers as the Supabase client');
  assert.ok(x.body instanceof FormData);
  assert.deepEqual(seen, [50, 100], 'progress reported');

  FakeXhr.respond = (x2) => { x2.status = 409; x2.responseText = '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}'; x2.onload?.(); };
  assert.equal(await uploadVisitPhotoBytes('v/p.jpg', new Blob([bytes(10)]), 'image/jpeg'), 'exists');
  FakeXhr.respond = (x2) => { x2.status = 400; x2.responseText = '{"statusCode":"403","message":"new row violates row-level security policy"}'; x2.onload?.(); };
  await assert.rejects(uploadVisitPhotoBytes('v/p.jpg', new Blob([bytes(10)]), 'image/jpeg'), (e: unknown) => e instanceof PhotoUploadError && e.status === 403);
  FakeXhr.respond = (x2) => { x2.status = 502; x2.responseText = '<html>bad gateway</html>'; x2.onload?.(); };
  await assert.rejects(uploadVisitPhotoBytes('v/p.jpg', new Blob([bytes(10)]), 'image/jpeg'), (e: unknown) => e instanceof PhotoUploadError && e.status === 502);
  FakeXhr.respond = (x2) => x2.onerror?.();
  await assert.rejects(uploadVisitPhotoBytes('v/p.jpg', new Blob([bytes(10)]), 'image/jpeg'), (e: unknown) => e instanceof TypeError, 'a dropped connection is a network error, like fetch');

  FakeXhr.respond = () => {}; // never answers
  const ctl = new AbortController();
  const pending = uploadVisitPhotoBytes('v/p.jpg', new Blob([bytes(10)]), 'image/jpeg', ctl.signal);
  await wait(5);
  ctl.abort();
  await assert.rejects(pending, (e: unknown) => (e as Error).name === 'AbortError');
  assert.ok(FakeXhr.last.aborted, 'cancelling aborts the request itself');
  delete (globalThis as any).XMLHttpRequest;
});
