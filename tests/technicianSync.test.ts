// Regression tests for the technician offline sync: which queued drafts the engine actually sends, and when the
// Completed screen may say a report reached the office. The real engine runs over a fake IndexedDB and a fake REST server
// (no network, nothing real is touched).
import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setCurrentUserId } from '../src/auth/currentUser';
import { putDraft, putPhoto, getDraft, listPhotosForVisit, type DraftReport, type PendingPhoto } from '../src/technician/offline/db';
import { subscribeReportSynced, trySubmitIfReady } from '../src/technician/offline/syncEngine';
import { isReportSyncedToServer } from '../src/technician/reportSyncStatus';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const OWNER = 'tech-user-1';
setCurrentUserId(OWNER);

// ---- fake REST server ------------------------------------------------------------------------------------------------
interface Logged { path: string; body: any }
let calls: Logged[] = [];
let rpcResponse: (name: string) => Response | Error = () => new Response(null, { status: 204 });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ path: url.pathname, body });
  const name = url.pathname.replace('/rest/v1/rpc/', '');
  const r = rpcResponse(name);
  if (r instanceof Error) throw r;
  return r;
}) as typeof fetch;

let synced: string[] = [];
let unsubscribe: () => void = () => {};
beforeEach(() => {
  calls = [];
  synced = [];
  rpcResponse = () => new Response(null, { status: 204 });
  unsubscribe();
  unsubscribe = subscribeReportSynced((visitId) => synced.push(visitId));
});

// ---- helpers ---------------------------------------------------------------------------------------------------------------
const rpcCalls = (name: string) => calls.filter((c) => c.path === `/rest/v1/rpc/${name}`);

function draft(visitId: string, over: Partial<DraftReport> = {}): DraftReport {
  return {
    ownerId: OWNER, visitId, mode: 'submit', reportId: null, workCarriedOut: 'Cleaned the windows', technicianNotes: null, issues: null,
    onSiteStart: '2026-10-08T09:00:00.000Z', onSiteEnd: '2026-10-08T10:00:00.000Z', specMet: true, readyToSubmit: true, submitting: false, submitError: null,
    updatedAt: '2026-10-08T10:00:00.000Z', ...over,
  };
}
function photo(visitId: string, id: string, status: PendingPhoto['status'] = 'uploaded'): PendingPhoto {
  return {
    id, ownerId: OWNER, visitId, phase: 'after', blob: new Blob(['x']), storagePath: `${visitId}/after/${id}.jpg`, status, lastError: null, createdAt: '2026-10-08T09:30:00.000Z',
  };
}

// ---- first submission --------------------------------------------------------------------------------------------------------
test('FIRST SUBMISSION with no photos is NOT sent (a first report needs at least one photo)', async () => {
  await putDraft(draft('v-first-nophoto'));
  await trySubmitIfReady('v-first-nophoto');
  assert.equal(calls.length, 0, 'nothing is sent');
  const kept = await getDraft(OWNER, 'v-first-nophoto');
  assert.ok(kept && kept.readyToSubmit && !kept.submitError, 'the draft stays queued, untouched');
  assert.deepEqual(synced, []);
});

test('FIRST SUBMISSION with an uploaded photo is sent through technician_submit_report, then cleared', async () => {
  await putDraft(draft('v-first-photo'));
  await putPhoto(photo('v-first-photo', 'p1'));
  rpcResponse = () => new Response(JSON.stringify('report-id-1'), { status: 200, headers: { 'content-type': 'application/json' } });
  await trySubmitIfReady('v-first-photo');
  const [call] = rpcCalls('technician_submit_report');
  assert.ok(call, 'the submit function was called');
  assert.equal(rpcCalls('technician_resubmit_report').length, 0);
  assert.equal(call.body.p_visit_id, 'v-first-photo');
  assert.deepEqual(call.body.p_photos, [{ storage_path: 'v-first-photo/after/p1.jpg', phase: 'after' }]);
  assert.equal(await getDraft(OWNER, 'v-first-photo'), undefined, 'draft removed once the server confirmed');
  assert.equal((await listPhotosForVisit(OWNER, 'v-first-photo')).length, 0);
  assert.deepEqual(synced, ['v-first-photo']);
});

test('FIRST SUBMISSION waits while its photo is still uploading', async () => {
  await putDraft(draft('v-first-uploading'));
  await putPhoto(photo('v-first-uploading', 'p2', 'pending'));
  await trySubmitIfReady('v-first-uploading');
  assert.equal(calls.length, 0);
  assert.ok(await getDraft(OWNER, 'v-first-uploading'));
});

// ---- resubmission ----------------------------------------------------------------------------------------------------------------
test('RESUBMISSION with a new photo is sent through technician_resubmit_report', async () => {
  await putDraft(draft('v-re-photo', { mode: 'resubmit', reportId: 'rep-1', onSiteStart: null, onSiteEnd: null }));
  await putPhoto(photo('v-re-photo', 'p3'));
  await trySubmitIfReady('v-re-photo');
  const [call] = rpcCalls('technician_resubmit_report');
  assert.ok(call);
  assert.equal(rpcCalls('technician_submit_report').length, 0);
  assert.equal(call.body.p_report_id, 'rep-1');
  assert.deepEqual(call.body.p_additional_photos, [{ storage_path: 'v-re-photo/after/p3.jpg', phase: 'after' }]);
  assert.equal(await getDraft(OWNER, 'v-re-photo'), undefined);
  assert.deepEqual(synced, ['v-re-photo']);
});

