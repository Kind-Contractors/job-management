// Phase 2 of manager video management, on the REAL components (server-rendered to static markup from a seeded query cache; there is no
// DOM library here):
//   1. Ready for client: videos grouped Before/During/After, play, per-video and report-level inclusion, "added after approval", the Completed
//      lock, removal - and everything that was already on that page unchanged;
//   2. "Videos without a report": a list of visits that have videos but no report, including visits kept on a cancelled job.
// What the buttons SEND is covered in reportVideosData.test.ts (soft delete only, never a hard delete) and the rules by the database suite.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import ReportVideos from '../src/components/reports/ReportVideos';
import ReadyForClientPage from '../src/pages/ReadyForClientPage';
import VideosWithoutReportPage, { VideosWithoutReportView, VisitVideosCard, isRetainedOnCancelledJob, phaseSummary } from '../src/pages/VideosWithoutReportPage';
import NavRail from '../src/components/shell/NavRail';
import { AuthContext } from '../src/auth/AuthProvider';
import { groupVisitsWithoutReport, listVisitsWithVideosNoReport, type ReportVideo, type VisitWithVideosNoReport } from '../src/repository/reportVideosRepository';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
const DONE = '2026-10-03T09:00:00Z';

function video(id: string, phase: 'before' | 'during' | 'after', over: Partial<ReportVideo> = {}): ReportVideo {
  return {
    id, visitId: 'va', phase, storagePath: `va/${phase}/${id}.mp4`, thumbnailPath: `va/${phase}/${id}.jpg`, mimeType: 'video/mp4', sizeBytes: 5 * 1024 * 1024, durationSeconds: 42,
    source: 'technician', uploadedByName: 'Mo', includeInClientReport: true, createdAt: '2026-10-01T10:00:00Z', ...over,
  };
}
const has = (html: string, text: string) => html.includes(text);
const disabledAttr = /\sdisabled=""/;

// ===== 1. Ready for client ==================================================================================================================
function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-01', status: 'completed', technicianId: 'mo', technicianName: 'Mo', additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'submitted',
    priceCharged: 100, completedAt: '2026-10-01T10:00:00Z', reportId: `rep-${id}`, reportReviewStatus: 'approved', sentToClientAt: null, sentToAccountsAt: null,
    reportCompletedAt: null, reportCompletedBy: null, invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, buildingName: string, visits: any[]): any {
  return {
    id, buildingId: `b-${id}`, buildingName, clientId: 'c1', clientName: 'Acme Ltd', jobSummary: `${buildingName} cleaning`, division: 'General', visits,
    clientContacts: [{ id: 'ct1', name: 'Sam Client', email: 'sam@acme.test', phoneNumber: null, isPrimary: true, isAccountsContact: false }],
  };
}
function reportFor(visitId: string, over: Record<string, unknown> = {}): any {
  return {
    id: `rep-${visitId}`, visitId, submittedBy: 'Mo', submittedAt: '2026-10-01T11:00:00Z', onSiteStart: null, onSiteEnd: null, workCarriedOut: 'Cleaned the windows', technicianNotes: null, issues: null,
    specMet: true, reviewStatus: 'approved', reviewedBy: 'luke', reviewedAt: '2026-10-01T12:00:00Z', returnReason: null, includePhotos: true, includeNotes: true, includeIssues: true, includePrice: false,
    includeVideos: true, sentToClientAt: null, sentToClientBy: null, sentToAccountsAt: null, sentToAccountsBy: null, completedAt: null, completedBy: null, ...over,
  };
}

