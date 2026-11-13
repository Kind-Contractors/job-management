// The waste reporter's upload-and-send engine (src/waste/offline/wasteSyncEngine.ts) over a fake IndexedDB, with the network replaced:
// files upload and are checked, a report is sent only when every file has passed, sending is never done twice at once, a lost reply is
// resent with the SAME report id (the server then returns the existing report), refusals stop, and sent reports are locked.
import 'fake-indexeddb/auto';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { setCurrentUserId } from '../src/auth/currentUser';
import {
  addWasteMedia,
  discardWasteDraft,
  editWasteDraftAgain,
  getOrCreateEditingDraft,
  kick,
  listWasteDrafts,
  listWasteMedia,
  removeWasteMedia,
  requestWasteSubmit,
  isWasteWorkerBusy,
  recoverAfterRestart,
  retryWasteMedia,
  retryWaitingUploads,
  UNREADABLE_MESSAGE,
  retryWasteSubmit,
  setWasteEngineDepsForTests,
  summarizeWasteUploads,
  subscribeWasteReportSent,
  updateWasteDraftFields,
  waitForWasteWorker,
  type WasteEngineDeps,
} from '../src/waste/offline/wasteSyncEngine';
import { getDraft, getMedia, listDrafts, listMediaForOwner, deleteDraft, deleteMedia, putMedia, updateMediaIfPresent } from '../src/waste/offline/wasteDb';
import { WasteRpcError, type FileCheckOutcome, type SubmitWasteReportInput, type VideoUploadOptions } from '../src/waste/wasteApi';
import { UploadPausedError } from '../src/waste/wasteTus';
import { UploadError } from '../src/lib/reportVideoUpload';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let ids = 0;
let clock = Date.parse('2026-11-03T10:00:00Z');

interface Calls {
  small: string[];
  video: { path: string; tusUrl: string | null }[];
  checks: string[];
  removed: string[][];
  submits: SubmitWasteReportInput[];
}
let calls: Calls;
let checkResult: (path: string) => FileCheckOutcome;
let submitImpl: (input: SubmitWasteReportInput) => Promise<{ created: boolean }>;
let smallUpload: (path: string, signal?: AbortSignal) => Promise<void>;
let videoUpload: (path: string, opts: VideoUploadOptions) => Promise<void>;
let baseDeps: Partial<WasteEngineDeps> = {};
/** Extra engine settings for one test, on top of the fakes. */
function useDeps(over: Partial<WasteEngineDeps>) {
  setWasteEngineDepsForTests({ ...baseDeps, ...over });
}
let online = true;
let videoMeta: { durationSeconds: number | null; thumbnail: Blob | null };

function photo(name = 'a.jpg', type = 'image/jpeg', size = 1000): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1 });
}

async function reset(): Promise<void> {
  setCurrentUserId(OWNER);
  await waitForWasteWorker();
  for (const d of await listDrafts(OWNER)) await deleteDraft(OWNER, d.reportId);
  for (const m of await listMediaForOwner(OWNER)) await deleteMedia(m.id);
  calls = { small: [], video: [], checks: [], removed: [], submits: [] };
  online = true;
  videoMeta = { durationSeconds: 12, thumbnail: new Blob([new Uint8Array(10)], { type: 'image/jpeg' }) };
  checkResult = (path) => ({ result: 'ok', durationSeconds: /\.(mp4|mov|webm)$/.test(path) ? 12 : null });
  submitImpl = async () => ({ created: true });
  smallUpload = async () => undefined;
  videoUpload = async (_p, o) => {
    o.onUploadUrl('https://tus/upload-1');
    o.onProgress(1);
  };
  baseDeps = {
    isOnline: () => online,
    now: () => new Date(clock),
    newId: () => `0000000${++ids}`.slice(-8) + '-0000-4000-8000-000000000000',
    uploadSmallFile: async (path, _b, _t, signal) => {
      calls.small.push(path);
      await smallUpload(path, signal);
    },
    uploadVideoFile: async (path, _b, _t, opts) => {
      calls.video.push({ path, tusUrl: opts.tusUrl });
      await videoUpload(path, opts);
    },
    checkUploadedFile: async (path) => {
      calls.checks.push(path);
      return checkResult(path);
    },
    removeFiles: async (paths) => {
      calls.removed.push(paths);
    },
    submitReport: async (input) => {
      calls.submits.push(input);
      return submitImpl(input);
    },
    preparePhoto: async (file) => ({ blob: file, filename: file.name }),
    readVideoMetadata: async () => videoMeta,
    stallMs: 40,
    videoTurnMs: 60_000,
    isReadable: async () => true,
  };
  setWasteEngineDepsForTests(baseDeps);
}

beforeEach(reset);

async function draftWith(fields: { address?: string } = {}) {
  const d = await getOrCreateEditingDraft();
  await updateWasteDraftFields(d.reportId, { address: fields.address ?? '1 High St' });
  return d.reportId;
}

async function settle() {
  await kick();
  await waitForWasteWorker();
}

test('a photo is stored under {user}/{report}/{phase}/{id}.jpg, uploaded, then checked by the server; then it is ready', async () => {
  const reportId = await draftWith();
  const r = await addWasteMedia(reportId, 'before', 'photo', photo());
  assert.equal(r.ok, true);
  await settle();
  const [m] = await listWasteMedia(reportId);
  assert.match(m.storagePath, new RegExp(`^${OWNER}/${reportId}/before/[0-9a-f-]{36}\\.jpg$`));
  assert.equal(m.status, 'ready');
  assert.deepEqual(calls.small, [m.storagePath]);
  assert.deepEqual(calls.checks, [m.storagePath]);
});

test('a video uploads resumably (its resume URL is kept), its poster and the video are both checked; the server length is kept', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'after', 'video', new File([new Uint8Array(500)], 'clip.mov', { type: 'video/quicktime', lastModified: 2 }));
  checkResult = (path) => ({ result: 'ok', durationSeconds: path.endsWith('.mov') ? 33.5 : null });
  await settle();
  const [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'ready');
  assert.equal(m.durationSeconds, 33.5);
  assert.equal(calls.video.length, 1);
  assert.ok(m.thumbPath?.endsWith('.thumb.jpg'));
  assert.deepEqual(calls.checks, [m.thumbPath, m.storagePath]);
});

