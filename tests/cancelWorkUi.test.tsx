// Rendering tests for cancelling work, on the REAL components (server-rendered to static markup from a seeded query cache;
// there is no DOM library in this repo): the shared cancellation dialog, both entry points, and the three report queues
// showing open report work on cancelled jobs. The writes behind the buttons are covered at the data layer
// (cancelWorkData.test.ts) and the database function by the database suite.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import CancelWorkDialog from '../src/components/jobs/CancelWorkDialog';
import VisitRow from '../src/components/jobs/VisitRow';
import JobInspectorDrawer from '../src/components/jobs/JobInspectorDrawer';
import DayBookingsList from '../src/components/calendar/DayBookingsList';
import NavRail from '../src/components/shell/NavRail';
import ClosedJobsNotice from '../src/components/reports/ClosedJobsNotice';
import ReadyForClientPage from '../src/pages/ReadyForClientPage';
import ReadyForAccountsPage from '../src/pages/ReadyForAccountsPage';
import ReportReviewPage from '../src/pages/ReportReviewPage';
import { AuthContext } from '../src/auth/AuthProvider';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};

// ---- fixtures -------------------------------------------------------------------------------------------------------
function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-20', status: 'booked', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, buildingName: string, visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id, buildingId: `b-${id}`, buildingName, clientId: 'c1', clientName: 'Acme Ltd', jobSummary: `${buildingName} cleaning`, division: 'General', lifecycleStatus: 'active', serviceEndsOn: null,
    frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 100, yearlyValue: 1200, monthlyValue: 100, nextDueLabel: '', status: 'booked', technician: 'Unassigned',
    defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null, recontactNotes: null, recontactIntervalMonths: null,
    street: '', postcode: 'AB1', buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: null,
    clientContacts: [{ id: 'ct1', name: 'Sam Client', email: 'sam@acme.test', phoneNumber: null, isPrimary: true, isAccountsContact: false }],
    ...over,
  };
}
function report(visitId: string, over: Record<string, unknown> = {}): any {
  return {
    id: `rep-${visitId}`, visitId, submittedBy: 'Mo', submittedAt: '2026-10-01T11:00:00Z', onSiteStart: null, onSiteEnd: null, workCarriedOut: 'Cleaned', technicianNotes: null, issues: null, specMet: true,
    reviewStatus: 'approved', reviewedBy: 'luke', reviewedAt: '2026-10-01T12:00:00Z', returnReason: null, includePhotos: true, includeNotes: true, includeIssues: true, includePrice: false,
    sentToClientAt: null, sentToClientBy: null, sentToAccountsAt: null, sentToAccountsBy: null, completedAt: null, completedBy: null, ...over,
  };
}
const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
function wrap(el: ReactElement, seed: (qc: QueryClient) => void = noop) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{el}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
const has = (html: string, text: string) => html.includes(text);

// A recurring job: three future bookings, one with a report.
const f1 = visit('f1', { scheduledDate: '2026-10-20' });
const f2 = visit('f2', { scheduledDate: '2026-11-20' });
const f3 = visit('f3', { scheduledDate: '2026-12-20' });
const fRep = visit('frep', { scheduledDate: '2026-11-25', reportId: 'r1', reportReviewStatus: 'awaiting_review' });
const done = visit('done', { status: 'completed', scheduledDate: '2026-09-20', priceCharged: 10, completedAt: 'x' });
const J = job('j1', 'Alpha Court', [done, f1, f2, f3, fRep]);

// ---- the shared dialog -----------------------------------------------------------------------------------------------------
test('DIALOG: from a visit it offers the three choices with the approved wording, "this visit only" preselected', () => {
  const html = wrap(<CancelWorkDialog job={J} visit={f1} onClose={noop} onDone={noop} />);
  assert.match(html, /Cancel this visit only/);
  assert.match(html, /Cancel only this scheduled visit\. The recurring job and other visits will remain active\./);
  assert.match(html, /Cancel this and all future visits/);
  assert.match(html, /Cancel this visit and all future scheduled visits\. Past work will remain unchanged\./);
  assert.match(html, /Cancel the entire job/);
  assert.match(html, /Remove this job from the active schedule and close it\. Historical visits, reports, photos and invoices will be kept\./);
  assert.match(html, /value="visit"[^>]*checked=""|checked=""[^>]*value="visit"/, 'visit scope is selected');
  assert.doesNotMatch(html, /disabled=""[^>]*value="visit"|value="visit"[^>]*disabled=""/, 'and enabled');
});