function clientPage(opts: { completed?: boolean; videos?: ReportVideo[]; reportOver?: Record<string, unknown>; withVideoSeed?: boolean } = {}) {
  const v = opts.completed ? visit('va', { reportCompletedAt: DONE, reportCompletedBy: 'luke@kindcontractors.co.uk' }) : visit('va');
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['jobRows'], [job('ja', 'Alpha Court', [v])]);
  qc.setQueryData(['report', 'rep-va'], reportFor('va', opts.completed ? { completedAt: DONE, completedBy: 'luke@kindcontractors.co.uk', ...opts.reportOver } : { ...opts.reportOver }));
  qc.setQueryData(['reportPhotos', 'rep-va'], []);
  qc.setQueryData(['clientSend', 'rep-va'], null);
  if (opts.withVideoSeed !== false) qc.setQueryData(['reportVideos', 'va'], opts.videos ?? []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <ReadyForClientPage initialView={opts.completed ? 'completed' : 'awaiting'} initialSelectedVisitId="va" />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
const phaseBlock = (html: string, phase: string) => {
  const start = html.indexOf(`data-testid="video-phase-${phase}"`);
  assert.ok(start >= 0, `${phase} section is shown`);
  const rest = ['before', 'during', 'after'].map((p) => html.indexOf(`data-testid="video-phase-${p}"`, start + 10)).filter((i) => i > start);
  return html.slice(start, rest.length ? Math.min(...rest) : undefined);
};
const cards = (html: string) => html.split('data-testid="video-card"').slice(1);

test('READY FOR CLIENT: the client-visible content now has a Videos block, grouped Before / During / After', () => {
  const html = clientPage({ videos: [video('a', 'before'), video('b', 'during'), video('c', 'during'), video('d', 'after')] });
  assert.match(html, /Videos — select which to include/);
  assert.match(phaseBlock(html, 'before'), /Before \(1\/3\)/);
  assert.match(phaseBlock(html, 'during'), /During \(2\/3\)/);
  assert.match(phaseBlock(html, 'after'), /After \(1\/3\)/);
  assert.equal(cards(html).length, 4);
  const order = ['Report details', 'Client-visible content', 'Videos — select which to include', 'Recipient'].map((t) => html.indexOf(t));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), 'the block sits inside the client-visible content, before the recipient');
});

test('READY FOR CLIENT: no uploading here (that stays in Report review) - no Add buttons, no file pickers; empty sections say None', () => {
  const html = clientPage({ videos: [video('a', 'before')] });
  assert.doesNotMatch(html, /\+ Add video/);
  assert.doesNotMatch(html, /type="file"/);
  assert.doesNotMatch(html, /MP4, MOV or WebM/);
  assert.match(phaseBlock(html, 'during'), />None</);
  assert.match(phaseBlock(html, 'after'), />None</);
});

test('READY FOR CLIENT: each video has Play, its own Include tick (ticked by default) and Remove; there is no report-level switch', () => {
  const html = clientPage({ videos: [video('a', 'before'), video('b', 'before', { includeInClientReport: false })] });
  const [first, second] = cards(html);
  assert.match(first, /aria-label="Play Before video"/);
  assert.match(first, /<input type="checkbox"[^>]*\schecked=""[^>]*\/>\s*Include for client/);
  assert.match(second, /<input type="checkbox"(?![^>]*\schecked)[^>]*\/>\s*Include for client/);
  assert.match(first, />\s*Remove\s*<\/button>/);
  assert.doesNotMatch(html, /Include videos in the client report/);
  assert.doesNotMatch(html, /switched off for the client report/);
});

test('READY FOR CLIENT: an old report that has the hidden include_videos flag off shows no switch and no misleading message either', () => {
  const html = clientPage({ videos: [video('a', 'before')], reportOver: { includeVideos: false } });
  assert.doesNotMatch(html, /Include videos in the client report/);
  assert.doesNotMatch(html, /switched off for the client report/);
});

test('READY FOR CLIENT: it says plainly that ticked videos appear in the client report as a "Watch video" link (client links are live; the old "not yet" note is gone)', () => {
  const html = clientPage({ videos: [video('a', 'before')] });
  assert.match(html, /data-testid="videos-in-report-note"[^>]*>\s*Each ticked video appears in the client report as a thumbnail with a “Watch video” link/);
  assert.doesNotMatch(html, /not part of the emailed or downloaded report yet/);
  assert.doesNotMatch(html, /videos-not-yet-sent-note/);
});

test('READY FOR CLIENT: a video that arrived after the report was approved is flagged; earlier ones are not', () => {
  const html = clientPage({ videos: [video('old', 'before', { createdAt: '2026-10-01T09:00:00Z' }), video('late', 'before', { createdAt: '2026-10-02T09:00:00Z' })] });
  const [old, late] = cards(html);
  assert.doesNotMatch(old, /Added after approval/);
  assert.match(late, /Added after approval/);
});