test('an interrupted video upload resumes from its saved upload URL on the next attempt', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'after', 'video', new File([new Uint8Array(500)], 'clip.mp4', { type: 'video/mp4', lastModified: 3 }));
  videoUpload = async (_p, o) => {
    o.onUploadUrl('https://tus/resume-me');
    throw new UploadError('connection reset', null);
  };
  await settle();
  let [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'pending');
  assert.equal(m.tusUrl, 'https://tus/resume-me');
  videoUpload = async () => undefined;
  clock += 10 * 60_000; // past the backoff
  await settle();
  [m] = await listWasteMedia(reportId);
  assert.equal(calls.video.at(-1)?.tusUrl, 'https://tus/resume-me');
  assert.equal(m.status, 'ready');
});

test('the report is sent only when every file has passed, exactly once, with the phone-made ids; then the phone forgets it', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo('1.jpg'));
  await addWasteMedia(reportId, 'after', 'photo', photo('2.jpg'));
  const sent: string[] = [];
  const off = subscribeWasteReportSent((id) => sent.push(id));
  await requestWasteSubmit(reportId);
  await settle();
  off();
  assert.equal(calls.submits.length, 1);
  const s = calls.submits[0];
  assert.equal(s.reportId, reportId);
  assert.equal(s.address, '1 High St');
  assert.deepEqual(s.media.map((m) => m.phase), ['before', 'after']);
  assert.deepEqual(sent, [reportId]);
  assert.equal(await getDraft(OWNER, reportId), undefined);
  assert.equal((await listWasteMedia(reportId)).length, 0);
});

test('a report waits while a file is still being checked, and is not sent with a rejected file', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo());
  checkResult = () => ({ result: 'retry', message: 'busy' });
  await requestWasteSubmit(reportId);
  await settle();
  assert.equal(calls.submits.length, 0, 'not sent while unchecked');

  const other = await getOrCreateEditingDraft();
  await updateWasteDraftFields(other.reportId, { address: '2 Low St' });
  await addWasteMedia(other.reportId, 'after', 'video', new File([new Uint8Array(9)], 'long.mp4', { type: 'video/mp4', lastModified: 9 }));
  checkResult = (path) => (path.endsWith('.mp4') ? { result: 'rejected', reason: 'That video is 1:05 long. The limit is 1:00.' } : { result: 'ok', durationSeconds: null });
  await requestWasteSubmit(other.reportId);
  clock += 10 * 60_000;
  await settle();
  const media = await listWasteMedia(other.reportId);
  const video = media.find((m) => m.kind === 'video')!;
  assert.equal(video.status, 'failed');
  assert.equal(video.permanentFailure, true);
  assert.match(video.lastError ?? '', /1:05/);
  assert.equal(calls.submits.filter((s) => s.reportId === other.reportId).length, 0);
  assert.match((await getDraft(OWNER, other.reportId))?.submitError ?? '', /can’t be sent. Remove it/);
});

test('three triggers at the same moment still send the report once (one worker, claimed before any waiting)', async () => {
  const reportId = await draftWith();
  let release!: () => void;
  submitImpl = () => new Promise((resolve) => (release = () => resolve({ created: true })));
  await requestWasteSubmit(reportId); // starts a worker
  const a = kick();
  const b = kick();
  const c = kick();
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all([a, b, c]);
  await waitForWasteWorker();
  assert.equal(calls.submits.length, 1);
});

test('a lost reply: the report stays on the phone and is resent with the SAME id; the server returns the existing report', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo());
  submitImpl = async () => {
    throw new WasteRpcError('Failed to fetch', null); // no Postgres code: the reply never arrived
  };
  await requestWasteSubmit(reportId);
  await settle();
  const kept = await getDraft(OWNER, reportId);
  assert.ok(kept, 'kept');
  assert.equal(kept!.permanentFailure, false);
  submitImpl = async () => ({ created: false }); // the first attempt had in fact reached the server
  await settle();
  assert.ok(calls.submits.length >= 2);
  for (const s of calls.submits) {
    assert.equal(s.reportId, reportId, 'every attempt uses the same report id');
    assert.deepEqual(s.media.map((m) => m.id), calls.submits[0].media.map((m) => m.id), 'and the same file ids');
  }
  assert.equal(await getDraft(OWNER, reportId), undefined, 'cleared once the server confirmed it');
});

test('a refusal from the database stops (no automatic retries) until he changes the report or tries again', async () => {
  const reportId = await draftWith();
  submitImpl = async () => {
    throw new WasteRpcError('The end date cannot be in the future.', 'P0001');
  };
  await requestWasteSubmit(reportId);
  await settle();
  await settle();
  assert.equal(calls.submits.length, 1);
  const d = await getDraft(OWNER, reportId);
  assert.equal(d?.permanentFailure, true);
  assert.equal(d?.submitError, 'The end date cannot be in the future.');

  await editWasteDraftAgain(reportId);
  const reopened = await getDraft(OWNER, reportId);
  assert.equal(reopened?.submitRequested, false);
  submitImpl = async () => ({ created: true });
  await requestWasteSubmit(reportId);
  await settle();
  assert.equal(calls.submits.length, 2);

  // "Try again" path
  const second = await draftWith();
  submitImpl = async () => {
    throw new WasteRpcError('refused', 'P0001');
  };
  await requestWasteSubmit(second);
  await settle();
  submitImpl = async () => ({ created: true });
  await retryWasteSubmit(second);
  await settle();
  assert.equal(await getDraft(OWNER, second), undefined);
});

test('a sent report is locked: no typing saved, no files added or removed', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo());
  online = false; // keep it on the phone
  await requestWasteSubmit(reportId);
  await updateWasteDraftFields(reportId, { address: 'changed' });
  assert.equal((await getDraft(OWNER, reportId))?.address, '1 High St');
  const add = await addWasteMedia(reportId, 'after', 'photo', photo('z.jpg'));
  assert.equal(add.ok, false);
  const [m] = await listWasteMedia(reportId);
  await assert.rejects(() => removeWasteMedia(m.id), /has been sent/);
});

