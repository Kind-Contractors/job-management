// The two follow-ups to manager video support:
//   1. cancelling work distinguishes a visit KEPT FOR A VIDEO (reason has_video) from one kept for a report or an invoice;
//   2. the Building File timeline words the new video audit events in plain language.
// Rendering is static markup on the real components; the database function itself is tested against DEV (cancellation suite).
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import CancelWorkDialog, { CancelResultView } from '../src/components/jobs/CancelWorkDialog';
import { keptReasonLabel, keptStayText, keptSubject, planCancelWork } from '../src/lib/cancelWork';
import { HISTORY_EVENT_LABEL, historyEventDetail } from '../src/lib/historyEventLabels';
import { cancelJobWork } from '../src/repository/jobsRepository';
import { mapVisitRow } from '../src/repository/mapJobRow';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-20', status: 'booked', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(visits: any[]): any {
  return {
    id: 'j1', buildingId: 'b1', buildingName: 'Alpha Court', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: 'Alpha Court cleaning', division: 'General', lifecycleStatus: 'active', serviceEndsOn: null,
    frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 100, yearlyValue: 1200, monthlyValue: 100, nextDueLabel: '', status: 'booked', technician: 'Unassigned',
    defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null, recontactNotes: null, recontactIntervalMonths: null,
    street: '', postcode: 'AB1', buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: null, clientContacts: [],
  };
}
const dialog = (j: any, v: any) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CancelWorkDialog job={j} visit={v} onClose={noop} onDone={noop} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

// ---- the plan (what the dialog says BEFORE anything is saved) ---------------------------------------------------------------
const plain = visit('plain', { scheduledDate: '2026-10-20' });
const withVideo = visit('vid', { scheduledDate: '2026-11-20', hasActiveVideo: true });
const withReport = visit('rep', { scheduledDate: '2026-11-25', reportId: 'r1', reportReviewStatus: 'awaiting_review' });
const reportAndVideo = visit('both', { scheduledDate: '2026-12-01', reportId: 'r2', reportReviewStatus: 'awaiting_review', hasActiveVideo: true });
const invoiceAndVideo = visit('inv', { scheduledDate: '2026-12-05', invoiceId: 'i1', invoiceStatus: 'draft', hasActiveVideo: true });
const J = job([plain, withVideo, withReport, reportAndVideo, invoiceAndVideo]);

test('PLAN: a visit with an active video (and nothing else) is KEPT as has_video, never counted as cancelled', () => {
  const plan = planCancelWork(J, 'job', null);
  assert.deepEqual(plan.willCancel.map((v) => v.id), ['plain']);
  assert.deepEqual(plan.kept.map((k) => [k.visit.id, k.reason]), [['vid', 'has_video'], ['rep', 'has_report'], ['both', 'has_report'], ['inv', 'has_invoice']]);
});

test('PLAN: a report or an invoice always wins over a video (the database checks them in the same order)', () => {
  const plan = planCancelWork(J, 'job', null);
  assert.equal(plan.kept.find((k) => k.visit.id === 'both')!.reason, 'has_report');
  assert.equal(plan.kept.find((k) => k.visit.id === 'inv')!.reason, 'has_invoice');
});

test('PLAN: a cached job row from before videos existed (no hasActiveVideo field) cancels exactly as before', () => {
  const old = visit('old', { scheduledDate: '2026-10-20' });
  assert.equal('hasActiveVideo' in old, false);
  assert.deepEqual(planCancelWork(job([old]), 'job', null).willCancel.map((v) => v.id), ['old']);
});

test('PLAN: a video that was removed no longer keeps the visit', () => {
  const removed = visit('gone', { hasActiveVideo: false });
  assert.deepEqual(planCancelWork(job([removed]), 'job', null).willCancel.map((v) => v.id), ['gone']);
});

// ---- wording -----------------------------------------------------------------------------------------------------------------------
test('WORDING: each reason has its own label; has_video says it is not yet in a report', () => {
  assert.equal(keptReasonLabel('has_report'), 'has a report');
  assert.equal(keptReasonLabel('has_invoice'), 'has an invoice');
  assert.equal(keptReasonLabel('has_video'), 'has a video (not yet in a report)');
});