test('READY FOR CLIENT, COMPLETED: the ticks are locked with the reason (Reopen first); Remove is still offered', () => {
  const html = clientPage({ completed: true, videos: [video('a', 'before', { includeInClientReport: true })] });
  assert.match(html, /This report is Completed, so the “Include” choices can’t be changed \(Reopen it first\)\. A video can still be removed\./);
  assert.match(cards(html)[0], /<input type="checkbox"[^>]*\sdisabled=""[^>]*\/>\s*Include for client/);
  assert.match(cards(html)[0], />\s*Remove\s*<\/button>/);
  assert.ok(has(html, 'Completed'), 'the completed banner is still there');
});

test('READY FOR CLIENT, NOT COMPLETED: the ticks are enabled', () => {
  const html = clientPage({ videos: [video('a', 'before')] });
  assert.doesNotMatch(cards(html)[0], /<input type="checkbox"[^>]*\sdisabled=""/);
  assert.doesNotMatch(html, /report is Completed/);
});

test('READY FOR CLIENT: removal asks first and only shows videos that are NOT removed (the list is whatever the database returned for active videos)', () => {
  // the repository query for this list filters deleted_at is null (reportVideosData.test.ts); a removed video therefore never reaches the page
  const html = clientPage({ videos: [video('kept', 'before')] });
  assert.equal(cards(html).length, 1);
  assert.doesNotMatch(html, /alertdialog/, 'no confirmation is open until Remove is pressed');
});

test('READY FOR CLIENT: everything that was already on the page is still there and unchanged (photos, notes, recipient, send, PDF, completion)', () => {
  const html = clientPage({ videos: [video('a', 'before')] });
  for (const text of ['Include notes', 'Include issues', 'Include photos', 'Photos — select which to include', 'Recipient', 'Report details', 'Work carried out', 'Cleaned the windows']) {
    assert.ok(has(html, text), `still shows "${text}"`);
  }
  assert.match(html, /Choose a recipient…/);
  assert.match(html, /Open building file/);
  const before = clientPage({ withVideoSeed: false });
  assert.ok(has(before, 'Include photos') && has(before, 'Recipient'), 'and the page renders while the videos are still loading');
  assert.match(before, /Loading videos…/);
});

test('READY FOR CLIENT: no video controls appear for a report that is not selected, and the awaiting-review Report review page is not changed by this (review mode keeps its upload controls)', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['reportVideos', 'va'], [video('a', 'before')]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReportVideos reportId="r1" visitId="va" reviewStatus="awaiting_review" reviewedAt={null} completed={false} actor="luke@x" />
    </QueryClientProvider>,
  );
  assert.equal((html.match(/\+ Add video/g) ?? []).length, 3, 'review mode: an Add button per section');
  assert.match(html, /MP4, MOV or WebM · up to 150 MB/);
});

// ===== 2. Videos without a report ============================================================================================================
const A: VisitWithVideosNoReport = {
  visitId: 'va', scheduledDate: '2026-10-08', visitStatus: 'booked', jobId: 'ja', jobSummary: 'Window cleaning', jobLifecycleStatus: 'active', buildingId: 'b1',
  buildingName: 'Alpha Court', buildingAddress: '1 High St', clientName: 'Acme Ltd', videos: [video('a1', 'before'), video('a2', 'before'), video('a3', 'after', { uploadedByName: 'Sam' })],
};
const B: VisitWithVideosNoReport = {
  visitId: 'vb', scheduledDate: '2026-09-20', visitStatus: 'booked', jobId: 'jb', jobSummary: 'Gutters', jobLifecycleStatus: 'cancelled', buildingId: 'b2',
  buildingName: 'Bravo House', buildingAddress: '2 Low Rd', clientName: 'Bravo Ltd', videos: [video('b1', 'during', { visitId: 'vb' })],
};