test('"Start another report" while one is still sending gives a new, separate draft', async () => {
  const first = await draftWith();
  online = false;
  await requestWasteSubmit(first);
  const next = await getOrCreateEditingDraft();
  assert.notEqual(next.reportId, first);
  assert.equal((await listWasteDrafts()).length, 2);
});

test('discarding a draft removes it and its files from the phone, and asks the server to remove uploaded copies', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo());
  await settle();
  const [m] = await listWasteMedia(reportId);
  await discardWasteDraft(reportId);
  assert.equal(await getDraft(OWNER, reportId), undefined);
  assert.equal((await listWasteMedia(reportId)).length, 0);
  assert.ok(calls.removed.flat().includes(m.storagePath));
});

test('picking: the same file twice in a section, a non-JPEG/PNG photo (e.g. HEIC) and an over-long video are refused at once', async () => {
  const reportId = await draftWith();
  assert.equal((await addWasteMedia(reportId, 'before', 'photo', photo('x.jpg'))).ok, true);
  const again = await addWasteMedia(reportId, 'before', 'photo', photo('x.jpg'));
  assert.equal(again.ok, false);
  const heic = await addWasteMedia(reportId, 'before', 'photo', photo('y.heic', 'image/heic'));
  assert.equal(heic.ok, false);
  assert.match(heic.ok ? '' : heic.message, /format can’t be used/);
  videoMeta = { durationSeconds: 75, thumbnail: null };
  const long = await addWasteMedia(reportId, 'after', 'video', new File([new Uint8Array(5)], 'l.mp4', { type: 'video/mp4', lastModified: 4 }));
  assert.equal(long.ok, false);
  assert.match(long.ok ? '' : long.message, /75\.0 seconds long\. The limit is 60 seconds/);
});

test('another user’s queued work on the same phone is never uploaded or sent', async () => {
  online = false;
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo());
  await requestWasteSubmit(reportId);
  setCurrentUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  online = true;
  await settle();
  assert.equal(calls.small.length, 0);
  assert.equal(calls.submits.length, 0);
  setCurrentUserId(OWNER);
});

// ---- C1: a video upload that finds "409 already exists" ----------------------------------------------------------------------------
const video = (name = 'v.mp4', size = 500) => new File([new Uint8Array(size)], name, { type: 'video/mp4', lastModified: 7 });
const existsError = () => new UploadError('The resource already exists', 409);

test('interrupted, then 409 on the retry: the found file is CHECKED by the server and, being exactly this file, counts as uploaded', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'after', 'video', video());
  // 1st attempt: the connection drops after the server took the upload (its finish was never recorded on the phone)
  videoUpload = async (_p, o) => {
    o.onUploadUrl('https://tus/u1');
    throw new UploadError('network error', null);
  };
  await settle();
  let [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'pending');
  const firstPath = m.storagePath;
  // 2nd attempt: the server says the file already exists
  videoUpload = async () => {
    throw existsError();
  };
  checkResult = (path) => ({ result: 'ok', durationSeconds: path.endsWith('.mp4') ? 20 : null, sizeBytes: path.endsWith('.mp4') ? 500 : 10 });
  clock += 10 * 60_000;
  await settle();
  [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'ready');
  assert.equal(m.storagePath, firstPath, 'kept: the found file is this one');
  assert.equal(m.durationSeconds, 20);
  assert.ok(calls.checks.includes(firstPath), 'the server checked the found file before it counted');
  assert.equal(calls.video.length, 2, 'not uploaded a third time');
});

test('409, but the stored copy is a different size (incomplete/different): NOT treated as uploaded - removed, new name, uploaded again', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'after', 'video', video('w.mp4', 500));
  let attempt = 0;
  videoUpload = async () => {
    attempt += 1;
    if (attempt === 1) throw existsError();
  };
  checkResult = (path) => {
    if (!path.endsWith('.mp4')) return { result: 'ok', durationSeconds: null, sizeBytes: 10 };
    return { result: 'ok', durationSeconds: 20, sizeBytes: attempt === 1 ? 123 : 500 };
  };
  await settle();
  let [m] = await listWasteMedia(reportId);
  const firstPath = calls.video[0].path;
  assert.equal(m.status, 'pending', 'not ready');
  assert.notEqual(m.storagePath, firstPath, 'a fresh name, so the retry cannot collide with the stale copy');
  assert.equal(m.fileUploaded, false);
  assert.ok(calls.removed.flat().includes(firstPath), 'the stale copy was removed');
  assert.match(m.lastError ?? '', /incomplete copy/);
  clock += 10 * 60_000;
  await settle();
  [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'ready');
  assert.equal(calls.video.at(-1)!.path, m.storagePath);
});

test('409 and the found copy is REJECTED by the server: not a success - this file is uploaded again under a fresh name and checked itself', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'after', 'video', video('x.mp4', 500));
  let attempt = 0;
  videoUpload = async () => {
    attempt += 1;
    if (attempt === 1) throw existsError();
  };
  checkResult = (path) => {
    if (!path.endsWith('.mp4')) return { result: 'ok', durationSeconds: null, sizeBytes: 10 };
    return attempt === 1 ? { result: 'rejected', reason: 'That file isn’t really an MP4 or MOV video.' } : { result: 'ok', durationSeconds: 15, sizeBytes: 500 };
  };
  await settle();
  let [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'pending');
  assert.equal(m.permanentFailure, false, 'one bad stale copy does not condemn this file');
  assert.notEqual(m.storagePath, calls.video[0].path);
  clock += 10 * 60_000;
  await settle();
  [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'ready');
});

test('a genuinely invalid video is still rejected for good (no endless retries), with or without a 409 first', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'after', 'video', video('long.mp4', 500));
  let attempt = 0;
  videoUpload = async () => {
    attempt += 1;
    if (attempt === 1) throw existsError();
  };
  checkResult = (path) => (path.endsWith('.mp4') ? { result: 'rejected', reason: 'That video is 75.0 seconds long. The limit is 60 seconds.' } : { result: 'ok', durationSeconds: null, sizeBytes: 10 });
  await settle();
  clock += 10 * 60_000;
  await settle();
  const [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'failed');
  assert.equal(m.permanentFailure, true);
  assert.match(m.lastError ?? '', /75\.0 seconds/);
  assert.equal(attempt, 2, 'one fresh upload after the stale copy, then stopped');
});

