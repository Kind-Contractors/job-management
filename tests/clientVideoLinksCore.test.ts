// Client video links - the pure parts, run for real in Node (no network): how a token is made / hashed / re-derived, how links are
// issued and REUSED, what the public watch endpoint answers (the same thing for every failure), how the browser prepares a report's videos,
// and what the PDF contains (thumbnail, play button, "Watch video", clickable link annotations; nothing for excluded videos).
//
// MOCKED vs LIVE: everything here is mocked/in-process. The database rules (expiry, revocation, soft delete, per-video and report-level
// inclusion, approval gate, return-for-correction) are enforced by Postgres and rehearsed against a LOCAL Postgres container, not here -
// see docs/client-video-links.md. Nothing in this file has touched the DEV or production Supabase projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildWatchUrl,
  deriveToken,
  hashTokenHex,
  isWellFormedToken,
  issueLinks,
  LinkConfigError,
  normaliseHash,
  type LinkPlanRow,
  type NewLink,
} from '../supabase/functions/_shared/videoLinks';
import { handleWatchRequest, notAvailable, tooManyRequests, type WatchDeps } from '../supabase/functions/_shared/watchVideo';
import { WindowLimiter, clientKey, createDbWatchGuard, createWatchGuard, normaliseAddress } from '../supabase/functions/_shared/rateLimit';
import { buildClientReportModel, orderVideosForReport, type ClientReportModel } from '../src/lib/clientReportModel';
import { ClientVideoLinkError, NO_VIDEOS, prepareClientReportVideos, type PrepareVideosDeps } from '../src/lib/clientVideoLinks';
import { generateClientReportPdf } from '../src/lib/clientReportPdf';
import type { ReportVideo } from '../src/repository/reportVideosRepository';
import type { JobRow, JobVisitSummary, ReportDetail } from '../src/domain/types';

const SECRET = 'a-test-secret-that-is-comfortably-longer-than-32-chars';
const BASE = 'https://proj.supabase.co/functions/v1/watch-report-video';
const LINK_A = '11111111-1111-4111-8111-111111111111';

// ---- tokens ---------------------------------------------------------------------------------------------------------------------
test('a token is 43 URL-safe characters (256 bits), the same for the same secret and link, different otherwise', async () => {
  const t = await deriveToken(SECRET, LINK_A);
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await deriveToken(SECRET, LINK_A), t, 'deterministic - that is what allows a link to be re-used');
  assert.notEqual(await deriveToken(SECRET, '22222222-2222-4222-8222-222222222222'), t);
  assert.notEqual(await deriveToken(SECRET + 'x', LINK_A), t, 'a different secret gives a different token');
  assert.ok(isWellFormedToken(t));
});

test('a missing or short secret is refused (so a link is never made with a guessable key)', async () => {
  await assert.rejects(() => deriveToken('', LINK_A), LinkConfigError);
  await assert.rejects(() => deriveToken('too-short', LINK_A), LinkConfigError);
  await assert.rejects(() => deriveToken(undefined as unknown as string, LINK_A), LinkConfigError);
});

test('SHA-256 hashing matches the standard test vector and is lower-case hex', async () => {
  assert.equal(await hashTokenHex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the token itself is never equal to, or contained in, the hash that is stored', async () => {
  const t = await deriveToken(SECRET, LINK_A);
  const h = await hashTokenHex(t);
  assert.equal(h.length, 64);
  assert.ok(!h.includes(t) && h !== t);
});

test('only a well-formed token reaches a lookup: wrong length, characters, type are all refused', () => {
  for (const bad of [null, undefined, '', 'short', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '!', 'a'.repeat(42) + ' ', 'a'.repeat(42) + '=', 123, {}, ['a'.repeat(43)]]) {
    assert.equal(isWellFormedToken(bad), false, JSON.stringify(bad));
  }
  assert.equal(isWellFormedToken('a'.repeat(43)), true);
  assert.equal(isWellFormedToken('A_-' + '0'.repeat(40)), true);
});

test('PostgREST bytea ("\\x...") and bare hex both normalise; anything else is rejected', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(normaliseHash('\\x' + hex), hex);
  assert.equal(normaliseHash(hex.toUpperCase()), hex);
  assert.equal(normaliseHash('\\x' + hex.slice(2)), null);
  assert.equal(normaliseHash(null), null);
  assert.equal(normaliseHash('zz'.repeat(32)), null);
});

