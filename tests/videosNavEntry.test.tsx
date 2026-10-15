// The "Videos without a report" left-rail entry is shown only while its count is above zero.
//
// It lists visits where a video exists but no report has been submitted. Most of the time that is nothing, and a
// permanent "0" row in a list headed "Needs you" is clutter - so the row is a pure function of the live count and
// comes back by itself when a video arrives before its report, or a cancelled job keeps a visit that has one.
//
// What this does NOT change, and is asserted below: the route, the page, the query, the cancellation behaviour and
// every video and visit. Only the row's visibility moved.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import NavRail from '../src/components/shell/NavRail';
import { AuthContext } from '../src/auth/AuthProvider';
import type { VisitWithVideosNoReport } from '../src/repository/reportVideosRepository';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };

const visit = (id: string, over: Partial<VisitWithVideosNoReport> = {}): VisitWithVideosNoReport => ({
  visitId: id, scheduledDate: '2026-10-20', visitStatus: 'booked', jobId: `j-${id}`, jobSummary: 'Communal cleaning',
  jobLifecycleStatus: 'active', buildingId: `b-${id}`, buildingName: 'Flair House', buildingAddress: '1 Test Way',
  clientName: 'ABC Property', videos: [], ...over,
});

/** A cache seeded like the other nav tests, with the video-visits list under test. */
function cache(videoVisits: VisitWithVideosNoReport[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['videosWithoutReport'], videoVisits);
  for (const k of ['jobRows', 'historicalJobRows', 'buildingRows', 'technicians', 'users']) qc.setQueryData([k], []);
  qc.setQueryData(['jobRows', 'openReportWork'], []);
  return qc;
}

function rail(qc: QueryClient, path = '/jobs') {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[path]}>
          <NavRail />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const ENTRY = /Videos without a report/;
const count = (html: string) => /title="Videos without a report"[^>]*>(?:<i[^>]*><\/i>)?Videos without a report<b[^>]*>([0-9]+)<\/b>/.exec(html)?.[1];

// ---- zero ---------------------------------------------------------------------------------------------------------
test('ZERO: the entry is not in the rail at all', () => {
  const html = rail(cache([]));
  assert.doesNotMatch(html, ENTRY);
  assert.doesNotMatch(html, /videos-without-report/);
});

test('ZERO: nothing is left behind — no empty row, no stray "0" in its place', () => {
  const html = rail(cache([]));
  assert.doesNotMatch(html, /title="Videos without a report"/);
  // the other two queue entries are still there, in order
  assert.match(html, /Ready for accounts/);
  assert.match(html, /Ready for client/);
  assert.ok(html.indexOf('Ready for accounts') < html.indexOf('Ready for client'));
});

test('ZERO: the rest of the rail is untouched (same views, same Needs-you entries)', () => {
  const withEntry = rail(cache([visit('a')]));
  const without = rail(cache([]));
  const strip = (h: string) => h.replace(/<div[^>]*title="Videos without a report"[\s\S]*?<\/div>/, '');
  for (const label of ['All live jobs', 'Buildings', 'Schedule', 'Monthly plan', 'Month matrix', 'Report review', 'Users', 'Historical jobs', 'Ready for accounts', 'Ready for client']) {
    assert.match(without, new RegExp(label), `${label} is still there`);
  }
  assert.equal(strip(without).length > 0, true);
  assert.ok(withEntry.length > without.length, 'the entry is the only difference in size');
});

// ---- non-zero -----------------------------------------------------------------------------------------------------
test('NON-ZERO: the entry is shown, with the current count', () => {
  const html = rail(cache([visit('a')]));
  assert.match(html, ENTRY);
  assert.equal(count(html), '1');
});

test('NON-ZERO: the count is the number of VISITS, not videos', () => {
  const html = rail(cache([visit('a'), visit('b'), visit('c')]));
  assert.equal(count(html), '3');
});

test('NON-ZERO: it keeps its place between Ready for client and the divider, and its highlight on its own page', () => {
  const html = rail(cache([visit('a')]), '/videos-without-report');
  assert.ok(html.indexOf('Ready for client') < html.indexOf('Videos without a report'));
  assert.ok(html.indexOf('Videos without a report') < html.indexOf('Views of the same data'));
  assert.match(html, /border-ink bg-neutral-200 font-semibold[^>]*>(?:<i[^>]*><\/i>)?Videos without a report/);
});

