// A permanently failed local draft whose report the server ALREADY holds (e.g. two sends of one resubmission raced: the first was
// accepted, the second refused with "This report is not awaiting correction." and kept as a permanent failure) must not say
// "report not sent" for ever. It is checked against the server once per app session (src/technician/offline/draftReconciliation.ts,
// syncEngine.ts reconcilePermanentFailures): only an exact match marks it as confirmed - it is never deleted, never re-sent, and its
// photos are never touched. No match, or no answer, changes nothing. Plus the Completed screen's "Back to jobs list" rule.
// The real engine over a fake IndexedDB; the server is faked - nothing real.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDB } from 'idb';

import { setCurrentUserId } from '../src/auth/currentUser';
import { getDraft, getPhoto, listPhotosForVisit, putDraft, putPhoto, type DraftReport, type PendingPhoto } from '../src/technician/offline/db';
import {
  readSyncStatusForTests,
  resetDraftReconciliationForTests,
  runSyncSweepForTests,
  setTechnicianUploadDepsForTests,
  trySubmitIfReady,
} from '../src/technician/offline/syncEngine';
import { draftMatchesServerReport, type ServerReportForDraft } from '../src/technician/offline/draftReconciliation';
import { isReportSyncedToServer, showBackToJobsList } from '../src/technician/reportSyncStatus';
import { getMyServerReportForVisit } from '../src/technician/api';
import { headerSyncBadge } from '../src/technician/headerSyncBadge';

const online = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: online, configurable: true });
const OWNER = 'reconcile-owner';
const NOT_AWAITING = 'This report is not awaiting correction.';