test('the watch URL carries only the token, as the "t" parameter', async () => {
  const t = await deriveToken(SECRET, LINK_A);
  const url = new URL(buildWatchUrl(BASE, t));
  assert.equal(url.origin + url.pathname, BASE);
  assert.equal(url.searchParams.get('t'), t);
  assert.deepEqual([...url.searchParams.keys()], ['t']);
});

// ---- issuing / reuse ---------------------------------------------------------------------------------------------------------------
function issueHarness(plan: LinkPlanRow[], opts: { secret?: string; failRegister?: boolean } = {}) {
  const registered: NewLink[][] = [];
  let n = 0;
  return {
    registered,
    run: () =>
      issueLinks({
        secret: opts.secret ?? SECRET,
        watchBaseUrl: BASE,
        plan: async () => plan,
        register: async (links) => {
          if (opts.failRegister) throw new Error('db down');
          registered.push(links);
        },
        newId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
      }),
  };
}

test('a video with no link gets a NEW one: only its hash is registered, and the URL contains the token that hashes to it', async () => {
  const h = issueHarness([{ video_id: 'v1', link_id: null, token_hash: null }]);
  const out = await h.run();
  assert.equal(out.length, 1);
  assert.equal(out[0].reused, false);
  assert.equal(h.registered.length, 1);
  const link = h.registered[0][0];
  const token = new URL(out[0].url).searchParams.get('t')!;
  assert.equal(link.token_hash, await hashTokenHex(token));
  assert.ok(!JSON.stringify(h.registered).includes(token), 'the token is never sent to the database');
});

test('a video that already has a valid link REUSES it: same URL again, nothing new registered (no duplicates)', async () => {
  const token = await deriveToken(SECRET, LINK_A);
  const plan: LinkPlanRow[] = [{ video_id: 'v1', link_id: LINK_A, token_hash: '\\x' + (await hashTokenHex(token)) }];
  const first = await issueHarness(plan).run();
  const second = await issueHarness(plan).run();
  const h = issueHarness(plan);
  const third = await h.run();
  assert.equal(first[0].reused, true);
  assert.equal(first[0].url, second[0].url);
  assert.equal(second[0].url, third[0].url);
  assert.equal(new URL(first[0].url).searchParams.get('t'), token);
  assert.equal(h.registered.length, 0, 'no register call at all when everything is reused');
});

test('mixed: reused links keep their place, new ones are created in ONE register call, order follows the plan', async () => {
  const token = await deriveToken(SECRET, LINK_A);
  const h = issueHarness([
    { video_id: 'v1', link_id: null, token_hash: null },
    { video_id: 'v2', link_id: LINK_A, token_hash: await hashTokenHex(token) },
    { video_id: 'v3', link_id: null, token_hash: null },
  ]);
  const out = await h.run();
  assert.deepEqual(out.map((o) => [o.videoId, o.reused]), [['v1', false], ['v2', true], ['v3', false]]);
  assert.equal(h.registered.length, 1);
  assert.deepEqual(h.registered[0].map((l) => l.video_id), ['v1', 'v3']);
  assert.equal(new Set(out.map((o) => o.url)).size, 3, 'every video has its own link');
});

test('if the secret was changed (or the stored link was made another way) the old link is NOT reused - a fresh one is issued', async () => {
  const oldToken = await deriveToken(SECRET + '-old', LINK_A);
  const h = issueHarness([{ video_id: 'v1', link_id: LINK_A, token_hash: await hashTokenHex(oldToken) }]);
  const out = await h.run();
  assert.equal(out[0].reused, false);
  assert.equal(h.registered[0].length, 1);
  assert.notEqual(h.registered[0][0].id, LINK_A);
  // and a link whose stored hash is missing/garbage is never trusted either
  const h2 = issueHarness([{ video_id: 'v1', link_id: LINK_A, token_hash: null }]);
  assert.equal((await h2.run())[0].reused, false);
});

test('if the database refuses to store the new links NO URL is returned (a link the database does not know is never handed out)', async () => {
  const h = issueHarness([{ video_id: 'v1', link_id: null, token_hash: null }], { failRegister: true });
  await assert.rejects(h.run, /db down/);
});

test('no shareable videos: nothing is requested or registered', async () => {
  const h = issueHarness([]);
  assert.deepEqual(await h.run(), []);
  assert.equal(h.registered.length, 0);
});

