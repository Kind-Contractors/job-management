// Unfinished "Complete & report" submissions kept on this device (src/lib/officeReportPending.ts): written before the save is sent, read
// back only for the same signed-in manager, files written once, cleared only when the outcome is settled - and every storage failure
// reported honestly (never "kept" when it wasn't).
import 'fake-indexeddb/auto';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getPendingSubmission,
  listPendingSubmissions,
  mediaEntryOf,
  removePendingSubmission,
  resetOfficePendingDbForTests,
  restorePendingMedia,
  savePendingSubmission,
  updatePendingSubmission,
  type PendingOfficeReport,
} from '../src/lib/officeReportPending';
import type { StagedMedia } from '../src/lib/officeReportMedia';

const LUKE = 'user-luke', TAMIKA = 'user-tamika';
let n = 0;
const req = () => `req-${++n}`;

function rec(requestId: string, over: Partial<PendingOfficeReport> = {}): Omit<PendingOfficeReport, 'filesNotKept'> {
  return {
    requestId, userId: LUKE, jobId: 'job-1', buildingName: 'Acme House', jobSummary: 'Window cleaning', visitLabel: 'Work already done', visitWasCompleted: false,
    stage: 'unconfirmed', result: null, media: [], createdAt: new Date(Date.now() + n).toISOString(), updatedAt: new Date().toISOString(),
    input: { visitId: null, jobId: 'job-1', workDate: '2026-11-24', completedAt: '2026-11-24T10:00:00.000Z', priceCharged: 55, workCarriedOut: 'Windows', technicianNotes: null, issues: null, specMet: true, onSiteStart: null, onSiteEnd: null },
    ...over,
  };
}
const photo = (id: string, bytes = 'photo-bytes', include = true): StagedMedia => ({
  id, kind: 'photo', phase: 'before', include, status: 'ready', previewUrl: null, file: new File([bytes], `${id}.jpg`, { type: 'image/jpeg' }),
});
const video = (id: string): StagedMedia => ({
  id, kind: 'video', phase: 'during', include: false, status: 'ready', previewUrl: null, file: new File(['video-bytes!'], `${id}.webm`, { type: 'video/webm' }),
  video: { mime: 'video/webm', ext: 'webm', durationSeconds: 3, thumbnail: new Blob(['jpeg'], { type: 'image/jpeg' }) },
});
const withMedia = (r: Omit<PendingOfficeReport, 'filesNotKept'>, media: StagedMedia[]) => ({ ...r, media: media.map(mediaEntryOf) });

beforeEach(() => {
  // A fresh, empty IndexedDB for every test.
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetOfficePendingDbForTests();
});

test('KEPT before sending: the submission (request id + exactly what is sent) and its files come back for the same manager and job', async () => {
  const id = req();
  const media = [photo('p1', 'abc'), video('v1')];
  assert.equal(await savePendingSubmission(withMedia(rec(id), media), media), 'all');
  const back = await getPendingSubmission(LUKE, 'job-1');
  assert.equal(back?.requestId, id);
  assert.deepEqual(back?.input, rec(id).input);
  assert.equal(back?.filesNotKept, false);
  const { items, missing } = await restorePendingMedia(back!);
  assert.equal(missing.length, 0);
  assert.deepEqual(items.map((m) => [m.id, m.kind, m.phase, m.include, m.status, m.file.name, m.file.size]), [
    ['p1', 'photo', 'before', true, 'ready', 'p1.jpg', 3],
    ['v1', 'video', 'during', false, 'ready', 'v1.webm', 12],
  ]);
  assert.equal(await items[0].file.text(), 'abc', 'the photo itself, read back');
  assert.equal(items[1].video?.thumbnail?.size, 4, 'the video poster too');
  assert.equal(await getPendingSubmission(LUKE, 'job-2'), null, 'only for that job');
});

test('PER MANAGER: on a shared computer another manager never sees, lists or resumes it', async () => {
  await savePendingSubmission(rec(req()), []);
  assert.equal(await getPendingSubmission(TAMIKA, 'job-1'), null);
  assert.deepEqual(await listPendingSubmissions(TAMIKA), []);
  assert.equal((await listPendingSubmissions(LUKE)).length, 1);
});

