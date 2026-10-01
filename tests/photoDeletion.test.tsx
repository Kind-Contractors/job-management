// Regression tests for technician photo deletion: the offline queue (IndexedDB), the Storage / RPC
// calls, and the failure handling. The real code runs unchanged; only the network and IndexedDB
// are replaced (a small fake Storage + RPC server behind fetch, and fake-indexeddb).
//
// The backend permission rules themselves (own photo only, not after submission, correction window,
// shared-visit isolation) live in the database and are tested against the DEV database - see the
// photo-deletion migration notes. Here the client side is tested against a server that refuses.
import 'fake-indexeddb/auto';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { setCurrentUserId } from '../src/auth/currentUser';
import { deleteDraft, deletePhoto, deletePhotosForVisit, getPhoto, putDraft, putPhoto, type DraftReport, type PendingPhoto } from '../src/technician/offline/db';
import { removeQueuedPhoto, retryPhoto } from '../src/technician/offline/syncEngine';
import { PhotoFileCleanupError, RpcError, deleteSubmittedPhoto, removePhotoObject } from '../src/technician/api';
import PhotoDeleteButton from '../src/technician/PhotoDeleteButton';

// ---- environment ----------------------------------------------------------------------
const nav: { onLine: boolean } = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });

// ---- a tiny fake Storage + RPC server -----------------------------------------------------
const BUCKET = 'visit-photos';
const server = {
  objects: new Map<string, { owner: string }>(), // Storage objects by path
  photoRows: new Set<string>(), // paths that have a photos row (submitted)
  calls: [] as string[],
  removeBodies: [] as string[][],
  denyRemove: false, // the Storage policy refuses: an empty result while the object exists
  failRemove: false, // Storage answers 500
  rpcError: null as null | { code: string; message: string },
  uploadGate: null as null | Promise<void>, // holds an upload in flight
};

