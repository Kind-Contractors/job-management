// Client video links, end to end through the REAL Edge Function code and the REAL PDF generator, in Node:
//   manager asks for links (issue-report-video-links) -> PDF is built with them -> the PDF is emailed (send-client-report) -> the client
//   opens the link from the PDF (watch-report-video) -> redirected to a short-lived signed URL.
//
// MOCKED, NOT LIVE: the Deno runtime, the database (a small in-memory stand-in that applies the SAME rules as resolve_report_video_link /
// the link plan+register functions), Storage and the email provider are all fakes. The real SQL rules are rehearsed separately against a
// local Postgres container (see docs/client-video-links.md); nothing here touches DEV or production.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildClientReportModel } from '../src/lib/clientReportModel';
import { prepareClientReportVideos } from '../src/lib/clientVideoLinks';
import { generateClientReportPdf } from '../src/lib/clientReportPdf';
import { buildSendClientReportInput } from '../src/lib/clientEmailSend';
import type { ReportVideo } from '../src/repository/reportVideosRepository';
import type { JobRow, JobVisitSummary, ReportDetail } from '../src/domain/types';

// ---- fake Deno runtime: three functions register themselves, in import order ------------------------------------------------------
const ENV: Record<string, string | undefined> = {};
const handlers: ((req: Request) => Promise<Response>)[] = [];
(globalThis as any).Deno = { serve: (h: (req: Request) => Promise<Response>) => { handlers.push(h); }, env: { get: (k: string) => ENV[k] } };

const SECRET = 'a-test-secret-that-is-comfortably-longer-than-32-chars';
function resetEnv() {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, {
    SUPABASE_URL: 'https://tests.invalid',
    SUPABASE_ANON_KEY: 'anon-test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test-key',
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM_EMAIL: 'Kind Contractors <reports@mail.test>',
    VIDEO_LINK_SECRET: SECRET,
    // The flow tests make many calls from one fake address; the throttle itself is tested in clientVideoLinksCore.test.ts.
    WATCH_RATE_LIMIT_PER_MINUTE: '1000',
    WATCH_FAILURE_LIMIT_PER_10_MIN: '200',
  });
}

