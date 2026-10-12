// Data-layer tests for report videos (manager side). The REAL repository code runs; only the network is replaced by a small fake
// Supabase server that records every request, so what is SENT - and what is NEVER sent (a hard delete, a service key, a public
// bucket) - can be asserted. The database and Storage rules themselves are tested against DEV (see the DEV security suite and
// the live manager test); here the client side is tested against a server that refuses.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REPORT_VIDEO_BUCKET,
  listVideosForVisit,
  removeReportVideo,
  setReportIncludeVideos,
  setVideoClientInclusion,
  signVideoPlaybackUrl,
  signVideoThumbnailUrls,
  uploadReportVideo,
  type ReportVideo,
} from '../src/repository/reportVideosRepository';
import { UploadCancelledError, UploadError, type ResumableUploadArgs } from '../src/lib/reportVideoUpload';

interface Logged { method: string; path: string; search: string; body: any; headers: Headers }
const server = {
  log: [] as Logged[],
  rows: [] as unknown[],
  failNext: null as null | { match: RegExp; status: number; body: unknown },
  patchRows: [{ id: 'v1' }] as unknown[],
  insertRow: null as null | Record<string, unknown>,
};
function reset() {
  server.log = [];
  server.rows = [];
  server.failNext = null;
  server.patchRows = [{ id: 'v1' }];
  server.insertRow = null;
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
  if (path === '/rest/v1/report_videos' && method === 'GET') return json(200, server.rows);
  if (path === '/rest/v1/report_videos' && method === 'PATCH') return json(200, server.patchRows);
  if (path === '/rest/v1/report_videos' && method === 'POST') return json(201, wantsObject ? server.insertRow : [server.insertRow]);
  if (path === '/rest/v1/reports' && method === 'PATCH') return json(200, server.patchRows);
  if (path.startsWith(`/storage/v1/object/sign/${REPORT_VIDEO_BUCKET}/`) && method === 'POST') return json(200, { signedURL: `/object/sign/${REPORT_VIDEO_BUCKET}/${path.split('/sign/' + REPORT_VIDEO_BUCKET + '/')[1]}?token=t` });
  if (path.startsWith(`/storage/v1/object/${REPORT_VIDEO_BUCKET}/`) && method === 'POST') return json(200, { Key: 'ok' });
  if (path === `/storage/v1/object/${REPORT_VIDEO_BUCKET}` && method === 'DELETE') return json(200, []);
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;

beforeEach(reset);

const calls = (re: RegExp) => server.log.filter((l) => re.test(`${l.method} ${l.path}`));
const VISIT = '0b7a2f4e-1111-4222-8333-444455556666';

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'v1', visit_id: VISIT, phase: 'before', storage_path: `${VISIT}/before/aaaa.mp4`, thumbnail_path: `${VISIT}/before/aaaa.jpg`, mime_type: 'video/mp4', size_bytes: 5242880,
    duration_seconds: '12.50', source: 'technician', include_in_client_report: false, created_at: '2026-10-12T10:00:00Z', technicians: { name: 'Mo' }, ...over,
  };
}
const FILE = new File([new Uint8Array(2048)], 'site.mp4', { type: 'video/mp4' });
const THUMB = new Blob([new Uint8Array(100)], { type: 'image/jpeg' });
const input = (over: Record<string, unknown> = {}) => ({ visitId: VISIT, phase: 'during' as const, file: FILE, mime: 'video/mp4' as const, ext: 'mp4' as const, durationSeconds: 20, thumbnail: THUMB, ...over });
const okUploader = async () => {};

// ---- reading ---------------------------------------------------------------------------------------------------
test('LIST asks for this visit\'s videos that have NOT been removed, oldest first, and maps the row (numeric text, technician name)', async () => {
  server.rows = [row(), row({ id: 'v2', source: 'manager', technicians: null, duration_seconds: null, thumbnail_path: null })];
  const videos = await listVideosForVisit(VISIT);
  const [get] = calls(/^GET \/rest\/v1\/report_videos$/);
  assert.match(get.search, new RegExp(`visit_id=eq\\.${VISIT}`));
  assert.match(get.search, /deleted_at=is\.null/, 'removed videos are never listed');
  assert.match(get.search, /order=created_at\.asc/);
  assert.equal(videos.length, 2);
  assert.deepEqual(videos[0], {
    id: 'v1', visitId: VISIT, phase: 'before', storagePath: `${VISIT}/before/aaaa.mp4`, thumbnailPath: `${VISIT}/before/aaaa.jpg`, mimeType: 'video/mp4', sizeBytes: 5242880,
    durationSeconds: 12.5, source: 'technician', uploadedByName: 'Mo', includeInClientReport: false, createdAt: '2026-10-12T10:00:00Z',
  });
  assert.equal(videos[1].uploadedByName, null);
  assert.equal(videos[1].durationSeconds, null);
});

