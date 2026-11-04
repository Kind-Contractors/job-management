// waste-media-check, through the REAL Edge Function code in Node: only an active waste reporter may call it, only for a file under his
// own folder; it reads the stored file itself (small Range reads), records the result with the service key, and removes a rejected file.
// MOCKED, NOT LIVE: the Deno runtime, Auth, the database and Storage are fakes. The live DEV run covers the real thing.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://tests.invalid',
  SUPABASE_ANON_KEY: 'anon-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test-key',
};
let handler: (req: Request) => Promise<Response>;
(globalThis as any).Deno = { serve: (h: (req: Request) => Promise<Response>) => (handler = h), env: { get: (k: string) => ENV[k] } };

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const REPORT = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const pathOf = (ext: string, user = ME) => `${user}/${REPORT}/before/${FILE}.${ext}`;

const enc = new TextEncoder();
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const box = (t: string, p: Uint8Array) => cat(u32(8 + p.length), enc.encode(t), p);
const mp4 = (seconds: number) =>
  cat(box('ftyp', enc.encode('isom\0\0\0\0isom')), box('mdat', new Uint8Array(4000)), box('moov', box('mvhd', cat(new Uint8Array(4), u32(0), u32(0), u32(1000), u32(seconds * 1000), new Uint8Array(80)))));
const JPEG = cat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), new Uint8Array(500));

const state = {
  role: 'waste_reporter' as string,
  active: true,
  signedIn: true,
  files: new Map<string, Uint8Array>(),
  checks: [] as any[],
  removed: [] as string[],
  rangeReads: 0,
  bytesServed: 0,
  serviceKeyUsedFor: [] as string[],
  upsertFails: false,
  /** Report ids that exist in waste_reports (= sent). */
  sentReports: new Set<string>(),
  /** Paths a sent report's media rows use (file or poster). */
  usedPaths: new Set<string>(),
  /** Called on each media lookup: lets a test make a file become "used" between the check and the clean-up. */
  onMediaLookup: null as null | ((n: number) => void),
  mediaLookups: 0,
  lookupFails: false,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const path = decodeURIComponent(url.pathname);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  const isService = headers.get('authorization') === 'Bearer service-test-key';
  if (isService) state.serviceKeyUsedFor.push(`${method} ${path}`);

  if (path === '/auth/v1/user') return state.signedIn ? json(200, { id: ME, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }) : json(401, { message: 'bad jwt' });
  if (path === '/rest/v1/app_users') {
    const row = { role: state.role, is_active: state.active };
    return json(200, (headers.get('accept') ?? '').includes('vnd.pgrst.object') ? row : [row]);
  }
  if (path.startsWith('/storage/v1/object/sign/waste-report-media/') && method === 'POST') {
    if (!isService) return json(403, { message: 'service only in this test' });
    const file = path.replace('/storage/v1/object/sign/waste-report-media/', '');
    if (!state.files.has(file)) return json(400, { error: 'not_found', message: 'Object not found' });
    return json(200, { signedURL: `/object/sign/waste-report-media/${file}?token=SIGNED` });
  }
  if (path.startsWith('/storage/v1/object/sign/waste-report-media/') && method === 'GET') {
    const file = path.replace('/storage/v1/object/sign/waste-report-media/', '');
    const bytes = state.files.get(file);
    if (!bytes) return json(400, { error: 'not_found' });
    const m = /bytes=(\d+)-(\d+)/.exec(headers.get('range') ?? '');
    assert.ok(m, 'every read is a Range read');
    const start = Number(m![1]);
    const end = Math.min(Number(m![2]), bytes.length - 1);
    const part = bytes.subarray(start, end + 1);
    state.rangeReads++;
    state.bytesServed += part.length;
    return new Response(part, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  }
  if (path === '/rest/v1/waste_reports' && method === 'GET') {
    if (!isService) return json(403, { message: 'service only' });
    if (state.lookupFails) return json(500, { message: 'db down' });
    const id = (url.searchParams.get('id') ?? '').replace(/^eq\./, '');
    return json(200, state.sentReports.has(id) ? [{ id }] : []);
  }
  if (path === '/rest/v1/waste_report_media' && method === 'GET') {
    if (!isService) return json(403, { message: 'service only' });
    state.mediaLookups += 1;
    state.onMediaLookup?.(state.mediaLookups);
    const value = (url.searchParams.get('storage_path') ?? url.searchParams.get('thumbnail_path') ?? '').replace(/^eq\./, '');
    return json(200, state.usedPaths.has(value) ? [{ id: 'm1' }] : []);
  }
  if (path === '/rest/v1/waste_media_checks' && method === 'POST') {
    if (!isService) return json(403, { message: 'service only' });
    if (state.upsertFails) return json(500, { message: 'db down' });
    assert.equal(url.searchParams.get('on_conflict'), 'storage_path');
    state.checks.push(body);
    return new Response(null, { status: 201 });
  }
  if (path === '/storage/v1/object/waste-report-media' && method === 'DELETE') {
    state.removed.push(...body.prefixes);
    return json(200, []);
  }
  return json(404, { message: `unexpected ${method} ${path}` });
}) as typeof fetch;