test('NON-ZERO includes a visit kept after its job was cancelled — it is a count of visits, whatever their state', () => {
  const kept = visit('k', { jobLifecycleStatus: 'cancelled', visitStatus: 'cancelled' });
  assert.equal(count(rail(cache([kept]))), '1');
});

// ---- the count changing -------------------------------------------------------------------------------------------
test('REAPPEARS: the same rail, one cache — hidden at 0, shown at 1, count follows, hidden again at 0', () => {
  const qc = cache([]);
  assert.doesNotMatch(rail(qc), ENTRY, 'starts hidden');

  qc.setQueryData(['videosWithoutReport'], [visit('a')]);
  assert.equal(count(rail(qc)), '1', 'a video arrives before its report: the entry is back');

  qc.setQueryData(['videosWithoutReport'], [visit('a'), visit('b')]);
  assert.equal(count(rail(qc)), '2', 'the count follows');

  qc.setQueryData(['videosWithoutReport'], [visit('b')]);
  assert.equal(count(rail(qc)), '1', 'and goes back down');

  qc.setQueryData(['videosWithoutReport'], []);
  assert.doesNotMatch(rail(qc), ENTRY, 'the last one is resolved: it goes away again');
});

test('REAPPEARS because the row is derived from the live query — not from any stored or remembered flag', () => {
  const raw = src('components/shell/NavRail.tsx');
  // The structural checks compare with quote style and wrapping normalised: they assert on what the code DOES, so an
  // auto-formatter (single vs double quotes, long lines wrapped) must not be able to fail them.
  const nav = raw.replace(/"/g, "'").replace(/\s+/g, ' ');
  assert.match(nav, /\{videoVisits\.length > 0 && \( ?<NavItem[\s\S]*?label='Videos without a report'[\s\S]*?count=\{videoVisits\.length\}/);
  assert.match(nav, /useQuery\(\{ ?queryKey: \['videosWithoutReport'\],? ?queryFn: listVisitsWithVideosNoReport,? ?\}\)/);
  // Comments are stripped from the RAW text (line comments end at a newline, which normalising would erase).
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /localStorage|sessionStorage|useState\([^)]*[Vv]ideo/, 'no persisted or local state decides visibility');
});

// ---- what stays exactly as it was ---------------------------------------------------------------------------------
test('UNCHANGED: the route, the page and the manager-only placement', () => {
  const app = src('App.tsx');
  const manager = app.slice(app.indexOf('<Route element={<AppShell />}>'));
  const technician = app.slice(app.indexOf('<TechnicianShell'), app.indexOf('<Route element={<AppShell />}>'));
  assert.match(manager, /path="\/videos-without-report" element=\{<VideosWithoutReportPage \/>\}/);
  assert.doesNotMatch(technician, /videos-without-report/);
});

test('UNCHANGED: the page is still reachable directly, and still shows its own empty state', () => {
  const page = src('pages/VideosWithoutReportPage.tsx');
  assert.match(page, /Nothing here — every visit with videos has a report/);
  assert.match(page, /queryKey: \['videosWithoutReport'\], queryFn: listVisitsWithVideosNoReport/);
  assert.match(page, /mode="noReport"/, 'the video management actions are still wired in');
});

test('UNCHANGED: cancellation still keeps a visit that has a video, and the query and grouping are untouched', () => {
  const cancel = src('lib/cancelWork.ts');
  assert.match(cancel, /else if \(v\.hasActiveVideo\) plan\.kept\.push\(\{ visit: v, reason: 'has_video' \}\)/);
  const repo = src('repository/reportVideosRepository.ts');
  assert.match(repo, /export async function listVisitsWithVideosNoReport\(\)/);
  assert.match(repo, /if \(one\(visit\.reports\)\) continue;/, 'a visit that has a report is still excluded');
});

test('THE CHANGE IS PRESENTATION ONLY: it adds no write, no query and no new import', () => {
  const nav = src('components/shell/NavRail.tsx');
  // No data-layer write. (`next.delete('status')` in this file is URLSearchParams tidying filters, not a database call, so
  // `.delete(` alone would be the wrong thing to forbid.)
  assert.doesNotMatch(nav, /removeReportVideo|supabase|upsert|createVisit|markVisit|cancelJobWork|from '\.\.\/\.\.\/repository\/(?!reportVideosRepository|jobsRepository|buildingsRepository|techniciansRepository|usersRepository)/);
  assert.equal((nav.match(/listVisitsWithVideosNoReport/g) ?? []).length, 2, 'still one import and one use of the existing query');
});