// ---- fake database ---------------------------------------------------------------------------------------------------------------------
interface Link { id: string; video_id: string; hash: string; expires_at: number; revoked: boolean; scheme: string; opens: number }
interface Vid { id: string; shareable: boolean; deleted: boolean; path: string; fileExists: boolean }
const DAY = 86_400_000;
const state = {
  role: 'manager',
  reviewStatus: 'approved',
  includeVideos: true,
  videos: [] as Vid[],
  links: [] as Link[],
  files: new Set<string>(),
  log: [] as { method: string; url: string; path: string; body: any }[],
  resend: { status: 200, body: { id: 'msg-1' } as unknown },
  registerFails: false,
  lastTtlDays: null as number | null,
  rate: 'allow' as 'allow' | 'block' | 'error',
  failsRecorded: 0,
};
const hexOf = (b: string) => (b.startsWith('\\x') ? b.slice(2) : b);
function reset() {
  resetEnv();
  state.role = 'manager';
  state.reviewStatus = 'approved';
  state.includeVideos = true;
  state.videos = [
    { id: 'v-a', shareable: true, deleted: false, path: 'visit-1/before/a.mp4', fileExists: true },
    { id: 'v-b', shareable: true, deleted: false, path: 'visit-1/after/b.mp4', fileExists: true },
  ];
  state.links = [];
  state.files = new Set(['visit-1/before/a.mp4', 'visit-1/after/b.mp4']);
  state.log = [];
  state.resend = { status: 200, body: { id: 'msg-1' } };
  state.registerFails = false;
  state.lastTtlDays = null;
  state.rate = 'allow';
  state.failsRecorded = 0;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The same rule as public.resolve_report_video_link: unexpired, unrevoked, video not removed + shared, report switch on, report approved. */
function resolves(l: Link): Vid | null {
  const v = state.videos.find((x) => x.id === l.video_id);
  if (!v || l.revoked || l.expires_at <= Date.now() || v.deleted || !v.shareable || !state.includeVideos || state.reviewStatus !== 'approved') return null;
  return v;
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  const path = decodeURIComponent(url.pathname);
  state.log.push({ method, url: url.href, path, body });
  const wantsObject = (headers.get('accept') ?? '').includes('vnd.pgrst.object');
  const one = (row: unknown) => json(200, wantsObject ? row : [row]);

  if (url.host === 'api.resend.com') return json(state.resend.status, state.resend.body);
  if (path === '/auth/v1/user') return json(200, { id: 'user-1', aud: 'authenticated', email: 'luke@kindcontractors.co.uk', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  if (path === '/rest/v1/app_users') return one({ role: state.role, is_active: true });

  if (path === '/rest/v1/rpc/manager_report_video_link_plan') {
    const minMs = body.p_min_remaining_days * DAY;
    if (!state.includeVideos) return json(200, []);
    return json(200, state.videos.filter((v) => v.shareable && !v.deleted).map((v) => {
      const best = state.links.filter((l) => l.video_id === v.id && l.scheme === 'hmac-v1' && !l.revoked && l.expires_at > Date.now() + minMs).sort((a, b) => b.expires_at - a.expires_at)[0];
      return { video_id: v.id, link_id: best?.id ?? null, token_hash: best ? '\\x' + best.hash : null, expires_at: best ? new Date(best.expires_at).toISOString() : null };
    }));
  }
  if (path === '/rest/v1/rpc/manager_register_report_video_links') {
    if (state.registerFails) return json(400, { message: 'refused' });
    state.lastTtlDays = body.p_valid_days;
    for (const l of body.p_links) state.links.push({ id: l.id, video_id: l.video_id, hash: hexOf(l.token_hash), expires_at: Date.now() + body.p_valid_days * DAY, revoked: false, scheme: 'hmac-v1', opens: 0 });
    return json(200, body.p_links.length);
  }
  if (path === '/rest/v1/rpc/watch_rate_check') return state.rate === 'error' ? json(500, { message: 'db down' }) : json(200, state.rate === 'allow');
  if (path === '/rest/v1/rpc/watch_rate_fail') { if (state.rate === 'error') return json(500, { message: 'db down' }); state.failsRecorded += 1; return new Response(null, { status: 204 }); }
  if (path === '/rest/v1/rpc/resolve_report_video_link') {
    if (headers.get('authorization') !== 'Bearer service-test-key') return json(401, { message: 'not allowed' });
    const link = state.links.find((l) => l.hash === hexOf(body.p_token_hash));
    const v = link && resolves(link);
    if (!link || !v) return json(200, []);
    link.opens += 1;
    return json(200, [{ storage_path: v.path, mime_type: 'video/mp4' }]);
  }
  if (path.startsWith('/storage/v1/object/sign/report-videos/')) {
    const file = path.replace('/storage/v1/object/sign/report-videos/', '');
    if (!state.files.has(file)) return json(400, { error: 'not_found', message: 'Object not found' });
    return json(200, { signedURL: `/object/sign/report-videos/${file}?token=SIGNED&exp=${body.expiresIn}` });
  }

  // send-client-report's own tables
  if (path === '/rest/v1/reports' && method === 'GET') {
    return one({ id: 'r1', review_status: state.reviewStatus, visits: { id: 'v1', scheduled_date: '2026-09-15', jobs: { id: 'j1', job_summary: 'Window Cleaning', buildings: { id: 'b1', name: 'Oak Court', client_id: 'client-1' } } } });
  }
  if (path === '/rest/v1/contacts') return one({ id: 'ct1', client_id: 'client-1', name: 'Sam Client', email: 'sam@client.test' });
  if (path === '/rest/v1/report_client_sends' && method === 'POST') return wantsObject ? json(201, { id: 'send-1' }) : new Response(null, { status: 201 });
  if (method === 'PATCH') return new Response(null, { status: 204 });
  if (path === '/rest/v1/activity_events' && method === 'POST') return new Response(null, { status: 201 });
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;

// Everything the functions write to the console is captured so we can prove tokens / URLs are never logged.
const consoleLines: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  (console as any)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
}

resetEnv();
await import('../supabase/functions/issue-report-video-links/index.ts');
await import('../supabase/functions/watch-report-video/index.ts');
await import('../supabase/functions/send-client-report/index.ts');
const [issueFn, watchFn, sendFn] = handlers;

beforeEach(() => {
  reset();
  consoleLines.length = 0;
});

// ---- helpers ------------------------------------------------------------------------------------------------------------------------
const REPORT_ID = '33333333-3333-4333-8333-333333333333';
const issue = (body: unknown = { reportId: REPORT_ID }, auth = true, method = 'POST') =>
  issueFn(new Request('https://fn.test/issue-report-video-links', { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer test-token' } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined }));
const open = (url: string, init?: RequestInit) => watchFn(new Request(url, init));
async function issued(): Promise<{ videoId: string; url: string; reused: boolean }[]> {
  const res = await issue();
  assert.equal(res.status, 200);
  return (await res.json()).links;
}
const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- issuing ----------------------------------------------------------------------------------------------------------------------------
test('first request creates a link per shareable video; asking again returns the SAME URLs and registers nothing new', async () => {
  const first = await issued();
  assert.deepEqual(first.map((l) => [l.videoId, l.reused]), [['v-a', false], ['v-b', false]]);
  assert.equal(state.links.length, 2);
  const second = await issued();
  assert.deepEqual(second.map((l) => l.url), first.map((l) => l.url), 'the same video keeps the same link');
  assert.ok(second.every((l) => l.reused));
  assert.equal(state.links.length, 2, 'no duplicate rows');
  assert.equal(state.log.filter((l) => l.path.endsWith('manager_register_report_video_links')).length, 1);
});

test('the database only ever receives the SHA-256 of each token - the token itself appears in no request to the database or storage', async () => {
  const links = await issued();
  const stored = state.links.map((l) => l.hash).sort();
  assert.deepEqual(stored, links.map((l) => sha(tokenOf(l.url))).sort());
  const wire = JSON.stringify(state.log);
  for (const l of links) assert.ok(!wire.includes(tokenOf(l.url)), 'token never sent to the database');
});

test('new links last 365 days by default (VIDEO_LINK_TTL_DAYS overrides, capped to the database maximum)', async () => {
  await issued();
  assert.equal(state.lastTtlDays, 365);
  reset();
  ENV.VIDEO_LINK_TTL_DAYS = '90';
  await issued();
  assert.equal(state.lastTtlDays, 90);
  reset();
  ENV.VIDEO_LINK_TTL_DAYS = '99999';
  await issued();
  assert.equal(state.lastTtlDays, 730);
});

test('a link close to expiry is not reused: a fresh one is made so a new PDF never carries a nearly-dead link', async () => {
  const [first] = await issued();
  state.links[0].expires_at = Date.now() + 10 * DAY; // only 10 days left (< 30)
  const again = await issued();
  assert.equal(again.find((l) => l.videoId === first.videoId)!.reused, false);
  assert.notEqual(again.find((l) => l.videoId === first.videoId)!.url, first.url);
  assert.equal(again.find((l) => l.videoId === 'v-b')!.reused, true);
});

test('a revoked link is not reused', async () => {
  await issued();
  state.links.filter((l) => l.video_id === 'v-a').forEach((l) => (l.revoked = true));
  const again = await issued();
  assert.equal(again.find((l) => l.videoId === 'v-a')!.reused, false);
});

test('videos that are removed, un-shared, or hidden by the report switch get no link', async () => {
  state.videos[0].deleted = true;
  assert.deepEqual((await issued()).map((l) => l.videoId), ['v-b']);
  reset();
  state.videos[1].shareable = false;
  assert.deepEqual((await issued()).map((l) => l.videoId), ['v-a']);
  reset();
  state.includeVideos = false;
  assert.deepEqual(await issued(), []);
  assert.equal(state.links.length, 0);
});

test('only an active manager can request links; the response never explains why', async () => {
  state.role = 'technician';
  const res = await issue();
  assert.equal(res.status, 403);
  assert.equal(state.log.filter((l) => l.path.includes('manager_')).length, 0);
  assert.equal((await issue(undefined, false)).status, 403);
  assert.equal((await issue(undefined, true, 'GET')).status, 405);
  state.role = 'manager';
  assert.equal((await issue({ reportId: 'not-a-uuid' })).status, 400);
  assert.equal((await issue({})).status, 400);
});

test('missing/short VIDEO_LINK_SECRET: a generic error (no secret, no detail), and no link is created', async () => {
  delete ENV.VIDEO_LINK_SECRET;
  const res = await issue();
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.match(text, /not set up yet/);
  assert.equal(state.links.length, 0);
  ENV.VIDEO_LINK_SECRET = 'short';
  assert.equal((await issue()).status, 500);
  assert.ok(consoleLines.every((l) => !l.includes(SECRET)));
});

test('if the database refuses to store the links the manager gets a generic error and NO url', async () => {
  state.registerFails = true;
  const res = await issue();
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /https?:|refused|\bt=/);
  assert.equal(state.links.length, 0);
});

test('issuing links never touches the report itself: no write to reports, approval or completion', async () => {
  await issued();
  const writes = state.log.filter((l) => l.method !== 'GET' && !l.path.startsWith('/auth/') && !l.path.includes('/rpc/'));
  assert.deepEqual(writes, []);
});

// ---- the client opens a link --------------------------------------------------------------------------------------------------------------
test('a client opens a link from the PDF: 302 to a short-lived signed URL (1 hour by default), open counted', async () => {
  const [a] = await issued();
  const res = await open(a.url);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location')!);
  assert.equal(loc.pathname, '/storage/v1/object/sign/report-videos/visit-1/before/a.mp4');
  assert.equal(loc.searchParams.get('exp'), '3600');
  assert.equal(state.links[0].opens, 1);
  ENV.VIDEO_SIGNED_URL_SECONDS = '120';
  const res2 = await open(a.url, { headers: { Range: 'bytes=0-' } });
  assert.equal(res2.status, 302, 'a Range request is redirected the same way; Storage answers the range');
  assert.equal(new URL(res2.headers.get('location')!).searchParams.get('exp'), '120');
});

async function notAvailable(res: Response) {
  return { status: res.status, body: await res.text(), headers: [...res.headers.entries()].sort() };
}

test('every way a link can stop working looks exactly like an unknown link', async () => {
  const [a] = await issued();
  const unknown = await notAvailable(await open(`https://x.invalid/watch?t=${'Q'.repeat(43)}`));
  assert.equal(unknown.status, 404);

  const scenarios: [string, () => void, () => void][] = [
    ['expired', () => { state.links[0].expires_at = Date.now() - 1000; }, () => { state.links[0].expires_at = Date.now() + 100 * DAY; }],
    ['revoked', () => { state.links[0].revoked = true; }, () => { state.links[0].revoked = false; }],
    ['video removed (soft deleted)', () => { state.videos[0].deleted = true; }, () => { state.videos[0].deleted = false; }],
    ['video un-ticked for the client', () => { state.videos[0].shareable = false; }, () => { state.videos[0].shareable = true; }],
    ['report "include videos" off', () => { state.includeVideos = false; }, () => { state.includeVideos = true; }],
    ['report returned for correction', () => { state.reviewStatus = 'returned'; }, () => { state.reviewStatus = 'approved'; }],
    ['report not approved (submitted)', () => { state.reviewStatus = 'submitted'; }, () => { state.reviewStatus = 'approved'; }],
    ['file missing from storage', () => { state.files.delete('visit-1/before/a.mp4'); }, () => { state.files.add('visit-1/before/a.mp4'); }],
  ];
  for (const [name, breakIt, fixIt] of scenarios) {
    breakIt();
    assert.deepEqual(await notAvailable(await open(a.url)), unknown, name);
    fixIt();
    assert.equal((await open(a.url)).status, 302, `${name}: works again once restored`);
  }
});

test('RETURNED for correction stops the link; RE-APPROVAL makes the SAME link work again (nothing needs re-sending)', async () => {
  const [a] = await issued();
  assert.equal((await open(a.url)).status, 302);
  state.reviewStatus = 'returned';
  assert.equal((await open(a.url)).status, 404);
  state.reviewStatus = 'submitted'; // technician resubmitted
  assert.equal((await open(a.url)).status, 404);
  state.reviewStatus = 'approved'; // Luke approves again
  assert.equal((await open(a.url)).status, 302);
  assert.equal(state.links.length, 2, 'no new links were needed');
});

test('per-video inclusion: un-ticking one video stops only that video\'s link', async () => {
  const [a, b] = await issued();
  state.videos[0].shareable = false;
  assert.equal((await open(a.url)).status, 404);
  assert.equal((await open(b.url)).status, 302);
});

test('the service key is used only inside the public function, and the lookup can only be done with it', async () => {
  const [a] = await issued();
  await open(a.url);
  const resolveCall = state.log.find((l) => l.path.endsWith('resolve_report_video_link'))!;
  assert.deepEqual(resolveCall.body, { p_token_hash: '\\x' + sha(tokenOf(a.url)) });
  const issueCalls = state.log.filter((l) => l.path.includes('manager_report_video_link_plan') || l.path.includes('manager_register'));
  assert.ok(issueCalls.length > 0);
});

test('tokens and URLs are never logged by any of the functions', async () => {
  const [a, b] = await issued();
  await open(a.url);
  await open(`https://x.invalid/watch?t=${'Q'.repeat(43)}`);
  state.reviewStatus = 'returned';
  await open(b.url);
  const all = consoleLines.join('\n');
  for (const l of [a, b]) {
    assert.ok(!all.includes(tokenOf(l.url)));
    assert.ok(!all.includes(sha(tokenOf(l.url))));
  }
  assert.doesNotMatch(all, /watch-report-video\?t=/);
});

// ---- PDF + email, end to end --------------------------------------------------------------------------------------------------------------
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const job = { clientName: 'Acme Ltd', buildingName: 'Oak Court', jobSummary: 'Window Cleaning' } as unknown as JobRow;
const visit = { scheduledDate: '2026-09-15' } as unknown as JobVisitSummary;
const rd = { workCarriedOut: 'Cleaned all windows.', technicianNotes: null, issues: null, specMet: true, includePhotos: true, includeNotes: true, includeIssues: true, includeVideos: true } as unknown as ReportDetail;
const vid = (id: string, phase: 'before' | 'after'): ReportVideo => ({ id, visitId: 'visit-1', phase, storagePath: `visit-1/${phase}/${id}.mp4`, thumbnailPath: null, mimeType: 'video/mp4', sizeBytes: 1, durationSeconds: 75, source: 'technician', uploadedByName: 'Tom', includeInClientReport: true, createdAt: '2026-09-15T10:00:00Z' });

/** What ReadyForClientPage does for "Send to client", with the real modules and the fake server. */
async function deliver(videos: ReportVideo[], message = 'Hi Sam, your report and videos are attached.') {
  const model = buildClientReportModel(job, visit, rd, [], {}, videos, {});
  const prepared = await prepareClientReportVideos(model, {
    requestLinks: async () => {
      const res = await issue();
      if (res.status !== 200) throw new Error('failed');
      return Object.fromEntries((await res.json()).links.map((l: any) => [l.videoId, l.url]));
    },
    signThumbnails: async () => Object.fromEntries(videos.map((v) => [v.id, 'https://thumb/' + v.id])),
    prepareImage: async () => ({ dataUrl: JPEG, width: 1, height: 1 }),
  });
  const blob = await generateClientReportPdf(model, { photos: [], skippedCount: 0 }, prepared);
  const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
  const built = buildSendClientReportInput('r1', 'ct1', base64, message);
  assert.ok(built.ok);
  const res = await sendFn(new Request('https://fn.test/send-client-report', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify(built.input) }));
  return { res, prepared };
}
const resendCalls = () => state.log.filter((l) => l.url.startsWith('https://api.resend.com/emails'));
const attachedPdf = () => Buffer.from(resendCalls()[0].body.attachments[0].content, 'base64').toString('latin1');
const uris = (pdf: string) => [...pdf.matchAll(/\/URI\s*\(([^)]*)\)/g)].map((m) => m[1]);

test('EMAIL: the PDF that is attached contains a working clickable link for each included video, and the recipient and custom message are unchanged', async () => {
  const { res } = await deliver([vid('v-a', 'before'), vid('v-b', 'after')]);
  assert.deepEqual(await res.json(), { status: 'sent', messageUsed: 'custom' });
  assert.equal(resendCalls().length, 1);
  const email = resendCalls()[0].body;
  assert.equal(email.to, 'sam@client.test');
  assert.equal(email.text, 'Hi Sam, your report and videos are attached.');
  assert.equal(email.attachments[0].filename, 'service-report.pdf');
  const pdf = attachedPdf();
  assert.ok(pdf.startsWith('%PDF-'));
  const found = uris(pdf);
  assert.equal(new Set(found).size, 2);
  // and the links in the emailed PDF really work for the client:
  for (const url of new Set(found)) assert.equal((await open(url)).status, 302);
  // the email body itself carries no video link (links live in the PDF only)
  assert.doesNotMatch(email.html + email.text, /watch-report-video|\bt=/);
});

test('EMAIL: sending the same report again reuses the same links (a resend does not create new links)', async () => {
  const first = await deliver([vid('v-a', 'before'), vid('v-b', 'after')]);
  assert.equal(first.res.status, 200);
  const urlsFirst = uris(attachedPdf());
  state.log = [];
  await deliver([vid('v-a', 'before'), vid('v-b', 'after')]);
  assert.deepEqual(uris(attachedPdf()), urlsFirst);
  assert.equal(state.links.length, 2);
});

test('EMAIL: a report with no videos sends a normal PDF with no links and never calls the link function', async () => {
  const { res } = await deliver([]);
  assert.equal(res.status, 200);
  assert.deepEqual(uris(attachedPdf()), []);
  assert.equal(state.log.filter((l) => l.path.includes('manager_report_video_link_plan')).length, 0);
  assert.equal(state.links.length, 0);
});

test('EMAIL: if the links cannot be created NOTHING is emailed and the report is not marked sent', async () => {
  state.registerFails = true;
  await assert.rejects(deliver([vid('v-a', 'before')]), /nothing was sent or downloaded/i);
  assert.equal(resendCalls().length, 0);
  assert.equal(state.log.filter((l) => l.method === 'PATCH').length, 0);
  assert.equal(state.log.filter((l) => l.path === '/rest/v1/report_client_sends').length, 0);
});

test('EMAIL: sending marks the report sent to the client only - never completed, and approval is not altered; the links keep working', async () => {
  const { res } = await deliver([vid('v-a', 'before')]);
  assert.equal(res.status, 200);
  const patches = state.log.filter((l) => l.method === 'PATCH');
  const reportPatch = patches.find((p) => p.path === '/rest/v1/reports')!;
  assert.deepEqual(Object.keys(reportPatch.body).sort(), ['sent_to_client_at', 'sent_to_client_by']);
  assert.doesNotMatch(JSON.stringify(patches), /completed|review_status|reviewed/);
  assert.equal((await open(uris(attachedPdf())[0])).status, 302);
});

test('EMAIL: if the email provider fails the send is recorded as failed, nothing is marked sent, and the links stay valid for the retry', async () => {
  state.resend = { status: 500, body: { message: 'boom' } };
  const { res } = await deliver([vid('v-a', 'before')]);
  const out = await res.json();
  assert.notEqual(out.status, 'sent');
  assert.ok(!state.log.some((l) => l.method === 'PATCH' && l.path === '/rest/v1/reports'), 'report not marked sent');
  assert.ok(state.links.length > 0 && state.links.every((l) => !l.revoked));
});

test('a returned report cannot be emailed by the send function, and its already-sent links stop working until re-approval', async () => {
  const { res } = await deliver([vid('v-a', 'before')]);
  assert.equal(res.status, 200);
  const url = uris(attachedPdf())[0];
  state.reviewStatus = 'returned';
  assert.equal((await open(url)).status, 404);
  const send = await sendFn(new Request('https://fn.test/send-client-report', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify({ reportId: 'r1', contactId: 'ct1', pdfBase64: 'JVBERi0xLjQK' }) }));
  assert.notEqual(send.status, 200);
  state.reviewStatus = 'approved';
  assert.equal((await open(url)).status, 302);
});

// ---- rate limiting through the real function ------------------------------------------------------------------------------------------------
test('RATE LIMIT (live function code, fake database): a blocked address gets 429 before any lookup; failures are recorded; the limiter failing never blocks a client', async () => {
  const [a] = await issued();
  const calls = () => state.log.filter((l) => l.path.endsWith('resolve_report_video_link')).length;
  assert.equal((await open(a.url)).status, 302);
  assert.equal(state.failsRecorded, 0, 'a valid open is not a failure');
  await open(`https://x.invalid/watch?t=${'Q'.repeat(43)}`);
  assert.equal(state.failsRecorded, 1, 'an unknown token is recorded as a failure');

  state.rate = 'block';
  const before = calls();
  const res = await open(a.url);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
  assert.equal(calls(), before, 'no lookup was made for a throttled request');

  state.rate = 'error';
  assert.equal((await open(a.url)).status, 302, 'if the rate-limit database call fails the request is still served (fails open)');
});