function listPage(seed: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <VideosWithoutReportPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

test('NO REPORT: each visit is identified by client, building, job, visit date, video count, sections and who uploaded', () => {
  const html = listPage((qc) => qc.setQueryData(['videosWithoutReport'], [A, B]));
  assert.match(html, /Videos without a report/);
  assert.match(html, /2 visits/);
  const [first] = html.split('data-testid="visit-with-videos"').slice(1);
  assert.match(first, /Alpha Court/);
  assert.match(first, /Acme Ltd · Window cleaning · Visit 08\/10\/2026/);
  assert.match(first, /3 videos · Before 2 · After 1/);
  assert.match(first, /from Mo, Sam/);
  assert.match(first, />View videos</);
  assert.match(first, />Open building file</);
});

test('NO REPORT: a visit kept on a CANCELLED job is marked, and explained honestly (kept for its video; nothing else changes when a video is removed)', () => {
  const html = listPage((qc) => qc.setQueryData(['videosWithoutReport'], [A, B]));
  const [a, b] = html.split('data-testid="visit-with-videos"').slice(1);
  assert.doesNotMatch(a, /Kept after the job was cancelled/);
  assert.match(b, /Kept after the job was cancelled/);
  assert.match(b, /kept when its job was cancelled because it has a video\. It stays open until the technician submits a report, or the videos are removed below\. Removing a video keeps its file; nothing else changes\./);
  assert.equal(isRetainedOnCancelledJob(B), true);
  assert.equal(isRetainedOnCancelledJob(A), false);
  assert.equal(isRetainedOnCancelledJob({ jobLifecycleStatus: 'active', visitStatus: 'cancelled' }), true, 'a cancelled visit counts too');
});

test('NO REPORT: collapsed by default (no video loads until asked); expanded it offers play and remove - and NOTHING that only makes sense with a report', () => {
  const collapsed = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <VisitVideosCard visit={A} expanded={false} actor="luke@x" onToggle={noop} onOpenBuilding={noop} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  assert.doesNotMatch(collapsed, /data-testid="report-videos"/);
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['reportVideos', 'va'], A.videos);
  const open = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <VisitVideosCard visit={A} expanded actor="luke@x" onToggle={noop} onOpenBuilding={noop} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  assert.match(open, />Hide videos</);
  assert.equal(cards(open).length, 3);
  assert.match(cards(open)[0], /aria-label="Play Before video"/);
  assert.match(cards(open)[0], />\s*Remove\s*<\/button>/);
  assert.doesNotMatch(open, /Include for client/, 'there is no report to include them in');
  assert.doesNotMatch(open, /Include videos in the client report/);
  assert.doesNotMatch(open, /\+ Add video/);
  assert.doesNotMatch(open, /type="file"/);
  assert.match(phaseBlock(open, 'during'), />None</);
});

test('NO REPORT: empty and loading states say what they mean', () => {
  assert.match(listPage((qc) => qc.setQueryData(['videosWithoutReport'], [])), /Nothing here — every visit with videos has a report/);
  assert.match(listPage(() => {}), />Loading…</);
  const failed = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <VideosWithoutReportView visits={[]} isLoading={false} isError error={new Error('Failed to load videos without a report: boom')} onRetry={noop} expanded={new Set()} actor="luke@x" onToggle={noop} onOpenBuilding={noop} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  assert.match(failed, /role="alert"[^>]*>\s*Couldn’t load these visits: Failed to load videos without a report: boom/);
  assert.match(failed, />Try again</);
});

test('NO REPORT: helper wording - sections that have a video, in order, with counts', () => {
  assert.equal(phaseSummary([{ phase: 'after' }, { phase: 'before' }, { phase: 'before' }]), 'Before 2 · After 1');
  assert.equal(phaseSummary([{ phase: 'during' }]), 'During 1');
});

// ---- the grouping and the query ---------------------------------------------------------------------------------------------------------
function vrow(id: string, phase: string, visit: any, over: Record<string, unknown> = {}): any {
  return {
    id, visit_id: visit?.id ?? 'x', phase, storage_path: `p/${id}.mp4`, thumbnail_path: null, mime_type: 'video/mp4', size_bytes: 1000, duration_seconds: '12.50', source: 'technician',
    include_in_client_report: false, created_at: '2026-10-01T10:00:00Z', technicians: { name: 'Mo' }, visits: visit, ...over,
  };
}
const visitEmbed = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, scheduled_date: date, status: 'booked', reports: [], jobs: { id: `j-${id}`, job_summary: 'Job', lifecycle_status: 'active', buildings: { id: `b-${id}`, name: `Building ${id}`, address: 'Addr', clients: { company_name: `Client ${id}` } } }, ...over,
});

