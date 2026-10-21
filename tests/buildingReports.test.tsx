// Job reports on the Building screen: a visit's client report becomes downloadable there once it is marked Completed or sent
// to the client (completing a JOB requires its reports to be Completed first), it stays there for completed/closed jobs, each
// report appears once, and the download is the Send to client screen's own (same model, same PDF generator, same file name).
// Pure rules tested directly; the panel rendered to static markup (there is no DOM library in this repo).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import BuildingReportsPanel, { ReportViewerDialog } from '../src/components/buildings/BuildingReportsPanel';
import SkippedPhotosDialog from '../src/components/reports/SkippedPhotosDialog';
import { MIN_PHOTO_SIDE_PT, PhotoLightbox, imageBoxesFromOperatorList, pdfLinkToPageLink, zoomablePhotoBoxes } from '../src/components/reports/PdfDocumentView';
import { buildingReports, isReportAvailableForBuilding } from '../src/lib/buildingReports';
import {
  finishClientReportDownload,
  generateClientReportBlob,
  prepareClientReportDownload,
  reportPdfFileName,
  type ClientReportDownloadDeps,
} from '../src/lib/clientReportDownload';

const SENT = '2026-10-02T09:00:00Z';
const DONE = '2026-10-03T09:00:00Z';
function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-01', status: 'completed', technicianId: 'mo', technicianName: 'Mo', additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'submitted',
    priceCharged: 100, completedAt: '2026-10-01T10:00:00Z', reportId: `rep-${id}`, reportReviewStatus: 'approved', sentToClientAt: null, sentToAccountsAt: null,
    reportCompletedAt: null, reportCompletedBy: null, invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, buildingId: string, visits: any[], over: Record<string, unknown> = {}): any {
  return { id, buildingId, buildingName: 'Oak Court', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: `Job ${id}`, division: 'General', lifecycleStatus: 'active', visits, clientContacts: [], ...over };
}
function reportFor(visitId: string, over: Record<string, unknown> = {}): any {
  return {
    id: `rep-${visitId}`, visitId, submittedBy: 'Mo', submittedAt: '2026-10-01T11:00:00Z', onSiteStart: null, onSiteEnd: null, workCarriedOut: 'Cleaned the windows', technicianNotes: 'Note', issues: 'Issue',
    specMet: true, reviewStatus: 'approved', reviewedBy: 'luke', reviewedAt: '2026-10-01T12:00:00Z', returnReason: null, includePhotos: true, includeNotes: true, includeIssues: false, includePrice: false,
    includeVideos: false, sentToClientAt: null, sentToClientBy: null, sentToAccountsAt: null, sentToAccountsBy: null, completedAt: null, completedBy: null, ...over,
  };
}

// ---- which reports appear -----------------------------------------------------------------------------------------------------------
test('AVAILABLE after the report is marked Completed (delivered by hand, never emailed)', () => {
  const r = buildingReports('b1', [job('j1', 'b1', [visit('v1', { reportCompletedAt: DONE })])]);
  assert.deepEqual(r.available.map((e) => [e.reportId, e.completedAt, e.sentToClientAt]), [['rep-v1', DONE, null]]);
});

test('AVAILABLE after the report is sent to the client through Send to client (even before it is marked Completed)', () => {
  const r = buildingReports('b1', [job('j1', 'b1', [visit('v1', { sentToClientAt: SENT })])]);
  assert.deepEqual(r.available.map((e) => [e.reportId, e.sentToClientAt, e.completedAt]), [['rep-v1', SENT, null]]);
});

test('NO DUPLICATES: a report both sent and completed is ONE entry with both facts; a job listed in both lists counts once', () => {
  const both = job('j1', 'b1', [visit('v1', { sentToClientAt: SENT, reportCompletedAt: DONE })]);
  const r = buildingReports('b1', [both], [both], [{ ...both }]);
  assert.equal(r.available.length, 1);
  assert.deepEqual([r.available[0].sentToClientAt, r.available[0].completedAt], [SENT, DONE]);
});

