// The technician photo queue (src/technician/offline/syncEngine.ts + db.ts) after Todd's stuck reports (Nov 2026):
//   - a saved photo is written to IndexedDB ONCE; status changes never re-save it (WebKit loses a Blob read back and put again);
//   - every network step has a time limit, so a hung request frees its queue place;
//   - "a file exists" is not proof: the server's copy must be exactly the photo's size (an incomplete copy is replaced under a fresh path);
//   - reports take turns; restart / reconnect / older records recover; plain technician-facing status.
// The real engine over a fake IndexedDB; the network side (Storage check / upload / remove, and the submit RPC) is faked - nothing real.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';

import { setCurrentUserId } from '../src/auth/currentUser';
import { getDraft, getPhoto, listPhotosForVisit, putDraft, putPhoto, type DraftReport, type PendingPhoto } from '../src/technician/offline/db';
import {
  enqueuePhoto,
  markReadyToSubmit,
  removeQueuedPhoto,
  retryPhoto,
  runSyncSweepForTests,
  setTechnicianUploadDepsForTests,
  takeTurnsByVisit,
  trySubmitIfReady,
} from '../src/technician/offline/syncEngine';
import { photoProblemText, reportSyncSummary } from '../src/technician/reportSyncStatus';
import { headerSyncBadge } from '../src/technician/headerSyncBadge';
import type { ServerPhotoCopy } from '../src/technician/api';

const online = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: online, configurable: true });
const OWNER = 'tech-queue-owner';
setCurrentUserId(OWNER);

// ---- fake submit RPC (the report itself) -------------------------------------------------------------------------------------------
let rpcCalls: { name: string; body: any }[] = [];
let rpcAnswer: () => Response | Error = () => new Response(null, { status: 204 });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    rpcCalls.push({ name: url.pathname.replace('/rest/v1/rpc/', ''), body: init?.body ? JSON.parse(init.body) : null });
    const r = rpcAnswer();
    if (r instanceof Error) throw r;
    return r;
  }
  return new Response('{}', { status: 200 }); // anything else (best-effort clean-ups)
}) as typeof fetch;

// ---- fake Storage --------------------------------------------------------------------------------------------------------------------
let server: Map<string, number | null>; // path -> stored size (null = the server doesn't say)
let uploads: string[];
let removed: string[];
let uploadImpl: (path: string, body: Blob, signal: AbortSignal) => Promise<'created' | 'exists'>;
let checkImpl: (path: string) => Promise<ServerPhotoCopy>;
const realUpload = async (path: string, body: Blob) => {
  if (server.has(path)) return 'exists' as const;
  server.set(path, body.size);
  return 'created' as const;
};
const realCheck = async (path: string): Promise<ServerPhotoCopy> => (server.has(path) ? { found: true, sizeBytes: server.get(path)! } : { found: false });
const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

let blobPuts = 0;
let restorePut: () => void = () => {};
function countBlobPuts() {
  const proto = (globalThis as any).IDBObjectStore.prototype;
  const put = proto.put;
  proto.put = function (this: { name: string }, ...args: unknown[]) {
    const v = args[0] as Record<string, unknown>;
    if (this.name === 'pendingPhotos' && v && Object.values(v).some((x) => x instanceof Blob)) blobPuts++;
    return put.apply(this, args);
  };
  restorePut = () => { proto.put = put; };
}