test('PROGRESS: only the small record is updated (stage, result, files on the report) - the files themselves are never written again', async () => {
  const id = req();
  const media = [photo('p1'), photo('p2')];
  await savePendingSubmission(withMedia(rec(id), media), media);
  const result = { visitId: 'v-1', reportId: 'r-1', visitCreated: true, replayed: false };
  assert.equal(await updatePendingSubmission(id, { stage: 'saved', result }), true);
  assert.equal(await updatePendingSubmission(id, { media: [{ ...mediaEntryOf(media[0]), savedId: 'photo-1' }, mediaEntryOf(media[1])] }), true);
  const back = (await getPendingSubmission(LUKE, 'job-1'))!;
  assert.equal(back.stage, 'saved');
  assert.deepEqual(back.result, result);
  const { items } = await restorePendingMedia(back);
  assert.deepEqual(items.map((m) => [m.id, m.status, m.savedId]), [['p1', 'added', 'photo-1'], ['p2', 'ready', undefined]], 'added files are never sent again');
  assert.equal(await updatePendingSubmission('no-such-request', { stage: 'saved' }), false);
});

test('CLEARED when settled: the record AND its files go; other submissions stay', async () => {
  const a = req(), b = req();
  const media = [photo('p1')];
  await savePendingSubmission(withMedia(rec(a), media), media);
  await savePendingSubmission(withMedia(rec(b, { jobId: 'job-2' }), media), media);
  assert.equal(await removePendingSubmission(a), true);
  assert.equal(await getPendingSubmission(LUKE, 'job-1'), null);
  const other = (await getPendingSubmission(LUKE, 'job-2'))!;
  assert.equal((await restorePendingMedia(other)).items.length, 1, 'the other submission\'s file is untouched');
  // A re-created record with the old id does not find any stale files.
  await savePendingSubmission(withMedia(rec(a), media), []);
  assert.equal((await restorePendingMedia((await getPendingSubmission(LUKE, 'job-1'))!)).missing.length, 1);
});

test('FILES DON\'T FIT: the submission itself is still kept (the request id matters most) and says so - "withoutFiles", never "all"', async () => {
  const id = req();
  // A "file" the browser can't store (as when storage is full) makes the whole first write fail.
  const unstorable = { ...photo('p1'), file: { name: 'x.jpg', type: 'image/jpeg', size: 1, oops: () => 1 } as unknown as File };
  assert.equal(await savePendingSubmission(withMedia(rec(id), [photo('p1')]), [unstorable]), 'withoutFiles');
  const back = (await getPendingSubmission(LUKE, 'job-1'))!;
  assert.equal(back.requestId, id);
  assert.equal(back.filesNotKept, true);
  const { items, missing } = await restorePendingMedia(back);
  assert.deepEqual([items.length, missing.length], [0, 1], 'nothing pretends to be there');
});

test('NO STORAGE AT ALL (private mode, blocked): "none" is reported, nothing throws, and reads fail loudly rather than saying "nothing pending"', async () => {
  (globalThis as { indexedDB: unknown }).indexedDB = { open: () => { throw new Error('IndexedDB is disabled'); } };
  resetOfficePendingDbForTests();
  assert.equal(await savePendingSubmission(rec(req()), [photo('p1')]), 'none');
  assert.equal(await updatePendingSubmission('x', { stage: 'saved' }), false);
  assert.equal(await removePendingSubmission('x'), false);
  await assert.rejects(getPendingSubmission(LUKE, 'job-1'));
  await assert.rejects(listPendingSubmissions(LUKE));
});

test('NOTHING SECRET is kept: the record holds the report content and ids only - no tokens, keys or access details', async () => {
  const id = req();
  await savePendingSubmission(rec(id), []);
  const back = (await getPendingSubmission(LUKE, 'job-1'))!;
  assert.deepEqual(Object.keys(back).sort(), ['buildingName', 'createdAt', 'filesNotKept', 'input', 'jobId', 'jobSummary', 'media', 'requestId', 'result', 'stage', 'updatedAt', 'userId', 'visitLabel', 'visitWasCompleted']);
  assert.doesNotMatch(JSON.stringify(back), /token|apikey|password|key ?safe|access/i);
});
