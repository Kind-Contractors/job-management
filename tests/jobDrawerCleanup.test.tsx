// Job Details drawer cleanup (Nov 2026): no "Report waiting on you" banner (Report review owns that), no "Also at this building"
// list (the Building file button stays), and visits as compact rows - "Upcoming & open" first, then "Past" (latest 5, Show all) -
// that expand to the same details and actions as before. Server-rendered on the REAL components from a seeded query cache.
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
import JobInspectorDrawer, { groupVisits, PAST_VISITS_SHOWN } from '../src/components/jobs/JobInspectorDrawer';
import { AuthContext } from '../src/auth/AuthProvider';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-12-02', status: 'booked', technicianId: 'mo', technicianName: 'Mo', additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id: 'job-1', buildingId: 'b-1', buildingName: 'Acme House', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: 'Window cleaning', division: 'General', lifecycleStatus: 'active', serviceEndsOn: null,
    frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 100, yearlyValue: 1200, monthlyValue: 100, nextDueLabel: 'Report from Mo', status: 'booked', technician: 'Mo',
    defaultTechnicianId: 'mo', schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null, recontactNotes: null, recontactIntervalMonths: null,
    street: '1 High St', postcode: 'AB1', buildingInternalAccessNote: 'Key safe 1234', clientInvoiceAddress: '', jobNotes: null, clientContacts: [],
    ...over,
  };
}
const technicians = [
  { id: 'mo', name: 'Mo', isActive: true, appUserId: null },
  { id: 'ali', name: 'Ali', isActive: true, appUserId: null },
];
const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
function wrap(el: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['technicians'], technicians);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{el}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

test('REMOVED: no "Report waiting on you" banner (even for a job with a report to review) and no "Also at this building"', () => {
  const html = wrap(<JobInspectorDrawer job={job([visit('v1')], { status: 'review' })} onClose={noop} layout="classic" />);
  assert.doesNotMatch(html, /Report waiting on you|Review it in Report Review/);
  assert.doesNotMatch(html, /Also at this building/);
  assert.match(html, /Report to review/, 'the status pill in the header still says so');
  const drawer = src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx');
  assert.doesNotMatch(drawer, /siblings|onSelectSibling/);
  for (const page of ['AllLiveJobsPage', 'BuildingFilePage', 'ThisWeekPage', 'MonthlyPlanPage', 'MonthMatrixPage']) {
    assert.doesNotMatch(src('src', 'pages', `${page}.tsx`), /siblings=|onSelectSibling=|handleSelectSibling/, page);
  }
});