await import('../supabase/functions/waste-media-check/index.ts');

beforeEach(() => {
  Object.assign(state, { role: 'waste_reporter', active: true, signedIn: true, files: new Map(), checks: [], removed: [], rangeReads: 0, bytesServed: 0, serviceKeyUsedFor: [], upsertFails: false, sentReports: new Set(), usedPaths: new Set(), onMediaLookup: null, mediaLookups: 0, lookupFails: false });
});

const call = (body: unknown, auth = true) =>
  handler(new Request('https://fn.test/waste-media-check', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer user-jwt' } : {}) }, body: JSON.stringify(body) }));

test('refused for no session, a manager, a technician, an unknown role and an inactive waste reporter - before anything is read', async () => {
  state.files.set(pathOf('jpg'), JPEG);
  assert.equal((await call({ path: pathOf('jpg') }, false)).status, 403);
  for (const role of ['manager', 'technician', 'viewer']) {
    state.role = role;
    assert.equal((await call({ path: pathOf('jpg') })).status, 403, role);
  }
  state.role = 'waste_reporter';
  state.active = false;
  assert.equal((await call({ path: pathOf('jpg') })).status, 403);
  assert.deepEqual(state.serviceKeyUsedFor, [], 'the service key is never used for a refused caller');
});

test('only a file under his OWN folder, with the agreed name shape, can be named', async () => {
  for (const path of [pathOf('jpg', OTHER), `${ME}/${REPORT}/during/${FILE}.jpg`, `${ME}/${REPORT}/before/x.jpg`, `../${pathOf('jpg')}`, pathOf('gif'), 42]) {
    assert.equal((await call({ path })).status, 400, String(path));
  }
  assert.deepEqual(state.serviceKeyUsedFor, []);
});

test('a good photo: recorded as ok with the service key (the database stamps the time); never removed', async () => {
  state.files.set(pathOf('jpg'), JPEG);
  const res = await call({ path: pathOf('jpg') });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, durationSeconds: null, sizeBytes: JPEG.length });
  assert.equal(state.checks.length, 1);
  assert.deepEqual(state.checks[0], { storage_path: pathOf('jpg'), owner_user_id: ME, kind: 'photo', detected_mime: 'image/jpeg', size_bytes: JPEG.length, duration_seconds: null, ok: true, reason: null });
  assert.equal('checked_at' in state.checks[0], false);
  assert.deepEqual(state.removed, []);
});

test('a 45 s video passes with its real length, read with a few small Range reads (not the whole file)', async () => {
  const file = mp4(45);
  state.files.set(pathOf('mp4'), file);
  const body = await (await call({ path: pathOf('mp4') })).json();
  assert.deepEqual(body, { ok: true, durationSeconds: 45, sizeBytes: file.length });
  assert.ok(state.bytesServed < file.length, `${state.bytesServed} of ${file.length} bytes read`);
});

test('a 75 s video is rejected with its length, recorded as not ok, and the stored file is removed', async () => {
  state.files.set(pathOf('mov'), mp4(75));
  const body = await (await call({ path: pathOf('mov') })).json();
  assert.equal(body.ok, false);
  assert.match(body.reason, /75\.0 seconds long\. The limit is 60 seconds/);
  assert.equal(state.checks[0].ok, false);
  assert.equal(state.checks[0].duration_seconds, 75);
  assert.deepEqual(state.removed, [pathOf('mov')]);
});