test('a COMPLETED job (historical list) keeps its reports here', () => {
  const closed = job('j9', 'b1', [visit('v9', { reportCompletedAt: DONE })], { lifecycleStatus: 'completed' });
  const r = buildingReports('b1', [], [closed]);
  assert.deepEqual(r.available.map((e) => e.job.id), ['j9']);
});

test('NOT YET AVAILABLE: in review, returned, or approved but neither completed nor sent - counted, never offered; no report at all is ignored', () => {
  const r = buildingReports('b1', [
    job('j1', 'b1', [
      visit('a', { reportReviewStatus: 'awaiting_review' }),
      visit('b', { reportReviewStatus: 'returned_for_correction' }),
      visit('c'),
      visit('d', { reportId: null, reportReviewStatus: null }),
    ]),
  ]);
  assert.equal(r.available.length, 0);
  assert.equal(r.notYetAvailable, 3);
  assert.equal(isReportAvailableForBuilding(visit('x', { reportId: null, sentToClientAt: SENT })), false, 'no report id: nothing to download');
});

test('JOB/BUILDING ASSOCIATION: only this building\'s jobs, each entry carries its own job and visit; latest visit first', () => {
  const here = job('j1', 'b1', [visit('old', { scheduledDate: '2026-08-01', reportCompletedAt: DONE }), visit('new', { scheduledDate: '2026-09-15', sentToClientAt: SENT })]);
  const elsewhere = job('j2', 'b2', [visit('other', { reportCompletedAt: DONE })]);
  const r = buildingReports('b1', [here, elsewhere]);
  assert.deepEqual(r.available.map((e) => [e.reportId, e.job.id, e.visit.id]), [['rep-new', 'j1', 'new'], ['rep-old', 'j1', 'old']]);
  assert.equal(buildingReports('b2', [here, elsewhere]).available[0].job.id, 'j2');
});

// ---- the download -------------------------------------------------------------------------------------------------------------------
function fakeDeps(over: Partial<ClientReportDownloadDeps> = {}) {
  const calls: string[] = [];
  const saved: { blob: Blob; name: string }[] = [];
  const deps: ClientReportDownloadDeps = {
    getReport: async (id) => { calls.push(`getReport ${id}`); return reportFor('v1'); },
    listPhotos: async (id) => { calls.push(`listPhotos ${id}`); return [{ id: 'p1', phase: 'after', storagePath: 'x', uploadStatus: 'uploaded', includeInClientReport: true }]; },
    signPhotoUrls: async () => { calls.push('signPhotoUrls'); return { p1: 'https://signed/p1' }; },
    listVideos: async (visitId) => { calls.push(`listVideos ${visitId}`); return []; },
    prepareVideos: async () => { calls.push('prepareVideos'); return { videos: [], thumbnailsMissing: 0 }; },
    preparePhotos: async (m) => { calls.push('preparePhotos'); return { photos: m.photos.map((p) => ({ id: p.id, phase: p.phase, image: {} as any })), skippedCount: 0 }; },
    generatePdf: async () => { calls.push('generatePdf'); return new Blob(['%PDF']); },
    save: (blob, name) => { calls.push('save'); saved.push({ blob, name }); },
    ...over,
  };
  return { deps, calls, saved };
}

test('DOWNLOAD: the same steps as Send to client\'s Download PDF - videos before photos, then the PDF, saved under the same file name', async () => {
  const { deps, calls, saved } = fakeDeps();
  const j = job('j1', 'b1', [visit('v1', { reportCompletedAt: DONE })]);
  const prepared = await prepareClientReportDownload(j, j.visits[0], deps);
  await finishClientReportDownload(prepared, deps);
  assert.deepEqual(calls, ['getReport rep-v1', 'listPhotos rep-v1', 'signPhotoUrls', 'listVideos v1', 'prepareVideos', 'preparePhotos', 'generatePdf', 'save']);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'Oak-Court-report.pdf');
  assert.equal(reportPdfFileName({ buildingName: 'Oak Court' }), 'Oak-Court-report.pdf');
  // The model is the client-safe one: this job/visit, the report's chosen sections only.
  assert.equal(prepared.model.buildingName, 'Oak Court');
  assert.equal(prepared.model.jobSummary, 'Job j1');
  assert.equal(prepared.model.notes, 'Note');
  assert.equal(prepared.model.issues, null, 'excluded sections stay out');
  assert.deepEqual(prepared.model.photos.map((p) => p.id), ['p1']);
});