test('a bad secret stops issuing before anything is registered', async () => {
  const h = issueHarness([{ video_id: 'v1', link_id: null, token_hash: null }], { secret: 'short' });
  await assert.rejects(h.run, LinkConfigError);
  assert.equal(h.registered.length, 0);
});

// ---- the public watch endpoint ---------------------------------------------------------------------------------------------------------
const GOOD_TOKEN = 'G'.repeat(43);
function watchDeps(over: Partial<WatchDeps> = {}) {
  const calls = { resolve: [] as string[], sign: [] as [string, number][] };
  const deps: WatchDeps = {
    signedUrlSeconds: 3600,
    resolve: async (hash) => {
      calls.resolve.push(hash);
      return { storagePath: 'visit-1/before/abc.mp4', mimeType: 'video/mp4' };
    },
    sign: async (path, seconds) => {
      calls.sign.push([path, seconds]);
      return `https://proj.supabase.co/storage/v1/object/sign/report-videos/${path}?token=signed`;
    },
    ...over,
  };
  return { deps, calls };
}
const watch = (url: string, deps: WatchDeps, init?: RequestInit) => handleWatchRequest(new Request(url, init), deps);

test('a valid link answers 302 to a SHORT-LIVED signed storage URL - never a proxy, never public, with no-store/no-referrer headers', async () => {
  const { deps, calls } = watchDeps();
  const res = await watch(`${BASE}?t=${GOOD_TOKEN}`, deps);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location')!, /^https:\/\/proj\.supabase\.co\/storage\/v1\/object\/sign\/report-videos\//);
  assert.equal(res.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.body, null, 'the file is not streamed through this function');
  assert.deepEqual(calls.sign, [['visit-1/before/abc.mp4', 3600]], 'the signed URL lifetime is the configured one');
});

test('the lookup uses the token\'s SHA-256, never the token', async () => {
  const { deps, calls } = watchDeps();
  await watch(`${BASE}?t=${GOOD_TOKEN}`, deps);
  assert.deepEqual(calls.resolve, [await hashTokenHex(GOOD_TOKEN)]);
  assert.ok(!calls.resolve.join('').includes(GOOD_TOKEN));
});

test('Range requests (seeking / streaming) are served: a request with a Range header still gets the redirect, and storage answers the range', async () => {
  const { deps } = watchDeps();
  const res = await watch(`${BASE}?t=${GOOD_TOKEN}`, deps, { headers: { Range: 'bytes=1000-' } });
  assert.equal(res.status, 302, 'the redirect is the same for a Range request; the browser re-sends the Range to the signed Storage URL, which supports it');
  assert.ok(res.headers.get('location'));
});

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text(), headers: [...res.headers.entries()].sort() };
}

test('EVERY failure gives the identical response: unknown/expired/revoked/removed/not-approved link, missing file, errors, bad token, wrong method', async () => {
  const reference = await snapshot(notAvailable());
  assert.equal(reference.status, 404);
  assert.equal(reference.body, 'This video is not available.');

  const failures: [string, WatchDeps, string, RequestInit?][] = [
    ['lookup finds nothing (unknown, expired, revoked, video removed or un-shared, report not approved)', watchDeps({ resolve: async () => null }).deps, `${BASE}?t=${GOOD_TOKEN}`],
    ['lookup throws (database down)', watchDeps({ resolve: async () => { throw new Error('boom: relation report_video_links'); } }).deps, `${BASE}?t=${GOOD_TOKEN}`],
    ['file is missing from storage', watchDeps({ sign: async () => null }).deps, `${BASE}?t=${GOOD_TOKEN}`],
    ['signing throws', watchDeps({ sign: async () => { throw new Error('storage down'); } }).deps, `${BASE}?t=${GOOD_TOKEN}`],
    ['no token', watchDeps().deps, BASE],
    ['empty token', watchDeps().deps, `${BASE}?t=`],
    ['malformed token', watchDeps().deps, `${BASE}?t=not-a-token`],
    ['oversized token', watchDeps().deps, `${BASE}?t=${'x'.repeat(500)}`],
    ['POST', watchDeps().deps, `${BASE}?t=${GOOD_TOKEN}`, { method: 'POST' }],
    ['DELETE', watchDeps().deps, `${BASE}?t=${GOOD_TOKEN}`, { method: 'DELETE' }],
  ];
  for (const [name, deps, url, init] of failures) {
    assert.deepEqual(await snapshot(await watch(url, deps, init)), reference, name);
  }
});

