// Videos must never change how a report is submitted. The REAL photo/report sync engine runs here over a fake IndexedDB and a fake REST
// server (mocked network, as in technicianSync.test.ts), with videos sitting in the video queue in every awkward state.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { setCurrentUserId } from '../src/auth/currentUser';
import { getDraft, listPhotosForVisit, putDraft, putPhoto, type DraftReport, type PendingPhoto } from '../src/technician/offline/db';
import { trySubmitIfReady } from '../src/technician/offline/syncEngine';
import { listVideosForVisit, putVideo, type QueuedVideo } from '../src/technician/offline/videoDb';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const OWNER = 'tech-user-1';
setCurrentUserId(OWNER);

let calls: { path: string; body: any }[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  calls.push({ path: url.pathname, body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify('report-id-1'), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
beforeEach(() => { calls = []; });

const rpc = (name: string) => calls.filter((c) => c.path === `/rest/v1/rpc/${name}`);
const draft = (visitId: string, over: Partial<DraftReport> = {}): DraftReport => ({
  ownerId: OWNER, visitId, mode: 'submit', reportId: null, workCarriedOut: 'Cleaned', technicianNotes: null, issues: null, onSiteStart: '2026-10-12T09:00:00.000Z',
  onSiteEnd: '2026-10-12T10:00:00.000Z', specMet: true, readyToSubmit: true, submitting: false, submitError: null, updatedAt: '2026-10-12T10:00:00.000Z', ...over,
});
const photo = (visitId: string, id: string): PendingPhoto => ({ id, ownerId: OWNER, visitId, phase: 'after', blob: new Blob(['x']), storagePath: `${visitId}/after/${id}.jpg`, status: 'uploaded', lastError: null, createdAt: '2026-10-12T09:30:00.000Z' });
const video = (visitId: string, id: string, over: Partial<QueuedVideo> = {}): QueuedVideo => ({
  id, ownerId: OWNER, visitId, phase: 'before', blob: new Blob(['v']), fileName: `${id}.mp4`, mime: 'video/mp4', ext: 'mp4', sizeBytes: 1, sourceKey: id, durationSeconds: 5, thumbnail: null,
  status: 'pending', videoPath: `${visitId}/before/${id}.mp4`, thumbPath: null, videoUploaded: false, thumbUploaded: false, tusUrl: null, lastError: null, permanentFailure: false,
  attempts: 0, nextAttemptAt: null, leaseUntil: null, createdAt: '2026-10-12T09:40:00.000Z', ...over,
});

test('SUBMISSION IGNORES VIDEOS: a report with its photo uploaded is submitted exactly as before while videos are pending, uploading, failed and refused', async () => {
  const v = 'v-indep-1';
  await putDraft(draft(v));
  await putPhoto(photo(v, 'p1'));
  await putVideo(video(v, 'vid-pending'));
  await putVideo(video(v, 'vid-uploading', { status: 'uploading', videoUploaded: false }));
  await putVideo(video(v, 'vid-failed', { status: 'failed', attempts: 6, lastError: 'Failed to fetch' }));
  await putVideo(video(v, 'vid-refused', { status: 'failed', permanentFailure: true, lastError: 'This report has been marked Completed' }));
  await trySubmitIfReady(v);
  const [call] = rpc('technician_submit_report');
  assert.ok(call, 'the report was submitted');
  assert.deepEqual(call.body.p_photos, [{ storage_path: `${v}/after/p1.jpg`, phase: 'after' }], 'only photos are sent - no video is part of the submission');
  assert.deepEqual(Object.keys(call.body).sort(), ['p_issues', 'p_on_site_end', 'p_on_site_start', 'p_photos', 'p_spec_met', 'p_technician_notes', 'p_visit_id', 'p_work_carried_out'], 'the call has exactly the same arguments as before');
  assert.equal(await getDraft(OWNER, v), undefined, 'the draft is cleared as usual');
  assert.equal((await listPhotosForVisit(OWNER, v)).length, 0);
  assert.equal((await listVideosForVisit(OWNER, v)).length, 4, 'submitting never deletes, changes or waits for a queued video');
  assert.equal(calls.some((c) => /video/i.test(c.path)), false, 'no video call is made by the report engine');
});

test('PHOTO REQUIREMENT UNCHANGED: a first report with NO photo is still not submitted, even with videos queued', async () => {
  const v = 'v-indep-2';
  await putDraft(draft(v));
  await putVideo(video(v, 'vid-a'));
  await putVideo(video(v, 'vid-b', { status: 'attaching', videoUploaded: true }));
  await trySubmitIfReady(v);
  assert.equal(calls.length, 0, 'nothing is sent: a video does not replace the required photo');
  const kept = await getDraft(OWNER, v);
  assert.ok(kept && kept.readyToSubmit && !kept.submitError);
});

test('RESUBMISSION is unaffected too: a returned report with no new photo is sent as before, whatever the videos are doing', async () => {
  const v = 'v-indep-3';
  await putDraft(draft(v, { mode: 'resubmit', reportId: 'rep-9' }));
  await putVideo(video(v, 'vid-x', { status: 'failed', lastError: 'boom' }));
  await trySubmitIfReady(v);
  assert.equal(rpc('technician_resubmit_report').length, 1);
  assert.equal(rpc('technician_resubmit_report')[0].body.p_report_id, 'rep-9');
  assert.equal((await listVideosForVisit(OWNER, v)).length, 1);
});

test('THE REPORT CODE DOES NOT KNOW ABOUT VIDEOS: neither the photo/report engine, its database, nor the report form\'s submit rule mentions them', () => {
  const read = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8');
  for (const file of [['technician', 'offline', 'syncEngine.ts'], ['technician', 'offline', 'db.ts'], ['technician', 'reportSyncStatus.ts'], ['technician', 'offline', 'photoCompression.ts']]) {
    assert.doesNotMatch(read(...file), /video/i, `${file.join('/')} has no video code`);
  }
  const page = read('technician', 'JobReportPage.tsx');
  assert.match(page, /const canSubmit = draftReady && !isCompleting && \(isResubmitMode \|\| photos\.length > 0\);/, 'the submit rule is exactly the original');
  const complete = page.slice(page.indexOf('const handleComplete'), page.indexOf('// Photos that ultimately failed'));
  assert.doesNotMatch(complete, /video/i, '"Complete job" never looks at videos');
  assert.match(page, /<TechnicianVideos visitId=\{visitId\} userId=\{userId\} \/>/, 'the videos section is on the report page');
  assert.match(read('technician', 'CompletedPage.tsx'), /<TechnicianVideos visitId=\{visitId\} userId=\{userId\} \/>/, 'and on the completed page, so videos can still be added or checked after submitting');
});

test('PHOTO BEHAVIOUR UNCHANGED: the photo upload and removal code in the technician API is byte-for-byte what it was (no video edits)', () => {
  const api = readFileSync(join(process.cwd(), 'src', 'technician', 'api.ts'), 'utf8');
  assert.doesNotMatch(api, /video/i, 'src/technician/api.ts (photos, submit, resubmit) has no video code');
});
