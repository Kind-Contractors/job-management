// Complete & report from the Schedule drawer (Nov 2026): on Schedule only, an eligible visit offers "Complete & report" (due/booked)
// or "Write report" (completed, no report), from the dialog's own eligibility rules; it opens the EXISTING OfficeReportDialog locked to
// that visit, mounted at drawer level; an unfinished submission kept on the device still takes priority; All live jobs is unchanged.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import VisitRow from '../src/components/jobs/VisitRow';
import JobInspectorDrawer, { officeReportActionFor } from '../src/components/jobs/JobInspectorDrawer';
import OfficeReportDialog, { officeReportTargets } from '../src/components/jobs/OfficeReportDialog';
import { AuthContext } from '../src/auth/AuthProvider';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (code: string) => code.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-11-20', status: 'booked', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id: 'job-1', buildingId: 'b-1', buildingName: 'Acme House', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: 'Window cleaning', division: 'General', lifecycleStatus: 'active', serviceEndsOn: null,
    frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 55, yearlyValue: null, monthlyValue: null, nextDueLabel: '', status: 'booked', technician: 'Unassigned',
    defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null, recontactNotes: null, recontactIntervalMonths: null,
    street: '', postcode: 'AB1', buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: null, clientContacts: [],
    ...over,
  };
}
const auth: any = { status: 'authorized', role: 'manager', session: { user: { id: 'user-luke', email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
function wrap(el: ReactElement, seed: (qc: QueryClient) => void = noop) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['technicians'], []);
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{el}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const multi = { additionalTechnicians: [{ technicianId: 't2', name: 'B', contribution: 'pending' }] };

test('SCHEDULE ONLY: the drawer offers the action only when Schedule asks for it; no other page does', () => {
  const j = job([visit('v1')]);
  const off = wrap(<JobInspectorDrawer job={j} onClose={noop} />);
  assert.doesNotMatch(off, /data-testid="visit-office-report"/);
  const on = wrap(<JobInspectorDrawer job={j} onClose={noop} allowOfficeReport />);
  assert.match(on, /data-testid="visit-office-report"[^>]*>Complete &amp; report</);
  assert.match(noComments(src('src', 'pages', 'ThisWeekPage.tsx')), /<JobInspectorDrawer[\s\S]*?allowOfficeReport[\s\S]*?\/>/);
  for (const page of ['AllLiveJobsPage', 'BuildingFilePage', 'MonthlyPlanPage', 'MonthMatrixPage']) {
    assert.doesNotMatch(src('src', 'pages', `${page}.tsx`), /allowOfficeReport/, page);
  }
});

test('LABELS + ELIGIBILITY come from the dialog\'s own rules (officeReportTargets): "Complete & report", "Write report", a reason, or nothing', () => {
  const v = {
    booked: visit('booked'),
    due: visit('due', { status: 'due' }),
    doneNoReport: visit('done', { status: 'completed', priceCharged: 30, completedAt: '2026-11-01T10:00:00Z' }),
    doneWithReport: visit('rep', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved' }),
    cancelled: visit('can', { status: 'cancelled' }),
    missed: visit('mis', { status: 'missed' }),
    multi: visit('multi', multi),
    invoiced: visit('inv', { status: 'completed', priceCharged: 30, completedAt: 'x', invoiceId: 'i1' }),
  };
  const t = officeReportTargets(job(Object.values(v)), '2026-11-24');
  assert.deepEqual(officeReportActionFor(t, v.booked), { label: 'Complete & report' });
  assert.deepEqual(officeReportActionFor(t, v.due), { label: 'Complete & report' });
  assert.deepEqual(officeReportActionFor(t, v.doneNoReport), { label: 'Write report' });
  assert.equal(officeReportActionFor(t, v.doneWithReport), undefined);
  assert.equal(officeReportActionFor(t, v.cancelled), undefined);
  assert.equal(officeReportActionFor(t, v.missed), undefined);
  assert.match((officeReportActionFor(t, v.multi) as { blockedReason: string }).blockedReason, /more than one technician/);
  assert.match((officeReportActionFor(t, v.invoiced) as { blockedReason: string }).blockedReason, /invoice/);
  assert.doesNotMatch(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'), /officeReportBlockedReason/, 'no second copy of the rules');
});

test('VISIT ROW: the button sits first among the visit actions; "Write report" beside "No report yet."; a blocked reason replaces it', () => {
  const open = wrap(<VisitRow job={job([])} visit={visit('v')} actor="x" technicians={[]} initiallyExpanded officeReport={{ label: 'Complete & report', onOpen: noop }} />);
  assert.ok(open.indexOf('data-testid="visit-office-report"') < open.indexOf('>Mark complete<'));
  assert.match(open, />Mark missed</);
  assert.match(open, />Cancel…</);
  const done = wrap(<VisitRow job={job([])} visit={visit('d', { status: 'completed', priceCharged: 30, completedAt: 'x' })} actor="x" technicians={[]} initiallyExpanded officeReport={{ label: 'Write report', onOpen: noop }} />);
  assert.match(done, /No report yet\.[\s\S]*data-testid="visit-office-report"[^>]*>Write report</);
  const blocked = wrap(<VisitRow job={job([])} visit={visit('m', multi)} actor="x" technicians={[]} initiallyExpanded officeReport={{ blockedReason: 'Visits with more than one technician aren’t supported here yet.' }} />);
  assert.doesNotMatch(blocked, /data-testid="visit-office-report"/);
  assert.match(blocked, /data-testid="visit-office-report-blocked">Complete &amp; report isn’t available: Visits with more than one technician/);
  const none = wrap(<VisitRow job={job([])} visit={visit('v')} actor="x" technicians={[]} initiallyExpanded />);
  assert.doesNotMatch(none, /visit-office-report/, 'other pages: nothing');
});

test('LOCKED DIALOG: opened for one visit it shows that visit only - no "Which visit?" choice, no "work already done"', () => {
  const j = job([visit('a', { scheduledDate: '2026-11-10' }), visit('b', { scheduledDate: '2026-11-20' })]);
  const html = wrap(<OfficeReportDialog job={j} actor="x" userId={null} onClose={noop} onCompleted={noop} visitId="b" />);
  assert.doesNotMatch(html, /data-testid="office-report-target"|Which visit\?|Work already done/);
  assert.match(html, /data-testid="office-report-chosen">20 Nov 2026 · Booked · Unassigned</);
  assert.match(html, /data-testid="office-report-form"/);
  assert.match(html, /type="submit"[^>]*>Complete &amp; save report</);
  const done = job([visit('c', { status: 'completed', scheduledDate: '2026-11-02', priceCharged: 30, completedAt: '2026-11-02T10:00:00Z' })]);
  const w = wrap(<OfficeReportDialog job={done} actor="x" userId={null} onClose={noop} onCompleted={noop} visitId="c" />);
  assert.match(w, /£30 — kept as recorded/);
  assert.match(w, /type="submit"[^>]*>Save report</);
});

test('LOCKED DIALOG, visit no longer eligible (e.g. a second technician added meanwhile): says so with the reason - no form', () => {
  const html = wrap(<OfficeReportDialog job={job([visit('m', multi)])} actor="x" userId={null} onClose={noop} onCompleted={noop} visitId="m" />);
  assert.match(html, /This visit can no longer be completed and reported here\./);
  assert.match(html, /more than one technician/);
  assert.doesNotMatch(html, /office-report-form/);
});

test('ALL LIVE JOBS UNCHANGED: without visitId the dialog still offers the choice of visit and "work already done"', () => {
  const html = wrap(<OfficeReportDialog job={job([visit('a')])} actor="x" userId={null} onClose={noop} onCompleted={noop} />);
  assert.match(html, /Which visit\?/);
  assert.match(html, /Work already done — not in JMS yet/);
  const page = noComments(src('src', 'pages', 'AllLiveJobsPage.tsx'));
  assert.match(page, /<OfficeReportDialog[\s\S]*?\/>/);
  assert.doesNotMatch(page.match(/<OfficeReportDialog[\s\S]*?\/>/)![0], /visitId/);
});

test('PENDING RECOVERY keeps priority: an unfinished submission for the job is shown even when opened for another visit', () => {
  const j = job([visit('a'), visit('b', { scheduledDate: '2026-11-25' })]);
  const record = {
    requestId: 'req-1', userId: 'user-luke', jobId: 'job-1', buildingName: 'Acme House', jobSummary: 'Window cleaning', visitLabel: '20 Nov 2026 · Booked · Unassigned',
    visitWasCompleted: false, stage: 'unconfirmed', result: null, media: [], filesNotKept: false, createdAt: '2026-11-25T09:00:00Z', updatedAt: '2026-11-25T09:00:00Z',
    input: { visitId: 'a', jobId: null, workDate: null, completedAt: '2026-11-20T15:00:00.000Z', priceCharged: 55, workCarriedOut: 'Windows', technicianNotes: null, issues: null, specMet: true, onSiteStart: null, onSiteEnd: null },
  };
  const html = wrap(<OfficeReportDialog job={j} actor="x" userId="user-luke" onClose={noop} onCompleted={noop} visitId="b" />, (qc) =>
    qc.setQueryData(['officePending', 'user-luke', 'job-1', 'open'], { record, items: [], missing: [] }));
  assert.match(html, /data-testid="office-report-resumed"/);
  assert.match(html, /no confirmation came back/);
  assert.doesNotMatch(html, /data-testid="office-report-form"/, 'no new submission while one is unresolved');
});

test('MOUNTED AT DRAWER LEVEL: the dialog lives in the drawer (outside the visit lists), keyed by the visit - never inside VisitRow', () => {
  const row = noComments(src('src', 'components', 'jobs', 'VisitRow.tsx'));
  assert.doesNotMatch(row, /OfficeReportDialog/);
  const drawer = noComments(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'));
  const asideEnd = drawer.indexOf('</aside>');
  const dialogAt = drawer.indexOf('<OfficeReportDialog');
  assert.ok(dialogAt > asideEnd, 'rendered after the drawer panel, not within a visit group');
  assert.match(drawer, /<OfficeReportDialog\s+key=\{reportVisitId\}\s+job=\{job\}\s+visitId=\{reportVisitId\}/);
  assert.match(drawer, /onCompleted=\{\(message\) => \{\s*setReportVisitId\(null\);\s*setReportNotice\(message\);/);
  assert.doesNotMatch(src('src', 'components', 'jobs', 'OfficeReportDialog.tsx'), /invalidateQueries\(\{ queryKey: \['schedule/, 'no new refresh paths: the existing job/visit/building/media refresh is reused');
});