test('409 and the found copy then vanished (missing): uploaded again, never counted as uploaded', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'after', 'video', video('y.mp4', 500));
  let attempt = 0;
  videoUpload = async () => {
    attempt += 1;
    if (attempt === 1) throw existsError();
  };
  checkResult = (path) => (path.endsWith('.mp4') && attempt === 1 ? { result: 'missing' } : { result: 'ok', durationSeconds: 9, sizeBytes: path.endsWith('.mp4') ? 500 : 10 });
  await settle();
  let [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'pending');
  assert.equal(m.fileUploaded, false);
  clock += 10 * 60_000;
  await settle();
  [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'ready');
  assert.equal(attempt, 2);
});

test('a file of a report already sent elsewhere is refused by the server (423 -> not accepted) and never counted as uploaded', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo('s.jpg'));
  checkResult = () => ({ result: 'rejected', reason: 'This report has already been sent, so its photos and videos can’t be checked or changed.' });
  await settle();
  const [m] = await listWasteMedia(reportId);
  assert.equal(m.status, 'failed');
  assert.match(m.lastError ?? '', /already been sent/);
});

// ---- 2026-11-04: uploads stuck on "Sending..." (a report whose files stopped retrying) ------------------------------------------
// Before this fix six failed attempts (about 14 minutes of a weak signal or a suspended app) STOPPED a file for good; only an
// "online" event - which iOS rarely sends - restarted it, so the report sat on "Sending..." with nothing uploading.

/** Runs worker passes, moving the clock past every pause, until nothing changes. */
async function passes(n: number) {
  for (let i = 0; i < n; i++) {
    clock += 11 * 60_000;
    await settle();
  }
}

test('STUCK FIX: a file that keeps failing never stops for good - it keeps retrying, then uploads when the signal is back, and the report is sent once', async () => {
  // Two upload, then the signal goes: every further attempt fails
  let uploads = 0;
  smallUpload = async () => {
    uploads += 1;
    if (uploads > 2) throw Object.assign(new Error('Load failed'), { status: null });
  };
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo('a.jpg'));
  await addWasteMedia(reportId, 'before', 'photo', photo('b.jpg', 'image/jpeg', 2000));
  await addWasteMedia(reportId, 'after', 'photo', photo('c.jpg', 'image/jpeg', 3000));
  await requestWasteSubmit(reportId);
  await settle();
  await passes(12);
  const waiting = (await listWasteMedia(reportId)).find((m) => m.status !== 'ready')!;
  assert.equal(waiting.status, 'pending', 'still queued after 12+ failures - not stopped');
  assert.equal(waiting.permanentFailure, false);
  assert.ok(waiting.attempts >= 12);
  assert.match(waiting.lastError ?? '', /interrupted - no answer from the server/, 'the REAL reason is kept after 12+ attempts (never replaced by a generic text)');
  assert.equal(waiting.lastErrorDetail, 'Load failed', 'with the technical detail beside it');
  assert.ok(Date.parse(waiting.nextAttemptAt!) - clock <= 10 * 60_000, 'retried at most 10 minutes apart');
  assert.equal(calls.submits.length, 0, 'never sent while a file is missing');
  assert.deepEqual(summarizeWasteUploads(await listWasteMedia(reportId)), { total: 3, ready: 2, retrying: 1, needsAttention: 0, reasons: [] });

  // signal back
  smallUpload = async () => undefined;
  await passes(1);
  assert.equal(calls.submits.length, 1, 'sent exactly once');
  assert.equal(calls.submits[0].media.length, 3, 'all three files, each once');
  assert.equal(new Set(calls.submits[0].media.map((m) => m.storagePath)).size, 3);
  assert.equal((await listWasteDrafts()).length, 0, 'the phone forgets it once the server confirmed it');
});

test('STUCK FIX: a phone left with STOPPED files by the old version recovers by itself when the app opens (retryWaitingUploads)', async () => {
  const reportId = await draftWith();
  await addWasteMedia(reportId, 'before', 'photo', photo('a.jpg'));
  await addWasteMedia(reportId, 'before', 'photo', photo('b.jpg', 'image/jpeg', 2000));
  smallUpload = async (path) => {
    if (calls.small.filter((p) => p === path).length === 1 && calls.small.length > 1) throw new Error('Load failed');
  };
  await requestWasteSubmit(reportId);
  await settle();
  // what the old engine left behind: the second photo 'failed' after six attempts (not refused by the server)
  const stuck = (await listWasteMedia(reportId)).find((m) => m.status !== 'ready')!;
  await updateMediaIfPresent({ ...stuck, status: 'failed', permanentFailure: false, attempts: 6, nextAttemptAt: null, lastError: 'The upload was interrupted. It will carry on by itself. Tried 6 times.' });
  await settle();
  assert.equal(calls.submits.length, 0, 'blocked while stopped');
  assert.equal(summarizeWasteUploads(await listWasteMedia(reportId)).retrying, 1, 'shown as waiting, not as needing him');

  smallUpload = async () => undefined;
  await retryWaitingUploads(); // what the app now does when it opens, comes back to the screen, or comes back online
  await waitForWasteWorker();
  assert.equal(calls.submits.length, 1);
  assert.equal(calls.submits[0].media.length, 2);
});

test('STUCK FIX: "Try now" / coming back to the app retries a waiting file at once, not at the end of its pause - and only that report when asked', async () => {
  const a = await draftWith({ address: 'A' });
  await addWasteMedia(a, 'before', 'photo', photo('a.jpg'));
  smallUpload = async () => {
    throw new Error('Load failed');
  };
  await requestWasteSubmit(a);
  await settle();
  const b = (await getOrCreateEditingDraft()).reportId;
  await updateWasteDraftFields(b, { address: 'B' });
  await addWasteMedia(b, 'before', 'photo', photo('b.jpg', 'image/jpeg', 2000));
  await requestWasteSubmit(b);
  await settle();
  const before = calls.small.length;
  smallUpload = async () => undefined;
  await retryWaitingUploads(a, { manual: true }); // "Try now" - no clock change: the pause has not ended
  await waitForWasteWorker();
  assert.equal(calls.submits.map((x) => x.reportId).join(), a, 'report A retried and sent at once');
  assert.ok(calls.small.length > before);
  assert.equal((await listWasteMedia(b))[0].status, 'pending', 'report B still waits for its own pause');
  await retryWaitingUploads(undefined, { manual: true });
  await waitForWasteWorker();
  assert.deepEqual(calls.submits.map((x) => x.reportId), [a, b]);
});