function reset() {
  server.objects.clear();
  server.photoRows.clear();
  server.calls.length = 0;
  server.removeBodies.length = 0;
  server.denyRemove = false;
  server.failRemove = false;
  server.rpcError = null;
  server.uploadGate = null;
  nav.onLine = true;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET').toUpperCase();
  const path = decodeURIComponent(url.pathname);
  const objectPrefix = `/storage/v1/object/${BUCKET}/`;

  if (path.startsWith(objectPrefix) && method === 'HEAD') {
    const p = path.slice(objectPrefix.length);
    return server.objects.has(p) ? new Response(null, { status: 200 }) : new Response(null, { status: 404 });
  }
  if (path.startsWith(objectPrefix) && method === 'POST') {
    const p = path.slice(objectPrefix.length);
    server.calls.push(`upload ${p}`);
    if (server.uploadGate) await server.uploadGate;
    server.objects.set(p, { owner: 'user-1' });
    return json(200, { Key: `${BUCKET}/${p}`, Id: 'x' });
  }
  if (path === `/storage/v1/object/${BUCKET}` && method === 'DELETE') {
    const prefixes: string[] = JSON.parse(init.body).prefixes;
    server.calls.push(`remove ${prefixes.join(',')}`);
    server.removeBodies.push(prefixes);
    if (server.failRemove) return json(500, { statusCode: '500', error: 'Internal', message: 'storage is down' });
    if (server.denyRemove) return json(200, []); // what the Storage API returns when a policy refuses
    const removed = prefixes.filter((p) => server.objects.has(p));
    for (const p of removed) server.objects.delete(p);
    return json(200, removed.map((name) => ({ name, bucket_id: BUCKET })));
  }
  if (path === '/rest/v1/rpc/technician_delete_photo' && method === 'POST') {
    const p: string = JSON.parse(init.body).p_storage_path;
    server.calls.push(`rpc technician_delete_photo ${p}`);
    if (server.rpcError) return json(400, server.rpcError);
    server.photoRows.delete(p);
    return new Response(null, { status: 204 });
  }
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;

// ---- fixtures -------------------------------------------------------------------------
let seq = 0;
async function seedPhoto(over: Partial<PendingPhoto> = {}): Promise<PendingPhoto> {
  seq += 1;
  const photo: PendingPhoto = {
    id: `photo-${seq}`,
    ownerId: 'user-1',
    visitId: 'visit-1',
    phase: 'before',
    blob: new Blob(['jpeg-bytes']),
    storagePath: `visit-1/before/uuid-${seq}.jpg`,
    status: 'pending',
    lastError: null,
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: null,
    ...over,
  };
  await putPhoto(photo);
  if (photo.status === 'uploaded') server.objects.set(photo.storagePath, { owner: 'user-1' });
  return photo;
}

beforeEach(async () => {
  reset();
  setCurrentUserId('user-1');
  // Start every test with an empty queue (the fake IndexedDB lives for the whole file).
  for (const owner of ['user-1', 'user-2']) {
    await deleteDraft(owner, 'visit-1');
    await deletePhotosForVisit(owner, 'visit-1');
  }
});

// ---- 1. own uploaded photo ------------------------------------------------------------
test('a technician can delete their own already-uploaded (unsubmitted) photo: file and queue record both go', async () => {
  const photo = await seedPhoto({ status: 'uploaded' });
  await removeQueuedPhoto(photo);
  assert.deepEqual(server.removeBodies, [[photo.storagePath]]);
  assert.equal(server.objects.has(photo.storagePath), false, 'the Storage object is removed (no orphan)');
  assert.equal(await getPhoto(photo.id), undefined, 'the local record is removed');
});

// ---- 2. someone else / refused --------------------------------------------------------
test('when Storage refuses (not your photo, or not allowed) the photo stays and the error is reported', async () => {
  const photo = await seedPhoto({ status: 'uploaded' });
  server.denyRemove = true;
  await assert.rejects(removeQueuedPhoto(photo), /cannot be deleted/);
  assert.ok(await getPhoto(photo.id), 'the record is kept');
  assert.equal(server.objects.has(photo.storagePath), true, 'the file is untouched');
});

test('a photo queued under a different account is refused before any network call', async () => {
  const photo = await seedPhoto({ ownerId: 'user-2', status: 'uploaded' });
  await assert.rejects(removeQueuedPhoto(photo), /different account/);
  assert.equal(server.calls.length, 0);
  assert.ok(await getPhoto(photo.id));
});

// ---- 3. submitted / being sent --------------------------------------------------------
test('a report that is being sent (Complete job tapped) blocks deletion of its photos', async () => {
  const photo = await seedPhoto({ status: 'uploaded' });
  const draft: DraftReport = {
    ownerId: 'user-1', visitId: 'visit-1', mode: 'submit', reportId: null, workCarriedOut: null, technicianNotes: null, issues: null,
    onSiteStart: null, onSiteEnd: null, specMet: true, readyToSubmit: true, submitting: false, submitError: null, updatedAt: new Date().toISOString(),
  };
  await putDraft(draft);
  await assert.rejects(removeQueuedPhoto(photo), /already being sent/);
  assert.equal(server.calls.length, 0, 'nothing is deleted');
  assert.ok(await getPhoto(photo.id));
});

test('a photo already submitted to the report is refused by the database unless returned for correction: no file is touched', async () => {
  const path = 'visit-1/before/submitted.jpg';
  server.objects.set(path, { owner: 'user-1' });
  server.photoRows.add(path);
  server.rpcError = { code: 'P0001', message: 'A photo that is already part of the report can only be removed while your part is returned for correction.' };
  await assert.rejects(deleteSubmittedPhoto(path), (e: unknown) => e instanceof RpcError && /returned for correction/.test(e.message));
  assert.deepEqual(server.calls, [`rpc technician_delete_photo ${path}`], 'the file removal is never attempted');
  assert.equal(server.objects.has(path), true);
  assert.equal(server.photoRows.has(path), true);
});

// ---- 4. returned for correction -------------------------------------------------------
test('returned for correction: a photo already in the report is removed from the database first, then its file', async () => {
  const path = 'visit-1/during/in-report.jpg';
  server.objects.set(path, { owner: 'user-1' });
  server.photoRows.add(path);
  await deleteSubmittedPhoto(path);
  assert.deepEqual(server.calls, [`rpc technician_delete_photo ${path}`, `remove ${path}`], 'database record first, then the Storage file');
  assert.equal(server.photoRows.has(path), false);
  assert.equal(server.objects.has(path), false, 'no orphaned file');
});

// ---- 5. shared visit isolation --------------------------------------------------------
test('shared visit: deleting one photo removes exactly that one object and leaves a colleague photos alone', async () => {
  const mine = await seedPhoto({ status: 'uploaded', storagePath: 'visit-1/before/mine.jpg' });
  server.objects.set('visit-1/before/colleague.jpg', { owner: 'user-2' });
  server.photoRows.add('visit-1/before/colleague-submitted.jpg');
  server.objects.set('visit-1/before/colleague-submitted.jpg', { owner: 'user-2' });
  await removeQueuedPhoto(mine);
  assert.deepEqual(server.removeBodies, [[mine.storagePath]], 'one request, one path');
  assert.equal(server.objects.has('visit-1/before/colleague.jpg'), true);
  assert.equal(server.objects.has('visit-1/before/colleague-submitted.jpg'), true);
  assert.equal(server.photoRows.has('visit-1/before/colleague-submitted.jpg'), true);
});

// ---- 6 and 7. pending photos ----------------------------------------------------------
test('a pending (not yet uploaded) photo is deleted immediately', async () => {
  const photo = await seedPhoto({ status: 'pending' });
  await removeQueuedPhoto(photo);
  assert.equal(await getPhoto(photo.id), undefined);
});

test('a deleted queued photo can never upload later, even from a stale copy held by the screen', async () => {
  const photo = await seedPhoto({ status: 'pending' });
  const staleCopy = { ...photo };
  await removeQueuedPhoto(photo);
  await retryPhoto(staleCopy); // the screen still holds the old object and taps Retry
  assert.equal(server.calls.filter((c) => c.startsWith('upload')).length, 0, 'no upload request is ever made');
  assert.equal(await getPhoto(photo.id), undefined, 'and the record is not resurrected');
});

test('deleted while its upload is in flight: not resurrected, and the file it created is cleaned up', async () => {
  const photo = await seedPhoto({ status: 'pending' });
  let release!: () => void;
  server.uploadGate = new Promise<void>((resolve) => (release = resolve));

  const inFlight = retryPhoto({ ...photo }); // upload request starts and waits at the gate
  while (!server.calls.some((c) => c.startsWith('upload'))) await new Promise((r) => setTimeout(r, 5));

  await removeQueuedPhoto(photo); // the technician deletes it while it is uploading
  release(); // the upload now completes
  await inFlight;
  await new Promise((r) => setTimeout(r, 30)); // let the best-effort cleanup finish

  assert.equal(await getPhoto(photo.id), undefined, 'the record stays deleted');
  assert.equal(server.objects.has(photo.storagePath), false, 'the file that was just uploaded is removed again - no orphan');
});

test('an upload that fails after its photo was deleted does not bring the record back or schedule retries', async () => {
  const photo = await seedPhoto({ status: 'pending' });
  await deletePhoto(photo.id);
  await retryPhoto({ ...photo });
  assert.equal(await getPhoto(photo.id), undefined);
  assert.equal(server.calls.filter((c) => c.startsWith('upload')).length, 0);
});

// ---- 8. failures ----------------------------------------------------------------------
test('Storage failing (500) keeps the uploaded photo and surfaces the error', async () => {
  const photo = await seedPhoto({ status: 'uploaded' });
  server.failRemove = true;
  await assert.rejects(removeQueuedPhoto(photo), /Could not delete the photo/);
  assert.ok(await getPhoto(photo.id), 'the record is kept so the UI still shows the photo');
  assert.equal(server.objects.has(photo.storagePath), true);
});

test('database record removed but the file removal fails: reported explicitly, nothing lost, retry works', async () => {
  const path = 'visit-1/after/needs-cleanup.jpg';
  server.objects.set(path, { owner: 'user-1' });
  server.photoRows.add(path);
  server.failRemove = true;
  await assert.rejects(deleteSubmittedPhoto(path), (e: unknown) => e instanceof PhotoFileCleanupError && /removed from your report/.test(e.message));
  assert.equal(server.photoRows.has(path), false, 'the photo is already out of the report');
  assert.equal(server.objects.has(path), true, 'the file is still there');

  server.failRemove = false;
  await removePhotoObject(path); // the retry
  assert.equal(server.objects.has(path), false);
});

test('removing a file that is already gone counts as success', async () => {
  await assert.doesNotReject(removePhotoObject('visit-1/before/already-gone.jpg'));
});

test('offline: an uploaded photo cannot be deleted (needs the network), but a pending one can', async () => {
  nav.onLine = false;
  const uploaded = await seedPhoto({ status: 'uploaded' });
  await assert.rejects(removeQueuedPhoto(uploaded), /need a connection/);
  assert.ok(await getPhoto(uploaded.id));

  const pending = await seedPhoto({ status: 'pending' });
  await removeQueuedPhoto(pending);
  assert.equal(await getPhoto(pending.id), undefined);
});

// ---- the control ----------------------------------------------------------------------
test('the trash control renders as a labelled button', () => {
  const html = renderToStaticMarkup(
    <PhotoDeleteButton needsConfirm ariaLabel="Delete before photo" onDelete={async () => {}} onError={() => {}} />,
  );
  assert.match(html, /aria-label="Delete before photo"/);
  assert.match(html, /<button/);
});