test('GROUPING: videos are grouped by visit; a visit WITH a report is left out whatever shape the database returns it in', () => {
  const rows = [
    vrow('v1', 'before', visitEmbed('A', '2026-10-01')),
    vrow('v2', 'after', visitEmbed('A', '2026-10-01')),
    vrow('v3', 'before', visitEmbed('B', '2026-10-05', { reports: [{ id: 'r' }] })), // has a report (array)
    vrow('v4', 'before', visitEmbed('C', '2026-10-07', { reports: { id: 'r' } })), // has a report (single object)
    vrow('v5', 'during', visitEmbed('D', '2026-10-09', { reports: null })), // no report (null)
    vrow('v6', 'during', null), // no visit at all
  ];
  const g = groupVisitsWithoutReport(rows);
  assert.deepEqual(g.map((v) => v.visitId), ['D', 'A'], 'newest visit first; B and C have reports');
  assert.deepEqual(g.find((v) => v.visitId === 'A')!.videos.map((v) => v.id), ['v1', 'v2']);
});

test('GROUPING: client, building, job and the cancelled-job state come through (building / client may arrive as arrays)', () => {
  const g = groupVisitsWithoutReport([
    vrow('v1', 'before', { id: 'A', scheduled_date: '2026-10-01', status: 'booked', reports: [], jobs: { id: 'jA', job_summary: 'Gutters', lifecycle_status: 'cancelled', buildings: [{ id: 'bA', name: 'Alpha', address: '1 St', clients: [{ company_name: 'Acme' }] }] } }),
  ]);
  assert.deepEqual({ ...g[0], videos: undefined }, {
    visitId: 'A', scheduledDate: '2026-10-01', visitStatus: 'booked', jobId: 'jA', jobSummary: 'Gutters', jobLifecycleStatus: 'cancelled', buildingId: 'bA', buildingName: 'Alpha', buildingAddress: '1 St', clientName: 'Acme', videos: undefined,
  });
  assert.equal(g[0].videos[0].durationSeconds, 12.5);
  assert.equal(g[0].videos[0].uploadedByName, 'Mo');
});

test('QUERY: asks only for videos that are not removed, with the visit, its report, job, building and client; failures are reported', async () => {
  const log: { url: URL }[] = [];
  let fail = false;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    log.push({ url });
    if (fail) return new Response(JSON.stringify({ message: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify([vrow('v1', 'before', visitEmbed('A', '2026-10-01'))]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r = await listVisitsWithVideosNoReport();
  assert.equal(r.length, 1);
  assert.equal(log[0].url.pathname, '/rest/v1/report_videos');
  assert.match(decodeURIComponent(log[0].url.search), /deleted_at=is\.null/, 'removed videos are never listed');
  const select = decodeURIComponent(log[0].url.searchParams.get('select') ?? '');
  assert.ok(select.includes('visits(id,scheduled_date,status,reports(id),jobs(id,job_summary,lifecycle_status,buildings(id,name,address,clients(company_name))))'), select);
  assert.equal(log.every((l) => l.url.pathname.startsWith('/rest/v1/')), true, 'only the database is queried - no storage object is touched');
  fail = true;
  await assert.rejects(listVisitsWithVideosNoReport(), /Failed to load videos without a report: boom/);
});

// ---- navigation ---------------------------------------------------------------------------------------------------------------------------
test('NAV: "Videos without a report" is in the Needs you list with a count of visits', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={(() => { const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }); qc.setQueryData(['videosWithoutReport'], [A, B]); for (const k of ['jobRows', 'historicalJobRows', 'buildingRows', 'technicians', 'users']) qc.setQueryData([k], []); qc.setQueryData(['jobRows', 'openReportWork'], []); return qc; })()}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/videos-without-report']}>
          <NavRail />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  const m = /title="Videos without a report"[^>]*>(?:<i[^>]*><\/i>)?Videos without a report<b[^>]*>([0-9]+)<\/b>/.exec(html);
  assert.ok(m, 'the nav row is there');
  assert.equal(m![1], '2');
  assert.match(html, /border-ink bg-neutral-200 font-semibold[^>]*>(?:<i[^>]*><\/i>)?Videos without a report/, 'highlighted on its own page');
});

test('ROUTE: the page is part of the MANAGER route tree only (technicians have a separate tree and never reach it)', () => {
  const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
  const manager = app.slice(app.indexOf('<Route element={<AppShell />}>'));
  const technician = app.slice(app.indexOf('<TechnicianShell'), app.indexOf('<Route element={<AppShell />}>'));
  assert.match(manager, /path="\/videos-without-report" element=\{<VideosWithoutReportPage \/>\}/);
  assert.doesNotMatch(technician, /videos-without-report/);
});
