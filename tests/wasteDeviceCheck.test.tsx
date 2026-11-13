// The Waste Reports "Device compatibility check" (src/waste/deviceCheck.ts, DeviceCheckPage.tsx, wasteApi.submitDeviceCheck): runs only
// when tapped, tests the app's own storage with a 1 KB generated file (never a photo/video), reports the browser's real errors, never
// carries report contents / addresses / file names, removes its test records, and is sent only by the reporter, never from a local copy
// set up for the live system. Plus the database function's rules (supabase/migrations/20261113100000_waste_device_checks.sql).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { openDB } from 'idb';

import { describeUserAgent, environmentOf, runDeviceCheck, runIndexedDbCheck, submitBlockedReason, verdictOf, type DeviceCheckReport } from '../src/waste/deviceCheck';
import { DeviceCheckSummary } from '../src/waste/DeviceCheckPage';
import { deleteDraft, deleteMedia, listDrafts, listMediaForOwner, WASTE_DB_NAME, wasteDbForDeviceCheck } from '../src/waste/offline/wasteDb';
import { setCurrentUserId } from '../src/auth/currentUser';
import { addWasteFiles, getOrCreateEditingDraft, setWasteEngineDepsForTests, updateWasteDraftFields, waitForWasteWorker } from '../src/waste/offline/wasteSyncEngine';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const OWNER = 'abababab-abab-4bab-8bab-abababababab';
let restorePut: (() => void) | null = null;
function failPutsWhere(pred: (value: Record<string, unknown>) => boolean, name: string, message: string) {
  const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: (...a: unknown[]) => unknown } } }).IDBObjectStore.prototype;
  const put = proto.put;
  proto.put = function (this: { name: string }, ...args: unknown[]) {
    if (this.name === 'media' && pred(args[0] as Record<string, unknown>)) throw new DOMException(message, name);
    return put.apply(this, args);
  };
  restorePut = () => { proto.put = put; };
}
async function rawMediaKeys(): Promise<string[]> {
  const db = await openDB(WASTE_DB_NAME);
  const keys = (await db.getAllKeys('media')).map(String);
  db.close();
  return keys;
}
const idbDeps = (over: Partial<Parameters<typeof runIndexedDbCheck>[0]> = {}) => ({ openDb: wasteDbForDeviceCheck, newId: () => 'run-1', now: () => Date.now(), indexedDbAvailable: true, ...over });

beforeEach(async () => {
  setCurrentUserId(OWNER);
  await waitForWasteWorker();
  for (const d of await listDrafts(OWNER)) await deleteDraft(OWNER, d.reportId);
  for (const m of await listMediaForOwner(OWNER)) await deleteMedia(m.id);
});
afterEach(() => { restorePut?.(); restorePut = null; });

test('USER AGENT: device category, the iOS version AS REPORTED, browser - and nothing guessed beyond it', () => {
  const safari = describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1', 5);
  assert.deepEqual(safari, { category: 'iPhone', iosVersionReported: '18.6', browser: { name: 'Safari', version: '26.0' } });
  assert.deepEqual(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1', 5).browser, { name: 'Chrome (iOS)', version: '131.0.6778.73' });
  assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 5).category, 'iPad', 'iPadOS desktop mode (touch)');
  assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 0).category, 'desktop');
  assert.deepEqual(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 5), { category: 'Android', iosVersionReported: null, browser: { name: 'Chrome', version: '131.0.0.0' } });
  assert.equal(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]', 5).browser.name, 'Facebook in-app browser');
  assert.deepEqual(describeUserAgent('', null), { category: 'unknown', iosVersionReported: null, browser: { name: 'unknown', version: null } });
});

