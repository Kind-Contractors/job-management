// My day: a job whose report (photos, then the report itself) or videos are still on their way to the office shows a compact upload
// status on its card - label, a thin bar of photos uploaded, a short supporting line - read from the two existing local queues.
// Jobs with nothing pending look exactly as before; tapping the card still opens the job.
import 'fake-indexeddb/auto';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';
import { renderToStaticMarkup } from 'react-dom/server';

import { setCurrentUserId } from '../src/auth/currentUser';
import { listPhotosForVisit, putDraft, putPhoto, updatePhotoIfPresent, type DraftReport, type PendingPhoto } from '../src/technician/offline/db';
import { listPhotoUploadsByVisit, type VisitPhotoUpload } from '../src/technician/offline/syncEngine';
import { dayUploadStatus, videosByVisit, type VisitVideoUpload } from '../src/technician/dayUploadStatus';
import type { QueuedVideo } from '../src/technician/offline/videoDb';
import { StopRow } from '../src/technician/DayViewPage';

const online = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: online, configurable: true });
const OWNER = 'day-status-owner';

const photos = (over: Partial<VisitPhotoUpload> = {}): VisitPhotoUpload => ({ visitId: 'v1', total: 10, uploaded: 3, uploading: 1, waiting: 6, retrying: 0, report: 'waiting', ...over });

// ---- the status rules --------------------------------------------------------------------------------------------------------------
test('PHOTOS UPLOADING: "Uploading photos · 3 of 10" with a 3/10 bar; it moves on as photos finish', () => {
  const s = dayUploadStatus(photos(), undefined, true)!;
  assert.equal(s.label, 'Uploading photos · 3 of 10');
  assert.deepEqual(s.progress, { done: 3, total: 10 });
  assert.equal(s.tone, 'busy');
  assert.equal(dayUploadStatus(photos({ uploaded: 8, waiting: 1 }), undefined, true)!.label, 'Uploading photos · 8 of 10');
});

test('WAITING / RETRYING / OFFLINE are never shown as active progress', () => {
  const waiting = dayUploadStatus(photos({ uploading: 0, waiting: 7 }), undefined, true)!;
  assert.equal(waiting.label, 'Waiting to upload · 3 of 10', 'its turn has not come (another job’s photo is uploading)');
  assert.equal(waiting.tone, 'waiting');
  const retry = dayUploadStatus(photos({ uploading: 0, waiting: 5, retrying: 2 }), undefined, true)!;
  assert.equal(retry.label, 'Retrying upload… · 3 of 10');
  assert.match(retry.detail!, /trying again automatically/);
  assert.equal(retry.tone, 'waiting');
  const off = dayUploadStatus(photos(), undefined, false)!;
  assert.equal(off.label, 'Waiting for connection · 3 of 10', 'offline wins even if a photo was mid-upload');
  assert.match(off.detail!, /back online/);
  assert.equal(off.tone, 'waiting');
});

test('ALL PHOTOS UP: the report itself - sending, not sent yet (retrying), or couldn’t be sent; offline says the report waits', () => {
  const all = { uploaded: 10, uploading: 0, waiting: 0 };
  assert.equal(dayUploadStatus(photos(all), undefined, true)!.label, 'Sending report…');
  assert.deepEqual(dayUploadStatus(photos(all), undefined, true)!.progress, { done: 10, total: 10 });
  assert.equal(dayUploadStatus(photos({ ...all, report: 'send-failed' }), undefined, true)!.label, 'Report not sent yet');
  const refused = dayUploadStatus(photos({ ...all, report: 'refused' }), undefined, true)!;
  assert.equal(refused.tone, 'bad');
  assert.match(refused.detail!, /Contact the office/);
  const off = dayUploadStatus(photos(all), undefined, false)!;
  assert.equal(off.label, 'Waiting for connection');
  assert.match(off.detail!, /report is sent automatically/);
});

test('NOTHING PENDING: no status at all (the card is unchanged)', () => {
  assert.equal(dayUploadStatus(undefined, undefined, true), null);
  assert.equal(dayUploadStatus(undefined, { pending: 0, failed: 0, sendingFraction: null }, true), null);
});

