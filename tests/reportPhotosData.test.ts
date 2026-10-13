// The MANAGER adding and removing photos on a report (src/repository/reportPhotosRepository.ts): the real repository code against a fake
// Supabase (REST + Storage) server behind fetch. Mocked, not live - the live check against DEV is a separate browser test.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { PHOTO_MAX_ORIGINAL_BYTES, addReportPhoto, checkPhotoFile, explainPhotoError, removeReportPhoto } from '../src/repository/reportPhotosRepository';

interface Logged { method: string; path: string; search: string; body: any; headers: Headers }
const server = {
  log: [] as Logged[],
  failNext: null as null | { match: RegExp; status: number; body: unknown },
  deleteRows: [{ id: 'p1' }] as unknown[],
  removeStatus: 200,
};
function reset() {
  server.log = [];
  server.failNext = null;
  server.deleteRows = [{ id: 'p1' }];
  server.removeStatus = 200;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(url.pathname);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : init?.body ? { binary: true } : undefined;
  server.log.push({ method, path, search: decodeURIComponent(url.search), body, headers: new Headers(init?.headers) });

  if (server.failNext && server.failNext.match.test(`${method} ${path}${url.search}`)) {
    const f = server.failNext;
    server.failNext = null;
    return json(f.status, f.body);
  }
  const wantsObject = (new Headers(init?.headers).get('accept') ?? '').includes('vnd.pgrst.object');
  if (path === '/rest/v1/photos' && method === 'POST') {
    const row = { id: 'new-photo', phase: body.phase, storage_path: body.storage_path, upload_status: body.upload_status, include_in_client_report: body.include_in_client_report };
    return json(201, wantsObject ? row : [row]);
  }
  if (path === '/rest/v1/photos' && method === 'DELETE') return json(200, server.deleteRows);
  if (path === '/rest/v1/activity_events' && method === 'POST') return new Response(null, { status: 201 });
  if (path.startsWith('/storage/v1/object/visit-photos/') && method === 'POST') return json(200, { Key: 'ok' });
  if (path === '/storage/v1/object/visit-photos' && method === 'DELETE') return server.removeStatus === 200 ? json(200, [{ name: 'x' }]) : json(server.removeStatus, { message: 'storage is down' });
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;

beforeEach(reset);
const calls = (re: RegExp) => server.log.filter((l) => re.test(`${l.method} ${l.path}`));
const order = () => server.log.map((l) => `${l.method} ${l.path.replace(/\/[0-9a-f-]{36}\.\w+$/, '/<uuid>')}`);
const VISIT = '0b7a2f4e-1111-4222-8333-444455556666';
const REPORT = 'rep-1';
const photoFile = (name = 'site.jpg', type = 'image/jpeg', size = 2048) => new File([new Uint8Array(size)], name, { type });

// ---- picking a file --------------------------------------------------------------------------------------------------------------
test('CHECK FILE: photos are fine; other files, empty files and files over 50 MB are refused with a plain reason', () => {
  assert.equal(checkPhotoFile({ name: 'a.jpg', type: 'image/jpeg', size: 1000 }), null);
  assert.equal(checkPhotoFile({ name: 'a.png', type: 'image/png', size: 1000 }), null);
  assert.equal(checkPhotoFile({ name: 'IMG_1.HEIC', type: '', size: 1000 }), null, 'some systems report no type for a phone photo: the extension decides');
  assert.match(checkPhotoFile({ name: 'report.pdf', type: 'application/pdf', size: 1000 })!, /not a photo/);
  assert.match(checkPhotoFile({ name: 'notes.txt', type: '', size: 1000 })!, /not a photo/);
  assert.match(checkPhotoFile({ name: 'a.jpg', type: 'image/jpeg', size: 0 })!, /empty/);
  assert.match(checkPhotoFile({ name: 'huge.jpg', type: 'image/jpeg', size: PHOTO_MAX_ORIGINAL_BYTES + 1 })!, /too large/);
  assert.equal(checkPhotoFile({ name: 'edge.jpg', type: 'image/jpeg', size: PHOTO_MAX_ORIGINAL_BYTES }), null);
});

// ---- adding ----------------------------------------------------------------------------------------------------------------------
test('ADD: uploads the file to the private visit-photos bucket under {visit}/{phase}/{uuid}, THEN creates the record, THEN writes the history', async () => {
  const photo = await addReportPhoto({ reportId: REPORT, visitId: VISIT, phase: 'during', file: photoFile(), actor: 'luke@x' });
  assert.deepEqual(order(), [
    `POST /storage/v1/object/visit-photos/${VISIT}/during/<uuid>`,
    'POST /rest/v1/photos',
    'POST /rest/v1/activity_events',
  ]);
  const [upload] = calls(/^POST \/storage\/v1\/object\/visit-photos\//);
  assert.match(upload.path, new RegExp(`^/storage/v1/object/visit-photos/${VISIT}/during/[0-9a-f-]{36}\\.jpg$`));
  assert.equal(calls(/\/object\/public\//).length, 0, 'never a public bucket');
  assert.deepEqual(photo, { id: 'new-photo', phase: 'during', storagePath: upload.path.replace('/storage/v1/object/visit-photos/', ''), uploadStatus: 'uploaded', includeInClientReport: true });
});

test('ADD: the record is an UPLOADED photo, INCLUDED for the client by default, with NO technician (it belongs to the office)', async () => {
  await addReportPhoto({ reportId: REPORT, visitId: VISIT, phase: 'before', file: photoFile(), actor: 'luke@x' });
  const [insert] = calls(/^POST \/rest\/v1\/photos$/);
  assert.deepEqual(Object.keys(insert.body).sort(), ['include_in_client_report', 'phase', 'report_id', 'storage_path', 'technician_id', 'upload_status', 'uploaded_at']);
  assert.equal(insert.body.report_id, REPORT);
  assert.equal(insert.body.phase, 'before');
  assert.equal(insert.body.upload_status, 'uploaded');
  assert.equal(insert.body.include_in_client_report, true);
  assert.equal(insert.body.technician_id, null);
  assert.ok(!Number.isNaN(Date.parse(insert.body.uploaded_at)), 'uploaded_at is a timestamp');
  assert.match(insert.body.storage_path, new RegExp(`^${VISIT}/before/`));
});

test('ADD: every photo gets its own fresh path (no collisions), and the history says who added it and to which section', async () => {
  await addReportPhoto({ reportId: REPORT, visitId: VISIT, phase: 'after', file: photoFile(), actor: 'luke@x' });
  await addReportPhoto({ reportId: REPORT, visitId: VISIT, phase: 'after', file: photoFile(), actor: 'luke@x' });
  const paths = calls(/^POST \/rest\/v1\/photos$/).map((c) => c.body.storage_path);
  assert.equal(new Set(paths).size, 2);
  const events = calls(/^POST \/rest\/v1\/activity_events$/).map((c) => c.body);
  assert.equal(events.length, 2);
  assert.deepEqual({ ...events[0], occurred_at: undefined }, { entity_type: 'report', entity_id: REPORT, event_type: 'report_photo_added', detail: 'after', actor: 'luke@x', occurred_at: undefined });
});

test('ADD: a file that is not a photo is refused BEFORE anything is sent', async () => {
  await assert.rejects(addReportPhoto({ reportId: REPORT, visitId: VISIT, phase: 'before', file: photoFile('plan.pdf', 'application/pdf'), actor: 'luke@x' }), /not a photo/);
  assert.equal(server.log.length, 0);
});

test('ADD: if the upload fails nothing is recorded and nothing is logged', async () => {
  server.failNext = { match: /POST \/storage\/v1\/object\/visit-photos\//, status: 400, body: { message: 'The object exceeded the maximum allowed size' } };
  await assert.rejects(addReportPhoto({ reportId: REPORT, visitId: VISIT, phase: 'before', file: photoFile(), actor: 'luke@x' }), /exceeded the maximum/);
  assert.equal(calls(/^POST \/rest\/v1\/photos$/).length, 0);
  assert.equal(calls(/activity_events/).length, 0);
});

test('ADD: if the record cannot be created the uploaded file is taken away again, and nothing is logged', async () => {
  server.failNext = { match: /POST \/rest\/v1\/photos/, status: 403, body: { message: 'new row violates row-level security policy' } };
  await assert.rejects(addReportPhoto({ reportId: REPORT, visitId: VISIT, phase: 'before', file: photoFile(), actor: 'luke@x' }), /row-level security/);
  const [upload] = calls(/^POST \/storage\/v1\/object\/visit-photos\//);
  const [remove] = calls(/^DELETE \/storage\/v1\/object\/visit-photos$/);
  assert.ok(remove, 'the orphan file was removed');
  assert.deepEqual(remove.body.prefixes, [upload.path.replace('/storage/v1/object/visit-photos/', '')]);
  assert.equal(calls(/activity_events/).length, 0);
});

// ---- removing --------------------------------------------------------------------------------------------------------------------
const PHOTO = { id: 'p1', phase: 'during' as const, storagePath: `${VISIT}/during/aaaa.jpg` };

test('REMOVE: deletes the record FIRST, then the file, then writes the history - and only for that photo on that report', async () => {
  const result = await removeReportPhoto(PHOTO, REPORT, 'luke@x');
  assert.deepEqual(order(), ['DELETE /rest/v1/photos', 'DELETE /storage/v1/object/visit-photos', 'POST /rest/v1/activity_events']);
  const [del] = calls(/^DELETE \/rest\/v1\/photos$/);
  assert.match(del.search, /id=eq\.p1/);
  assert.match(del.search, /report_id=eq\.rep-1/);
  assert.deepEqual(calls(/^DELETE \/storage\/v1\/object\/visit-photos$/)[0].body.prefixes, [PHOTO.storagePath]);
  const [event] = calls(/^POST \/rest\/v1\/activity_events$/);
  assert.equal(event.body.event_type, 'report_photo_removed');
  assert.equal(event.body.detail, 'during');
  assert.equal(event.body.actor, 'luke@x');
  assert.deepEqual(result, { fileCleanupFailed: false });
});

test('REMOVE: a photo that is already gone says so, and the file is not touched', async () => {
  server.deleteRows = [];
  await assert.rejects(removeReportPhoto(PHOTO, REPORT, 'luke@x'), /already been removed/);
  assert.equal(calls(/storage/).length, 0);
  assert.equal(calls(/activity_events/).length, 0);
});

test('REMOVE: if the record cannot be deleted the file is NOT deleted (the photo stays exactly as it was)', async () => {
  server.failNext = { match: /DELETE \/rest\/v1\/photos/, status: 403, body: { message: 'permission denied for table photos' } };
  await assert.rejects(removeReportPhoto(PHOTO, REPORT, 'luke@x'), /permission denied/);
  assert.equal(calls(/storage/).length, 0);
  assert.equal(calls(/activity_events/).length, 0);
});

test('REMOVE: if only the FILE cannot be deleted the photo is still removed from the report and the manager is told (nothing uses the file any more)', async () => {
  server.removeStatus = 500;
  const result = await removeReportPhoto(PHOTO, REPORT, 'luke@x');
  assert.deepEqual(result, { fileCleanupFailed: true });
  assert.equal(calls(/^POST \/rest\/v1\/activity_events$/).length, 1, 'the removal is still recorded');
});

// ---- errors ----------------------------------------------------------------------------------------------------------------------
test('ERRORS become plain sentences', () => {
  assert.match(explainPhotoError(new Error('new row violates row-level security policy')), /permission/);
  assert.match(explainPhotoError(new Error('The object exceeded the maximum allowed size')), /too large/);
  assert.match(explainPhotoError(new TypeError('Failed to fetch')), /Could not reach the server/);
  assert.match(explainPhotoError(new Error('That photo has already been removed.')), /already been removed/);
  assert.match(explainPhotoError(new Error('weird')), /Something went wrong: weird/);
  assert.match(explainPhotoError(undefined), /Something went wrong/);
});