test('DOWNLOAD: a report that cannot be loaded, or that belongs to another visit, is refused with a message - nothing saved', async () => {
  const j = job('j1', 'b1', [visit('v1', { reportCompletedAt: DONE })]);
  const failing = fakeDeps({ getReport: async () => { throw new Error('Failed to load report: JSON object requested, multiple (or no) rows returned'); } });
  await assert.rejects(prepareClientReportDownload(j, j.visits[0], failing.deps), /The report could not be loaded, so nothing was downloaded/);
  const wrong = fakeDeps({ getReport: async () => reportFor('some-other-visit') });
  await assert.rejects(prepareClientReportDownload(j, j.visits[0], wrong.deps), /does not belong to this visit/);
  await assert.rejects(prepareClientReportDownload(j, visit('v2', { reportId: null }), fakeDeps().deps), /no report/);
  assert.equal(failing.saved.length + wrong.saved.length, 0);
});

test('DOWNLOAD: if video links cannot be made nothing is downloaded; skipped photos are reported to the caller before any save', async () => {
  const j = job('j1', 'b1', [visit('v1', { reportCompletedAt: DONE })]);
  const noLinks = fakeDeps({ prepareVideos: async () => { throw new Error('The video links could not be created, so nothing was sent or downloaded. Please try again.'); } });
  await assert.rejects(prepareClientReportDownload(j, j.visits[0], noLinks.deps), /video links could not be created/);
  assert.equal(noLinks.calls.includes('generatePdf'), false);
  const skipped = fakeDeps({ preparePhotos: async () => ({ photos: [], skippedCount: 1 }) });
  const prepared = await prepareClientReportDownload(j, j.visits[0], skipped.deps);
  assert.equal(prepared.photos.skippedCount, 1);
  assert.equal(skipped.saved.length, 0, 'nothing saved until the manager chooses to continue');
});