test('ENVIRONMENT: live / DEV / other from the configured server; a copy on this computer set up for the live system can never send', () => {
  assert.equal(environmentOf('https://rgcxybsnoqjnbywzycfx.supabase.co'), 'production');
  assert.equal(environmentOf('https://oewjoxttcxrgwhqcstqc.supabase.co'), 'dev');
  assert.equal(environmentOf('https://tests.invalid'), 'other');
  assert.equal(environmentOf(undefined), 'other');
  assert.match(submitBlockedReason('production', 'localhost') ?? '', /can’t be sent from here/);
  assert.match(submitBlockedReason('production', '127.0.0.1') ?? '', /can’t be sent from here/);
  assert.equal(submitBlockedReason('production', 'job-manage1.netlify.app'), null, 'the live site sends to the live system');
  assert.equal(submitBlockedReason('dev', 'localhost'), null, 'local testing sends to DEV');
});

test('STORAGE TEST (works): the app`s own database; plain record and 1 KB file saved, committed, read back byte for byte; test records removed', async () => {
  const r = await runIndexedDbCheck(idbDeps());
  assert.equal(r.open.ok, true);
  assert.deepEqual([r.plainObject.ok, r.plainObject.request, r.plainObject.transaction, r.plainObject.readBack], [true, 'success', 'complete', true]);
  assert.deepEqual([r.blob.ok, r.blob.request, r.blob.transaction, r.blob.readBack, r.blob.sizeMatches, r.blob.bytesMatch, r.blob.hashMatches, r.blob.bytes], [true, 'success', 'complete', true, true, true, true, 1024]);
  assert.equal(r.cleanup.ok, true);
  assert.deepEqual(await rawMediaKeys(), [], 'no test record left in the media store');
  assert.match(r.target, /app’s own storage/);
});

test('STORAGE TEST (refused, as in a private tab): the browser`s own error is reported, nothing is claimed as saved, test records still removed', async () => {
  failPutsWhere((v) => v.blob instanceof Blob, 'UnknownError', 'Error preparing Blob/File data to be stored in object store');
  const r = await runIndexedDbCheck(idbDeps());
  assert.deepEqual([r.plainObject.ok, r.plainObject.readBack], [true, true], 'a plain record still works');
  assert.deepEqual([r.blob.ok, r.blob.request, r.blob.transaction, r.blob.readBack, r.blob.bytesMatch], [false, 'threw', 'abort', false, null]);
  assert.deepEqual(r.blob.error, { name: 'UnknownError', message: 'Error preparing Blob/File data to be stored in object store' });
  assert.equal(r.cleanup.ok, true);
  assert.deepEqual(await rawMediaKeys(), []);
});

test('STORAGE TEST: storage that can`t be opened, or no IndexedDB at all, is reported plainly (no crash)', async () => {
  const noOpen = await runIndexedDbCheck(idbDeps({ openDb: async () => { throw new DOMException('Database deleted by request of the user', 'UnknownError'); } }));
  assert.deepEqual([noOpen.open.ok, noOpen.open.error?.name, noOpen.blob.ok], [false, 'UnknownError', false]);
  const none = await runIndexedDbCheck(idbDeps({ indexedDbAvailable: false }));
  assert.deepEqual([none.open.ok, none.open.error?.name], [false, 'Unsupported']);
});

test('TEST RECORDS are never linked to anyone: the app`s lists never show them, even while they exist', async () => {
  const db = await wasteDbForDeviceCheck();
  let seenDuring: number | null = null;
  const r = await runIndexedDbCheck(idbDeps({
    openDb: async () => db,
    now: () => { if (seenDuring === null) void listMediaForOwner(OWNER).then((l) => { seenDuring = l.length; }); return Date.now(); },
  }));
  assert.equal(r.blob.ok, true);
  assert.equal(seenDuring, 0);
});