test('STUCK FIX: an upload that hangs (no answer, no progress) is abandoned and retried - it does not hold up other files or another report', async () => {
  const a = await draftWith({ address: 'A' });
  await addWasteMedia(a, 'before', 'video', new File([new Uint8Array(9)], 'v.mp4', { type: 'video/mp4', lastModified: 3 }));
  let hang = true;
  videoUpload = async (_p, o) => {
    if (hang) return new Promise<void>(() => undefined); // never settles: e.g. iOS suspended the page mid-request
    o.onUploadUrl('https://tus/upload-2');
    o.onProgress(1);
  };
  await requestWasteSubmit(a);
  const b = (await getOrCreateEditingDraft()).reportId;
  await updateWasteDraftFields(b, { address: 'B' });
  await addWasteMedia(b, 'after', 'photo', photo('b.jpg'));
  await requestWasteSubmit(b);
  await settle();
  assert.deepEqual(calls.submits.map((x) => x.reportId), [b], 'report B is sent although A’s video hung');
  const video = (await listWasteMedia(a))[0];
  assert.equal(video.status, 'pending');
  assert.match(video.lastError ?? '', /stopped responding/);
  hang = false;
  await passes(1);
  assert.deepEqual(calls.submits.map((x) => x.reportId), [b, a]);
});

test('STUCK FIX: a video that keeps making progress is never cut off by the stall guard (it is not a time limit)', async () => {
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'video', new File([new Uint8Array(9)], 'slow.mp4', { type: 'video/mp4', lastModified: 4 }));
  videoUpload = async (_p, o) => {
    o.onUploadUrl('https://tus/slow');
    for (let i = 1; i <= 6; i++) {
      await new Promise((r) => setTimeout(r, 15)); // 6 x 15 ms = 90 ms in all, more than the 40 ms stall limit, with progress each time
      o.onProgress(i / 6);
    }
  };
  await requestWasteSubmit(a);
  await settle();
  assert.equal(calls.video.length, 1, 'one attempt, never abandoned');
  assert.equal(calls.submits.length, 1);
});

test('STUCK FIX: a hung attempt that finished late is found (409) on the retry, CHECKED by the server and counted once - no duplicate', async () => {
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo('late.jpg', 'image/jpeg', 1234));
  let first = true;
  smallUpload = async () => {
    if (first) {
      first = false;
      return new Promise<void>(() => undefined); // abandoned; pretend it reached the server after all
    }
    throw Object.assign(new Error('The resource already exists'), { status: 409 });
  };
  checkResult = () => ({ result: 'ok', durationSeconds: null, sizeBytes: 1234 });
  await requestWasteSubmit(a);
  await settle();
  await passes(1);
  assert.equal(calls.submits.length, 1);
  assert.equal(calls.submits[0].media.length, 1, 'one media row, not two');
  assert.ok(calls.checks.length >= 1, 'the found copy was checked before it counted');
});

test('STUCK FIX: a refused file stops (needs attention) with its reason, the report is not sent, and removing it after reopening lets the rest go', async () => {
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo('ok.jpg'));
  await addWasteMedia(a, 'after', 'video', new File([new Uint8Array(9)], 'long.mp4', { type: 'video/mp4', lastModified: 5 }));
  checkResult = (path) => (path.endsWith('.mp4') ? { result: 'rejected', reason: 'That video is 1:05 long. The limit is 60 seconds.' } : { result: 'ok', durationSeconds: null });
  await requestWasteSubmit(a);
  await settle();
  const summary = summarizeWasteUploads(await listWasteMedia(a));
  assert.deepEqual([summary.ready, summary.needsAttention, summary.retrying], [1, 1, 0]);
  assert.deepEqual(summary.reasons, ['That video is 1:05 long. The limit is 60 seconds.']);
  assert.equal(calls.submits.length, 0, 'never sent with a refused file');
  // "Open the report to fix it": unlock, remove the refused file, send again
  await editWasteDraftAgain(a);
  const video = (await listWasteMedia(a)).find((m) => m.kind === 'video')!;
  await removeWasteMedia(video.id);
  await requestWasteSubmit(a);
  await settle();
  assert.equal(calls.submits.length, 1);
  assert.equal(calls.submits[0].media.length, 1, 'the photo already uploaded is kept and not uploaded again');
  assert.equal(calls.small.filter((p) => p.endsWith('.jpg') && !p.includes('thumb')).length, 1);
});

test('STUCK FIX: 401/403 (e.g. an expired sign-in) keeps trying instead of stopping the file for good', async () => {
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  smallUpload = async () => {
    throw Object.assign(new Error('jwt expired'), { status: 403 });
  };
  await requestWasteSubmit(a);
  await settle();
  const m = (await listWasteMedia(a))[0];
  assert.equal(m.status, 'pending');
  assert.equal(m.permanentFailure, false);
  smallUpload = async () => undefined;
  await passes(1);
  assert.equal(calls.submits.length, 1);
});

test('STUCK FIX: "Try again" on a file waiting to retry runs it at once; it is never offered for a refused or uploaded file', async () => {
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  smallUpload = async () => {
    throw new Error('Load failed');
  };
  await settle();
  const m = (await listWasteMedia(a))[0];
  assert.ok(m.nextAttemptAt);
  smallUpload = async () => undefined;
  await retryWasteMedia(m.id);
  await waitForWasteWorker();
  assert.equal((await getMedia(m.id))?.status, 'ready');
});

test('STUCK FIX: "Open the report" opens THAT report even when a newer draft exists (it is not swapped for the newest one)', async () => {
  online = false; // so it stays on the phone, waiting to be sent
  const a = await draftWith({ address: 'Old report' });
  await requestWasteSubmit(a);
  const newer = await getOrCreateEditingDraft();
  assert.notEqual(newer.reportId, a);
  await editWasteDraftAgain(a);
  assert.equal((await getOrCreateEditingDraft(a)).reportId, a, 'the one he chose');
  assert.equal((await getOrCreateEditingDraft()).reportId, newer.reportId, 'without a choice: the newest, as before');
  assert.equal((await getOrCreateEditingDraft('not-on-this-phone')).reportId, newer.reportId);
});