// Anything that would SEND a report is recorded (and must never happen here). The real server lookup's database calls are answered by
// `rpcRows` when set (array = rows; { error } = a database error) - only in the getMyServerReportForVisit tests.
let rpcCalls: string[] = [];
let rpcRows: Record<string, unknown[] | { error: string }> = {};
globalThis.fetch = (async (input: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const name = url.pathname.replace('/rest/v1/rpc/', '');
  if (name in rpcRows) {
    const answer = rpcRows[name];
    if (!Array.isArray(answer)) return new Response(JSON.stringify({ code: 'XX000', message: answer.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  rpcCalls.push(url.pathname);
  return new Response('{}', { status: 200 });
}) as typeof fetch;

// ---- fake server: this technician's part of each visit's report ---------------------------------------------------------------------
let serverReports: Map<string, ServerReportForDraft | null>;
let serverDown: boolean;
let serverChecks: string[];
let storageCalls: string[];

function draft(over: Partial<DraftReport> = {}): DraftReport {
  return {
    ownerId: OWNER,
    visitId: 'visit-1',
    mode: 'resubmit',
    reportId: 'report-1',
    workCarriedOut: 'Window Cleaning',
    technicianNotes: 'Optional notes test - return',
    issues: 'Notes / issues test - return',
    onSiteStart: null,
    onSiteEnd: '2026-10-01T21:25:40.687Z',
    specMet: true,
    readyToSubmit: true,
    submitting: false,
    submitError: NOT_AWAITING,
    permanentFailure: true,
    updatedAt: '2026-10-01T21:25:41.481Z',
    ...over,
  };
}
function serverCopy(over: Partial<ServerReportForDraft> = {}): ServerReportForDraft {
  return {
    reportId: 'report-1',
    reviewStatus: 'approved',
    workCarriedOut: 'Window Cleaning',
    technicianNotes: 'Optional notes test - return',
    issues: 'Notes / issues test - return',
    specMet: true,
    photoPaths: [],
    ...over,
  };
}
const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
async function uploadedPhoto(visitId: string, id: string, fill: number): Promise<PendingPhoto> {
  const photo: PendingPhoto = {
    id,
    ownerId: OWNER,
    visitId,
    phase: 'during',
    blob: new Blob([bytes(64, fill)], { type: 'image/jpeg' }),
    storagePath: `${visitId}/during/${id}.jpg`,
    status: 'uploaded',
    lastError: null,
    createdAt: '2026-10-01T15:35:34.711Z',
    originalSize: 64,
    attempts: 0,
    nextAttemptAt: null,
  };
  await putPhoto(photo);
  return photo;
}

beforeEach(async () => {
  online.onLine = true;
  setCurrentUserId(OWNER);
  await listPhotosForVisit(OWNER, 'none'); // the app's own code creates the database first
  const db = await openDB('kind-contractors-technician-offline');
  await db.clear('pendingPhotos');
  await db.clear('draftReports');
  db.close();
  serverReports = new Map();
  serverDown = false;
  serverChecks = [];
  storageCalls = [];
  rpcCalls = [];
  rpcRows = {};
  resetDraftReconciliationForTests();
  setTechnicianUploadDepsForTests({
    fetchMyServerReport: async (visitId) => {
      serverChecks.push(visitId);
      if (serverDown) throw new TypeError('Failed to fetch');
      return serverReports.has(visitId) ? serverReports.get(visitId)! : null;
    },
    checkOnServer: async (path) => { storageCalls.push(`check ${path}`); return { found: false }; },
    uploadBytes: async (path) => { storageCalls.push(`upload ${path}`); return 'created'; },
    removeObject: async (path) => { storageCalls.push(`remove ${path}`); },
    checkTimeoutMs: 60,
    uploadTimeoutMs: 60,
  });
});
afterEach(() => setTechnicianUploadDepsForTests(null));

test('MATCH: a failed resubmission the server already holds exactly is marked confirmed - kept, not counted, never re-sent', async () => {
  await putDraft(draft());
  serverReports.set('visit-1', serverCopy());
  assert.equal((await readSyncStatusForTests()).failedDraftCount, 1, 'before the check it is counted, as today');

  await runSyncSweepForTests();

  const after = await getDraft(OWNER, 'visit-1');
  assert.ok(after, 'the draft is KEPT (never deleted by a check)');
  assert.ok(after!.serverConfirmedAt, 'marked as confirmed');
  assert.equal(after!.permanentFailure, true, 'otherwise unchanged');
  assert.equal(after!.workCarriedOut, 'Window Cleaning');
  const status = await readSyncStatusForTests();
  assert.equal(status.failedDraftCount, 0);
  assert.equal(status.waitingReportCount, 0);
  assert.equal(headerSyncBadge(status, { pending: 0, failed: 0 }), null, 'no "report not sent" badge');
  assert.equal(isReportSyncedToServer({ reportId: 'report-1' }, after), true, 'the Completed screen says it was sent');

  await trySubmitIfReady('visit-1');
  await runSyncSweepForTests(true);
  assert.deepEqual(rpcCalls, [], 'nothing is ever sent for it');
  assert.deepEqual(serverChecks, ['visit-1'], 'checked once per session, not on every sweep');
});

test('NO MATCH: different text, another report, a correction still awaited, or no report - nothing changes, still counted', async () => {
  const cases: [string, ServerReportForDraft | null][] = [
    ['different text', serverCopy({ issues: 'something else' })],
    ['different "something not done"', serverCopy({ specMet: false })],
    ['another report on the visit', serverCopy({ reportId: 'report-OTHER' })],
    ['server still awaiting this technician\'s correction', serverCopy({ reviewStatus: 'returned_for_correction' })],
    ['no report of theirs / visit gone', null],
  ];
  for (const [name, server] of cases) {
    await putDraft(draft());
    serverReports.set('visit-1', server);
    resetDraftReconciliationForTests();
    await runSyncSweepForTests();
    const after = await getDraft(OWNER, 'visit-1');
    assert.ok(after && !after.serverConfirmedAt, `${name}: not marked`);
    assert.equal((await readSyncStatusForTests()).failedDraftCount, 1, `${name}: still "not sent"`);
  }
  assert.deepEqual(rpcCalls, [], 'and never re-sent (it could overwrite the server\'s report)');
});

test('NETWORK FAILURE: an unanswered check assumes nothing, and is tried again on a later sweep', async () => {
  await putDraft(draft());
  serverReports.set('visit-1', serverCopy());
  serverDown = true;
  await runSyncSweepForTests();
  assert.ok(!(await getDraft(OWNER, 'visit-1'))!.serverConfirmedAt, 'not marked');
  assert.equal((await readSyncStatusForTests()).failedDraftCount, 1, 'still counted');

  // a check that never answers is given up by its time limit - also assumes nothing
  setTechnicianUploadDepsForTests({ fetchMyServerReport: () => new Promise(() => {}), checkTimeoutMs: 30 });
  await runSyncSweepForTests();
  assert.ok(!(await getDraft(OWNER, 'visit-1'))!.serverConfirmedAt, 'a hung check: not marked');

  // offline: not even tried
  setTechnicianUploadDepsForTests({ fetchMyServerReport: async (v) => { serverChecks.push(v); return serverCopy(); }, checkTimeoutMs: 60 });
  online.onLine = false;
  serverChecks = [];
  await runSyncSweepForTests();
  assert.deepEqual(serverChecks, [], 'offline: no check');

  online.onLine = true;
  await runSyncSweepForTests();
  assert.ok((await getDraft(OWNER, 'visit-1'))!.serverConfirmedAt, 'answered later: marked');
});

test('PHOTOS: a matched first report keeps every local photo exactly as it was; one photo missing on the server = no match', async () => {
  await putDraft(draft({ visitId: 'visit-2', mode: 'submit', reportId: null, onSiteStart: '2026-10-01T15:21:21.536Z', submitError: 'refused', technicianNotes: null, issues: null }));
  const a = await uploadedPhoto('visit-2', 'photo-a', 1);
  const b = await uploadedPhoto('visit-2', 'photo-b', 2);
  const before = await Promise.all([a, b].map(async (p) => new Uint8Array(await (await getPhoto(p.id))!.blob.arrayBuffer())));

  // one of its photos is not in the server's report -> no match
  serverReports.set('visit-2', serverCopy({ reportId: 'report-2', technicianNotes: null, issues: null, photoPaths: [a.storagePath] }));
  await runSyncSweepForTests();
  assert.ok(!(await getDraft(OWNER, 'visit-2'))!.serverConfirmedAt, 'a photo the server does not have: not marked');

  // every photo is there -> match (next session)
  serverReports.set('visit-2', serverCopy({ reportId: 'report-2', technicianNotes: null, issues: null, photoPaths: [b.storagePath, a.storagePath, 'visit-2/during/other.jpg'] }));
  resetDraftReconciliationForTests();
  await runSyncSweepForTests();
  assert.ok((await getDraft(OWNER, 'visit-2'))!.serverConfirmedAt, 'marked');

  const photos = await listPhotosForVisit(OWNER, 'visit-2');
  assert.equal(photos.length, 2, 'both photo records kept');
  for (const [i, p] of [a, b].entries()) {
    const now = (await getPhoto(p.id))!;
    assert.equal(now.status, 'uploaded');
    assert.equal(now.storagePath, p.storagePath);
    assert.deepEqual(new Uint8Array(await now.blob.arrayBuffer()), before[i], 'the photo data is untouched and still readable');
  }
  assert.deepEqual(storageCalls, [], 'no Storage check, upload or removal for them');
  assert.deepEqual(rpcCalls, [], 'nothing sent');

  // a first report can't be matched on text alone
  assert.equal(draftMatchesServerReport(draft({ mode: 'submit', reportId: null }), [], serverCopy()), false);
});

test('LATER MISMATCH: if the office returns the report, a new session clears the mark and it counts again', async () => {
  await putDraft(draft());
  serverReports.set('visit-1', serverCopy());
  await runSyncSweepForTests();
  assert.ok((await getDraft(OWNER, 'visit-1'))!.serverConfirmedAt);

  serverReports.set('visit-1', serverCopy({ reviewStatus: 'returned_for_correction' }));
  resetDraftReconciliationForTests();
  await runSyncSweepForTests();
  assert.ok(!(await getDraft(OWNER, 'visit-1'))!.serverConfirmedAt, 'mark cleared');
  assert.equal((await readSyncStatusForTests()).failedDraftCount, 1);
});

test('ONLY permanent failures are checked: pending reports and retrying failures are left to the normal send', async () => {
  await putDraft(draft({ visitId: 'pending', readyToSubmit: false, submitError: null, permanentFailure: false }));
  // (a first report without photos is never sent by the queue, so the normal send stays out of this test)
  await putDraft(draft({ visitId: 'retrying', mode: 'submit', reportId: null, submitError: 'Failed to fetch', permanentFailure: false }));
  await putDraft({ ...draft({ visitId: 'someone-elses' }), ownerId: 'another-technician' });
  setTechnicianUploadDepsForTests({ fetchMyServerReport: async (v) => { serverChecks.push(v); return serverCopy(); }, checkTimeoutMs: 60 });
  await runSyncSweepForTests();
  assert.deepEqual(rpcCalls, [], 'nothing sent either');
  assert.deepEqual(serverChecks, [], 'none of them is checked against the server');
  assert.equal((await readSyncStatusForTests()).failedDraftCount, 1, 'the genuinely retrying failure still counts as not sent');
});

test('BACK TO JOBS LIST: only once the report is sent, and only next to a "Next stop" job (not an activity)', () => {
  assert.equal(showBackToJobsList(true, { kind: 'visit' }), true);
  assert.equal(showBackToJobsList(false, { kind: 'visit' }), false, 'waiting to send / failed: not shown');
  assert.equal(showBackToJobsList(true, { kind: 'activity' }), false, 'the activity button already goes to the jobs list');
  assert.equal(showBackToJobsList(true, null), false, 'no next stop: "Back to your day" is already the button');
  assert.equal(showBackToJobsList(true, undefined), false);

  const src = readFileSync(join(process.cwd(), 'src', 'technician', 'CompletedPage.tsx'), 'utf8');
  assert.match(src, /showBackToJobsList\(isSyncedToServer, nextStop\) && \(/, 'the Completed screen uses that rule');
  assert.match(src, /Back to jobs list/);
  assert.match(src, /`Next stop — \$\{nextStop\.buildingName \?\? nextStop\.buildingAddress\}`/, '"Next stop" is unchanged');
});

test('NO FALSE POSITIVE from missing or odd data: unknown/missing review state, or a resubmission without its report id', () => {
  const d = draft();
  assert.equal(draftMatchesServerReport(d, [], serverCopy()), true, '(the baseline does match)');
  assert.equal(draftMatchesServerReport(d, [], serverCopy({ reviewStatus: null })), false, 'no review state: proves nothing');
  assert.equal(draftMatchesServerReport(d, [], serverCopy({ reviewStatus: 'something_new' })), false, 'an unknown state: proves nothing');
  assert.equal(draftMatchesServerReport(draft({ reportId: null }), [], serverCopy()), false, 'a resubmission must name its report');
  assert.equal(draftMatchesServerReport(d, [], serverCopy({ reportId: '' })), false, 'no report id');
});

test('OVERLAPPING SWEEPS check a draft once; the Completed screen ignores the mark once the server says "returned"', async () => {
  await putDraft(draft());
  let release!: () => void;
  setTechnicianUploadDepsForTests({
    fetchMyServerReport: async (v) => { serverChecks.push(v); await new Promise<void>((r) => { release = r; }); return serverCopy(); },
    checkTimeoutMs: 1000,
  });
  const first = runSyncSweepForTests();
  const second = runSyncSweepForTests();
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(serverChecks, ['visit-1'], 'one request, not two');
  const marked = (await getDraft(OWNER, 'visit-1'))!;
  assert.ok(marked.serverConfirmedAt);

  assert.equal(isReportSyncedToServer({ reportId: 'report-1', reportReviewStatus: 'approved' }, marked), true);
  assert.equal(isReportSyncedToServer({ reportId: 'report-1', reportReviewStatus: 'returned_for_correction' }, marked), false, 'returned meanwhile: not shown as sent');
  assert.equal(isReportSyncedToServer({ reportId: 'report-1', reportReviewStatus: 'approved' }, { ...marked, serverConfirmedAt: null }), false, 'unmarked failed draft: not sent');
  assert.equal(isReportSyncedToServer({ reportId: 'report-1', reportReviewStatus: 'returned_for_correction' }, undefined), true, 'no draft at all: unchanged rule');
});

// ---- the REAL server lookup (src/technician/api.ts) over faked database answers -------------------------------------------------------
function detailRow(over: Record<string, unknown> = {}) {
  return {
    visit_id: 'visit-1', scheduled_date: '2026-10-01', visit_status: 'completed', job_id: 'job-1', job_summary: 'Window Cleaning', job_type: 'general',
    job_notes: null, building_name: 'B', building_address: 'A', building_postcode: null, site_instructions: null, key_safe_code: null,
    keyholder_name: null, keyholder_phone: null, parking_notes: null, access_notes: null,
    report_id: 'report-1', report_review_status: 'approved', report_return_reason: null, report_work_carried_out: 'Window Cleaning',
    report_technician_notes: 'Optional notes test - return', report_issues: 'Notes / issues test - return', report_photo_count: 1, report_spec_met: true,
    ...over,
  };
}

test('SERVER LOOKUP: reads this technician\'s own part and own photo paths; no report of theirs = null', async () => {
  rpcRows = { technician_visit_detail: [detailRow()], technician_shared_visits: [], technician_my_photos: [{ storage_path: 'visit-1/before/p.jpg', phase: 'before', can_delete: false }] };
  const got = await getMyServerReportForVisit('visit-1');
  assert.deepEqual(got, {
    reportId: 'report-1', reviewStatus: 'approved', workCarriedOut: 'Window Cleaning', technicianNotes: 'Optional notes test - return',
    issues: 'Notes / issues test - return', specMet: true, photoPaths: ['visit-1/before/p.jpg'],
  });

  rpcRows.technician_visit_detail = [detailRow({ report_id: null, report_review_status: null })];
  assert.equal(await getMyServerReportForVisit('visit-1'), null, 'their part not submitted: null (= no match)');
  rpcRows.technician_visit_detail = [];
  assert.equal(await getMyServerReportForVisit('visit-1'), null, 'visit not theirs / gone: null');
});

test('SERVER LOOKUP is strict: any error or incomplete answer throws (= unknown), never "no photos" or empty text', async () => {
  const base = { technician_shared_visits: [], technician_my_photos: [] as unknown[] };
  const cases: [string, Record<string, unknown[] | { error: string }>][] = [
    ['visit detail error', { ...base, technician_visit_detail: { error: 'boom' } }],
    ['photo list error', { ...base, technician_visit_detail: [detailRow()], technician_my_photos: { error: 'boom' } }],
    ['a text field missing', { ...base, technician_visit_detail: [(({ report_issues: _x, ...rest }) => rest)(detailRow())] }],
    ['review state missing', { ...base, technician_visit_detail: [detailRow({ report_review_status: null })] }],
    ['odd photo row', { ...base, technician_visit_detail: [detailRow()], technician_my_photos: [{ phase: 'before' }] }],
    ['an answer for another visit', { ...base, technician_visit_detail: [detailRow({ visit_id: 'visit-OTHER' })] }],
  ];
  for (const [name, rows] of cases) {
    rpcRows = rows;
    await assert.rejects(getMyServerReportForVisit('visit-1'), `${name}: throws`);
  }

  // end to end: an incomplete answer leaves the draft exactly as it was
  setTechnicianUploadDepsForTests({ fetchMyServerReport: getMyServerReportForVisit, checkTimeoutMs: 1000 });
  await putDraft(draft({ technicianNotes: null, issues: null }));
  rpcRows = { ...base, technician_visit_detail: [(({ report_issues: _x, ...rest }) => rest)(detailRow({ report_technician_notes: null }))] };
  await runSyncSweepForTests();
  assert.ok(!(await getDraft(OWNER, 'visit-1'))!.serverConfirmedAt, 'not marked on incomplete data');
  assert.equal((await readSyncStatusForTests()).failedDraftCount, 1);
});