async function fullReport(navOver: Record<string, unknown> = {}): Promise<DeviceCheckReport> {
  const nav = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5, language: 'en-GB', standalone: true, storage: { estimate: async () => ({ usage: 1234, quota: 5000000000 }), persisted: async () => false }, ...navOver } as unknown as Navigator;
  const win = { matchMedia: () => ({ matches: false }), screen: { width: 402, height: 874 }, devicePixelRatio: 3 } as unknown as Window;
  return runDeviceCheck({ nav, win, supabaseUrl: 'https://oewjoxttcxrgwhqcstqc.supabase.co', now: () => new Date('2026-11-13T12:00:00Z') });
}

test('REPORT: exactly the expected facts; home-screen mode detected; matches the database`s allowed fields', async () => {
  const r = await fullReport();
  assert.deepEqual(Object.keys(r).sort(), ['appVersion', 'browser', 'checkedAt', 'device', 'environment', 'indexedDb', 'kind', 'lastMediaSaveError', 'storage', 'version']);
  assert.deepEqual([r.kind, r.version, r.environment, r.checkedAt], ['waste-device-check', 1, 'dev', '2026-11-13T12:00:00.000Z']);
  assert.deepEqual(r.device, { userAgent: r.device.userAgent, platform: 'iPhone', iosVersionReported: '18.6', category: 'iPhone', screen: { width: 402, height: 874 }, devicePixelRatio: 3, touchPoints: 5, language: 'en-GB' });
  assert.deepEqual(r.browser, { name: 'Safari', version: '26.0', displayMode: 'home-screen app' });
  assert.deepEqual(r.storage, { indexedDbAvailable: true, estimate: { usageBytes: 1234, quotaBytes: 5000000000 }, persisted: false });
  assert.equal(verdictOf(r).ok, true);
  const sql = src('supabase', 'migrations', '20261113100000_waste_device_checks.sql');
  const allowed = /v_allowed text\[\] := array\[([^\]]+)\]/.exec(sql)![1].match(/'([^']+)'/g)!.map((s) => s.slice(1, -1)).sort();
  assert.deepEqual(Object.keys(r).sort(), allowed, 'the report sends exactly the fields the database accepts');
});

test('UNSUPPORTED APIs: no storage estimate / persisted / matchMedia / userAgentData - reported as such, no crash', async () => {
  const r = await fullReport({ storage: undefined, standalone: undefined });
  assert.deepEqual([r.storage.estimate, r.storage.persisted], ['unsupported', 'unsupported']);
  assert.equal(r.browser.displayMode, 'browser tab');
});

test('PRIVACY: no report contents, addresses, file names, photos or videos - even with a draft and a media save failure on the phone', async () => {
  setWasteEngineDepsForTests({ isOnline: () => false, preparePhoto: async (file) => ({ blob: file, filename: file.name }) });
  const d = await getOrCreateEditingDraft();
  await updateWasteDraftFields(d.reportId, { address: '17 Secret Road, Client Town', description: 'Confidential works for Acme Ltd' });
  await addWasteFiles(d.reportId, 'before', 'photo', [new File([new Uint8Array(500)], 'acme-roof-photo.jpg', { type: 'image/jpeg' })]);
  failPutsWhere((v) => v.blob instanceof Blob && v.ownerId === OWNER, 'QuotaExceededError', 'The quota has been exceeded.');
  await addWasteFiles(d.reportId, 'after', 'video', [new File([new Uint8Array(900)], 'acme-video.mp4', { type: 'video/mp4' })]);
  restorePut?.(); restorePut = null;
  const r = await fullReport();
  const json = JSON.stringify(r);
  for (const secret of ['Secret Road', 'Client Town', 'Acme', 'acme-roof-photo', 'acme-video', d.reportId, OWNER]) assert.ok(!json.includes(secret), `no "${secret}"`);
  assert.deepEqual(r.lastMediaSaveError && { kind: r.lastMediaSaveError.kind, name: r.lastMediaSaveError.name }, { kind: 'video', name: 'QuotaExceededError' }, 'the browser`s save error is included (no file name)');
  assert.ok(json.length < 16384, 'well under the database`s 16 KB limit');
  setWasteEngineDepsForTests(null);
});

