// Waste-report video links, through the REAL Edge Function code in Node (issue-waste-video-links + public watch-waste-video):
// manager-only issuing, one reusable link per video, a public redirect to a short-lived URL in the waste bucket, uniform 404s, and full
// isolation from the job-report links (own secret + token prefix, own resolve function, own bucket, own throttle keys).
// MOCKED, NOT LIVE: Deno, the database and Storage are fakes that apply the same rules as the SQL; the live DEV run covers the real thing.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveToken } from '../supabase/functions/_shared/videoLinks';
import { deriveWasteToken } from '../supabase/functions/_shared/wasteVideoLinks';

const SECRET = 'a-waste-test-secret-that-is-longer-than-32-characters';
const ENV: Record<string, string | undefined> = {};
const handlers: ((req: Request) => Promise<Response>)[] = [];
(globalThis as any).Deno = { serve: (h: (req: Request) => Promise<Response>) => handlers.push(h), env: { get: (k: string) => ENV[k] } };

const REPORT = '22222222-2222-4222-8222-222222222222';
const DAY = 86_400_000;
interface Link { id: string; media_id: string; hash: string; expires_at: number; revoked: boolean; opens: number }
const state = {
  role: 'manager',
  videos: [] as { id: string; path: string }[],
  links: [] as Link[],
  archived: false,
  log: [] as { method: string; path: string; body: any; auth: string | null }[],
  rateKeys: [] as string[],
};
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const hexOf = (b: string) => (b.startsWith('\\x') ? b.slice(2) : b);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const path = decodeURIComponent(url.pathname);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  state.log.push({ method, path, body, auth: headers.get('authorization') });
  if (path === '/auth/v1/user') return json(200, { id: 'm1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: 'x' });
  if (path === '/rest/v1/app_users') {
    const row = { role: state.role, is_active: true };
    return json(200, (headers.get('accept') ?? '').includes('vnd.pgrst.object') ? row : [row]);
  }
  if (path === '/rest/v1/rpc/manager_waste_video_link_plan') {
    return json(200, state.videos.map((v) => {
      const best = state.links.filter((l) => l.media_id === v.id && !l.revoked && l.expires_at > Date.now() + body.p_min_remaining_days * DAY).sort((a, b) => b.expires_at - a.expires_at)[0];
      return { video_id: v.id, link_id: best?.id ?? null, token_hash: best ? '\\x' + best.hash : null, expires_at: null };
    }));
  }
  if (path === '/rest/v1/rpc/manager_register_waste_video_links') {
    for (const l of body.p_links) state.links.push({ id: l.id, media_id: l.video_id, hash: l.token_hash, expires_at: Date.now() + body.p_valid_days * DAY, revoked: false, opens: 0 });
    return json(200, body.p_links.length);
  }
  if (path === '/rest/v1/rpc/resolve_waste_video_link') {
    if (headers.get('authorization') !== 'Bearer service-key') return json(401, { message: 'service only' });
    // The same rule as the SQL: not revoked, not expired - archiving the report does NOT matter.
    const link = state.links.find((l) => l.hash === hexOf(body.p_token_hash) && !l.revoked && l.expires_at > Date.now());
    if (!link) return json(200, []);
    link.opens += 1;
    const v = state.videos.find((x) => x.id === link.media_id)!;
    return json(200, [{ storage_path: v.path, mime_type: 'video/mp4' }]);
  }
  if (path === '/rest/v1/rpc/watch_rate_check') {
    state.rateKeys.push(body.p_key);
    return json(200, true);
  }
  if (path === '/rest/v1/rpc/watch_rate_fail') {
    state.rateKeys.push(body.p_key);
    return new Response(null, { status: 204 });
  }
  if (path.startsWith('/storage/v1/object/sign/waste-report-media/')) {
    return json(200, { signedURL: `/object/sign/waste-report-media/${path.replace('/storage/v1/object/sign/waste-report-media/', '')}?token=SIGNED&exp=${body.expiresIn}` });
  }
  return json(404, { message: `unexpected ${method} ${path}` });
}) as typeof fetch;