test('WORDING: with no video involved the sentences are EXACTLY what they were before videos existed', () => {
  assert.equal(keptSubject([{ reason: 'has_report' }, { reason: 'has_invoice' }]), 'a report or an invoice');
  assert.equal(keptStayText([{ reason: 'has_report' }], false), 'It stays in the report queues until finished.');
  assert.equal(keptStayText([{ reason: 'has_invoice' }, { reason: 'has_report' }], true), 'They stay in the report queues until finished.');
});

test('WORDING: a video-only kept visit says what it has and that it is not in the report queues; a mixed set names all three', () => {
  assert.equal(keptSubject([{ reason: 'has_video' }]), 'a video');
  assert.equal(keptSubject([{ reason: 'has_video' }, { reason: 'has_report' }]), 'a report, an invoice or a video');
  assert.match(keptStayText([{ reason: 'has_video' }], false), /keeps its video and stays open until the technician submits the report; it is not in the report queues before then/);
  assert.match(keptStayText([{ reason: 'has_video' }, { reason: 'has_video' }], true), /keep their videos and stay open until the technician submits the report; they are not in the report queues/);
  assert.match(keptStayText([{ reason: 'has_video' }, { reason: 'has_report' }], true), /Visits with a report or an invoice stay in the report queues until finished\. A visit kept for its video stays open/);
});

// ---- the dialog before confirming ---------------------------------------------------------------------------------------------
test('DIALOG: a kept-for-video visit is warned about as having a VIDEO - not as having a report', () => {
  const html = dialog(job([plain, withVideo]), null);
  assert.match(html, /1 visit already has a video, so it won’t be cancelled\./);
  assert.match(html, /20\/11\/2026 — has a video \(not yet in a report\)/);
  assert.doesNotMatch(html, /has a report/);
  assert.doesNotMatch(html, /a report or an invoice/);
  assert.match(html, /keeps its video and stays open until the technician submits the report/);
});

test('DIALOG: a visit with a report is still described exactly as before (report wording unchanged)', () => {
  const html = dialog(job([plain, withReport]), null);
  assert.match(html, /1 visit already has a report or an invoice, so it won’t be cancelled\./);
  assert.match(html, /25\/11\/2026 — has a report/);
  assert.doesNotMatch(html, /video/);
});

test('DIALOG: a mixed set lists each visit with its own reason and names all three kinds', () => {
  const html = dialog(J, null);
  assert.match(html, /4 visits already have a report, an invoice or a video, so they won’t be cancelled\./);
  assert.match(html, /20\/11\/2026 — has a video \(not yet in a report\)/);
  assert.match(html, /25\/11\/2026 — has a report/);
  assert.match(html, /05\/12\/2026 — has an invoice/);
});

test('DIALOG: cancelling only a video-kept visit plans nothing, so Confirm is disabled', () => {
  const html = dialog(job([withVideo]), withVideo);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm cancellation</);
  assert.match(html, /1 visit already has a video/);
});

// ---- the dialog after the server answered --------------------------------------------------------------------------------------
const view = (result: any) => renderToStaticMarkup(<CancelResultView result={result} onDone={noop} />);
const RESULT = { scope: 'job', alreadyDone: false, cancelledVisitIds: ['a'], serviceEndsOn: null, lifecycleStatus: 'cancelled' };

test('RESULT: visits the server kept for a video are explained and labelled as such', () => {
  const html = view({ ...RESULT, keptVisits: [{ id: 'v', scheduledDate: '2026-11-20', reason: 'has_video' }] });
  assert.match(html, /1 visit was cancelled\./);
  assert.match(html, /1 visit was not cancelled because it already has a video\./);
  assert.match(html, /keeps its video and stays open until the technician submits the report; it is not in the report queues before then/);
  assert.match(html, /20\/11\/2026 — has a video \(not yet in a report\)/);
  assert.doesNotMatch(html, /Report review, Ready for client and Ready for accounts/, 'a video-only visit is not in those queues');
});