// ---- 2026-11-06: two lanes, fair turns, real pauses, unreadable files ------------------------------------------------------------
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const vid = (name: string, lastModified = 7) => new File([new Uint8Array(9)], name, { type: 'video/mp4', lastModified });

test('LANES: a slow video does not hold up photos - another report\'s photos upload and that report is SENT while the video is still going', async () => {
  const gate = deferred();
  videoUpload = async (_p, o) => {
    o.onUploadUrl('https://tus/a');
    o.onProgress(1, 10);
    await gate.promise; // a slow video
  };
  useDeps({ stallMs: 60_000 });
  const a = await draftWith({ address: 'A' });
  await addWasteMedia(a, 'before', 'video', vid('a.mp4'));
  await requestWasteSubmit(a);
  const b = (await getOrCreateEditingDraft()).reportId;
  await updateWasteDraftFields(b, { address: 'B' });
  await addWasteMedia(b, 'before', 'photo', photo('b1.jpg'));
  await addWasteMedia(b, 'after', 'photo', photo('b2.jpg', 'image/jpeg', 1001));
  await requestWasteSubmit(b);
  for (let i = 0; i < 50 && !calls.submits.some((x) => x.reportId === b); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.submits.map((x) => x.reportId), [b], 'B sent while A\'s video is still uploading');
  assert.equal(isWasteWorkerBusy(), true, 'the video lane is still working (a new app version would wait)');
  gate.release();
  await settle();
  assert.deepEqual(calls.submits.map((x) => x.reportId), [b, a]);
  assert.equal(isWasteWorkerBusy(), false);
});

test('PHOTOS FIRST: a video is only started once no photo is waiting', async () => {
  const order: string[] = [];
  smallUpload = async (path) => void order.push(`photo:${path.slice(-12)}`);
  videoUpload = async (path, o) => {
    order.push(`video:${path.slice(-12)}`);
    o.onUploadUrl('https://tus/x');
  };
  online = false; // queue everything first
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'video', vid('first.mp4'));
  await addWasteMedia(a, 'before', 'photo', photo('p1.jpg'));
  await addWasteMedia(a, 'after', 'photo', photo('p2.jpg', 'image/jpeg', 1002));
  online = true;
  await settle();
  const firstVideo = order.findIndex((x) => x.startsWith('video:'));
  assert.ok(firstVideo > order.lastIndexOf(order.filter((x) => x.startsWith('photo:')).at(-1)!), `photos before the video: ${order.join(', ')}`);
});

test('FAIR TURNS: two reports\' photos are uploaded in turns, not one report after the other', async () => {
  const order: string[] = [];
  smallUpload = async (path) => void order.push(path.split('/')[1]);
  online = false;
  const a = await draftWith({ address: 'A' });
  for (let i = 0; i < 3; i++) await addWasteMedia(a, 'before', 'photo', photo(`a${i}.jpg`, 'image/jpeg', 1000 + i));
  const b = (await getOrCreateEditingDraft()).reportId;
  await updateWasteDraftFields(b, { address: 'B' });
  for (let i = 0; i < 3; i++) await addWasteMedia(b, 'before', 'photo', photo(`b${i}.jpg`, 'image/jpeg', 2000 + i));
  online = true;
  await settle();
  assert.deepEqual(order.slice(0, 4), [a, b, a, b], 'A, B, A, B');
});

test('VIDEO TURN: after its turn, a video pauses at a CONFIRMED chunk boundary when another report has a video waiting; each resumes from its confirmed offset and both finish', async () => {
  const offset = new Map<string, number>(); // what the fake server has confirmed per upload
  const turns: string[] = [];
  videoUpload = async (path, o) => {
    const report = path.split('/')[1];
    const url = o.tusUrl ?? `https://tus/${report}`;
    if (!o.tusUrl) o.onUploadUrl(url);
    let done = offset.get(url) ?? 0; // resumes from the server's confirmed offset
    turns.push(`${report}@${done}`);
    while (done < 18) {
      done += 6; // one 6 MB chunk confirmed
      offset.set(url, done);
      o.onChunkComplete?.(done, 18);
      clock += 61_000; // longer than this test's 60 s turn
      if (done < 18 && o.pauseAtChunkBoundary?.()) throw new UploadPausedError('turn');
    }
  };
  online = false;
  const a = await draftWith({ address: 'A' });
  await addWasteMedia(a, 'before', 'video', vid('a.mp4', 1));
  await requestWasteSubmit(a);
  const b = (await getOrCreateEditingDraft()).reportId;
  await updateWasteDraftFields(b, { address: 'B' });
  await addWasteMedia(b, 'before', 'video', vid('b.mp4', 2));
  await requestWasteSubmit(b);
  online = true;
  await settle();
  // A starts; each turn ends at a confirmed chunk and the other report goes; nothing is ever sent twice or from the start again
  const ta = turns.filter((t) => t.startsWith(`${a}@`)).map((t) => Number(t.split('@')[1]));
  const tb = turns.filter((t) => t.startsWith(`${b}@`)).map((t) => Number(t.split('@')[1]));
  assert.deepEqual(turns.map((t) => (t.startsWith(`${a}@`) ? 'A' : 'B')), ['A', 'B', 'A', 'B', 'A', 'B'], 'the two reports take turns');
  assert.ok(ta.length >= 2 && tb.length >= 2, `both took turns: ${turns.join(' ')}`);
  for (const offs of [ta, tb]) for (let i = 1; i < offs.length; i++) assert.ok(offs[i] > offs[i - 1], `resumed further each time: ${offs.join(',')}`);
  assert.deepEqual(calls.submits.map((x) => x.reportId).sort(), [a, b].sort(), 'both sent, once each');
  for (const v of calls.video.slice(2)) assert.ok(v.tusUrl, 'every resumed turn reuses its upload');
});