test('a failure never reveals paths, buckets, table names or the token, and a malformed token never reaches the database', async () => {
  const { deps, calls } = watchDeps({ resolve: async () => { throw new Error('relation report_video_links violates storage_path report-videos/secret'); } });
  const res = await watch(`${BASE}?t=${GOOD_TOKEN}`, deps);
  const text = (await res.text()) + JSON.stringify([...res.headers.entries()]);
  assert.doesNotMatch(text, /report_video|storage|report-videos|secret|violates/i);
  assert.ok(!text.includes(GOOD_TOKEN));
  const bad = watchDeps();
  await watch(`${BASE}?t=short`, bad.deps);
  assert.equal(bad.calls.resolve.length, 0);
  assert.equal(calls.sign.length, 0, 'nothing is signed when the lookup failed');
});

test('the watch code never logs: it contains no console / logging calls at all', () => {
  for (const file of ['supabase/functions/_shared/watchVideo.ts', 'supabase/functions/_shared/videoLinks.ts', 'supabase/functions/watch-report-video/index.ts']) {
    const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /console\.|Deno\.stdout|Deno\.stderr/, file);
  }
});

test('the issuing function logs only a fixed message (never a token, hash or URL) and never writes to the reports table', () => {
  const src = readFileSync('supabase/functions/issue-report-video-links/index.ts', 'utf8').replace(/\/\/.*$/gm, '');
  const logs = src.match(/console\.[a-z]+\([^)]*\)/g) ?? [];
  assert.deepEqual(logs, ["console.error('VIDEO_LINK_SECRET is missing or too short.')"]);
  assert.doesNotMatch(src, /\.from\(\s*['"]reports['"]/);
  assert.doesNotMatch(src, /service_role|SERVICE_ROLE/i, 'the issuing function runs as the caller - no service key');
});

// ---- the report model: which videos can appear -----------------------------------------------------------------------------------------
function video(id: string, phase: 'before' | 'during' | 'after', over: Partial<ReportVideo> = {}): ReportVideo {
  return {
    id, visitId: 'visit-1', phase, storagePath: `visit-1/${phase}/${id}.mp4`, thumbnailPath: `visit-1/${phase}/${id}.jpg`, mimeType: 'video/mp4',
    sizeBytes: 1000, durationSeconds: 42, source: 'technician', uploadedByName: 'Tom', includeInClientReport: true,
    createdAt: `2026-09-15T10:0${id.length}:00Z`, ...over,
  };
}
const job = { clientName: 'Acme Ltd', buildingName: 'Oak Court', jobSummary: 'Window Cleaning' } as unknown as JobRow;
const visit = { scheduledDate: '2026-09-15' } as unknown as JobVisitSummary;
function report(over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    workCarriedOut: 'Cleaned all windows.', technicianNotes: 'Notes', issues: null, specMet: true,
    includePhotos: true, includeNotes: true, includeIssues: true, includePrice: false, includeVideos: true, ...over,
  } as unknown as ReportDetail;
}
const model = (videos: ReportVideo[], r: Partial<ReportDetail> = {}, posters: Record<string, string> = {}) =>
  buildClientReportModel(job, visit, report(r), [], {}, videos, posters);

test('only videos with their own "Include for client" ON appear, and only while the report\'s "Include videos" is ON', () => {
  const videos = [video('a', 'before'), video('b', 'after', { includeInClientReport: false }), video('c', 'during')];
  assert.deepEqual(model(videos).videos.map((v) => v.id), ['a', 'c']);
  assert.deepEqual(model(videos, { includeVideos: false }).videos, [], 'report-level switch off hides every video');
  assert.deepEqual(model([]).videos, []);
});

test('videos are shown Before, During, After; the model holds no storage path and no link', () => {
  const m = model([video('xx', 'after'), video('y', 'before'), video('zzz', 'during')], {}, { y: 'https://thumb/y' });
  assert.deepEqual(m.videos.map((v) => v.phase), ['before', 'during', 'after']);
  assert.equal(m.videos[0].thumbnailUrl, 'https://thumb/y');
  assert.equal(m.videos[1].thumbnailUrl, null);
  assert.equal(m.videos[0].durationLabel, '0:42');
  const dump = JSON.stringify(m);
  assert.doesNotMatch(dump, /storagePath|visit-1\/|watch-report-video|\/mp4/);
});

test('orderVideosForReport keeps the order videos were added within a phase', () => {
  const a = video('a', 'before', { createdAt: '2026-09-15T10:00:02Z' });
  const b = video('b', 'before', { createdAt: '2026-09-15T10:00:01Z' });
  assert.deepEqual(orderVideosForReport([a, b]).map((v) => v.id), ['b', 'a']);
});

// ---- preparing videos for delivery -----------------------------------------------------------------------------------------------------------
// A real (1x1) JPEG, so jsPDF can embed a thumbnail.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const IMG = { dataUrl: JPEG, width: 1, height: 1 };
function prepDeps(over: Partial<PrepareVideosDeps> = {}) {
  const calls = { links: 0, thumbs: 0, images: [] as string[] };
  const deps: PrepareVideosDeps = {
    requestLinks: async () => { calls.links += 1; return { a: `${BASE}?t=${'A'.repeat(43)}`, c: `${BASE}?t=${'C'.repeat(43)}` }; },
    signThumbnails: async () => { calls.thumbs += 1; return { a: 'https://thumb/a', c: 'https://thumb/c' }; },
    prepareImage: async (url) => { calls.images.push(url); return IMG; },
    ...over,
  };
  return { deps, calls };
}
const twoVideoModel = () => model([video('a', 'before'), video('c', 'after')]);

test('a report with NO videos makes no link request and no thumbnail request at all', async () => {
  const { deps, calls } = prepDeps();
  const out = await prepareClientReportVideos(model([]), deps);
  assert.equal(out, NO_VIDEOS);
  assert.deepEqual([calls.links, calls.thumbs, calls.images.length], [0, 0, 0]);
  const excluded = await prepareClientReportVideos(model([video('a', 'before')], { includeVideos: false }), deps);
  assert.equal(excluded.videos.length, 0);
  assert.equal(calls.links, 0, 'videos excluded by the report switch never trigger link creation either');
});

test('every included video gets its link, length and thumbnail', async () => {
  const { deps } = prepDeps();
  const out = await prepareClientReportVideos(twoVideoModel(), deps);
  assert.deepEqual(out.videos.map((v) => [v.id, v.phase, v.durationLabel, v.url.endsWith('A'.repeat(43)) || v.url.endsWith('C'.repeat(43)), v.thumbnail !== null]), [
    ['a', 'before', '0:42', true, true],
    ['c', 'after', '0:42', true, true],
  ]);
  assert.equal(out.thumbnailsMissing, 0);
});

test('if the links cannot be made delivery STOPS with a plain message that names no id, url or server text', async () => {
  const { deps } = prepDeps({ requestLinks: async () => { throw new Error('HTTP 500 relation report_video_links token https://x?t=SECRET'); } });
  await assert.rejects(prepareClientReportVideos(twoVideoModel(), deps), (err: unknown) => {
    assert.ok(err instanceof ClientVideoLinkError);
    assert.doesNotMatch(err.message, /500|relation|SECRET|https/);
    assert.match(err.message, /nothing was sent or downloaded/i);
    return true;
  });
});

test('if the server returns no link for an included video (removed / un-shared meanwhile) delivery STOPS rather than silently dropping it', async () => {
  const { deps } = prepDeps({ requestLinks: async () => ({ a: `${BASE}?t=${'A'.repeat(43)}` }) });
  await assert.rejects(prepareClientReportVideos(twoVideoModel(), deps), /can no longer be shared/);
});

test('a link the server returns for a video that is NOT in the preview is ignored (the PDF matches the preview)', async () => {
  const { deps } = prepDeps({ requestLinks: async () => ({ a: `${BASE}?t=${'A'.repeat(43)}`, zzz: `${BASE}?t=${'Z'.repeat(43)}` }) });
  const out = await prepareClientReportVideos(model([video('a', 'before')]), deps);
  assert.deepEqual(out.videos.map((v) => v.id), ['a']);
});

test('missing / unreadable thumbnails are NOT a failure: that video keeps its link and is drawn with a placeholder', async () => {
  const { deps } = prepDeps({
    signThumbnails: async () => ({ a: 'https://thumb/a' }), // c has none
    prepareImage: async () => { throw new Error('404'); }, // a cannot be read
  });
  const out = await prepareClientReportVideos(twoVideoModel(), deps);
  assert.equal(out.videos.length, 2);
  assert.ok(out.videos.every((v) => v.thumbnail === null && v.url));
  assert.equal(out.thumbnailsMissing, 2);
  const failedSigning = await prepareClientReportVideos(twoVideoModel(), prepDeps({ signThumbnails: async () => { throw new Error('x'); } }).deps);
  assert.equal(failedSigning.videos.length, 2);
});

// ---- the PDF ---------------------------------------------------------------------------------------------------------------------------------
async function pdfText(m: ClientReportModel, videos = NO_VIDEOS) {
  const blob = await generateClientReportPdf(m, { photos: [], skippedCount: 0 }, videos);
  return Buffer.from(await blob.arrayBuffer()).toString('latin1');
}
const uris = (pdf: string) => [...pdf.matchAll(/\/URI\s*\(([^)]*)\)/g)].map((m) => m[1]);
const URL_A = `${BASE}?t=${'A'.repeat(43)}`;
const URL_C = `${BASE}?t=${'C'.repeat(43)}`;