test('RESULT: visits kept for a report keep the original wording, now with the reason beside each date', () => {
  const html = view({ ...RESULT, keptVisits: [{ id: 'a', scheduledDate: '2026-11-25', reason: 'has_report' }, { id: 'b', scheduledDate: '2026-12-05', reason: 'has_invoice' }] });
  assert.match(html, /2 visits were not cancelled because they already have a report or an invoice\. They stay in Report review, Ready for client and Ready for accounts until finished\./);
  assert.match(html, /25\/11\/2026 — has a report/);
  assert.match(html, /05\/12\/2026 — has an invoice/);
});

// ---- data layer ---------------------------------------------------------------------------------------------------------------------
test('DATA: the server\'s has_video reason comes through cancelJobWork untouched', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ scope: 'visit', already_done: false, cancelled_visit_ids: [], kept_visits: [{ id: 'v', scheduled_date: '2026-11-20', reason: 'has_video' }], service_ends_on: null, lifecycle_status: 'active' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const r = await cancelJobWork({ jobId: 'j1', scope: 'visit', fromVisitId: 'v', reason: null });
  assert.deepEqual(r.keptVisits, [{ id: 'v', scheduledDate: '2026-11-20', reason: 'has_video' }]);
});

test('DATA: a visit row with videos maps to hasActiveVideo; removed videos and no videos do not', () => {
  const base = { id: 'v', technician_id: null, scheduled_date: '2026-10-20', status: 'booked', price_charged: null, completed_at: null, technicians: null, visit_technicians: [], reports: null, invoice_line_items: null } as any;
  assert.equal(mapVisitRow({ ...base, report_videos: [{ id: 'a', deleted_at: null }] }).hasActiveVideo, true);
  assert.equal(mapVisitRow({ ...base, report_videos: [{ id: 'a', deleted_at: '2026-10-12T10:00:00Z' }] }).hasActiveVideo, false);
  assert.equal(mapVisitRow({ ...base, report_videos: [{ id: 'a', deleted_at: '2026-10-12T10:00:00Z' }, { id: 'b', deleted_at: null }] }).hasActiveVideo, true);
  assert.equal(mapVisitRow({ ...base, report_videos: [] }).hasActiveVideo, false);
  assert.equal(mapVisitRow({ ...base }).hasActiveVideo, false, 'a row from a query without the embed');
});

// ---- Building File timeline ------------------------------------------------------------------------------------------------------------
test('TIMELINE: the four video audit events have plain titles', () => {
  assert.equal(HISTORY_EVENT_LABEL.report_video_added, 'Video added');
  assert.equal(HISTORY_EVENT_LABEL.report_video_removed, 'Video removed');
  assert.equal(HISTORY_EVENT_LABEL.report_video_links_issued, 'Client video links created');
  assert.equal(HISTORY_EVENT_LABEL.report_video_links_revoked, 'Client video links revoked');
});

test('TIMELINE: the database\'s detail text is tidied (section names, singular/plural links); other events pass straight through', () => {
  assert.equal(historyEventDetail('report_video_added', 'before'), 'Before section');
  assert.equal(historyEventDetail('report_video_removed', 'after'), 'After section');
  assert.equal(historyEventDetail('report_video_links_issued', '2 link(s), valid 365 days'), '2 links, valid for 365 days');
  assert.equal(historyEventDetail('report_video_links_issued', '1 link(s), valid 30 days'), '1 link, valid for 30 days');
  assert.equal(historyEventDetail('report_video_links_revoked', '3 link(s)'), '3 links');
  assert.equal(historyEventDetail('report_video_links_revoked', '1 link(s)'), '1 link');
  assert.equal(historyEventDetail('report_video_added', null), null);
  assert.equal(historyEventDetail('report_video_added', 'unexpected'), 'unexpected');
  assert.equal(historyEventDetail('visit_cancelled', 'Customer asked'), 'Customer asked', 'every other event is untouched');
});

test('TIMELINE: every title that existed before is still there, unchanged, and an unknown event still falls back to its raw name', () => {
  assert.equal(HISTORY_EVENT_LABEL.report_approved, 'Report approved');
  assert.equal(HISTORY_EVENT_LABEL.visit_cancelled, 'Visit cancelled');
  assert.equal(HISTORY_EVENT_LABEL.report_completed, 'Report completed');
  assert.equal(HISTORY_EVENT_LABEL.some_future_event ?? 'some_future_event', 'some_future_event');
});