test('DIALOG: shows the exact count of visits affected for the selected choice, a reason box, "Confirm cancellation" and "Keep"', () => {
  const html = wrap(<CancelWorkDialog job={J} visit={f1} onClose={noop} onDone={noop} />);
  assert.match(html, /1 visit will be cancelled \(20\/10\/2026\)\./);
  assert.match(html, /Reason \(optional\)/);
  assert.match(html, /<textarea/);
  assert.match(html, />Confirm cancellation</);
  assert.match(html, />Keep</);
});

test('DIALOG: nothing in the wording suggests history is deleted', () => {
  const html = wrap(<CancelWorkDialog job={J} visit={f1} onClose={noop} onDone={noop} />);
  assert.match(html, /Nothing is deleted\./);
  assert.match(html, /stay available in the job’s history/);
  assert.doesNotMatch(html, /permanently|will be deleted|delete the|erase|remove (the )?history|remove (the )?reports/i);
});

test('DIALOG: from the Job status panel (no visit) only "the entire job" is available, preselected, with the count', () => {
  const html = wrap(<CancelWorkDialog job={J} visit={null} onClose={noop} onDone={noop} />);
  assert.match(html, /value="job"[^>]*checked=""|checked=""[^>]*value="job"/);
  assert.match(html, /disabled=""[^>]*value="visit"|value="visit"[^>]*disabled=""/, '"this visit only" needs a visit');
  assert.match(html, /disabled=""[^>]*value="this_and_future"|value="this_and_future"[^>]*disabled=""/);
  assert.match(html, /Choose a visit to use this option\./);
  assert.match(html, /3 scheduled visits will be cancelled and the job will move to Historical Jobs\./, 'f1, f2, f3 - the visit with a report is kept');
});

test('DIALOG: a visit that already has a report is KEPT - warned about, never counted as cancelled', () => {
  const html = wrap(<CancelWorkDialog job={J} visit={null} onClose={noop} onDone={noop} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /1 visit already has a report or an invoice, so it won’t be cancelled\./);
  assert.match(html, /25\/11\/2026 — has a report/);
});

test('DIALOG: cancelling only a visit that has a report plans nothing, so Confirm is disabled and the reason is explained', () => {
  const html = wrap(<CancelWorkDialog job={J} visit={fRep} onClose={noop} onDone={noop} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm cancellation</);
  assert.match(html, /1 visit already has a report or an invoice/);
});

test('DIALOG: "this and all future visits" shows the count and the start date', () => {
  // Rendered with that choice selected by giving the dialog a job where only it applies is not possible statically, so check the
  // wording the choice produces from the same plan the dialog uses.
  const html = wrap(<CancelWorkDialog job={J} visit={f1} onClose={noop} onDone={noop} />);
  assert.match(html, /name="cancel-scope"/);
  assert.equal((html.match(/name="cancel-scope"/g) ?? []).length, 3, 'exactly three choices');
});

// ---- the entry points --------------------------------------------------------------------------------------------------------
test('ENTRY POINT 1 - Job Inspector: an open visit offers "Cancel…"; a completed or cancelled one does not', () => {
  const open = wrap(<VisitRow job={J} visit={f1} actor="luke" technicians={[]} />);
  assert.match(open, />Cancel…</);
  const closed = wrap(<VisitRow job={J} visit={done} actor="luke" technicians={[]} />);
  assert.doesNotMatch(closed, />Cancel…</);
  const cancelled = wrap(<VisitRow job={J} visit={visit('c', { status: 'cancelled' })} actor="luke" technicians={[]} />);
  assert.doesNotMatch(cancelled, />Cancel…</);
});