async function preparedTwo(thumbs = true) {
  const { deps } = prepDeps(thumbs ? {} : { signThumbnails: async () => ({}) });
  return prepareClientReportVideos(twoVideoModel(), deps);
}

test('PDF: each included video is a clickable link annotation to its own secure URL (thumbnail AND "Watch video" label)', async () => {
  const pdf = await pdfText(twoVideoModel(), await preparedTwo());
  assert.ok(pdf.startsWith('%PDF-'));
  const found = uris(pdf);
  assert.equal(found.filter((u) => u === URL_A).length, 2, 'two clickable areas for video a (thumbnail + label)');
  assert.equal(found.filter((u) => u === URL_C).length, 2);
  assert.equal(found.length, 4, 'no other links in the document');
  assert.equal((pdf.match(/\/Subtype\s*\/Link/g) ?? []).length, 4);
  assert.match(pdf, /Watch video/);
  assert.match(pdf, /0:42/, 'the duration is printed');
  assert.match(pdf, /Videos/);
});

test('PDF: the thumbnail is embedded as an image and the play button is drawn; the video file itself is never embedded', async () => {
  const withThumbs = await pdfText(twoVideoModel(), await preparedTwo(true));
  const without = await pdfText(twoVideoModel(), await preparedTwo(false));
  assert.ok((withThumbs.match(/\/Subtype\s*\/Image/g) ?? []).length >= 2, 'both thumbnails embedded');
  assert.equal((without.match(/\/Subtype\s*\/Image/g) ?? []).length, 0, 'with no thumbnails: no images, a placeholder is drawn instead');
  assert.equal(uris(without).length, 4, 'the links still work without a thumbnail');
  assert.doesNotMatch(withThumbs, /video\/mp4|ftyp|\/EmbeddedFile|\/Subtype\s*\/Movie|\/RichMedia/i, 'no video data in the PDF');
  assert.ok(withThumbs.length < 200_000, 'the PDF stays small');
  // the play button is vector shapes (a filled disc + triangle) painted after the thumbnail: the content has more than just the image
  assert.match(withThumbs, /\bf\b/);
});

