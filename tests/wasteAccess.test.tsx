// The waste reporter can reach his reporting screens and nothing else:
//   * App routing: his role gets only /waste/*; an unknown role is refused (it used to fall through to the manager screens);
//   * Edge Functions: every existing function's manager gate refuses him; admin-users can create him without a technician record;
//   * the migration: read-only waste tables, no write/delete policies, the lock-before-read submit, the bucket and its rules;
// plus the rules and presentational pieces of his screens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App';
import { AuthContext, type AuthContextValue } from '../src/auth/AuthProvider';
import { addDays, checkWasteForm, checkWastePick, emptySections, emptySectionsQuestion, formatWorkDates, londonToday, wasteMediaPath, wasteThumbPath } from '../src/waste/wasteRules';
import WasteMediaSection from '../src/waste/WasteMediaSection';
import { MyWasteReportsList, sendingRowLabel } from '../src/waste/MyWasteReportsPage';
import { summarizeWasteUploads } from '../src/waste/offline/wasteSyncEngine';
import { sentStateFor } from '../src/waste/WasteReportSentPage';
import type { WasteDraft, WasteMedia } from '../src/waste/offline/wasteDb';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ---- routing -------------------------------------------------------------------------------------------------------------------------
function renderApp(role: string, path: string): string {
  const auth = { status: 'authorized', role, session: { user: { id: 'u1' } }, signOut: async () => {}, recheck: () => {} } as unknown as AuthContextValue;
  return renderToStaticMarkup(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

test('a waste reporter gets his own shell (New report / My reports) and never the manager or technician app', () => {
  const html = renderApp('waste_reporter', '/waste');
  assert.match(html, /Waste reports/);
  assert.match(html, /New report/);
  assert.match(html, /My reports/);
  for (const path of ['/jobs', '/buildings', '/report-review', '/ready-for-accounts', '/users', '/technician', '/technician/visits/x']) {
    const other = renderApp('waste_reporter', path);
    assert.doesNotMatch(other, /Views of the same data|Needs you|TECHNICIAN|Technician/i, path);
    assert.doesNotMatch(other, /Ready for accounts|Report review|Buildings/, path);
  }
});

test('an unknown role is refused - it no longer falls through to the manager screens', () => {
  const html = renderApp('viewer', '/jobs');
  assert.match(html, /Not set up for access/);
  assert.doesNotMatch(html, /Views of the same data/);
  const src = read('src/App.tsx');
  assert.ok(src.indexOf("if (role !== 'manager') return <UnauthorizedPage />") < src.indexOf('<AppShell />'), 'the manager gate comes before the manager routes');
});

test('AuthProvider accepts exactly manager, technician and waste_reporter (and still requires an active account)', () => {
  const src = read('src/auth/AuthProvider.tsx');
  assert.match(src, /data\?\.is_active && \(data\.role === 'manager' \|\| data\.role === 'technician' \|\| data\.role === 'waste_reporter'\)/);
});

// ---- Edge Functions --------------------------------------------------------------------------------------------------------------
test('every existing Edge Function is gated to managers (a waste reporter gets 403); waste-media-check to waste reporters', () => {
  const dir = join(root, 'supabase/functions');
  const fns = readdirSync(dir).filter((f) => !f.startsWith('_') && existsSync(join(dir, f, 'index.ts')));
  assert.ok(fns.length >= 7);
  for (const fn of fns) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    if (fn === 'watch-report-video' || fn === 'watch-waste-video') {
      assert.match(src, /resolve_(report|waste)_video_link/, 'public, token-only');
      assert.doesNotMatch(src, /assertManager|assertWasteReporter|from\('/, 'no login and no table access - only the token resolver');
      continue;
    }
    if (fn === 'waste-media-check') {
      assert.match(src, /assertWasteReporter\(req\)/);
      assert.doesNotMatch(src, /assertManager/);
      continue;
    }
    assert.match(src, /await assertManager\(req\)/, fn);
  }
  const auth = read('supabase/functions/_shared/auth.ts');
  assert.match(auth, /appUser\.role !== 'manager'/);
  assert.match(auth, /appUser\.role !== 'waste_reporter'/);
});

test('assertManager refuses an active waste reporter; assertWasteReporter refuses a manager', async () => {
  const ENV: Record<string, string> = { SUPABASE_URL: 'https://tests.invalid', SUPABASE_ANON_KEY: 'anon' };
  (globalThis as any).Deno = { env: { get: (k: string) => ENV[k] } };
  let role = 'waste_reporter';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const accept = new Headers(init?.headers).get('accept') ?? '';
    if (url.pathname === '/auth/v1/user') return new Response(JSON.stringify({ id: 'u1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const row = { role, is_active: true };
    return new Response(JSON.stringify(accept.includes('vnd.pgrst.object') ? row : [row]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const { assertManager, assertWasteReporter, UnauthorizedError } = await import('../supabase/functions/_shared/auth');
    const req = () => new Request('https://x.test', { headers: { Authorization: 'Bearer jwt' } });
    await assert.rejects(() => assertManager(req()), UnauthorizedError);
    const ok = await assertWasteReporter(req());
    assert.equal(ok.userId, 'u1');
    role = 'manager';
    await assert.rejects(() => assertWasteReporter(req()), UnauthorizedError);
    role = 'technician';
    await assert.rejects(() => assertWasteReporter(req()), UnauthorizedError);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('admin-users can create a waste reporter, and does not create a technician record for one', () => {
  const src = read('supabase/functions/admin-users/index.ts');
  assert.match(src, /role !== 'manager' && role !== 'technician' && role !== 'waste_reporter'/);
  assert.match(src, /if \(role === 'technician'\) \{\s*const \{ error: technicianError \} = await service\s*\.from\('technicians'\)/);
  const users = read('src/pages/UsersPage.tsx');
  assert.match(users, /setRole\('waste_reporter'\)/);
  assert.match(users, /if \(role === 'waste_reporter'\) return 'Waste reporter';/);
});

// ---- the migration -------------------------------------------------------------------------------------------------------------------
const sql = read('supabase/migrations/20261103100000_waste_reports.sql');
const stamp = read('supabase/migrations/20261103100100_waste_media_checks_stamp.sql');

test('migration: the role list gains waste_reporter only; no existing policy, table or function is changed', () => {
  assert.match(sql, /check \(role in \('manager', 'technician', 'waste_reporter'\)\)/);
  const altered = [...sql.matchAll(/alter table (public\.\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(altered)].sort(), ['public.app_users', 'public.waste_media_checks', 'public.waste_report_events', 'public.waste_report_media', 'public.waste_reports']);
  assert.doesNotMatch(sql, /drop policy|alter policy|drop function|drop table/i);
  for (const m of sql.matchAll(/create policy \w+ on (\S+)/g)) assert.ok(/^public\.waste_|^storage\.objects$/.test(m[1]), m[1]);
});

test('migration: waste tables are read-only through the API - no insert/update/delete policy or grant, deletes are restricted', () => {
  assert.doesNotMatch(sql, /create policy[^;]*for (insert|update|delete|all)[^;]*on public\.waste/i);
  assert.doesNotMatch(sql, /create policy \w+ on public\.waste\w+ for (insert|update|delete|all)/i);
  assert.match(sql, /revoke all on public\.waste_reports, public\.waste_report_media, public\.waste_media_checks, public\.waste_report_events from anon, authenticated;/);
  assert.match(sql, /grant select on public\.waste_reports, public\.waste_report_media, public\.waste_report_events to authenticated;/);
  assert.doesNotMatch(sql, /grant [^;]*waste_media_checks[^;]* to authenticated/i);
  assert.equal((sql.match(/on delete restrict/g) ?? []).length, 3);
  assert.match(sql, /using \(reporter_user_id = private\.current_waste_reporter_id\(\)\)/);
});

test('migration: submit takes the lock BEFORE reading, returns an existing report unchanged, and requires a fresh passing check per file', () => {
  const fn = sql.slice(sql.indexOf('create or replace function public.waste_submit_report'));
  const lock = fn.indexOf('pg_advisory_xact_lock');
  const firstRead = fn.indexOf('from public.waste_reports where id = p_report_id');
  assert.ok(lock > 0 && lock < firstRead, 'lock first');
  assert.match(fn, /if v_existing_owner = v_me then\s*return jsonb_build_object\('id', p_report_id, 'created', false\);/);
  assert.match(fn, /v_object_created > v_check\.checked_at/);
  assert.match(fn, /v_check\.owner_user_id <> v_me/);
  assert.match(fn, /v_path not like v_prefix \|\| v_phase \|\| '\/%'/);
  assert.match(fn, /v_photos_before > 30 or v_photos_after > 30/);
  assert.match(fn, /v_videos_before > 5 or v_videos_after > 5/);
  assert.match(fn, /duration_seconds > 61/);
  assert.match(sql, /revoke execute on function public\.waste_submit_report\(uuid, text, date, date, text, jsonb\) from public, anon;/);
  assert.match(stamp, /new\.checked_at := now\(\);/);
});

test('strict 60 s: the later migration replaces the 61 s allowance in both the table rule and the submit check', () => {
  const strict = read('supabase/migrations/20261103100200_waste_video_limit_60.sql');
  assert.match(strict, /duration_seconds > 0 and duration_seconds <= 60\)/);
  assert.match(strict, /v_check\.duration_seconds is null or v_check\.duration_seconds > 60 then/);
  const code = strict.replace(/--.*$/gm, ''); // the comments mention the old figure
  assert.doesNotMatch(code, /> 61|<= 61/);
  const fn = strict.slice(strict.indexOf('create or replace function public.waste_submit_report'));
  assert.ok(fn.indexOf('pg_advisory_xact_lock') < fn.indexOf('from public.waste_reports where id = p_report_id'), 'still locks first');
});

test('migration: the private bucket, and storage rules limited to his own folder (no update for anyone, no manager delete)', () => {
  assert.match(sql, /'waste-report-media', 'waste-report-media', false, 157286400,\s*array\['image\/jpeg', 'image\/png', 'video\/mp4', 'video\/quicktime', 'video\/webm'\]/);
  assert.match(sql, /if split_part\(p_name, '\/', 1\) <> v_me::text then\s*return false;/);
  assert.match(sql, /a submitted report never gains files/);
  assert.doesNotMatch(sql, /on storage\.objects for update/);
  const storagePolicies = [...sql.matchAll(/create policy (\w+) on storage\.objects for (\w+)/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(storagePolicies.sort(), ['manager_waste_media_select:select', 'waste_reporter_media_insert:insert', 'waste_reporter_media_select:select', 'waste_reporter_unsubmitted_media_delete:delete']);
});

// ---- rules -------------------------------------------------------------------------------------------------------------------------
test('form rules: address required, end not before start, not in the future; reported later is fine', () => {
  const today = '2026-11-03';
  const ok = { address: '1 High St', startDate: '2026-10-31', endDate: '2026-11-01', description: '' };
  assert.deepEqual(checkWasteForm(ok, today), []);
  assert.deepEqual(checkWasteForm({ ...ok, address: '  ' }, today), ['Enter the job address.']);
  assert.deepEqual(checkWasteForm({ ...ok, endDate: '2026-10-30' }, today), ['The end date cannot be before the start date.']);
  assert.deepEqual(checkWasteForm({ ...ok, endDate: '2026-11-05' }, today), ['The end date cannot be in the future.']);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.match(londonToday(new Date('2026-06-30T23:30:00Z')), /^2026-07-01$/, 'UK date, not UTC');
});

test('empty sections are asked about, never blocked', () => {
  assert.deepEqual(emptySections([{ phase: 'before' }]), ['after']);
  assert.equal(emptySectionsQuestion(['after']), 'The After section has no photos or videos. Send it anyway?');
  assert.equal(emptySectionsQuestion(['before', 'after']), 'There are no photos or videos in this report. Send it anyway?');
  assert.equal(emptySectionsQuestion([]), null);
});

test('limits: 30 photos and 5 videos per section, 150 MB per video, accepted video types', () => {
  const photos = Array.from({ length: 30 }, () => ({ kind: 'photo' as const, phase: 'before' as const }));
  assert.equal(checkWastePick({ name: 'a.jpg', type: 'image/jpeg', size: 10 }, 'photo', 'before', photos).ok, false);
  assert.equal(checkWastePick({ name: 'a.jpg', type: 'image/jpeg', size: 10 }, 'photo', 'after', photos).ok, true);
  const videos = Array.from({ length: 5 }, () => ({ kind: 'video' as const, phase: 'after' as const }));
  assert.equal(checkWastePick({ name: 'a.mp4', type: 'video/mp4', size: 10 }, 'video', 'after', videos).ok, false);
  const big = checkWastePick({ name: 'a.mov', type: '', size: 157_286_401 }, 'video', 'before', []);
  assert.equal(big.ok, false);
  assert.match(big.ok ? '' : big.message, /1080p/);
  assert.equal(checkWastePick({ name: 'a.avi', type: 'video/x-msvideo', size: 10 }, 'video', 'before', []).ok, false);
  assert.equal(wasteMediaPath('u', 'r', 'after', 'f', 'mp4'), 'u/r/after/f.mp4');
  assert.equal(wasteThumbPath('u', 'r', 'after', 'f'), 'u/r/after/f.thumb.jpg');
  assert.equal(formatWorkDates('2026-11-01', '2026-11-01'), '1 Nov 2026');
  assert.equal(formatWorkDates('2026-10-31', '2026-11-01'), '31 Oct – 1 Nov 2026');
});

// ---- screens -------------------------------------------------------------------------------------------------------------------------
function media(over: Partial<WasteMedia>): WasteMedia {
  return {
    id: 'm1', ownerId: 'u', reportId: 'r', kind: 'photo', phase: 'before', blob: new Blob(['x']), fileName: 'a.jpg', mime: 'image/jpeg', ext: 'jpg', sizeBytes: 1,
    sourceKey: 'k', durationSeconds: null, thumbnail: null, storagePath: 'p', thumbPath: null, fileUploaded: false, thumbUploaded: false, tusUrl: null, status: 'pending',
    progress: 0, lastError: null, permanentFailure: false, attempts: 0, nextAttemptAt: null, sortOrder: 0, createdAt: '2026-11-03T10:00:00Z', ...over,
  };
}

test('a section shows each file’s upload state; a rejected file explains why; a locked section has no add/remove buttons', () => {
  const props = { phase: 'before' as const, progressOf: (id: string) => (id === 'm2' ? 0.42 : null), previewUrl: () => 'blob:x', addError: null, onAdd: () => {}, onRemove: () => {}, onRetry: () => {} };
  const list = [
    media({ id: 'm1', status: 'ready' }),
    media({ id: 'm2', kind: 'video', status: 'uploading', durationSeconds: 33 }),
    media({ id: 'm3', status: 'failed', permanentFailure: true, lastError: 'That video is 1:05 long. The limit is 1:00.' }),
    media({ id: 'm4', status: 'failed', lastError: 'The upload was interrupted. Tried 6 times.' }),
  ];
  const html = renderToStaticMarkup(<WasteMediaSection {...props} media={list} locked={false} />);
  assert.match(html, /✓ Uploaded/);
  assert.match(html, /Uploading 42%/);
  assert.match(html, /▶ 0:33/);
  assert.match(html, /1:05 long\. The limit is 1:00\. Remove it to send the report\./);
  assert.match(html, /Try again/);
  assert.match(html, /\+ Photo/);
  assert.match(html, /Remove before photo/);
  const locked = renderToStaticMarkup(<WasteMediaSection {...props} media={list} locked />);
  assert.doesNotMatch(locked, /\+ Photo|Remove before/);
});

test('My reports is read-only (no edit or delete), and lists reports still sending first', () => {
  const draft = { reportId: 'r9', address: '9 Sending St', permanentFailure: false } as WasteDraft;
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <MyWasteReportsList sending={[draft]} reports={[{ id: 'r1', address: '1 High St', startDate: '2026-11-01', endDate: '2026-11-02', submittedAt: '2026-11-03T09:00:00Z', photoCount: 3, videoCount: 1 }]} />
    </MemoryRouter>,
  );
  assert.ok(html.indexOf('9 Sending St') < html.indexOf('1 High St'));
  assert.match(html, /Sending…/);
  assert.match(html, /1 Nov – 2 Nov 2026 · 3 photos · 1 video/);
  assert.doesNotMatch(html, /Edit|Delete|Remove/);
});

test('the Sent screen: sending / refused while on the phone; "sent" only once the server lists it', () => {
  const base = { reportId: 'r', submitRequested: true, permanentFailure: false } as WasteDraft;
  assert.equal(sentStateFor(undefined, [], null).kind, 'loading');
  const s = sentStateFor(base, [media({ status: 'ready' }), media({ id: 'm2' })], null);
  assert.deepEqual(s.kind === 'sending' && [s.ready, s.total], [1, 2]);
  assert.equal(sentStateFor({ ...base, permanentFailure: true }, [], null).kind, 'refused');
  assert.equal(sentStateFor(null, [], null).kind, 'loading');
  assert.equal(sentStateFor(null, [], true).kind, 'sent');
  assert.equal(sentStateFor(null, [], false).kind, 'unknown');
});

// ---- 2026-11-04: a report blocked by a file no longer says "Sending..." --------------------------------------------------------------
test('STUCK FIX: My reports says "Sending…" only while it really is on its way; waiting for signal and needing attention are told apart', () => {
  const d = { reportId: 'r', address: '1 High St', permanentFailure: false } as WasteDraft;
  const sum = (list: WasteMedia[]) => summarizeWasteUploads(list);
  assert.deepEqual(sendingRowLabel(d, sum([media({ status: 'ready' }), media({ id: 'm2', status: 'uploading' })])), { text: 'Sending… - 1 of 2 uploaded', attention: false });
  assert.deepEqual(sendingRowLabel(d, sum([media({ status: 'ready' }), media({ id: 'm2', status: 'pending', lastError: 'Load failed', nextAttemptAt: '2026-11-04T10:00:00Z' })])), {
    text: 'Waiting for signal - 1 of 2 uploaded. It keeps trying by itself.',
    attention: false,
  });
  const refused = sendingRowLabel(d, sum([media({ status: 'ready' }), media({ id: 'm2', status: 'failed', permanentFailure: true, lastError: 'That file type isn’t accepted.' })]));
  assert.equal(refused.attention, true);
  assert.match(refused.text, /^Needs attention/);
  assert.match(sendingRowLabel({ ...d, permanentFailure: true }, sum([])).text, /Couldn’t be sent/);
  // an old-version "stopped" file is shown as waiting (the app retries it when it opens), never as "Sending…" with no hint
  assert.match(sendingRowLabel(d, sum([media({ status: 'failed', permanentFailure: false, lastError: 'Tried 6 times.' })])).text, /^Waiting for signal/);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <MyWasteReportsList sending={[d]} reports={[]} uploads={{ r: sum([media({ status: 'failed', permanentFailure: true, lastError: 'x' })]) }} />
    </MemoryRouter>,
  );
  assert.match(html, /Needs attention - a photo or video wasn’t accepted\. Tap to fix it\./);
});

test('STUCK FIX: the sending screen tells "needs attention" (with the reasons and one button to fix it) from "still sending" (with Try now)', () => {
  const base = { reportId: 'r', submitRequested: true, permanentFailure: false } as WasteDraft;
  const blocked = sentStateFor(base, [media({ status: 'ready' }), media({ id: 'm2', status: 'failed', permanentFailure: true, lastError: 'That video is 1:05 long. The limit is 60 seconds.' })], null);
  assert.ok(blocked.kind === 'sending' && blocked.failed === 1 && blocked.uploads.reasons[0].includes('1:05'));
  const retrying = sentStateFor(base, [media({ status: 'pending', lastError: 'Load failed', nextAttemptAt: '2026-11-04T10:00:00Z' })], null);
  assert.ok(retrying.kind === 'sending' && retrying.failed === 0 && retrying.uploads.retrying === 1);
  const page = readFileSync(join(process.cwd(), 'src', 'waste', 'WasteReportSentPage.tsx'), 'utf8');
  assert.match(page, /Your report needs attention/);
  assert.match(page, /navigate\(`\/waste\?report=\$\{reportId\}`\)/, 'opens THAT report');
  assert.match(page, /retryWaitingUploads\(reportId\)/);
  assert.match(page, /state\.kind === 'sending' && state\.failed === 0/, '"will be sent by itself" is only said when nothing blocks it');
});

test('STUCK FIX: a file waiting to retry offers "Try again"; a refused one does not (it has to be removed)', () => {
  const props = { phase: 'before' as const, progressOf: () => null, previewUrl: () => 'blob:x', addError: null, onAdd: () => {}, onRemove: () => {}, onRetry: () => {}, locked: false };
  assert.match(renderToStaticMarkup(<WasteMediaSection {...props} media={[media({ status: 'pending', lastError: 'Load failed' })]} />), /Waiting to retry[\s\S]*Try again/);
  assert.doesNotMatch(renderToStaticMarkup(<WasteMediaSection {...props} media={[media({ status: 'failed', permanentFailure: true, lastError: 'No.' })]} />), /Try again/);
});