// ---- the panel ----------------------------------------------------------------------------------------------------------------------
const renderPanel = (jobLists: any[][], opts: { loading?: boolean; error?: boolean } = {}) =>
  renderToStaticMarkup(
    <BuildingReportsPanel buildingId="b1" jobLists={jobLists} historicalLoading={opts.loading ?? false} historicalError={opts.error ?? false} onRetryHistorical={() => {}} deps={fakeDeps().deps} />,
  ).replace(/&#x27;/g, "'");

test('PANEL: lists each available report with its job, visit, sent/completed facts and a Download PDF button', () => {
  const html = renderPanel([[job('j1', 'b1', [visit('v1', { scheduledDate: '2026-09-15', sentToClientAt: SENT, reportCompletedAt: DONE }), visit('v2')])]]);
  assert.match(html, /Job reports \(1\)/);
  assert.match(html, /Job j1<span[^>]*> · Visit 15\/09\/2026<\/span>/);
  assert.match(html, /Sent to client [^<]+ · Completed /);
  assert.equal((html.match(/>Download PDF<\/button>/g) ?? []).length, 1);
  assert.match(html, /1 more report is not available yet: still in review, or not yet marked\s+Completed or sent to the client\./);
});

test('PANEL: nothing available says when a report will appear (no broken links); loading and load-failure are explained', () => {
  const empty = renderPanel([[job('j1', 'b1', [visit('v1')])]]);
  assert.match(empty, /No reports to download yet\. A report appears here once it is marked Completed or sent to the client in Ready for client\./);
  assert.doesNotMatch(empty, /Download PDF/);
  assert.match(renderPanel([[]], { loading: true }), /Loading reports…/);
  assert.match(renderPanel([[]], { error: true }), /Couldn't load completed and closed jobs, so their reports may be missing from this list\./);
});

// ---- wiring: the Building screen and Send to client ---------------------------------------------------------------------------------
const src = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8');

test('WIRING: the panel is on the Site file tab with active AND historical jobs; History (activity, work photos) is unchanged', () => {
  const page = src('pages', 'BuildingFilePage.tsx');
  assert.match(page, /queryKey: \['historicalJobRows'\], queryFn: listHistoricalJobRows/);
  assert.match(page, /<BuildingReportsPanel\s+buildingId=\{building\.id\}\s+jobLists=\{\[jobRows, historicalJobs\.data \?\? \[\]\]\}/);
  const site = page.slice(page.indexOf("{tab === 'site' ? ("), page.indexOf(') : (\n        <div className="flex flex-col gap-4">'));
  assert.match(site, /<BuildingReportsPanel/, 'on the Site file tab');
  assert.match(page, /queryFn: \(\) => listBuildingHistory\(buildingId!\)/);
  assert.match(page, /queryFn: \(\) => listBuildingPhotos\(buildingId!\)/);
});

test('WIRING: Send to client keeps its own download, now saving through the same shared file name and save; same skipped-photos dialog', () => {
  const page = src('pages', 'ReadyForClientPage.tsx');
  assert.match(page, /saveClientReportPdf\(blob, reportPdfFileName\(m\)\)/);
  assert.match(page, /import SkippedPhotosDialog from "\.\.\/components\/reports\/SkippedPhotosDialog"/);
  const panel = src('components', 'buildings', 'BuildingReportsPanel.tsx');
  for (const fn of ['generateClientReportPdf', 'prepareClientReportPhotos', 'prepareClientReportVideos', 'issueClientVideoLinks', 'getReport', 'saveClientReportPdf']) assert.match(panel, new RegExp(fn));
  assert.doesNotMatch(panel, /sendClientReport|completeReport|updateReport|storage\.from\(|\.upload\(/, 'the Building screen only downloads: it never sends, completes, edits or stores a report');
});

// ---- View report --------------------------------------------------------------------------------------------------------------------
test('VIEW: every row has View report beside Download PDF; each button acts on THAT row\'s report', () => {
  const html = renderPanel([[job('j1', 'b1', [visit('v1', { reportCompletedAt: DONE }), visit('v2', { sentToClientAt: SENT })])]]);
  assert.equal((html.match(/>View report<\/button>/g) ?? []).length, 2);
  assert.equal((html.match(/>Download PDF<\/button>/g) ?? []).length, 2);
  const panel = src('components', 'buildings', 'BuildingReportsPanel.tsx');
  assert.match(panel, /onClick=\{\(\) => void start\(entry, 'view'\)\}/);
  assert.match(panel, /onClick=\{\(\) => void start\(entry, 'download'\)\}/);
  assert.match(panel, /prepareClientReportDownload\(entry\.job, entry\.visit, deps\)/, 'the clicked row\'s own job and visit');
});

test('VIEW: opening a row loads that row\'s report only; a report of another visit (another job or building) is refused', async () => {
  const j1 = job('j1', 'b1', [visit('v1', { reportCompletedAt: DONE })]);
  const j2 = job('j2', 'b1', [visit('v2', { reportCompletedAt: DONE })]);
  const { deps, calls } = fakeDeps({ getReport: async (id) => { calls.push(`getReport ${id}`); return reportFor(id.replace('rep-', '')); } });
  const a = await prepareClientReportDownload(j1, j1.visits[0], deps);
  const b = await prepareClientReportDownload(j2, j2.visits[0], deps);
  assert.deepEqual(calls.filter((c) => c.startsWith('getReport')), ['getReport rep-v1', 'getReport rep-v2']);
  assert.deepEqual([a.model.jobSummary, b.model.jobSummary], ['Job j1', 'Job j2']);
  const crossed = fakeDeps({ getReport: async () => reportFor('v2') });
  await assert.rejects(prepareClientReportDownload(j1, j1.visits[0], crossed.deps), /does not belong to this visit/);
});

test('VIEW = DOWNLOAD: the viewer shows the very PDF Download PDF saves - one generator call with the same prepared report', async () => {
  const j = job('j1', 'b1', [visit('v1', { reportCompletedAt: DONE })]);
  const args: unknown[][] = [];
  const { deps, saved } = fakeDeps({ generatePdf: async (...a) => { args.push(a); return new Blob([`%PDF-${args.length}`]); } });
  const prepared = await prepareClientReportDownload(j, j.visits[0], deps);
  const viewedBlob = await generateClientReportBlob(prepared, deps);
  await finishClientReportDownload(prepared, deps);
  assert.equal(args.length, 2);
  assert.deepEqual(args[0], args[1], 'same model, photos and videos for view and download');
  assert.equal(await viewedBlob.text(), '%PDF-1');
  assert.equal(saved[0].name, 'Oak-Court-report.pdf');
  const panel = src('components', 'buildings', 'BuildingReportsPanel.tsx');
  assert.match(panel, /onDownload=\{\(\) => deps\.save\(viewed\.blob, viewed\.fileName\)\}/, 'Download inside the viewer saves the PDF being viewed');
});

test('VIEWER: a dialog with the report title, the report itself (drawn in the app), Download PDF and Close', () => {
  const html = renderToStaticMarkup(<ReportViewerDialog title="Job j1 · Visit 15/09/2026" blob={new Blob(['%PDF'])} onDownload={() => {}} onClose={() => {}} />);
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Job report: Job j1 · Visit 15\/09\/2026"/);
  assert.match(html, /Displaying the report…/, 'the PDF is drawn after opening (not in static markup)');
  assert.doesNotMatch(html, /<iframe/, 'not the browser\'s PDF viewer, which would open video links in place of the report');
  assert.match(html, />Download PDF<\/button>/);
  assert.match(html, />Close<\/button>/);
  const panel = src('components', 'buildings', 'BuildingReportsPanel.tsx');
  assert.match(panel, /const closeViewer = \(\) => setViewed\(null\);/);
  assert.match(panel, /onClose=\{closeViewer\}/);
  assert.match(panel, /if \(e\.key === 'Escape'\) onClose\(\);/);
  assert.match(panel, /<PdfDocumentView blob=\{blob\}/);
});

// ---- video links in the viewer open in a NEW tab -------------------------------------------------------------------------------------
test('VIDEO LINKS: a link drawn by the report PDF (jsPDF, A4 in points) lands exactly over the same spot of the displayed page', () => {
  // Measured with the real libraries: jsPDF doc.link(100, 200, 150, 20, ...) on A4 is read back by pdf.js as rect [100, 621.89, 250, 641.89].
  const link = pdfLinkToPageLink({ subtype: 'Link', url: 'https://watch.test/v?t=abc', rect: [100, 621.89, 250, 641.89] }, { width: 595.28, height: 841.89 })!;
  assert.equal(link.url, 'https://watch.test/v?t=abc');
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.01, `${a} ~ ${b}`);
  near(link.left, (100 / 595.28) * 100);
  near(link.top, (200 / 841.89) * 100);
  near(link.width, (150 / 595.28) * 100);
  near(link.height, (20 / 841.89) * 100);
  const shifted = pdfLinkToPageLink({ subtype: 'Link', url: 'https://x.test', rect: [110, 631.89, 260, 651.89] }, { x0: 10, y0: 10, width: 595.28, height: 841.89 })!;
  near(shifted.left, link.left);
  near(shifted.top, link.top);
});

test('VIDEO LINKS: only web links become clickable - internal jumps, javascript: and malformed annotations are ignored', () => {
  const page = { width: 595.28, height: 841.89 };
  assert.equal(pdfLinkToPageLink({ subtype: 'Link', url: 'javascript:alert(1)', rect: [0, 0, 10, 10] }, page), null);
  assert.equal(pdfLinkToPageLink({ subtype: 'Link', url: 'file:///c:/x', rect: [0, 0, 10, 10] }, page), null);
  assert.equal(pdfLinkToPageLink({ subtype: 'Link', rect: [0, 0, 10, 10] }, page), null, 'internal destination');
  assert.equal(pdfLinkToPageLink({ subtype: 'Widget', url: 'https://x.test', rect: [0, 0, 10, 10] }, page), null);
  assert.equal(pdfLinkToPageLink({ subtype: 'Link', url: 'https://x.test', rect: [0, 0] }, page), null);
});

test('VIDEO LINKS: every link over the displayed report opens in a new tab, without giving the new tab access to the app', () => {
  const view = src('components', 'reports', 'PdfDocumentView.tsx');
  assert.match(view, /target="_blank"\s+rel="noopener noreferrer"/);
  assert.equal((view.match(/<a\b/g) ?? []).length, 1, 'the one link element is the new-tab one');
  assert.match(view, /isEvalSupported: false/);
  assert.match(view, /await import\('pdfjs-dist'\)/, 'pdf.js loads only when a report is opened');
});

test('VIEW: failures show under the row (nothing opens); unreadable photos ask first, with "View without them"', () => {
  const panel = src('components', 'buildings', 'BuildingReportsPanel.tsx');
  assert.match(panel, /setSkipped\(\{ reportId: entry\.reportId, action, title: reportTitle\(entry\), prepared \}\)/);
  assert.match(panel, /action === 'view' \? openViewer\(reportId, title, prepared\) : finishClientReportDownload\(prepared, deps\)/);
  const dialog = renderToStaticMarkup(<SkippedPhotosDialog count={2} action="view" onCancel={() => {}} onContinue={() => {}} />);
  assert.match(dialog, /You can view the report without them/);
  assert.match(dialog, />View without them<\/button>/);
  assert.match(renderToStaticMarkup(<SkippedPhotosDialog count={1} action="send" onCancel={() => {}} onContinue={() => {}} />), /You can send the report without it[\s\S]*>Send without them</, 'Send to client wording unchanged');
});

// ---- layout ---------------------------------------------------------------------------------------------------------------------------
test('LAYOUT: Site file order is Site instructions, then Job reports, then Jobs at this building', () => {
  const page = src('pages', 'BuildingFilePage.tsx');
  const order = ['Site instructions', '<BuildingReportsPanel', 'Jobs at this building ('].map((s) => page.indexOf(s));
  assert.ok(order.every((i) => i > 0), String(order));
  assert.ok(order[0] < order[1] && order[1] < order[2], String(order));
  assert.equal((page.match(/<BuildingReportsPanel/g) ?? []).length, 1, 'shown once, not also on History');
});

// ---- photos can be opened larger -----------------------------------------------------------------------------------------------------
// The operator sequence pdf.js produced (measured with the real libraries) for a jsPDF A4 page with, in order: the header leaf
// (inside a clip, partly off the page), the 56pt logo, two photos, and a video thumbnail under its "Watch video" link.
const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintInlineImageXObject: 5, other: 9 };
const A4 = { width: 595.28, height: 841.89 };
const measured: [number, unknown[]][] = [
  [OPS.save, []], [OPS.other, []], [OPS.save, []], [OPS.transform, [310, 0, 0, 310, 405.28, 565.89]], [OPS.paintImageXObject, ['img_p0_1', 900, 900]], [OPS.restore, []], [OPS.restore, []],
  [OPS.save, []], [OPS.transform, [120, 0, 0, 56, 40, 755.89]], [OPS.paintImageXObject, ['img_p0_3', 400, 186]], [OPS.restore, []],
  [OPS.save, []], [OPS.transform, [160, 0, 0, 120, 50, 421.89]], [OPS.paintImageXObject, ['img_p0_4', 1600, 1200]], [OPS.restore, []],
  [OPS.save, []], [OPS.transform, [90, 0, 0, 120, 220, 421.89]], [OPS.paintImageXObject, ['img_p0_5', 900, 1200]], [OPS.restore, []],
  [OPS.save, []], [OPS.transform, [160, 0, 0, 90, 50, 251.89]], [OPS.paintImageXObject, ['img_p0_6', 640, 360]], [OPS.restore, []],
];
const round = (b: any) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round((v as number) * 100) / 100]));