test('PDF: no video section, no links and the same facts as before when there are no included videos', async () => {
  const none = await pdfText(model([]));
  assert.deepEqual(uris(none), []);
  assert.doesNotMatch(none, /Watch video/);
  assert.doesNotMatch(none, /\(Videos\)/);
  const hidden = await pdfText(model([video('a', 'before')], { includeVideos: false }));
  assert.deepEqual(uris(hidden), [], 'excluded by the report switch: nothing about videos in the PDF');
  const unticked = await pdfText(model([video('a', 'before', { includeInClientReport: false })]));
  assert.deepEqual(uris(unticked), []);
  assert.doesNotMatch(unticked, /Watch video/);
});

test('PDF: report text, status and footer are unchanged by the video section', async () => {
  const withV = await pdfText(twoVideoModel(), await preparedTwo());
  for (const expected of ['Oak Court', 'Prepared for Acme Ltd', 'Cleaned all windows.', 'Specification completed as agreed.', 'Thank you for choosing Kind Contractors']) {
    assert.ok(withV.includes(expected), expected);
  }
});

test('PDF: many videos flow onto further pages and every one stays clickable', async () => {
  const many = Array.from({ length: 6 }, (_, i) => video(`v${i}`, (['before', 'during', 'after'] as const)[i % 3], { createdAt: `2026-09-15T10:00:0${i}Z` }));
  const m = model(many);
  const links = Object.fromEntries(many.map((v, i) => [v.id, `${BASE}?t=${String(i).repeat(43)}`]));
  const out = await prepareClientReportVideos(m, prepDeps({ requestLinks: async () => links, signThumbnails: async () => ({}) }).deps);
  const pdf = await pdfText(m, out);
  assert.equal(uris(pdf).length, 12);
  assert.equal(new Set(uris(pdf)).size, 6);
});