test('VIDEO TURN: a video is never paused when no other report is waiting, however long it takes', async () => {
  let asked = 0;
  videoUpload = async (_p, o) => {
    o.onUploadUrl('https://tus/only');
    for (let i = 1; i <= 5; i++) {
      clock += 120_000;
      o.onChunkComplete?.(i * 6, 30);
      if (o.pauseAtChunkBoundary?.()) throw new UploadPausedError('turn');
      asked += 1;
    }
  };
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'video', vid('long.mp4'));
  await requestWasteSubmit(a);
  await settle();
  assert.equal(asked, 5);
  assert.equal(calls.video.length, 1, 'one uninterrupted upload');
  assert.equal(calls.submits.length, 1);
});

test('STALL: a photo request that stops answering is really CANCELLED (its signal aborted), not left running beside the retry', async () => {
  let aborted = false;
  let first = true;
  smallUpload = async (_p, signal) => {
    if (!first) return;
    first = false;
    await new Promise<void>((_r, reject) => signal?.addEventListener('abort', () => {
      aborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }));
  };
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await settle();
  assert.equal(aborted, true, 'the hung request was stopped');
  const m = (await listWasteMedia(a))[0];
  assert.match(m.lastError ?? '', /stopped responding/);
  await passes(1);
  assert.equal((await listWasteMedia(a))[0].status, 'ready');
});

test('STALL: a video that stops making progress is paused for real (signal aborted -> the server keeps its upload) and resumes with the same upload URL', async () => {
  let aborted = false;
  let first = true;
  videoUpload = async (_p, o) => {
    o.onUploadUrl('https://tus/stall');
    if (!first) return;
    first = false;
    await new Promise<void>((_r, reject) => o.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(new UploadPausedError('signal'));
    }));
  };
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'video', vid('stall.mp4'));
  await settle();
  assert.equal(aborted, true);
  await passes(1);
  assert.equal(calls.video.length, 2);
  assert.equal(calls.video[1].tusUrl, 'https://tus/stall');
});

test('UNREADABLE: a file that keeps failing to be read over time is finally marked unreadable - never uploaded, never retried as a network failure', async () => {
  useDeps({ isReadable: async () => false });
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await requestWasteSubmit(a);
  await settle();
  assert.equal((await listWasteMedia(a))[0].status, 'pending', 'one failed read is not proof: checked again later');
  await passes(3);
  const m = (await listWasteMedia(a))[0];
  assert.equal(m.status, 'failed');
  assert.equal(m.permanentFailure, true);
  assert.equal(m.failureKind, 'unreadable');
  assert.equal(m.lastError, UNREADABLE_MESSAGE);
  assert.equal(calls.small.length, 0, 'never uploaded');
  assert.equal(calls.submits.length, 0, 'the report is not sent without it');
  assert.equal(summarizeWasteUploads(await listWasteMedia(a)).needsAttention, 1);
});

test('UNREADABLE: a failure with no answer is checked against the file - a read problem is NOT counted as an upload attempt', async () => {
  let readable = true;
  useDeps({ isReadable: async () => readable });
  smallUpload = async () => {
    readable = false; // the file can't be read mid-upload
    throw new TypeError('Load failed');
  };
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await settle();
  const m = (await listWasteMedia(a))[0];
  assert.equal(m.status, 'pending', 'checked again later, not given up');
  assert.equal(m.readFailures, 1);
  assert.equal(m.attempts, 0, 'not an upload attempt');
  assert.match(m.lastError ?? '', /couldn’t be read from your phone just now/);
  assert.match(m.lastErrorDetail ?? '', /Load failed/);
});

test('RESTART: a file left "uploading" or "checking" by a closed app goes back to waiting (no stale "Uploading…"); a video keeps its resume URL', async () => {
  online = false;
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'video', vid('v.mp4'));
  await addWasteMedia(a, 'before', 'photo', photo());
  const [v, p] = (await listWasteMedia(a)).sort((x, y) => x.kind.localeCompare(y.kind)).reverse();
  await updateMediaIfPresent({ ...v, status: 'uploading', tusUrl: 'https://tus/keep', pausedForTurn: true });
  await updateMediaIfPresent({ ...p, status: 'checking' });
  await recoverAfterRestart();
  const after = await listWasteMedia(a);
  assert.deepEqual(after.map((m) => m.status).sort(), ['pending', 'pending']);
  assert.equal(after.find((m) => m.kind === 'video')!.tusUrl, 'https://tus/keep');
  assert.equal(after.find((m) => m.kind === 'video')!.pausedForTurn, false);
});

test('ONE SENDING PASS: a report whose photo and video finish in the two lanes at the same moment is sent exactly once', async () => {
  const gate = deferred();
  smallUpload = async () => gate.promise;
  videoUpload = async (_p, o) => {
    o.onUploadUrl('https://tus/s');
    await gate.promise;
  };
  useDeps({ stallMs: 60_000 });
  online = false;
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await addWasteMedia(a, 'after', 'video', vid('s.mp4'));
  await requestWasteSubmit(a);
  online = true;
  void kick();
  void kick();
  await new Promise((r) => setTimeout(r, 20));
  gate.release();
  await settle();
  void kick();
  await settle();
  assert.equal(calls.submits.length, 1);
  assert.equal(calls.submits[0].media.length, 2);
});

test('REMOVE while uploading: the upload is stopped first (its signal aborted), then the file is gone', async () => {
  let aborted = false;
  const started = deferred();
  smallUpload = async (_p, signal) => {
    started.release();
    await new Promise<void>((_r, reject) => signal?.addEventListener('abort', () => {
      aborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }));
  };
  useDeps({ stallMs: 60_000 });
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await started.promise;
  const m = (await listWasteMedia(a))[0];
  await removeWasteMedia(m.id);
  await settle();
  assert.equal(aborted, true);
  assert.equal((await listWasteMedia(a)).length, 0, 'not brought back by the stopped upload');
});

// ---- 2026-11-09: reading problems, optional posters, real reasons, paced retries -------------------------------------------------
test('READ: a file briefly unreadable recovers by itself - checked again, then uploaded; no upload attempt was counted', async () => {
  let readable = false;
  useDeps({ isReadable: async () => readable });
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await requestWasteSubmit(a);
  await settle();
  let m = (await listWasteMedia(a))[0];
  assert.deepEqual([m.status, m.readFailures, m.attempts, m.permanentFailure], ['pending', 1, 0, false]);
  assert.equal(calls.small.length, 0);
  readable = true; // the phone can read it again
  await passes(1);
  assert.equal(calls.submits.length, 1, 'uploaded, checked and sent');
});