test('KEPT: everything else in the drawer - Building file and Edit job, facts, schedule, internal access, job status', () => {
  const html = wrap(<JobInspectorDrawer job={job([visit('v1')])} onClose={noop} layout="classic" />);
  assert.match(html, />Building file</);
  assert.match(html, />Edit job</);
  assert.match(html, /Price per visit/);
  assert.match(html, /Internal only · access/);
  assert.match(html, /Mark as Completed/);
  assert.match(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'), /navigate\(`\/buildings\/\$\{job\.buildingId\}`\)/, 'Building file still opens the building');
});

test('ORDER: "Upcoming & open" = due/booked soonest first (no date last); "Past" = completed/missed/cancelled, most recent first', () => {
  const v = [
    visit('old-done', { status: 'completed', scheduledDate: '2026-09-01' }),
    visit('later', { status: 'booked', scheduledDate: '2027-01-06' }),
    visit('missed', { status: 'missed', scheduledDate: '2026-11-01' }),
    visit('nodate', { status: 'due', scheduledDate: null }),
    visit('soon', { status: 'due', scheduledDate: '2026-12-02' }),
    visit('cancelled', { status: 'cancelled', scheduledDate: '2026-10-01' }),
  ];
  const g = groupVisits(v);
  assert.deepEqual(g.open.map((x) => x.id), ['soon', 'later', 'nodate']);
  assert.deepEqual(g.past.map((x) => x.id), ['missed', 'cancelled', 'old-done']);
});

test('DRAWER LIST: section headings, one row per visit, ONLY the next open visit starts expanded', () => {
  const v = [visit('a', { scheduledDate: '2027-01-06' }), visit('b', { scheduledDate: '2026-12-02' }), visit('p', { status: 'completed', scheduledDate: '2026-11-04', priceCharged: 100, completedAt: 'x' })];
  const html = wrap(<JobInspectorDrawer job={job(v)} onClose={noop} layout="classic" />);
  assert.match(html, /Visits \(3\)/);
  assert.ok(html.indexOf('Upcoming &amp; open') < html.indexOf('>Past<'));
  assert.equal(count(html, 'data-testid="visit-row"'), 3);
  assert.equal(count(html, 'data-testid="visit-details"'), 1, 'one expanded');
  assert.equal(count(html, 'aria-expanded="true"'), 1);
  const expandedAt = html.indexOf('aria-expanded="true"');
  assert.ok(expandedAt > html.indexOf('Wed, 2 Dec 2026') - 400 && expandedAt < html.indexOf('Wed, 6 Jan 2027'), 'the soonest open visit (2 Dec) is the expanded one');
});

test('PAST: only the latest 5 at first, with "Show all N past visits"', () => {
  const past = Array.from({ length: 8 }, (_, i) => visit(`p${i}`, { status: 'completed', scheduledDate: `2026-0${i + 1}-15`, priceCharged: 100, completedAt: 'x' }));
  const html = wrap(<JobInspectorDrawer job={job(past)} onClose={noop} layout="classic" />);
  assert.equal(PAST_VISITS_SHOWN, 5);
  assert.equal(count(html, 'data-testid="visit-row"'), 5);
  assert.match(html, />Show all 8 past visits</);
  assert.match(html, /Sat, 15 Aug 2026/, 'the most recent is shown');
  assert.doesNotMatch(html, /Thu, 15 Jan 2026/, 'the oldest is behind Show all');
  assert.equal(count(html, 'data-testid="visit-details"'), 0, 'no open visit: nothing expanded');
});

test('COLLAPSED ROW: date, technicians, visit status and report status on one line - and no actions until expanded', () => {
  const v = visit('v', { status: 'completed', scheduledDate: '2026-11-04', priceCharged: 100, completedAt: 'x', reportId: 'r1', reportReviewStatus: 'approved',
    additionalTechnicians: [{ technicianId: 'ali', name: 'Ali', contribution: 'submitted' }] });
  const html = wrap(<VisitRow job={job([v])} visit={v} actor="luke" technicians={technicians as any} />);
  assert.match(html, /<button type="button" aria-expanded="false"/);
  assert.match(html, /Wed, 4 Nov 2026/);
  assert.match(html, />Mo \+ 1</);
  assert.match(html, /Completed/);
  assert.match(html, /data-testid="visit-report-status"[\s\S]*Approved/);
  assert.doesNotMatch(html, /Mark complete|Mark missed|Cancel…|Price charged|Also on this visit/);
});

test('EXPANDED BOOKED VISIT: every existing control is still there - date, technician, extra technicians, Mark complete / Mark missed / Cancel…', () => {
  const v = visit('v', { additionalTechnicians: [{ technicianId: 'ali', name: 'Ali', contribution: 'pending' }] });
  const html = wrap(<VisitRow job={job([v])} visit={v} actor="luke" technicians={technicians as any} initiallyExpanded />);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<input type="date"[^>]*value="2026-12-02"/);
  assert.match(html, /Technician<select/);
  assert.match(html, /Also on this visit:/);
  assert.match(html, /aria-label="Remove Ali"/);
  assert.match(html, /aria-label="Add another technician to this visit"/);
  assert.match(html, />Mark complete</);
  assert.match(html, />Mark missed</);
  assert.match(html, />Cancel…</);
});

test('EXPANDED COMPLETED VISIT: the report status appears once (in the row); "Written by the office" is kept below', () => {
  const v = visit('v', { status: 'completed', scheduledDate: '2026-11-04', priceCharged: 100, completedAt: 'x', reportId: 'r1', reportReviewStatus: 'approved' });
  const render = (authorship: unknown) => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(['technicians'], technicians);
    qc.setQueryData(['reportAuthorship', 'r1'], authorship);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <AuthContext.Provider value={auth}>
          <MemoryRouter>
            <VisitRow job={job([v])} visit={v} actor="luke" technicians={technicians as any} initiallyExpanded />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
  };
  const office = render({ source: 'manager', submittedBy: 'Luke' });
  assert.equal(count(office, '>Approved<'), 1, 'status shown once');
  assert.match(office, /data-testid="visit-report-status"/);
  assert.match(office, /Price charged: £100/);
  assert.match(office, /Report: <span data-testid="office-author">Written by the office · Luke<\/span>/);
  const tech = render({ source: 'technician', submittedBy: 'Mo' });
  assert.equal(count(tech, '>Approved<'), 1);
  assert.doesNotMatch(tech, /office-author|Report:/, 'nothing extra for a technician\'s report');
});

test('SAFEGUARDS unchanged: the same mutations and locks, now only inside the expanded area', () => {
  // The visit writes and locks live in the shared hook VisitRow (and the Schedule card) use; the row decides where they appear.
  const row = src('src', 'components', 'jobs', 'VisitRow.tsx');
  const hook = src('src', 'components', 'jobs', 'useVisitManagement.ts');
  assert.match(row, /useVisitManagement\(\{ visit, actor, technicians \}\)/);
  for (const fn of ['rescheduleVisit(visit.id, date)', 'assignVisitTechnician(visit.id, technicianId)', 'addVisitTechnician(visit.id, technicianId)', 'removeVisitTechnician(visit.id, technicianId)', 'markVisitMissed(visit.id, actor)']) {
    assert.ok(hook.includes(fn), fn);
  }
  assert.match(row, /disabled=\{assignTechnicianMutation\.isPending \|\| visit\.reportId != null\}/, 'technician still locked once a report exists');
  assert.match(hook, /const extrasLocked =/);
  assert.match(row, /<CompleteVisitForm/);
  assert.match(row, /<CancelWorkDialog/);
  assert.ok(row.indexOf('{expanded && (') < row.indexOf('Mark complete'), 'actions sit inside the expanded area');
});