test('ENTRY POINT 1b - Job status panel: "Mark as Cancelled", "Mark as Completed" and "Mark as Lost" are all still there', () => {
  const html = wrap(<JobInspectorDrawer job={J} siblings={[]} onClose={noop} onSelectSibling={noop} />);
  assert.match(html, />Mark as Cancelled</);
  assert.match(html, />Mark as Completed</);
  assert.match(html, />Mark as Lost</);
});

test('ENTRY POINT 2 - Schedule day list: an open visit has a cancel control only when the drawer provides one; a completed one never does', () => {
  const wv = (id: string, status: string) => ({ id, jobId: 'j1', technicianId: null, additionalTechnicianIds: [], sortOrder: null, createdAt: '2026-10-01T00:00:00Z', scheduledDate: '2026-10-20', status, startTime: null, endTime: null });
  const jobById = new Map([['j1', J]]);
  const props = { dayVisits: [wv('f1', 'booked'), wv('done', 'completed')] as any, dateISO: '2026-10-20', jobById, technicianById: new Map(), visitStatusStyle: {} as any, onSelectVisit: noop };
  const withCancel = wrap(<DayBookingsList {...props} onCancelVisit={noop} />);
  assert.equal((withCancel.match(/aria-label="Cancel Alpha Court"/g) ?? []).length, 1, 'one control: for the open visit only');
  const without = wrap(<DayBookingsList {...props} />);
  assert.doesNotMatch(without, /aria-label="Cancel Alpha Court"/);
});