test('PHOTOS: each image\'s position on the page is recovered from the PDF exactly as the report drew it', () => {
  const boxes = imageBoxesFromOperatorList(measured.map((m) => m[0]), measured.map((m) => m[1]), OPS, A4).map(round);
  assert.deepEqual(boxes, [
    { left: 405.28, top: -34, width: 310, height: 310, pixelWidth: 900 },
    { left: 40, top: 30, width: 120, height: 56, pixelWidth: 400 },
    { left: 50, top: 300, width: 160, height: 120, pixelWidth: 1600 },
    { left: 220, top: 300, width: 90, height: 120, pixelWidth: 900 },
    { left: 50, top: 500, width: 160, height: 90, pixelWidth: 640 },
  ]);
});

test('PHOTOS: only the photos are clickable - not the leaf (off the page), the logo (small) or a video thumbnail (under its link)', () => {
  const images = imageBoxesFromOperatorList(measured.map((m) => m[0]), measured.map((m) => m[1]), OPS, A4);
  const videoLink = { left: 50, top: 500, width: 160, height: 90 };
  assert.deepEqual(zoomablePhotoBoxes(images, [videoLink], A4).map((b) => [Math.round(b.left), Math.round(b.top)]), [[50, 300], [220, 300]]);
  assert.equal(MIN_PHOTO_SIDE_PT, 60, 'the logo (56pt) stays below the photo threshold');
});