test('a photo that is really a video is rejected and removed', async () => {
  state.files.set(pathOf('jpg'), mp4(5));
  const body = await (await call({ path: pathOf('jpg') })).json();
  assert.equal(body.ok, false);
  assert.deepEqual(state.removed, [pathOf('jpg')]);
});

test('a file not in storage yet -> 409 (upload again); a failed record -> 503 (try later); neither records a result', async () => {
  assert.equal((await call({ path: pathOf('jpg') })).status, 409);
  state.files.set(pathOf('jpg'), JPEG);
  state.upsertFails = true;
  assert.equal((await call({ path: pathOf('jpg') })).status, 503);
  assert.equal(state.checks.length, 0);
});

// ---- C2: files of SENT reports are never checked, changed or removed --------------------------------------------------------------
test('a file in a SENT report’s folder: refused (423) before anything is read, signed, recorded or removed - even if it would fail', async () => {
  state.files.set(pathOf('mov'), mp4(75)); // would be rejected by the length rule
  state.sentReports.add(REPORT);
  const res = await call({ path: pathOf('mov') });
  assert.equal(res.status, 423);
  assert.match((await res.json()).error, /already been sent/);
  assert.equal(state.rangeReads, 0, 'not read');
  assert.ok(!state.serviceKeyUsedFor.some((x) => x.includes('/object/sign/')), 'not signed');
  assert.equal(state.checks.length, 0, 'no check recorded');
  assert.deepEqual(state.removed, [], 'never removed');
  assert.ok(state.files.has(pathOf('mov')));
});

test('a file a sent report USES (as its file or poster): refused (423), never removed', async () => {
  state.files.set(pathOf('jpg'), mp4(5)); // a "photo" that would fail the type check
  state.usedPaths.add(pathOf('jpg'));
  const res = await call({ path: pathOf('jpg') });
  assert.equal(res.status, 423);
  assert.deepEqual(state.removed, []);
  assert.equal(state.checks.length, 0);
});

test('a file that joins a sent report between the check and the clean-up is NOT removed (asked again right before removing)', async () => {
  state.files.set(pathOf('mov'), mp4(75));
  // lookups 1-2 happen before the check (file, poster column); from the 3rd on (the re-check before removal) the file is in use.
  state.onMediaLookup = (n) => {
    if (n >= 3) state.usedPaths.add(pathOf('mov'));
  };
  const body = await (await call({ path: pathOf('mov') })).json();
  assert.equal(body.ok, false, 'still reported as rejected');
  assert.deepEqual(state.removed, [], 'but never removed');
  assert.ok(state.mediaLookups >= 3, 'asked again before removing');
});

test('if the database cannot say whether the report was sent, nothing is read or removed (503)', async () => {
  state.files.set(pathOf('mov'), mp4(75));
  state.lookupFails = true;
  assert.equal((await call({ path: pathOf('mov') })).status, 503);
  assert.equal(state.rangeReads, 0);
  assert.deepEqual(state.removed, []);
});

test('a rejected file of an UNSENT draft is still cleaned up (unchanged behaviour)', async () => {
  state.files.set(pathOf('mp4'), mp4(61));
  const body = await (await call({ path: pathOf('mp4') })).json();
  assert.equal(body.ok, false);
  assert.deepEqual(state.removed, [pathOf('mp4')]);
});

test('the deployed rules: sent-report guard sits before signing and before removal, and asks the database (service role)', () => {
  const src = readFileSync(join(process.cwd(), 'supabase/functions/waste-media-check/index.ts'), 'utf8');
  const guard = src.indexOf('if (await belongsToSentReport(service, path)) return json({ error: SENT }, 423);');
  assert.ok(guard > 0 && guard < src.indexOf('createSignedUrl(path, 60)'));
  assert.ok(src.indexOf('removable = !(await belongsToSentReport(service, path));') < src.indexOf(".remove([path])"));
  assert.match(src, /from\('waste_reports'\)\.select\('id'\)\.eq\('id', reportId\)/);
  assert.match(src, /for \(const column of \['storage_path', 'thumbnail_path'\]\)/);
});