test('VIDEOS: their own line (no "of how many" - a video leaves the queue once the server has it); a report already sent keeps showing its pending videos', () => {
  const sending: VisitVideoUpload = { pending: 2, failed: 0, sendingFraction: 0.45 };
  const onlyVideos = dayUploadStatus(undefined, sending, true)!; // report sent, videos still going
  assert.equal(onlyVideos.label, 'Uploading videos');
  assert.equal(onlyVideos.videos, 'Uploading video · 45% · 1 more waiting');
  assert.equal(onlyVideos.progress, null, 'no photo bar invented for videos');
  assert.equal(dayUploadStatus(undefined, { pending: 1, failed: 0, sendingFraction: null }, true)!.videos, '1 video waiting to upload');
  assert.equal(dayUploadStatus(undefined, { pending: 1, failed: 0, sendingFraction: 0.2 }, false)!.videos, '1 video waiting for connection');
  const failed = dayUploadStatus(undefined, { pending: 0, failed: 1, sendingFraction: null }, true)!;
  assert.equal(failed.tone, 'bad');
  assert.match(failed.videos!, /not uploaded — open the job/);
  const both = dayUploadStatus(photos(), sending, true)!;
  assert.equal(both.label, 'Uploading photos · 3 of 10', 'photos lead (they hold the report back)');
  assert.equal(both.videos, 'Uploading video · 45% · 1 more waiting');
});

test('videosByVisit: per job, waiting/sending vs failed, and the live byte progress of the one being sent', () => {
  const v = (id: string, visitId: string, status: QueuedVideo['status']) => ({ id, visitId, status }) as QueuedVideo;
  const map = videosByVisit([v('a', 'v1', 'uploading'), v('b', 'v1', 'pending'), v('c', 'v1', 'failed'), v('d', 'v2', 'attaching')], (id) => (id === 'a' ? 0.3 : null));
  assert.deepEqual(map.get('v1'), { pending: 2, failed: 1, sendingFraction: 0.3 });
  assert.deepEqual(map.get('v2'), { pending: 1, failed: 0, sendingFraction: null });
});

// ---- the photo side, from the real local queue ---------------------------------------------------------------------------------------
function draft(visitId: string, over: Partial<DraftReport> = {}): DraftReport {
  return { ownerId: OWNER, visitId, mode: 'submit', reportId: null, workCarriedOut: 'W', technicianNotes: null, issues: null, onSiteStart: '2026-11-24T08:00:00.000Z', onSiteEnd: '2026-11-24T09:00:00.000Z', specMet: true, readyToSubmit: true, submitting: false, submitError: null, updatedAt: '2026-11-24T09:00:00.000Z', ...over };
}
const photo = (visitId: string, n: number, status: PendingPhoto['status'], attempts = 0, ownerId = OWNER): PendingPhoto => ({
  id: `${visitId}-${n}`, ownerId, visitId, phase: 'after', blob: new Blob([new Uint8Array(20)], { type: 'image/jpeg' }), storagePath: `${visitId}/after/${n}.jpg`, status, lastError: null, createdAt: `2026-11-24T08:${String(n).padStart(2, '0')}:00.000Z`, attempts, nextAttemptAt: null,
});

beforeEach(async () => {
  online.onLine = true;
  setCurrentUserId(OWNER);
  await listPhotosForVisit(OWNER, 'none');
  const db = await openDB('kind-contractors-technician-offline');
  await db.clear('pendingPhotos');
  await db.clear('draftReports');
  db.close();
});

test('FROM THE QUEUE: a completed job with 10 photos, 3 uploaded - counted per job, and it updates as photos finish', async () => {
  await putDraft(draft('job10'));
  for (let i = 0; i < 10; i++) await putPhoto(photo('job10', i, i < 3 ? 'uploaded' : i === 3 ? 'uploading' : 'pending'));
  let [p] = await listPhotoUploadsByVisit();
  assert.deepEqual(p, { visitId: 'job10', total: 10, uploaded: 3, uploading: 1, waiting: 6, retrying: 0, report: 'waiting' });
  assert.equal(dayUploadStatus(p, undefined, true)!.label, 'Uploading photos · 3 of 10');
  await updatePhotoIfPresent({ ...photo('job10', 3, 'uploaded') }); // the next one finished
  [p] = await listPhotoUploadsByVisit();
  assert.equal(p.uploaded, 4);
  assert.equal(dayUploadStatus(p, undefined, true)!.label, 'Waiting to upload · 4 of 10');
});