test('PHOTOS: a nested transform and a restore are followed correctly', () => {
  const fn = [OPS.save, OPS.transform, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.restore, OPS.transform, OPS.paintImageXObject];
  const args = [[], [1, 0, 0, 1, 10, 20], [], [100, 0, 0, 80, 5, 5], ['a', 10, 10], [], [], [70, 0, 0, 70, 300, 300], ['b', 10, 10]];
  const [a, b] = imageBoxesFromOperatorList(fn, args as unknown[][], OPS, A4).map(round);
  assert.deepEqual([a.left, a.top, a.width, a.height], [15, Math.round((841.89 - 105) * 100) / 100, 100, 80]);
  assert.deepEqual([b.left, b.top, b.width, b.height], [300, Math.round((841.89 - 370) * 100) / 100, 70, 70]);
});

test('PHOTOS: a click opens an enlarged view with Close; Escape or a click outside closes only the photo, not the report', () => {
  const html = renderToStaticMarkup(<PhotoLightbox zoom={{ status: 'ready', image: 'data:image/jpeg;base64,AA' }} onClose={() => {}} />);
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Photo, enlarged"/);
  assert.match(html, /<img src="data:image\/jpeg;base64,AA" alt="Photo from the report, enlarged"/);
  assert.match(html, />Close<\/button>/);
  assert.match(renderToStaticMarkup(<PhotoLightbox zoom={{ status: 'loading' }} onClose={() => {}} />), /Opening the photo…/);
  assert.match(renderToStaticMarkup(<PhotoLightbox zoom={{ status: 'error' }} onClose={() => {}} />), /The photo could not be shown larger\./);
  const view = src('components', 'reports', 'PdfDocumentView.tsx');
  assert.match(view, /if \(e\.key === 'Escape'\) \{\s*e\.stopPropagation\(\);\s*onClose\(\);/, 'Escape closes the photo without also closing the report');
  assert.match(view, /onClick=\{\(\) => openPhoto\(i, photo\)\}/);
  assert.match(view, /void opened\?\.destroy\(\);/, 'the open document is released when the viewer closes');
});