test('READ: a file marked unreadable that becomes readable again carries on - when the app comes back, and by Try again', async () => {
  let readable = false;
  useDeps({ isReadable: async () => readable });
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await requestWasteSubmit(a);
  await settle();
  await passes(4); // several failed checks over more than 10 minutes
  let m = (await listWasteMedia(a))[0];
  assert.equal(m.failureKind, 'unreadable');
  // still unreadable: Try again keeps it marked (with the time of this check)
  await retryWasteMedia(m.id);
  await waitForWasteWorker();
  assert.equal((await listWasteMedia(a))[0].failureKind, 'unreadable');
  // readable again: the app coming back (automatic) reads it again and it carries on
  readable = true;
  await retryWaitingUploads();
  await waitForWasteWorker();
  assert.equal(calls.submits.length, 1);
});

test('READ: a file with nothing saved (or saved empty) is identified as unreadable at once', async () => {
  online = false;
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  const m = (await listWasteMedia(a))[0];
  // Saved empty: the file's record as first written holds nothing (a status update can't replace a saved file - see wasteDb.ts).
  await putMedia({ ...m, blob: new Blob([]) });
  online = true;
  useDeps({ isReadable: async (b) => b.size > 0 });
  await settle();
  const after = (await listWasteMedia(a))[0];
  assert.equal(after.failureKind, 'unreadable');
  assert.equal(after.permanentFailure, true);
});

test('POSTER: an unreadable poster is skipped and the VIDEO still uploads and is sent - the poster is never retried in its place', async () => {
  useDeps({ isReadable: async (b) => b.size !== 10 }); // the test poster is 10 bytes: make it unreadable
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'video', new File([new Uint8Array(9)], 'v.mov', { type: 'video/quicktime', lastModified: 31 }));
  await requestWasteSubmit(a);
  await settle();
  assert.equal(calls.small.filter((p) => p.endsWith('.thumb.jpg')).length, 0, 'poster never sent');
  assert.equal(calls.video.length, 1, 'video uploaded on the first try');
  assert.equal(calls.submits.length, 1);
  assert.equal(calls.submits[0].media[0].thumbnailPath, null, 'sent without a poster');
});

test('POSTER: a poster whose upload fails (no answer, refused, or stalled) is skipped; the video uploads in the same attempt', async () => {
  for (const failure of [new TypeError('Load failed'), Object.assign(new Error('nope'), { status: 500 }), 'hang']) {
    await reset();
    smallUpload = async (path) => {
      if (!path.endsWith('.thumb.jpg')) return;
      if (failure === 'hang') return new Promise<void>(() => undefined);
      throw failure;
    };
    const a = await draftWith();
    await addWasteMedia(a, 'before', 'video', new File([new Uint8Array(9)], 'v.mov', { type: 'video/quicktime', lastModified: 32 }));
    await requestWasteSubmit(a);
    await settle();
    assert.equal(calls.video.length, 1, `video uploaded despite the poster (${String(failure)})`);
    assert.equal(calls.submits.length, 1);
    assert.equal(calls.submits[0].media[0].thumbnailPath, null);
  }
});

test('POSTER: a poster that can\'t be CHECKED is skipped too - the video is not held back for it', async () => {
  checkResult = (path) => (path.endsWith('.thumb.jpg') ? { result: 'retry', message: 'busy' } : { result: 'ok', durationSeconds: 12 });
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'video', new File([new Uint8Array(9)], 'v.mov', { type: 'video/quicktime', lastModified: 33 }));
  await requestWasteSubmit(a);
  await settle();
  assert.equal(calls.submits.length, 1);
  assert.equal(calls.submits[0].media[0].thumbnailPath, null);
});

test('REASON: after six and more attempts the real reason (and its detail) is still shown; the count is shown apart', async () => {
  smallUpload = async () => {
    throw Object.assign(new Error('Service Unavailable'), { status: 503 });
  };
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await settle();
  await passes(7);
  const m = (await listWasteMedia(a))[0];
  assert.ok(m.attempts >= 6);
  assert.equal(m.lastError, 'The server couldn’t take the file just now (error 503).');
  assert.equal(m.lastErrorDetail, 'HTTP 503: Service Unavailable');
});

test('PACED: coming back to the app or online right after a failure does NOT retry again at once; once a minute has passed it does; Try again always does', async () => {
  let tries = 0;
  smallUpload = async () => {
    tries += 1;
    throw new TypeError('Load failed');
  };
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  await settle();
  assert.equal(tries, 1);
  for (let i = 0; i < 5; i++) await retryWaitingUploads(); // switching apps back and forth / online events
  await waitForWasteWorker();
  assert.equal(tries, 1, 'no rapid repeated attempts');
  clock += 61_000; // its pause (5 s) and a minute have passed -> the usual timer would have retried; an early retry is now allowed
  const m = (await listWasteMedia(a))[0];
  await updateMediaIfPresent({ ...m, nextAttemptAt: new Date(clock + 600_000).toISOString() }); // pretend a long pause is set
  await retryWaitingUploads();
  await waitForWasteWorker();
  assert.equal(tries, 2, 'one early retry after a minute');
  await retryWaitingUploads();
  await waitForWasteWorker();
  assert.equal(tries, 2, 'and not again straight away');
  await retryWasteMedia(m.id); // Try again: always at once
  await waitForWasteWorker();
  assert.equal(tries, 3);
});

test('PACED: the usual growing pauses are unchanged (5 s, 15 s, 1 min, 3 min, then 10 min)', async () => {
  smallUpload = async () => {
    throw new TypeError('Load failed');
  };
  const a = await draftWith();
  await addWasteMedia(a, 'before', 'photo', photo());
  const gaps: number[] = [];
  await settle();
  for (let i = 0; i < 5; i++) {
    const m = (await listWasteMedia(a))[0];
    gaps.push((Date.parse(m.nextAttemptAt!) - clock) / 1000);
    clock = Date.parse(m.nextAttemptAt!) + 1;
    await settle();
  }
  assert.deepEqual(gaps, [5, 15, 60, 180, 600]);
});