// ---- rate limiting of the public endpoint ----------------------------------------------------------------------------------------------------
const fromIp = (ip: string, token = GOOD_TOKEN, init: RequestInit = {}) => new Request(`${BASE}?t=${token}`, { ...init, headers: { 'x-forwarded-for': ip, ...(init.headers as Record<string, string> | undefined) } });

test('RATE LIMIT: the Nth+1 request in a minute from one address gets 429; other addresses are unaffected; it recovers after the window', async () => {
  let now = 1_000_000;
  const guard = createWatchGuard({ requestsPerWindow: 3, windowMs: 60_000, now: () => now });
  const { deps } = watchDeps({ guard });
  for (let i = 0; i < 3; i += 1) assert.equal((await handleWatchRequest(fromIp('9.9.9.9'), deps)).status, 302, `request ${i + 1} allowed`);
  const blocked = await handleWatchRequest(fromIp('9.9.9.9'), deps);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal((await handleWatchRequest(fromIp('8.8.8.8'), deps)).status, 302, 'a different address is not affected');
  now += 61_000;
  assert.equal((await handleWatchRequest(fromIp('9.9.9.9'), deps)).status, 302, 'allowed again once the window has passed');
});

test('RATE LIMIT: repeated FAILED lookups lock an address out sooner, even when the request rate is low - and valid links never count as failures', async () => {
  let now = 1_000_000;
  const guard = createWatchGuard({ requestsPerWindow: 1000, failuresPerWindow: 3, failureWindowMs: 600_000, now: () => now });
  const missing = watchDeps({ guard, resolve: async () => null }).deps;
  for (let i = 0; i < 3; i += 1) assert.equal((await handleWatchRequest(fromIp('7.7.7.7', 'B'.repeat(43)), missing)).status, 404);
  assert.equal((await handleWatchRequest(fromIp('7.7.7.7', 'B'.repeat(43)), missing)).status, 429, 'the 4th failure from this address is refused outright');
  const ok = watchDeps({ guard }).deps;
  assert.equal((await handleWatchRequest(fromIp('7.7.7.7'), ok)).status, 429, 'and a valid link from that address is throttled too, for now');
  assert.equal((await handleWatchRequest(fromIp('6.6.6.6'), ok)).status, 302, 'another address with a valid link is fine');
  for (let i = 0; i < 50; i += 1) assert.equal((await handleWatchRequest(fromIp('5.5.5.5'), ok)).status, 302, 'valid opens never count as failures');
  now += 601_000;
  assert.equal((await handleWatchRequest(fromIp('7.7.7.7'), ok)).status, 302, 'recovers after the failure window');
});

test('RATE LIMIT: the 429 depends only on the address - identical for a good token, a bad token and no token', async () => {
  const guard = createWatchGuard({ requestsPerWindow: 1, now: () => 5 });
  const { deps } = watchDeps({ guard });
  await handleWatchRequest(fromIp('4.4.4.4'), deps);
  const a = await handleWatchRequest(fromIp('4.4.4.4'), deps);
  const b = await handleWatchRequest(fromIp('4.4.4.4', 'short'), deps);
  const c = await handleWatchRequest(new Request(BASE, { headers: { 'x-forwarded-for': '4.4.4.4' } }), deps);
  const snap = async (r: Response) => ({ s: r.status, body: await r.text(), h: [...r.headers.entries()].sort() });
  assert.deepEqual(await snap(a), await snap(await tooManyRequests()));
  assert.deepEqual(await snap(b), await snap(await tooManyRequests()));
  assert.deepEqual(await snap(c), await snap(await tooManyRequests()));
});

test('RATE LIMIT: a throttled request never reaches the database or storage', async () => {
  const guard = createWatchGuard({ requestsPerWindow: 1, now: () => 5 });
  const { deps, calls } = watchDeps({ guard });
  await handleWatchRequest(fromIp('3.3.3.3'), deps);
  const before = [calls.resolve.length, calls.sign.length];
  await handleWatchRequest(fromIp('3.3.3.3'), deps);
  assert.deepEqual([calls.resolve.length, calls.sign.length], before);
});