test('RESUBMISSION with ZERO new photos (a text-only correction) IS sent - this was silently never sent before', async () => {
  await putDraft(draft('v-re-text', { mode: 'resubmit', reportId: 'rep-2', workCarriedOut: 'Corrected: also cleaned the stairwell', onSiteStart: null, onSiteEnd: null }));
  await trySubmitIfReady('v-re-text');
  const [call] = rpcCalls('technician_resubmit_report');
  assert.ok(call, 'the resubmit function was called');
  assert.equal(call.body.p_report_id, 'rep-2');
  assert.equal(call.body.p_work_carried_out, 'Corrected: also cleaned the stairwell');
  assert.deepEqual(call.body.p_additional_photos, []);
  assert.equal(await getDraft(OWNER, 'v-re-text'), undefined, 'cleared only after the server confirmed');
  assert.deepEqual(synced, ['v-re-text'], 'the screens are told it really synced');
});

test('RESUBMISSION is still held back while a queued photo is uploading', async () => {
  await putDraft(draft('v-re-uploading', { mode: 'resubmit', reportId: 'rep-3', onSiteStart: null, onSiteEnd: null }));
  await putPhoto(photo('v-re-uploading', 'p4', 'uploading'));
  await trySubmitIfReady('v-re-uploading');
  assert.equal(calls.length, 0);
});

// ---- a failed resubmission is not "synced" ----------------------------------------------------------------------------------------
test('FAILED RESUBMISSION (server refuses it) keeps the draft, records the error, and never reports success', async () => {
  await putDraft(draft('v-re-fail', { mode: 'resubmit', reportId: 'rep-4', onSiteStart: null, onSiteEnd: null }));
  rpcResponse = () => new Response(JSON.stringify({ message: 'This report is not awaiting correction.', code: 'P0001' }), { status: 400, headers: { 'content-type': 'application/json' } });
  await trySubmitIfReady('v-re-fail');
  assert.equal(rpcCalls('technician_resubmit_report').length, 1);
  const kept = await getDraft(OWNER, 'v-re-fail');
  assert.ok(kept, 'the technician\'s work is not thrown away');
  assert.equal(kept!.readyToSubmit, true);
  assert.match(kept!.submitError ?? '', /not awaiting correction/);
  assert.equal(kept!.permanentFailure, true, 'a business-rule refusal will not be retried automatically');
  assert.deepEqual(synced, [], 'no "synced" signal');
  assert.equal(isReportSyncedToServer({ reportId: 'rep-4' }, kept), false, 'the Completed screen must not say "Sent to the office"');
});

test('FAILED RESUBMISSION from a network error is kept and retried later, never reported as synced', async () => {
  await putDraft(draft('v-re-net', { mode: 'resubmit', reportId: 'rep-5', onSiteStart: null, onSiteEnd: null }));
  rpcResponse = () => new TypeError('Failed to fetch');
  await trySubmitIfReady('v-re-net');
  const kept = await getDraft(OWNER, 'v-re-net');
  assert.ok(kept && kept.readyToSubmit);
  assert.ok(kept!.submitError, 'the failure is recorded (this is what the header\'s "Sync failed" badge counts)');
  assert.notEqual(kept!.permanentFailure, true, 'a connection failure keeps retrying');
  assert.deepEqual(synced, []);
  assert.equal(isReportSyncedToServer({ reportId: 'rep-5' }, kept), false);
  // ...and the next attempt (back online) succeeds and clears it
  rpcResponse = () => new Response(null, { status: 204 });
  await trySubmitIfReady('v-re-net');
  assert.equal(await getDraft(OWNER, 'v-re-net'), undefined);
  assert.deepEqual(synced, ['v-re-net']);
});

// ---- the Completed screen's sync rule ---------------------------------------------------------------------------------------------
test('COMPLETED SCREEN: an existing report id alone does not mean a resubmission has synced', () => {
  const queued = { readyToSubmit: true } as DraftReport;
  assert.equal(isReportSyncedToServer({ reportId: 'rep' }, queued), false, 'resubmission still queued');
  assert.equal(isReportSyncedToServer({ reportId: 'rep' }, undefined), true, 'no queued draft left: the server confirmed it');
  assert.equal(isReportSyncedToServer({ reportId: null }, queued), false, 'first submission still queued');
  assert.equal(isReportSyncedToServer({ reportId: null }, undefined), false, 'nothing at all');
  assert.equal(isReportSyncedToServer(undefined, undefined), false);
  assert.equal(isReportSyncedToServer({ reportId: 'rep' }, { readyToSubmit: false }), true, 'a draft that was never completed does not hide a real report');
});

test('COMPLETED SCREEN is wired to that rule (it no longer treats "has a report id" as synced)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(process.cwd(), 'src', 'technician', 'CompletedPage.tsx'), 'utf8');
  assert.match(src, /isReportSyncedToServer\(visit, draft\)/);
  assert.doesNotMatch(src, /isSyncedToServer = !!visit\?\.reportId/);
});