beforeEach(async () => {
  online.onLine = true;
  setCurrentUserId(OWNER);
  // a clean queue for this owner (the app's own code opens - and on first use creates - the database first)
  await listPhotosForVisit(OWNER, 'none');
  const db = await openDB('kind-contractors-technician-offline');
  await db.clear('pendingPhotos');
  await db.clear('draftReports');
  db.close();
  server = new Map();
  uploads = [];
  removed = [];
  rpcCalls = [];
  rpcAnswer = () => new Response(null, { status: 204 });
  uploadImpl = (path, body) => realUpload(path, body);
  checkImpl = realCheck;
  setTechnicianUploadDepsForTests({
    checkOnServer: (path) => checkImpl(path),
    uploadBytes: async (path, body, _type, signal) => {
      uploads.push(path);
      return uploadImpl(path, body, signal);
    },
    removeObject: async (path) => {
      removed.push(path);
      server.delete(path);
    },
    uploadTimeoutMs: 60,
    checkTimeoutMs: 60,
  });
  blobPuts = 0;
  countBlobPuts();
});
afterEach(() => {
  restorePut();
  setTechnicianUploadDepsForTests(null);
});

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed) % 251);
const jpeg = (n = 3000, seed = 1) => new File([bytes(n, seed)], `IMG_${seed}.jpg`, { type: 'image/jpeg', lastModified: seed });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 30) {
  await wait(ms);
}
function draft(visitId: string, over: Partial<DraftReport> = {}): DraftReport {
  return {
    ownerId: OWNER, visitId, mode: 'submit', reportId: null, workCarriedOut: 'Done', technicianNotes: null, issues: null,
    onSiteStart: '2026-11-21T05:53:00.000Z', onSiteEnd: '2026-11-21T05:55:00.000Z', specMet: true, readyToSubmit: false, submitting: false,
    submitError: null, updatedAt: '2026-11-21T05:55:00.000Z', ...over,
  };
}
async function photosOf(visitId: string) {
  return (await listPhotosForVisit(OWNER, visitId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---- 1. the photo is written once ---------------------------------------------------------------------------------------------------
test('ONE WRITE: through failures, retries, a timeout and success, each photo is written to IndexedDB with its data exactly once', async () => {
  await putDraft(draft('v1'));
  let n = 0;
  uploadImpl = async (path, body, signal) => {
    n++;
    if (n === 1) throw new Error('Failed to fetch');
    if (n === 2) return hang(signal);
    return realUpload(path, body);
  };
  const p = await enqueuePhoto('v1', 'after', jpeg(3000, 1));
  await settle(150);
  await retryPhoto((await getPhoto(p.id))!); // a tap, after the timeout
  await settle(50);
  await retryPhoto((await getPhoto(p.id))!);
  await settle(50);
  const after = await getPhoto(p.id);
  assert.equal(after?.status, 'uploaded', JSON.stringify(after && { ...after, blob: undefined }));
  assert.equal(blobPuts, 1, 'only the first save carried the photo; every status change wrote the separate status record');
  assert.equal(after!.blob.size, 3000);
  assert.deepEqual(new Uint8Array(await after!.blob.arrayBuffer()), bytes(3000, 1), 'the stored photo is byte-identical');
});

test('OLDER RECORDS (saved by the previous version, one record with everything) are read as before, upload, and are never re-saved', async () => {
  const legacy: PendingPhoto = {
    id: 'legacy-1', ownerId: OWNER, visitId: 'v-legacy', phase: 'before', blob: new Blob([bytes(2000, 7)], { type: 'image/jpeg' }),
    storagePath: 'v-legacy/before/legacy-1.jpg', status: 'uploading', lastError: 'old error', createdAt: '2026-11-20T11:50:00.000Z', attempts: 2,
  };
  await putPhoto(legacy);
  await putDraft(draft('v-legacy', { readyToSubmit: true }));
  blobPuts = 0;
  assert.equal((await getPhoto('legacy-1'))?.status, 'uploading', 'read exactly as the old version left it (a page closed mid-upload)');
  await runSyncSweepForTests();
  await settle(50);
  assert.equal(blobPuts, 0, 'the old record (with its photo) was never written again');
  assert.equal(rpcCalls.filter((c) => c.name === 'technician_submit_report').length, 1, 'and the completed report was sent (once)');
  assert.ok(JSON.stringify(rpcCalls[0].body).includes('v-legacy/before/legacy-1.jpg'), 'with the old photo`s path');
  assert.equal(server.get('v-legacy/before/legacy-1.jpg'), 2000, 'the stored copy is the full photo');
  assert.equal(await getDraft(OWNER, 'v-legacy'), undefined, 'cleared only after the server confirmed');
});

// ---- 2. hung requests -------------------------------------------------------------------------------------------------------------
test('TIMEOUT: an upload that never answers is abandoned within the time limit, recorded as such, kept, and retried', async () => {
  await putDraft(draft('v2'));
  uploadImpl = async (_p, _b, signal) => hang(signal);
  const p = await enqueuePhoto('v2', 'after', jpeg());
  await settle(150);
  const after = await getPhoto(p.id);
  assert.deepEqual([after?.status, after?.failureKind, after?.attempts], ['pending', 'timeout', 1]);
  assert.match(after!.lastError ?? '', /took too long/);
  uploadImpl = (path, body) => realUpload(path, body);
  await retryPhoto(after!);
  await settle(50);
  assert.equal((await getPhoto(p.id))?.status, 'uploaded');
});

test('SLOTS: three hung uploads do not block the queue - their places are freed and other photos (other reports) still upload', async () => {
  await putDraft(draft('stuck'));
  await putDraft(draft('other'));
  uploadImpl = async (path, body, signal) => (path.startsWith('stuck/') ? hang(signal) : realUpload(path, body));
  const stuck = await Promise.all([1, 2, 3].map((s) => enqueuePhoto('stuck', 'after', jpeg(1000, s))));
  const other = await enqueuePhoto('other', 'after', jpeg(1000, 9)); // waits for a free place
  await settle(250);
  assert.equal((await getPhoto(other.id))?.status, 'uploaded', 'got a place once the hung ones timed out');
  for (const s of stuck) assert.equal((await getPhoto(s.id))?.failureKind, 'timeout');
});

// ---- 3. verification ----------------------------------------------------------------------------------------------------------------
test('VERIFY: a complete copy already on the server counts (no second upload); duplicate triggers upload once', async () => {
  await putDraft(draft('v3'));
  const p = await enqueuePhoto('v3', 'after', jpeg(2500));
  await settle(50);
  const done = await getPhoto(p.id);
  assert.equal(done?.status, 'uploaded');
  assert.equal(uploads.length, 1);
  // a "lost reply": record says pending, server has it complete
  const p2 = await enqueuePhoto('v3', 'before', jpeg(1500, 2));
  await settle(50);
  const path2 = (await getPhoto(p2.id))!.storagePath;
  uploads = [];
  await Promise.all([retryPhoto({ ...(await getPhoto(p2.id))!, status: 'pending' }), retryPhoto({ ...(await getPhoto(p2.id))!, status: 'pending' })]);
  await settle(50);
  assert.equal(uploads.length, 0, 'already complete on the server: not uploaded again');
  assert.equal(server.get(path2), 1500);
});

test('VERIFY: an INCOMPLETE copy at the path is never counted - removed, the photo moves to a fresh path, uploads complete; the report uses the new path', async () => {
  await putDraft(draft('v4'));
  online.onLine = false; // taken offline
  const p = await enqueuePhoto('v4', 'after', jpeg(4000));
  const oldPath = (await getPhoto(p.id))!.storagePath;
  server.set(oldPath, 1200); // an earlier attempt left part of it
  online.onLine = true;
  await markReadyToSubmit('v4');
  await runSyncSweepForTests();
  await settle(60);
  const after = await getPhoto(p.id);
  assert.equal(after, undefined, 'report sent and cleared');
  assert.ok(removed.includes(oldPath), 'the incomplete copy was removed');
  const sent = JSON.stringify(rpcCalls.find((c) => c.name === 'technician_submit_report')?.body);
  assert.ok(!sent.includes(oldPath), 'the report never references the incomplete copy');
  const newPath = [...server.keys()].find((k) => k.startsWith('v4/after/') && k !== oldPath)!;
  assert.equal(server.get(newPath), 4000);
  assert.ok(sent.includes(newPath));
});

test('VERIFY: uploaded but the server keeps the wrong size, or says nothing about size - NOT marked uploaded; recorded as "couldn’t be confirmed"', async () => {
  await putDraft(draft('v5'));
  uploadImpl = async (path) => { server.set(path, 10); return 'created'; }; // stored truncated
  const p = await enqueuePhoto('v5', 'after', jpeg(3000));
  await settle(60);
  let after = await getPhoto(p.id);
  assert.deepEqual([after?.status, after?.failureKind], ['pending', 'verify']);
  checkImpl = async (path) => (server.has(path) ? { found: true, sizeBytes: null } : { found: false });
  uploadImpl = (path, body) => realUpload(path, body);
  await retryPhoto(after!);
  await settle(60);
  after = await getPhoto(p.id);
  assert.notEqual(after?.status, 'uploaded', 'size unknown: not enough to count it');
  assert.equal(after?.failureKind, 'verify');
  checkImpl = realCheck;
  await retryPhoto(after!);
  await settle(60);
  assert.equal((await getPhoto(p.id))?.status, 'uploaded');
});

// ---- 4. fairness, restart, connectivity -------------------------------------------------------------------------------------------------
test('TURNS: reports take turns (completed reports first), each report`s photos oldest first', () => {
  const ph = (visitId: string, n: number): PendingPhoto => ({ id: `${visitId}${n}`, ownerId: OWNER, visitId, phase: 'after', blob: new Blob([]), storagePath: '', status: 'pending', lastError: null, createdAt: `2026-11-21T0${n}:00:00Z` });
  const big = [1, 2, 3, 4, 5].map((n) => ph('A', n));
  const small = [1, 2].map((n) => ph('B', n));
  const ready = [ph('R', 1), ph('R', 2)];
  const order = takeTurnsByVisit([...big, ...small, ...ready], new Set(['R'])).map((p) => p.id);
  assert.deepEqual(order.slice(0, 7), ['R1', 'A1', 'B1', 'R2', 'A2', 'B2', 'A3']);
  assert.equal(order.length, 9);
});

test('RESTART: a photo left "uploading" by a closed page, and photos taken offline, upload on the next sweep; the completed report is then sent', async () => {
  online.onLine = false;
  await putDraft(draft('v6'));
  const a = await enqueuePhoto('v6', 'before', jpeg(1000, 1));
  const b = await enqueuePhoto('v6', 'after', jpeg(1100, 2));
  await markReadyToSubmit('v6');
  assert.equal(uploads.length, 0, 'offline: nothing tried');
  // a page that died mid-upload left this one "uploading"
  const { updatePhotoIfPresent } = await import('../src/technician/offline/db');
  await updatePhotoIfPresent({ ...(await getPhoto(a.id))!, status: 'uploading' });
  online.onLine = true; // reopened / back online
  await runSyncSweepForTests(true);
  await settle(80);
  assert.equal(rpcCalls.filter((c) => c.name === 'technician_submit_report').length, 1);
  assert.equal(await getPhoto(a.id), undefined);
  assert.equal(await getPhoto(b.id), undefined);
});

test('FAILED photos of a completed report keep being tried - spaced out, not every 30 seconds', async () => {
  await putDraft(draft('v7'));
  uploadImpl = async () => { throw new Error('Load failed'); };
  // As after three failed automatic attempts (each a few seconds apart) - the next failure is the "gave up" step.
  await putPhoto({ id: 'p7', ownerId: OWNER, visitId: 'v7', phase: 'after', blob: new Blob([bytes(800)], { type: 'image/jpeg' }), storagePath: 'v7/after/p7.jpg', status: 'pending', lastError: 'Load failed', createdAt: '2026-11-21T06:00:00.000Z', attempts: 3, nextAttemptAt: null });
  await runSyncSweepForTests();
  await settle(30);
  const p = { id: 'p7' };
  const after = await getPhoto(p.id);
  assert.deepEqual([after?.status, after?.failureKind], ['failed', 'network']);
  const waitMs = Date.parse(after!.nextAttemptAt!) - Date.now();
  assert.ok(waitMs > 50_000, `next automatic try is spaced out (${Math.round(waitMs / 1000)} s)`);
  await markReadyToSubmit('v7');
  const before = uploads.length;
  await runSyncSweepForTests();
  await settle(20);
  assert.equal(uploads.length, before, 'the sweep respects that pause');
});

// ---- 5. unreadable photos ---------------------------------------------------------------------------------------------------------------
test('UNREADABLE: a photo the phone can`t read is not sent, not counted as a network failure, kept - and may be removed from a completed report (not if it is the only one)', async () => {
  await putDraft(draft('v8'));
  const good = await enqueuePhoto('v8', 'before', jpeg(1000, 1));
  online.onLine = false;
  const bad: PendingPhoto = { id: 'unreadable-1', ownerId: OWNER, visitId: 'v8', phase: 'after', blob: new Blob([bytes(900)], { type: 'image/jpeg' }), storagePath: 'v8/after/u.jpg', status: 'pending', lastError: null, createdAt: '2026-11-21T06:00:00.000Z' };
  Object.defineProperty(bad.blob, 'arrayBuffer', { value: () => Promise.reject(new DOMException('The object can not be found here.', 'NotFoundError')) });
  await putPhoto(bad);
  online.onLine = true;
  await settle(40);
  await retryPhoto(bad);
  await settle(40);
  const after = await getPhoto('unreadable-1');
  // (fake-indexeddb returns a fresh Blob copy on read, so the stored record is readable again here - the attempt above used the broken one)
  assert.ok(after, 'kept, never deleted');
  assert.ok(!uploads.includes('v8/after/u.jpg'), 'nothing sent for it');
  assert.deepEqual([after?.status, after?.failureKind], ['failed', 'unreadable']);
  assert.match(photoProblemText(after!), /can’t be read from this phone/);
  await markReadyToSubmit('v8');
  await assert.rejects(removeQueuedPhoto(good), /already being sent/, 'a readable photo of a completed report stays fixed');
  await removeQueuedPhoto(after!);
  await settle(40);
  assert.equal(await getPhoto('unreadable-1'), undefined);
  assert.equal(rpcCalls.filter((c) => c.name === 'technician_submit_report').length, 1, 'the report then goes with its remaining photo');
});

test('UNREADABLE: the report`s ONLY photo can`t be removed (the office needs one) - the message says to contact the office', async () => {
  await putDraft(draft('v9', { readyToSubmit: true }));
  const only: PendingPhoto = { id: 'only-1', ownerId: OWNER, visitId: 'v9', phase: 'after', blob: new Blob([bytes(10)]), storagePath: 'v9/after/o.jpg', status: 'failed', failureKind: 'unreadable', lastError: 'x', createdAt: '2026-11-21T06:00:00.000Z' };
  await putPhoto(only);
  await assert.rejects(removeQueuedPhoto(only), /only photo/);
  assert.ok(await getPhoto('only-1'));
});

// ---- 6. status: photo problems vs report send problems --------------------------------------------------------------------------------
test('STATUS: header and Completed screen tell uploading, photos failing, report not sent and sending apart; a send failure is never hidden', () => {
  const base = { online: true, pendingPhotoCount: 0, failedPhotoCount: 0, failedDraftCount: 0, waitingReportCount: 0 };
  const none = { pending: 0, failed: 0 };
  assert.deepEqual(headerSyncBadge({ ...base, online: false }, none), { tone: 'bad', text: 'Offline' });
  assert.deepEqual(headerSyncBadge({ ...base, pendingPhotoCount: 12, waitingReportCount: 4 }, none), { tone: 'busy', text: 'Uploading 12 photos' }, 'Todd`s case: photos still uploading is NOT "sync failed"');
  assert.deepEqual(headerSyncBadge({ ...base, pendingPhotoCount: 3, failedPhotoCount: 3, waitingReportCount: 1 }, none), { tone: 'bad', text: '3 photos not uploaded' });
  assert.deepEqual(headerSyncBadge({ ...base, pendingPhotoCount: 9, failedPhotoCount: 2, failedDraftCount: 1, waitingReportCount: 5 }, none), { tone: 'bad', text: 'Report not sent' }, 'a report send failure always wins');
  assert.deepEqual(headerSyncBadge({ ...base, waitingReportCount: 1 }, none), { tone: 'busy', text: 'Sending report' });
  assert.deepEqual(headerSyncBadge({ ...base, pendingPhotoCount: 1 }, { pending: 2, failed: 0 }), { tone: 'busy', text: 'Uploading 1 photo + 2 videos' });
  assert.equal(headerSyncBadge(base, none), null);

  const up = (s: PendingPhoto['status']) => ({ status: s });
  assert.equal(reportSyncSummary(true, undefined, []).headline, 'Sent to the office');
  assert.equal(reportSyncSummary(false, { permanentFailure: true, submitError: 'x' }, []).state, 'refused');
  assert.equal(reportSyncSummary(false, { submitError: 'Load failed' }, [up('failed')]).state, 'send-failed', 'send failure first');
  assert.equal(reportSyncSummary(false, {}, [up('uploaded'), up('failed'), up('pending')]).headline, '1 photo not uploaded yet — retrying automatically');
  assert.equal(reportSyncSummary(false, {}, [up('uploaded'), up('uploaded'), up('pending'), up('uploading'), up('pending')]).headline, 'Uploading photos — 2 of 5 done');
  assert.equal(reportSyncSummary(false, {}, [up('uploaded')]).state, 'sending');
  for (const k of ['network', 'timeout', 'verify', 'rejected', 'unreadable'] as const) assert.doesNotMatch(photoProblemText({ failureKind: k }), /HTTP|Error|bytes|fetch/i, `${k}: plain words only`);
});

test('SUBMIT FAILURE stays a report failure (photos all uploaded) and keeps retrying; photo records are kept until the server confirms', async () => {
  await putDraft(draft('v10'));
  const p = await enqueuePhoto('v10', 'after', jpeg());
  await settle(40);
  rpcAnswer = () => new TypeError('Load failed');
  await markReadyToSubmit('v10');
  await settle(40);
  const d = await getDraft(OWNER, 'v10');
  assert.ok(d?.submitError, 'recorded as a report send failure');
  assert.equal((await getPhoto(p.id))?.status, 'uploaded', 'its photo stays uploaded and kept');
  rpcAnswer = () => new Response(null, { status: 204 });
  await trySubmitIfReady('v10');
  assert.equal(await getDraft(OWNER, 'v10'), undefined);
});