test('SCREEN: the summary shows what would be sent, incl. a failed test file with the browser`s error', async () => {
  failPutsWhere((v) => v.blob instanceof Blob && !('ownerId' in v), 'UnknownError', 'Error preparing Blob/File data to be stored in object store');
  const r = await fullReport();
  restorePut?.(); restorePut = null;
  const html = renderToStaticMarkup(<DeviceCheckSummary report={r} />);
  assert.match(html, /Safari 26\.0 · home-screen app/);
  assert.match(html, /iOS 18\.6 \(as reported\)/);
  assert.match(html, /Test file saved<\/dt><dd[^>]*>no \(abort · UnknownError: Error preparing Blob\/File data to be stored in object store\)/);
  assert.equal(verdictOf(r).ok, false);
  assert.match(verdictOf(r).text, /private browsing tab/);
});

test('WIRING: a waste-reporter route and an unobtrusive link; nothing runs or sends by itself', () => {
  const app = src('src', 'App.tsx');
  const wasteBlock = app.slice(app.indexOf("if (role === 'waste_reporter')"), app.indexOf("if (role !== 'manager')"));
  assert.match(wasteBlock, /<Route path="\/waste\/device-check" element=\{<DeviceCheckPage \/>\} \/>/);
  assert.match(src('src', 'waste', 'MyWasteReportsPage.tsx'), /<Link to="\/waste\/device-check"[^>]*>\s*Device compatibility check\s*<\/Link>/);
  const page = src('src', 'waste', 'DeviceCheckPage.tsx');
  assert.doesNotMatch(page, /useEffect/, 'no automatic run on opening');
  assert.match(page, /onClick=\{\(\) => void run\(\)\}/);
  assert.match(page, /onClick=\{\(\) => void send\(phase\.report\)\}/);
  assert.match(page, /const blocked = submitBlockedReason\(report\.environment, window\.location\.hostname\);/);
  assert.match(src('src', 'waste', 'wasteApi.ts'), /supabase\.rpc\('waste_submit_device_check', \{ p_check: check \}\)/);
});

test('DATABASE: one table nobody can reach directly; one function for active waste reporters only, validated, rate-limited, 30-day retention', () => {
  const sql = src('supabase', 'migrations', '20261113100000_waste_device_checks.sql').replace(/^\s*--.*$/gm, '');
  assert.match(sql, /alter table public\.waste_device_checks enable row level security;\s*revoke all on table public\.waste_device_checks from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /create policy|grant [^;]* on table/i);
  const fn = sql.slice(sql.indexOf('create function public.waste_submit_device_check'));
  assert.match(fn, /security definer\s+set search_path to 'public'/);
  assert.match(fn, /v_me uuid := private\.current_waste_reporter_id\(\);[\s\S]*?begin\s+if v_me is null then\s+raise exception 'Not authorized\.' using errcode = '42501';/);
  assert.match(fn, /octet_length\(p_check::text\) > 16384/);
  assert.match(fn, /p_check ->> 'kind' is distinct from 'waste-device-check'/);
  assert.match(fn, />= 20 then/);
  assert.match(fn, /delete from public\.waste_device_checks where received_at < now\(\) - interval '30 days';/);
  assert.match(sql, /revoke all on function public\.waste_submit_device_check\(jsonb\) from public, anon, authenticated;\s*grant execute on function public\.waste_submit_device_check\(jsonb\) to authenticated;/);
  const rb = src('supabase', 'rollbacks', '20261113100000_waste_device_checks.rollback.sql').replace(/^\s*--.*$/gm, '');
  assert.match(rb, /begin;\s*drop function if exists public\.waste_submit_device_check\(jsonb\);\s*drop table if exists public\.waste_device_checks;\s*commit;/);
  assert.match(src('supabase', 'migrations', 'MIGRATION_README.md'), /`20261113100000_waste_device_checks\.rollback\.sql`/);
});