Object.assign(ENV, { SUPABASE_URL: 'https://tests.invalid', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-key', WASTE_VIDEO_LINK_SECRET: SECRET });
await import('../supabase/functions/issue-waste-video-links/index.ts');
await import('../supabase/functions/watch-waste-video/index.ts');
const [issue, watch] = handlers;

beforeEach(() => {
  Object.assign(state, { role: 'manager', videos: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', path: 'u/r/before/v1.mp4' }, { id: 'aaaaaaaa-0000-4000-8000-000000000002', path: 'u/r/after/v2.mov' }], links: [], archived: false, log: [], rateKeys: [] });
  ENV.WASTE_VIDEO_LINK_SECRET = SECRET;
});

const ask = () => issue(new Request('https://fn.test/issue-waste-video-links', { method: 'POST', headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' }, body: JSON.stringify({ reportId: REPORT }) }));
const open = (url: string, ip = '203.0.113.9') => watch(new Request(url, { headers: { 'cf-connecting-ip': ip } }));

test('only a manager can issue links (a waste reporter or technician gets 403)', async () => {
  for (const role of ['waste_reporter', 'technician']) {
    state.role = role;
    assert.equal((await ask()).status, 403, role);
  }
  assert.equal(state.links.length, 0);
});

test('one link per video, stored as a hash only; asking again reuses the same URLs', async () => {
  const first = (await (await ask()).json()).links;
  assert.equal(first.length, 2);
  assert.ok(first.every((l: any) => l.reused === false && l.url.startsWith('https://tests.invalid/functions/v1/watch-waste-video?t=')));
  assert.equal(state.links.length, 2);
  const token = new URL(first[0].url).searchParams.get('t')!;
  assert.equal(state.links[0].hash, sha(token), 'only sha256(token) is stored');
  assert.ok(!JSON.stringify(state.log.filter((l) => l.path.includes('register'))).includes(token), 'the token itself never reaches the database');
  const again = (await (await ask()).json()).links;
  assert.deepEqual(again.map((l: any) => l.url), first.map((l: any) => l.url));
  assert.ok(again.every((l: any) => l.reused));
  assert.equal(state.links.length, 2);
});

test('a missing secret: a clear "not set up" error and no link created', async () => {
  ENV.WASTE_VIDEO_LINK_SECRET = undefined;
  const res = await ask();
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not set up/);
  assert.equal(state.links.length, 0);
});

test('the public link redirects to a short-lived URL for the file in the WASTE bucket - no login - and counts the open', async () => {
  const [l] = (await (await ask()).json()).links;
  const res = await open(l.url);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location')!);
  assert.equal(loc.pathname, '/storage/v1/object/sign/waste-report-media/u/r/before/v1.mp4');
  assert.equal(state.links[0].opens, 1);
  const resolveCall = state.log.find((x) => x.path === '/rest/v1/rpc/resolve_waste_video_link')!;
  assert.equal(resolveCall.auth, 'Bearer service-key');
  assert.ok(!state.log.some((x) => x.path.includes('resolve_report_video_link') || x.path.includes('report-videos')), 'never the job-report resolver or bucket');
});

test('an archived report’s links keep working', async () => {
  const [l] = (await (await ask()).json()).links;
  state.archived = true;
  assert.equal((await open(l.url)).status, 302);
});

test('bad, unknown, revoked or expired tokens all get the same 404', async () => {
  const [l] = (await (await ask()).json()).links;
  const base = 'https://tests.invalid/functions/v1/watch-waste-video';
  assert.equal((await open(`${base}?t=short`)).status, 404);
  assert.equal((await open(`${base}?t=${'A'.repeat(43)}`)).status, 404);
  state.links[0].revoked = true;
  assert.equal((await open(l.url)).status, 404);
  state.links[0].revoked = false;
  state.links[0].expires_at = Date.now() - 1;
  assert.equal((await open(l.url)).status, 404);
});

test('isolation: a waste token is not the job-report token for the same id and secret; throttle keys are separate ("waste:")', async () => {
  const id = 'bbbbbbbb-0000-4000-8000-000000000001';
  assert.notEqual(await deriveWasteToken(SECRET, id), await deriveToken(SECRET, id));
  const [l] = (await (await ask()).json()).links;
  await open(l.url, '198.51.100.7');
  assert.ok(state.rateKeys.length > 0 && state.rateKeys.every((k) => k.startsWith('waste:')), JSON.stringify(state.rateKeys));
  assert.ok(state.rateKeys.every((k) => k.length <= 64));
  await open(l.url, 'x'.repeat(200)); // a junk address header is trimmed to the database's 64-character key limit
  assert.ok(state.rateKeys.every((k) => k.length <= 64));
});

test('the job-report link code is untouched, and the waste functions never call it', () => {
  const root = process.cwd();
  const src = (p: string) => readFileSync(join(root, p), 'utf8');
  assert.match(src('supabase/functions/_shared/videoLinks.ts'), /const TOKEN_CONTEXT = 'kc-video-link-v1:';/);
  assert.match(src('supabase/functions/_shared/wasteVideoLinks.ts'), /const WASTE_TOKEN_CONTEXT = 'kc-waste-video-link-v1:';/);
  assert.match(src('supabase/functions/issue-waste-video-links/index.ts'), /WASTE_VIDEO_LINK_SECRET/);
  assert.doesNotMatch(src('supabase/functions/issue-waste-video-links/index.ts'), /'VIDEO_LINK_SECRET'|manager_report_video_link_plan|manager_register_report_video_links/);
  assert.doesNotMatch(src('supabase/functions/watch-waste-video/index.ts'), /resolve_report_video_link|'report-videos'/);
  assert.match(src('supabase/functions/watch-report-video/index.ts'), /const BUCKET = 'report-videos';/);
});