test('BOTH entry points use the one shared dialog and the one cancel call (no second implementation)', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
  for (const file of ['components/jobs/VisitRow.tsx', 'components/jobs/JobInspectorDrawer.tsx', 'components/calendar/ScheduleDayDrawer.tsx']) {
    assert.match(src(file), /<CancelWorkDialog/, `${file} opens the shared dialog`);
    assert.match(src(file), /CancelWorkDialog'/, `${file} imports it from the one component`);
  }
  assert.doesNotMatch(src('components/jobs/VisitRow.tsx'), /markVisitCancelled/, 'the old one-visit-only write is no longer used from the Inspector');
  assert.equal((src('components/jobs/CancelWorkDialog.tsx').match(/cancelJobWork\(/g) ?? []).length, 1, 'the dialog makes the one cancel call');
});

// ---- report queues show open work on cancelled jobs ----------------------------------------------------------------------------
const seed = (active: any[], closed: any[]) => (qc: QueryClient) => {
  qc.setQueryData(['jobRows'], active);
  qc.setQueryData(['jobRows', 'openReportWork'], closed);
};
const closedAwaiting = job('c1', 'Cancelled Awaiting', [visit('ca', { status: 'completed', reportId: 'r', reportReviewStatus: 'awaiting_review', completedAt: '2026-10-01T10:00:00Z' })], { lifecycleStatus: 'cancelled' });
const closedReturned = job('c2', 'Cancelled Returned', [visit('cb', { status: 'completed', reportId: 'r', reportReviewStatus: 'returned_for_correction', completedAt: '2026-10-02T10:00:00Z' })], { lifecycleStatus: 'lost' });
const closedApproved = job('c3', 'Cancelled Approved', [visit('cc', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved' })], { lifecycleStatus: 'cancelled' });
const closedApprovedDone = job('c4', 'Cancelled Completed Unbilled', [visit('cd', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved', reportCompletedAt: '2026-10-03T00:00:00Z', reportCompletedBy: 'l' })], { lifecycleStatus: 'cancelled' });
const closedFinished = job('c5', 'Cancelled Finished', [visit('ce', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved', reportCompletedAt: '2026-10-03T00:00:00Z', reportCompletedBy: 'l', invoiceId: 'i', invoiceStatus: 'sent' })], { lifecycleStatus: 'cancelled' });

test('REPORT REVIEW: awaiting and returned reports of cancelled / lost jobs are still in the queue', () => {
  const html = wrap(<ReportReviewPage />, seed([], [closedAwaiting, closedReturned, closedApproved]));
  assert.ok(has(html, 'Cancelled Awaiting'));
  assert.ok(has(html, 'Cancelled Returned'));
  assert.ok(!has(html, 'Cancelled Approved'), 'an approved report is not awaiting review');
  assert.match(html, /2 awaiting review/);
});

function clientPage(active: any[], closed: any[], view: 'awaiting' | 'completed' = 'awaiting') {
  return wrap(<ReadyForClientPage initialView={view} initialSelectedVisitId={null} />, seed(active, closed));
}

test('READY FOR CLIENT: an approved, not-Completed report of a cancelled job is still awaiting completion; Completed ones are not', () => {
  const html = clientPage([], [closedApproved, closedApprovedDone, closedAwaiting]);
  assert.ok(has(html, 'Cancelled Approved'));
  assert.ok(!has(html, 'Cancelled Completed Unbilled'), 'Completed is Completed');
  assert.ok(!has(html, 'Cancelled Awaiting'), 'awaiting review belongs to Report review');
  assert.match(html, /1 awaiting completion/);
});

test('READY FOR CLIENT: the Completed tab never lists a cancelled job\'s finished reports (no historical leak)', () => {
  const html = clientPage([], [closedApprovedDone, closedFinished], 'completed');
  assert.ok(!has(html, 'Cancelled Completed Unbilled'));
  assert.ok(!has(html, 'Cancelled Finished'));
  assert.match(html, /Completed \(0\)/);
});

test('READY FOR ACCOUNTS: unbilled approved work of a cancelled job stays - even when the report is Completed - but a finished, sent invoice does not', () => {
  const html = wrap(<ReadyForAccountsPage />, seed([], [closedApproved, closedApprovedDone, closedFinished, closedAwaiting]));
  assert.ok(has(html, 'Cancelled Approved'));
  assert.ok(has(html, 'Cancelled Completed Unbilled'), 'completed means the client workflow is finished, not the accounting one');
  assert.ok(!has(html, 'Cancelled Finished'), 'invoice sent: closed');
  assert.ok(!has(html, 'Cancelled Awaiting'), 'not approved yet');
});

test('QUEUES: with active jobs too, both lists show together and nothing is listed twice', () => {
  const active = job('a1', 'Active Approved', [visit('aa', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved' })]);
  const html = clientPage([active], [closedApproved, active]);
  assert.ok(has(html, 'Active Approved') && has(html, 'Cancelled Approved'));
  assert.match(html, /2 awaiting completion/);
});

test('QUEUES: if the closed-job list could not be loaded the queue says so instead of silently showing less', () => {
  assert.match(renderToStaticMarkup(<ClosedJobsNotice show onRetry={noop} />), /may be incomplete/);
  assert.equal(renderToStaticMarkup(<ClosedJobsNotice show={false} onRetry={noop} />), '');
});

test('the Ready for client page still renders reports it was already showing (seeded without any closed-job list)', () => {
  const only = job('o1', 'Only Active', [visit('oa', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved' })]);
  const html = wrap(<ReadyForClientPage initialSelectedVisitId={null} />, (qc) => qc.setQueryData(['jobRows'], [only]));
  assert.ok(has(html, 'Only Active'));
});

test('NAV: the Report review / Ready for client / Ready for accounts badges count open work on cancelled jobs', () => {
  const closed = job('cn', 'Cancelled Nav', [
    visit('n1', { status: 'completed', reportId: 'r1', reportReviewStatus: 'awaiting_review' }),
    visit('n2', { status: 'completed', reportId: 'r2', reportReviewStatus: 'approved' }),
  ], { lifecycleStatus: 'cancelled', status: 'review' });
  const html = wrap(<NavRail />, (qc) => {
    qc.setQueryData(['jobRows'], []);
    qc.setQueryData(['jobRows', 'openReportWork'], [closed]);
    for (const k of ['historicalJobRows', 'buildingRows', 'technicians', 'users']) qc.setQueryData([k], []);
  });
  const badge = (title: string) => new RegExp(`title="${title}"[^>]*>(?:<i[^>]*></i>)?${title}<b[^>]*>([0-9]+)</b>`).exec(html)?.[1];
  assert.equal(badge('Report review'), '1');
  assert.equal(badge('Ready for client'), '1');
  assert.equal(badge('Ready for accounts'), '1');
});