test('LIST failure is reported, not swallowed', async () => {
  server.failNext = { match: /GET \/rest\/v1\/report_videos/, status: 500, body: { message: 'boom' } };
  await assert.rejects(listVideosForVisit(VISIT), /Failed to load videos: boom/);
});

test('PLAYBACK links are signed for 10 minutes from the PRIVATE report-videos bucket (never a public URL)', async () => {
  const url = await signVideoPlaybackUrl(`${VISIT}/before/aaaa.mp4`);
  const [sign] = calls(/^POST \/storage\/v1\/object\/sign\//);
  assert.equal(sign.path, `/storage/v1/object/sign/${REPORT_VIDEO_BUCKET}/${VISIT}/before/aaaa.mp4`);
  assert.equal(sign.body.expiresIn, 600);
  assert.match(url, /\/object\/sign\/report-videos\/.*token=t/);
  assert.equal(calls(/\/object\/public\//).length, 0, 'no public URL is ever requested');
  server.failNext = { match: /sign/, status: 400, body: { message: 'Object not found' } };
  await assert.rejects(signVideoPlaybackUrl('x'), /Failed to prepare the video for playback/);
});

test('POSTERS are signed only for videos that have a thumbnail, and one failure does not hide the others', async () => {
  const videos = [row(), row({ id: 'v2', thumbnail_path: null }), row({ id: 'v3', thumbnail_path: `${VISIT}/before/cccc.jpg` })].map((r) => ({
    id: r.id as string, thumbnailPath: r.thumbnail_path as string | null,
  })) as ReportVideo[];
  server.failNext = { match: /aaaa\.jpg/, status: 400, body: { message: 'nope' } };
  const urls = await signVideoThumbnailUrls(videos);
  assert.equal(calls(/^POST \/storage\/v1\/object\/sign\//).length, 2, 'only v1 and v3 have a thumbnail');
  assert.equal(urls.v1, '', 'the failed one is blank, not an exception');
  assert.match(urls.v3, /cccc\.jpg/);
  assert.equal('v2' in urls, false);
});

// ---- inclusion switches ---------------------------------------------------------------------------------------------
test('INCLUDE FOR CLIENT is a single-column update of one video that is not removed, and nothing else', async () => {
  await setVideoClientInclusion('v1', true);
  const [patch] = calls(/^PATCH \/rest\/v1\/report_videos$/);
  assert.match(patch.search, /id=eq\.v1/);
  assert.match(patch.search, /deleted_at=is\.null/);
  assert.deepEqual(patch.body, { include_in_client_report: true });
  await setVideoClientInclusion('v1', false);
  assert.deepEqual(calls(/^PATCH \/rest\/v1\/report_videos$/)[1].body, { include_in_client_report: false });
});

test('INCLUDE FOR CLIENT: a Completed report\'s refusal is passed through readably; a vanished video is explained', async () => {
  server.failNext = { match: /PATCH/, status: 400, body: { message: 'This report has been marked Completed; reopen it before changing its videos.' } };
  await assert.rejects(setVideoClientInclusion('v1', true), /marked Completed; reopen it/);
  server.patchRows = [];
  await assert.rejects(setVideoClientInclusion('v1', true), /no longer available/);
});

test('REPORT-LEVEL switch updates only include_videos on that report; a Completed report\'s refusal is passed through', async () => {
  await setReportIncludeVideos('r1', false);
  const [patch] = calls(/^PATCH \/rest\/v1\/reports$/);
  assert.match(patch.search, /id=eq\.r1/);
  assert.deepEqual(patch.body, { include_videos: false });
  server.failNext = { match: /PATCH \/rest\/v1\/reports/, status: 400, body: { message: 'This report has been marked Completed; reopen it before changing whether videos are included.' } };
  await assert.rejects(setReportIncludeVideos('r1', true), /marked Completed; reopen it/);
  server.patchRows = [];
  await assert.rejects(setReportIncludeVideos('r1', true), /could not be found/);
});

// ---- removal ---------------------------------------------------------------------------------------------------------------
test('REMOVE is a SOFT delete: it sets deleted_at / deleted_by on a video not yet removed, and NEVER hard-deletes a row or a file', async () => {
  const before = Date.now();
  await removeReportVideo('v1', 'luke@kindcontractors.co.uk');
  const [patch] = calls(/^PATCH \/rest\/v1\/report_videos$/);
  assert.match(patch.search, /id=eq\.v1/);
  assert.match(patch.search, /deleted_at=is\.null/, 'only a video that is not already removed');
  assert.deepEqual(Object.keys(patch.body).sort(), ['deleted_at', 'deleted_by']);
  assert.equal(patch.body.deleted_by, 'luke@kindcontractors.co.uk');
  assert.ok(Date.parse(patch.body.deleted_at) >= before - 1000);
  assert.equal(server.log.filter((l) => l.method === 'DELETE').length, 0, 'no DELETE of any kind - not the row, not the file');
  assert.equal(calls(/\/storage\//).length, 0, 'Storage is not touched at all');
  assert.equal(calls(/activity_events/).length, 0, 'the database writes the audit event itself; the client writes none (no duplicates)');
});

test('REMOVE: refusals and an already-removed video are reported', async () => {
  server.patchRows = [];
  await assert.rejects(removeReportVideo('v1', 'luke@x'), /already been removed/);
  server.failNext = { match: /PATCH/, status: 403, body: { message: 'permission denied for table report_videos' } };
  await assert.rejects(removeReportVideo('v1', 'luke@x'), /permission denied/);
});

// ---- uploading ----------------------------------------------------------------------------------------------------------------
test('UPLOAD: poster, then the resumable video file, then the record - source manager, NOT included for the client, private bucket', async () => {
  const order: string[] = [];
  let args!: ResumableUploadArgs;
  server.insertRow = row({ id: 'new1', source: 'manager', phase: 'during', technicians: null, size_bytes: FILE.size, duration_seconds: 20 });
  const saving: string[] = [];
  const video = await uploadReportVideo(
    { ...input(), onSaving: () => { saving.push('saving'); order.push('saving'); } },
    { getAccessToken: async () => 'manager-token', uploader: async (a) => { order.push('video'); args = a; a.onProgress?.(1024, 2048); } },
  );

  // the poster went first, through the private bucket's standard upload
  const thumbPost = calls(new RegExp(`^POST /storage/v1/object/${REPORT_VIDEO_BUCKET}/${VISIT}/during/[0-9a-f-]{36}\\.jpg$`));
  assert.equal(thumbPost.length, 1);
  // the video file: private bucket, {visit}/{phase}/{uuid}.{ext}, declared type
  assert.equal(args.bucket, 'report-videos');
  assert.match(args.objectName, new RegExp(`^${VISIT}/during/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.mp4$`));
  assert.equal(args.contentType, 'video/mp4');
  assert.equal(args.file, FILE);
  assert.equal(args.apiKey, 'test-key', 'only the public anon key is ever used');
  assert.equal(await args.getAccessToken(), 'manager-token', 'the signed-in user\'s own token');
  assert.match(args.endpoint, /\/storage\/v1\/upload\/resumable$/);
  assert.deepEqual(order, ['video', 'saving'], 'the record is saved only after the file is up');
  // the record
  const [insert] = calls(/^POST \/rest\/v1\/report_videos$/);
  assert.deepEqual(insert.body, {
    visit_id: VISIT, phase: 'during', storage_path: args.objectName, thumbnail_path: thumbPost[0].path.replace(`/storage/v1/object/${REPORT_VIDEO_BUCKET}/`, ''),
    mime_type: 'video/mp4', size_bytes: FILE.size, duration_seconds: 20, source: 'manager', include_in_client_report: false,
  });
  assert.equal(video.id, 'new1');
  assert.equal(calls(/\/object\/public\//).length, 0);
  assert.equal(server.log.filter((l) => l.method === 'DELETE').length, 0, 'a successful upload removes nothing');
  for (const l of server.log) assert.equal(l.headers.get('apikey'), 'test-key');
});

test('UPLOAD without a poster sends no poster request and records no thumbnail', async () => {
  server.insertRow = row({ id: 'n', thumbnail_path: null });
  await uploadReportVideo(input({ thumbnail: null }), { uploader: okUploader, getAccessToken: async () => 't' });
  assert.equal(calls(/^POST \/storage\/v1\/object\//).length, 0);
  assert.equal(calls(/^POST \/rest\/v1\/report_videos$/)[0].body.thumbnail_path, null);
});

test('UPLOAD: a poster that fails to upload never blocks the video', async () => {
  server.insertRow = row({ id: 'n' });
  server.failNext = { match: /POST \/storage\/v1\/object\/report-videos\/.*\.jpg/, status: 400, body: { message: 'bad' } };
  await uploadReportVideo(input(), { uploader: okUploader, getAccessToken: async () => 't' });
  assert.equal(calls(/^POST \/rest\/v1\/report_videos$/)[0].body.thumbnail_path, null);
  assert.equal(server.log.filter((l) => l.method === 'DELETE').length, 0);
});

test('UPLOAD: every attempt uses brand-new file names, so a retry never collides with an earlier half-finished one', async () => {
  const names: string[] = [];
  server.insertRow = row();
  for (let i = 0; i < 2; i++) await uploadReportVideo(input({ thumbnail: null }), { uploader: async (a) => { names.push(a.objectName); }, getAccessToken: async () => 't' });
  assert.notEqual(names[0], names[1]);
});

test('UPLOAD FAILURE after the files are up (e.g. the database refuses the record): the exact files this attempt uploaded are removed again, and the database\'s readable message is shown', async () => {
  let videoName = '';
  server.failNext = { match: /POST \/rest\/v1\/report_videos/, status: 400, body: { message: 'Only 3 videos can be added to each section (Before / During / After).' } };
  await assert.rejects(
    uploadReportVideo(input(), { uploader: async (a) => { videoName = a.objectName; }, getAccessToken: async () => 't' }),
    /Only 3 videos can be added to each section/,
  );
  const [del] = calls(/^DELETE \/storage\/v1\/object\/report-videos$/);
  assert.ok(del, 'the unreferenced files are cleaned up');
  assert.equal(del.body.prefixes.length, 2);
  assert.ok(del.body.prefixes.includes(videoName));
  assert.ok(del.body.prefixes.every((p: string) => p.startsWith(`${VISIT}/during/`)));
});

test('UPLOAD FAILURE during the file upload (Storage said too large): no record is created, only the poster is cleaned up', async () => {
  await assert.rejects(
    uploadReportVideo(input(), { uploader: async () => { throw new UploadError('The object exceeded the maximum allowed size', 413); }, getAccessToken: async () => 't' }),
    (e: any) => e instanceof UploadError && e.status === 413,
  );
  assert.equal(calls(/^POST \/rest\/v1\/report_videos$/).length, 0, 'no record for a file that never arrived');
  const [del] = calls(/^DELETE \/storage\/v1\/object\/report-videos$/);
  assert.equal(del.body.prefixes.length, 1);
  assert.match(del.body.prefixes[0], /\.jpg$/);
});

test('UPLOAD CANCELLED: the cancellation is passed on unchanged, nothing is recorded, the poster is removed', async () => {
  await assert.rejects(
    uploadReportVideo(input(), { uploader: async () => { throw new UploadCancelledError(); }, getAccessToken: async () => 't' }),
    (e: any) => e instanceof UploadCancelledError,
  );
  assert.equal(calls(/^POST \/rest\/v1\/report_videos$/).length, 0);
  assert.equal(calls(/^DELETE \/storage\/v1\/object\/report-videos$/)[0].body.prefixes.length, 1);
});

test('UPLOAD: the abort signal reaches the uploader', async () => {
  const controller = new AbortController();
  let got: AbortSignal | undefined;
  server.insertRow = row();
  await uploadReportVideo(input({ signal: controller.signal, thumbnail: null }), { uploader: async (a) => { got = a.signal; }, getAccessToken: async () => 't' });
  assert.equal(got, controller.signal);
});