test('FROM THE QUEUE: two completed jobs side by side; a retrying photo; a send failure; only completed, unsent jobs of THIS technician', async () => {
  await putDraft(draft('A'));
  await putDraft(draft('B', { submitError: 'Failed to fetch' }));
  await putDraft(draft('in-progress', { readyToSubmit: false })); // still being filled in: not shown
  await putDraft(draft('confirmed', { permanentFailure: true, submitError: 'x', serverConfirmedAt: '2026-11-24T10:00:00.000Z' })); // the server has it
  await putDraft({ ...draft('someone-else') , ownerId: 'other-technician' });
  await putPhoto(photo('A', 1, 'uploaded'));
  await putPhoto(photo('A', 2, 'pending', 2)); // failed before, retried automatically
  await putPhoto(photo('A', 3, 'failed', 4));
  await putPhoto(photo('B', 1, 'uploaded'));
  await putPhoto(photo('someone-else', 1, 'pending', 0, 'other-technician'));
  const list = await listPhotoUploadsByVisit();
  assert.deepEqual(list.map((p) => p.visitId).sort(), ['A', 'B']);
  const a = list.find((p) => p.visitId === 'A')!;
  assert.deepEqual([a.total, a.uploaded, a.retrying], [3, 1, 2]);
  assert.equal(dayUploadStatus(a, undefined, true)!.label, 'Retrying upload… · 1 of 3');
  assert.equal(dayUploadStatus(list.find((p) => p.visitId === 'B')!, undefined, true)!.label, 'Report not sent yet');
});

// ---- the card --------------------------------------------------------------------------------------------------------------------------
const visit = (over: Record<string, unknown> = {}) => ({
  visitId: 'v1', scheduledDate: '2026-11-24', status: 'booked', jobId: 'j1', jobSummary: 'Window Cleaning', jobType: 'general', buildingName: 'Acme - Build 2',
  buildingAddress: '1 Test St', buildingPostcode: 'ZZ1 1ZZ', reportId: null, reportSubmitted: false, assignedCount: 1, ...over,
}) as any;

test('CARD: the status sits under the job details - label, bar, line; a done card keeps its tick and only its details fade', () => {
  const s = dayUploadStatus(photos(), { pending: 1, failed: 0, sendingFraction: null }, true)!;
  const html = renderToStaticMarkup(<StopRow visit={visit({ status: 'completed', reportSubmitted: true })} index={0} isNext={false} upload={s} onSelect={() => {}} />);
  assert.match(html, /data-testid="day-upload-status"/);
  assert.match(html, /Uploading photos · 3 of 10/);
  assert.match(html, /role="progressbar"[^>]*aria-valuemax="10"[^>]*aria-valuenow="3"/);
  assert.match(html, /width:30%/);
  assert.match(html, /1 video waiting to upload/);
  assert.match(html, /✓/, 'the completed tick is still there');
  assert.doesNotMatch(html.slice(0, html.indexOf('>')), /opacity-50/, 'the card itself is not faded, so the status is readable');
  assert.match(html, /class="opacity-50"/, 'its details still are');
});

test('CARD without anything pending looks exactly as before (no status, done card faded as before); next stop unchanged', () => {
  const doneNone = renderToStaticMarkup(<StopRow visit={visit({ status: 'completed', reportSubmitted: true })} index={0} isNext={false} upload={null} onSelect={() => {}} />);
  const doneUndef = renderToStaticMarkup(<StopRow visit={visit({ status: 'completed', reportSubmitted: true })} index={0} isNext={false} onSelect={() => {}} />);
  assert.equal(doneNone, doneUndef);
  assert.doesNotMatch(doneNone, /day-upload-status/);
  assert.match(doneNone.slice(0, doneNone.indexOf('>')), /opacity-50/, 'a done card with nothing pending is faded exactly as before');
  const next = renderToStaticMarkup(<StopRow visit={visit()} index={1} isNext onSelect={() => {}} />);
  assert.match(next, /Next stop/);
  assert.doesNotMatch(next, /day-upload-status/);
});