test('RATE LIMIT: the address comes from the platform header (cf-connecting-ip / x-real-ip) first, which a client cannot forge; x-forwarded-for (last entry) is only a fallback', () => {
  assert.equal(clientKey(new Headers({ 'cf-connecting-ip': '5.6.7.8', 'x-forwarded-for': '1.1.1.1, 13.248.101.200' })), '5.6.7.8');
  assert.equal(clientKey(new Headers({ 'x-real-ip': '9.9.9.1', 'x-forwarded-for': '1.1.1.1' })), '9.9.9.1');
  assert.equal(clientKey(new Headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })), '3.3.3.3');
  assert.equal(clientKey(new Headers({ 'x-forwarded-for': ' 10.0.0.9 ' })), '10.0.0.9');
  assert.equal(clientKey(new Headers()), 'unknown');
  assert.equal(clientKey(new Headers({ 'x-forwarded-for': 'x'.repeat(500) })).length, 64);
});

test('RATE LIMIT: IPv6 callers are keyed by their /64, so rotating addresses inside it does not dodge the limit', () => {
  const k1 = normaliseAddress('2001:db8:abcd:12:1111:2222:3333:4444');
  assert.equal(k1, '2001:db8:abcd:12::/64');
  assert.equal(normaliseAddress('2001:DB8:ABCD:0012:ffff:ffff:ffff:ffff'), k1);
  assert.equal(normaliseAddress('2001:db8:abcd:12::1'), k1);
  assert.equal(normaliseAddress('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(normaliseAddress('::1'), '0:0:0:0::/64');
  assert.notEqual(normaliseAddress('2001:db8:abcd:13::1'), k1);
  assert.equal(normaliseAddress('203.0.113.7'), '203.0.113.7');
  assert.equal(normaliseAddress('::ffff:203.0.113.7'), '::ffff:203.0.113.7');
  assert.equal(normaliseAddress('not-an-address:::'), 'not-an-address:::');
  assert.equal(clientKey(new Headers({ 'cf-connecting-ip': '2001:db8:abcd:12:aaaa:bbbb:cccc:dddd' })), k1);
});

test('RATE LIMIT: the key table is capped, so rotating addresses cannot exhaust memory', () => {
  const l = new WindowLimiter({ limit: 5, windowMs: 60_000, maxKeys: 100, now: () => 1 });
  for (let i = 0; i < 1000; i += 1) l.record(`ip-${i}`);
  assert.ok(l.size <= 100, `size ${l.size}`);
});

test('RATE LIMIT: no guard configured means no throttling (plain behaviour unchanged)', async () => {
  const { deps } = watchDeps();
  for (let i = 0; i < 200; i += 1) assert.equal((await handleWatchRequest(fromIp('2.2.2.2'), deps)).status, 302);
});

test('RATE LIMIT (database guard): refuses only on an explicit "false" from the database; any error means ALLOW (fails open)', async () => {
  const mk = (check: () => Promise<boolean>, fail: () => Promise<void> = async () => {}) => createDbWatchGuard({ check, fail });
  assert.equal(await mk(async () => false).shouldThrottle('k'), true);
  assert.equal(await mk(async () => true).shouldThrottle('k'), false);
  assert.equal(await mk(async () => { throw new Error('db down'); }).shouldThrottle('k'), false, 'a database error never blocks a client');
  assert.equal(await mk(async () => true, async () => { throw new Error('db down'); }).recordFailure('k'), undefined, 'a failed failure-record is swallowed');
});

test('RATE LIMIT (database guard): through the handler - blocked address gets 429 without any lookup; a failed lookup is recorded; a valid open is not', async () => {
  const seen = { fails: [] as string[], checks: [] as string[] };
  let block = false;
  const guard = createDbWatchGuard({ check: async (k) => { seen.checks.push(k); return !block; }, fail: async (k) => { seen.fails.push(k); } });
  const ok = watchDeps({ guard });
  assert.equal((await handleWatchRequest(fromIp('1.2.3.4'), ok.deps)).status, 302);
  assert.deepEqual(seen.fails, [], 'a valid open is never counted as a failure');
  const missing = watchDeps({ guard, resolve: async () => null });
  assert.equal((await handleWatchRequest(fromIp('1.2.3.4', 'B'.repeat(43)), missing.deps)).status, 404);
  assert.deepEqual(seen.fails, ['1.2.3.4'], 'the failure is recorded against the address');
  block = true;
  const blocked = watchDeps({ guard });
  assert.equal((await handleWatchRequest(fromIp('1.2.3.4'), blocked.deps)).status, 429);
  assert.equal(blocked.calls.resolve.length, 0, 'no database lookup and no signing for a throttled request');
});
