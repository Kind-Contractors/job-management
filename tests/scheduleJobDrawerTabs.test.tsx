// Schedule's Job Details drawer, tabbed (Nov 2026): Visits (default) and Details tabs; upcoming visit cards with the main action on the
// card and the rest behind a chevron; a compact Past list with Review / View / Write report; the job's facts, prices, access and
// lifecycle actions on Details. Schedule only - every other page keeps the classic drawer. Same writes, rules and dialogs as before.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import JobInspectorDrawer, { PAST_VISITS_SHOWN } from '../src/components/jobs/JobInspectorDrawer';
import ScheduleVisitCard, { reportLinkFor } from '../src/components/jobs/ScheduleVisitCard';
import { AuthContext } from '../src/auth/AuthProvider';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (code: string) => code.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const count = (html: string, re: RegExp) => (html.match(new RegExp(re.source, 'g')) ?? []).length;

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-11-25', status: 'booked', technicianId: 't1', technicianName: 'Mo', additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id: '1eab2d2f-0000-4000-8000-000000000001', buildingId: 'b-1', buildingName: 'Acme House', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: 'Window cleaning', division: 'General',
    lifecycleStatus: 'active', serviceEndsOn: null, frequency: 'Weekly', frequencyRaw: 'Weekly', frequencyType: 'weekly', pricePerVisit: 10, yearlyValue: 520, monthlyValue: 43.33,
    nextDueLabel: '', status: 'booked', technician: 'Mo', defaultTechnicianId: 't1', schedulePattern: 'Weekly', schedule: null, visits, lostReason: null, recontactDueAt: null,
    recontactNotes: null, recontactIntervalMonths: null, street: '1 High St', postcode: 'AB1 2CD', buildingInternalAccessNote: 'Key safe 4821', clientInvoiceAddress: '2 Low Rd, Town',
    jobNotes: null, clientContacts: [], ...over,
  };
}
const technicians = [
  { id: 't1', name: 'Mo', isActive: true },
  { id: 't2', name: 'Ali', isActive: true },
];
const auth: any = { status: 'authorized', role: 'manager', session: { user: { id: 'user-luke', email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
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
const tabbed = (j: any) => wrap(<JobInspectorDrawer job={j} onClose={noop} allowOfficeReport layout="tabbed" />);
/** The part of the drawer markup inside one tab panel. */
function panel(html: string, name: 'visits' | 'details') {
  const start = html.indexOf(`id="job-drawer-panel-${name}"`);
  const next = name === 'visits' ? html.indexOf('id="job-drawer-panel-details"') : html.indexOf('</aside>');
  return html.slice(start, next);
}

const upcoming = visit('up1', { scheduledDate: '2026-11-25' });
const later = visit('up2', { scheduledDate: '2026-12-02' });
const toReview = visit('p1', { status: 'completed', scheduledDate: '2026-11-18', completedAt: '2026-11-18T10:00:00Z', priceCharged: 10, reportId: 'r1', reportReviewStatus: 'awaiting_review' });
const approved = visit('p2', { status: 'completed', scheduledDate: '2026-11-11', completedAt: '2026-11-11T10:00:00Z', priceCharged: 10, reportId: 'r2', reportReviewStatus: 'approved' });

test('SCHEDULE ONLY: Schedule asks for the tabbed layout; every other page keeps the classic drawer', () => {
  assert.match(noComments(src('src', 'pages', 'ThisWeekPage.tsx')), /<JobInspectorDrawer[\s\S]*?layout="tabbed"[\s\S]*?\/>/);
  for (const page of ['AllLiveJobsPage', 'BuildingFilePage', 'MonthlyPlanPage', 'MonthMatrixPage']) {
    assert.doesNotMatch(src('src', 'pages', `${page}.tsx`), /layout="tabbed"/, page);
  }
  const classic = wrap(<JobInspectorDrawer job={job([upcoming, toReview])} onClose={noop} />);
  assert.doesNotMatch(classic, /role="tablist"|job-drawer-tabbed/);
  assert.match(classic, /Upcoming &amp; open/);
  assert.match(classic, /data-testid="visit-row"/);
  assert.match(classic, /Internal only · access/);
  assert.match(classic, />Building file</);
});

test('TABS: Visits and Details, Visits selected by default; both panels stay mounted so switching keeps their state', () => {
  const html = tabbed(job([upcoming]));
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab" id="job-drawer-tab-visits" aria-selected="true"[^>]*>Visits</);
  assert.match(html, /role="tab" id="job-drawer-tab-details" aria-selected="false"[^>]*>Details</);
  assert.match(html, /role="tabpanel" id="job-drawer-panel-visits" aria-labelledby="job-drawer-tab-visits" class=/, 'visits panel shown');
  assert.match(html, /role="tabpanel" id="job-drawer-panel-details" aria-labelledby="job-drawer-tab-details" hidden=""/, 'details panel hidden, not unmounted');
  assert.match(panel(html, 'details'), /Access details/, 'details content is already rendered');
  const drawer = noComments(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'));
  assert.match(drawer, /hidden=\{tab !== 'visits'\}/);
  assert.match(drawer, /hidden=\{tab !== 'details'\}/);
  assert.match(drawer, /onClick=\{\(\) => setTab\(t\.id\)\}/, 'a tab click only changes the tab - nothing closes the drawer');
});

test('HEADER: job, building (a link to its file), division · frequency · price per visit, close - and no "needs attention" or sibling sections', () => {
  const html = tabbed(job([upcoming, toReview]));
  assert.match(html, /<h2[^>]*>Window cleaning<\/h2>/);
  assert.match(html, />Job · 1EAB2D2F</);
  assert.match(html, /data-testid="drawer-subtitle"[^>]*><button[^>]*>Acme House<\/button><span> · 1 High St, AB1 2CD<\/span>/);
  assert.match(html, /data-testid="drawer-meta"[^>]*>General · Weekly · £10 per visit</);
  assert.match(html, /aria-label="Close job details"/);
  assert.doesNotMatch(html, /Report waiting on you|Needs attention|Also at this building/);
  assert.match(tabbed(job([], { pricePerVisit: null })), /data-testid="drawer-meta"[^>]*>General · Weekly · Variable price</);
});

test('UPCOMING: one card per due/booked visit, soonest first, with date tile, technician, status and the Complete & report button', () => {
  const html = panel(tabbed(job([later, toReview, upcoming])), 'visits');
  assert.match(html, />Upcoming · 2</);
  assert.equal(count(html, /data-testid="schedule-visit-upcoming"/), 2);
  assert.ok(html.indexOf('Wed, 25 Nov 2026') < html.indexOf('Wed, 2 Dec 2026'), 'soonest first');
  assert.ok(html.indexOf('Wed, 2 Dec 2026') < html.indexOf('>Past · 1<'), 'upcoming before past');
  const first = html.slice(html.indexOf('data-testid="schedule-visit-upcoming"'), html.indexOf('Wed, 2 Dec 2026'));
  assert.match(first, />Wed</);
  assert.match(first, />25</);
  assert.match(first, />MO</, 'technician initials');
  assert.match(first, /title="Mo">Mo</);
  assert.match(first, /BOOKED|Booked/);
  assert.match(first, /data-testid="visit-office-report"[^>]*>Complete &amp; report</);
  assert.match(first, /aria-expanded="false" aria-label="Edit visit on Wed, 25 Nov 2026"/);
  assert.doesNotMatch(first, /data-testid="visit-details"/, 'secondary actions start hidden');
});

test('COMPLETE & REPORT ELIGIBILITY: the same rules as before - blocked with a reason for a multi-technician visit; nothing on other pages', () => {
  const multi = visit('m', { additionalTechnicians: [{ technicianId: 't2', name: 'Ali', contribution: 'pending' }] });
  const html = tabbed(job([multi]));
  assert.doesNotMatch(html, /data-testid="visit-office-report"/);
  assert.match(html, /data-testid="visit-office-report-blocked"[^>]*>Complete &amp; report isn’t available: Visits with more than one technician/);
  assert.match(html, /title="Mo \+ 1">Mo \+ 1</);
  const offSchedule = wrap(<JobInspectorDrawer job={job([upcoming])} onClose={noop} layout="tabbed" />);
  assert.doesNotMatch(offSchedule, /visit-office-report/, 'only offered when the caller allows it');
});

test('EXPANDED ACTIONS: date, technician, extra technicians, complete without report, mark missed, cancel - with the existing locks', () => {
  const html = wrap(<ScheduleVisitCard job={job([])} visit={upcoming} actor="x" technicians={technicians as any} variant="upcoming" initiallyExpanded />);
  assert.match(html, /aria-expanded="true" aria-label="Hide visit on Wed, 25 Nov 2026"/);
  assert.match(html, /data-testid="visit-details"/);
  assert.match(html, /Date<input type="date"[^>]*value="2026-11-25"/);
  assert.match(html, /Technician<select/);
  assert.match(html, /aria-label="Add another technician to this visit"/);
  assert.match(html, />\+ Add another technician</);
  assert.match(html, />Complete without report</);
  assert.match(html, />Mark missed</);
  assert.match(html, />Cancel visit</);
  // A report already exists: technician locked; a single-technician report locks extras too.
  const reported = visit('r', { reportId: 'r9', reportReviewStatus: 'awaiting_review', additionalTechnicians: [{ technicianId: 't2', name: 'Ali', contribution: 'pending' }] });
  const locked = wrap(<ScheduleVisitCard job={job([])} visit={reported} actor="x" technicians={technicians as any} variant="upcoming" initiallyExpanded />);
  assert.match(locked, /<select disabled=""[^>]*title="Can&#x27;t be changed — a report has already been submitted for this visit\."/);
  assert.match(locked, /A single-technician report has already been submitted for this visit\. Additional technicians can&#x27;t be added\./);
  assert.doesNotMatch(locked, /aria-label="Add another technician to this visit"/);
  // The same writes as VisitRow, from one shared hook.
  const card = src('src', 'components', 'jobs', 'ScheduleVisitCard.tsx');
  assert.match(card, /useVisitManagement\(\{ visit, actor, technicians \}\)/);
  assert.match(card, /<CompleteVisitForm/);
  assert.match(card, /<CancelWorkDialog/);
  assert.doesNotMatch(card, /from '\.\.\/\.\.\/repository/, 'no writes of its own');
});

test('PAST: a compact row per visit - date, "technician · status", one report chip and Review / View; Write report when there is none', () => {
  const noReport = visit('p3', { status: 'completed', scheduledDate: '2026-11-04', completedAt: '2026-11-04T10:00:00Z', priceCharged: 10 });
  const html = panel(tabbed(job([toReview, approved, noReport])), 'visits');
  assert.match(html, />Past · 3</);
  assert.equal(count(html, /data-testid="schedule-visit-past"/), 3);
  assert.ok(html.indexOf('18 Nov 2026') < html.indexOf('11 Nov 2026') && html.indexOf('11 Nov 2026') < html.indexOf('4 Nov 2026'), 'most recent first');
  const row = (date: string) => html.slice(html.indexOf(date), html.indexOf('data-testid="schedule-visit-past"', html.indexOf(date)) >>> 0);
  const review = row('Wed, 18 Nov 2026');
  assert.match(review, /data-testid="visit-report-status"/);
  assert.match(review, /data-testid="visit-report-link"[^>]*>Review</);
  const view = row('Wed, 11 Nov 2026');
  assert.match(view, /data-testid="visit-report-link"[^>]*>View</);
  const write = html.slice(html.indexOf('Wed, 4 Nov 2026'));
  assert.match(write, /data-testid="visit-office-report"[^>]*>Write report</);
  assert.doesNotMatch(write, /visit-report-link/);
});

test('NO DUPLICATED STATUSES: the visit status once in the subline, the report status once in its chip', () => {
  const html = wrap(<ScheduleVisitCard job={job([])} visit={approved} actor="x" technicians={technicians as any} variant="past" initiallyExpanded />);
  assert.equal(count(html, /data-testid="schedule-visit-status"/), 1);
  assert.equal(count(html, /data-testid="visit-report-status"/), 1);
  assert.equal(count(html, />Approved</i), 1);
  assert.equal(count(html, />Completed</i), 1);
});

test('REVIEW / VIEW go to the existing pages: Report review on that report; Ready for client on that visit (its delivered list once sent or completed)', () => {
  assert.deepEqual(reportLinkFor(toReview), { label: 'Review', to: '/report-review?report=r1' });
  assert.deepEqual(reportLinkFor({ ...toReview, reportReviewStatus: 'returned_for_correction' }), { label: 'Review', to: '/report-review?report=r1' });
  assert.deepEqual(reportLinkFor(approved), { label: 'View', to: '/ready-for-client?visit=p2' });
  assert.deepEqual(reportLinkFor({ ...approved, sentToClientAt: '2026-11-12T09:00:00Z' }), { label: 'View', to: '/ready-for-client?view=delivered&visit=p2' });
  assert.deepEqual(reportLinkFor({ ...approved, reportCompletedAt: '2026-11-12T09:00:00Z' }), { label: 'View', to: '/ready-for-client?view=delivered&visit=p2' });
  assert.equal(reportLinkFor(upcoming), null);
  // Report review opens on ?report=<id>; without it nothing is pre-selected, as before.
  assert.match(src('src', 'pages', 'ReportReviewPage.tsx'), /useState<string \| null>\(\(\) => searchParams\.get\('report'\)\)/);
});

test('PAST LIST: the latest few, then "Show all"', () => {
  const many = Array.from({ length: PAST_VISITS_SHOWN + 2 }, (_, i) =>
    visit(`old${i}`, { status: 'missed', scheduledDate: `2026-10-${String(10 + i).padStart(2, '0')}` }));
  const html = panel(tabbed(job(many)), 'visits');
  assert.equal(count(html, /data-testid="schedule-visit-past"/), PAST_VISITS_SHOWN);
  assert.match(html, />Show all 7 past visits</);
});

test('BOOK A VISIT: one click from the Visits tab; opens by itself when the job needs booking; the same booking form', () => {
  const booked = panel(tabbed(job([upcoming])), 'visits');
  assert.match(booked, /data-testid="drawer-book-visit-toggle"[^>]*>\+ Book a visit</);
  assert.match(booked, /aria-expanded="false"[^>]*data-testid="drawer-book-visit-toggle"/);
  assert.doesNotMatch(booked, /data-testid="drawer-booking"/);
  const needs = panel(tabbed(job([], { status: 'needs_booking' })), 'visits');
  assert.match(needs, /data-testid="drawer-booking"/);
  assert.match(needs, /This job is due with no date set yet\./);
  assert.match(needs, />Book this visit</);
  assert.match(needs, /data-testid="drawer-no-upcoming"[^>]*>No upcoming visits\.</);
  // The same createVisit write as the classic layout - one booking form body shared by both.
  const drawer = noComments(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'));
  assert.equal(count(drawer, /createVisit\(/), 1);
  assert.equal(count(drawer, /\{bookingBody\}/), 2);
});

test('DETAILS TAB: prices per visit / month / year, assigned technician, client, invoice address, division · frequency', () => {
  const html = panel(tabbed(job([upcoming])), 'details');
  assert.match(html, /Per visit<\/div><div[^>]*>£10\.00</);
  assert.match(html, /Per month<\/div><div[^>]*>£43\.33</);
  assert.match(html, /Per year<\/div><div[^>]*>£520\.00</);
  assert.match(html, /<select aria-label="Assigned technician"/);
  assert.match(html, /<option value="t1" selected="">Mo<\/option>/);
  assert.match(html, /Client<\/dt><dd[^>]*>Acme Ltd</);
  assert.match(html, /Invoice address<\/dt><dd[^>]*>2 Low Rd, Town</);
  assert.match(html, /Division · frequency<\/dt><dd[^>]*>General · Weekly</);
  const variable = panel(tabbed(job([], { pricePerVisit: null, monthlyValue: null, yearlyValue: null })), 'details');
  assert.match(variable, /Per visit<\/div><div[^>]*>Variable</);
  assert.match(variable, /Per year<\/div><div[^>]*>On request</);
});

test('DETAILS TAB: access details hidden until revealed; Edit job, Open building file and End this job (active jobs only)', () => {
  const html = panel(tabbed(job([upcoming])), 'details');
  assert.match(html, /Access details/);
  assert.match(html, /aria-expanded="false"[^>]*>Reveal</);
  assert.match(html, />Internal only\. Key safe, keyholder and parking\.</);
  assert.doesNotMatch(html, /Key safe 4821/, 'the access note is not in the page until revealed');
  assert.match(html, />Edit job</);
  assert.match(html, />Open building file</);
  assert.match(html, /aria-expanded="false" aria-controls="[^"]+" data-testid="end-job-toggle"[^>]*>End this job/);
  assert.doesNotMatch(html, /end-job-choices/, 'choices closed until asked for');
  const closed = panel(tabbed(job([], { lifecycleStatus: 'completed' })), 'details');
  assert.doesNotMatch(closed, /End this job/);
  const drawer = noComments(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'));
  assert.match(drawer, /if \(choice === 'cancelled'\) setCancelOpen\(true\);\s*else setLifecycleTransition\(choice\);/, 'completed / lost -> the lifecycle dialog; cancelled -> the cancellation dialog');
  assert.match(drawer, /\{editDialogOpen && <JobEditDialog job=\{job\} onClose=\{\(\) => setEditDialogOpen\(false\)\} \/>\}/);
  assert.match(drawer, /navigate\(`\/buildings\/\$\{job\.buildingId\}`\)/);
});

test('OFFICE REPORT: one dialog at drawer level for both layouts, locked to the visit; its notice shows on the Visits tab', () => {
  const drawer = noComments(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'));
  assert.equal(count(drawer, /<OfficeReportDialog/), 1);
  assert.ok(drawer.indexOf('<OfficeReportDialog') > drawer.lastIndexOf('</aside>'), 'outside both layouts');
  const visitsPanel = drawer.slice(drawer.indexOf('id="job-drawer-panel-visits"'), drawer.indexOf('id="job-drawer-panel-details"'));
  assert.match(visitsPanel, /data-testid="drawer-office-report-notice"/);
  assert.match(visitsPanel, /officeReport=\{officeReportFor\(v\)\}/);
});

test('ACCESSIBLE NAMES: each visit action names its visit; the visible text stays short', () => {
  const html = panel(tabbed(job([upcoming, toReview, approved, visit('p3', { status: 'completed', scheduledDate: '2026-11-04', completedAt: '2026-11-04T10:00:00Z', priceCharged: 10 })])), 'visits');
  assert.match(html, /aria-label="Complete &amp; report — 25 Nov 2026" data-testid="visit-office-report"[^>]*>Complete &amp; report</);
  assert.match(html, /aria-label="Review report — 18 Nov 2026" data-testid="visit-report-link"[^>]*>Review</);
  assert.match(html, /aria-label="View report — 11 Nov 2026" data-testid="visit-report-link"[^>]*>View</);
  assert.match(html, /aria-label="Write report — 4 Nov 2026" data-testid="visit-office-report"[^>]*>Write report</);
});

test('END THIS JOB: a disclosure (not an ARIA menu) - Escape closes and refocuses the button; a press outside or focus leaving closes it', () => {
  const menu = src('src', 'components', 'jobs', 'EndJobMenu.tsx');
  assert.doesNotMatch(menu, /role="menu"|role="menuitem"|aria-haspopup/);
  assert.match(menu, /role="group"/);
  assert.match(menu, /e\.key === 'Escape'[\s\S]*?setOpen\(false\);\s*triggerRef\.current\?\.focus\(\);/);
  assert.match(menu, /document\.addEventListener\('pointerdown', onPointerDown\);\s*return \(\) => document\.removeEventListener\('pointerdown', onPointerDown\);/);
  assert.match(menu, /if \(!open\) return;\s*const onPointerDown/, 'listener only while open');
  assert.match(menu, /onBlur=\{\(e\) => \{[\s\S]*?if \(open && !rootRef\.current\?\.contains\(e\.relatedTarget as Node \| null\)\) setOpen\(false\);/, 'closes when focus leaves, including out of the page');
  assert.match(menu, /onMouseDown=\{\(e\) => \{\s*if \(!\(e\.target as HTMLElement\)\.closest\('button'\)\) e\.preventDefault\(\);/, 'a press on its text keeps it open');
  assert.match(menu, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/);
});

test('COPY JOB ID: copies the full id; "Copied" clears itself; the result is announced in a live region', () => {
  const html = tabbed(job([]));
  assert.match(html, /aria-label="Copy job ID 1EAB2D2F"/);
  assert.match(html, /<span role="status" aria-live="polite" class="sr-only" data-testid="copy-job-id-status"><\/span>/, 'live region mounted, empty');
  const drawer = noComments(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'));
  assert.match(drawer, /navigator\.clipboard\.writeText\(job\.id\)\.then\(\(\) => show\('copied'\), \(\) => show\('failed'\)\)/);
  assert.match(drawer, /copyTimer\.current = window\.setTimeout\(\(\) => setCopyState\('idle'\), 2500\);/);
  assert.match(drawer, /'Job ID copied'/);
});

test('COMPLETE WITHOUT REPORT: the open form stays in view - the chevron is hidden until it is saved or cancelled', () => {
  const card = noComments(src('src', 'components', 'jobs', 'ScheduleVisitCard.tsx'));
  assert.match(card, /\{canExpand && mode === 'summary' && \(/, 'no chevron while the form is open');
  assert.match(card, /\{expanded && mode === 'summary' && \(/);
  const form = card.indexOf('data-testid="visit-complete-form"');
  assert.ok(form > card.indexOf('data-testid="visit-details"'), 'rendered outside the chevron area');
  assert.equal((card.match(/<CompleteVisitForm/g) ?? []).length, 1);
  assert.match(card.slice(form), /onDone=\{\(\) => setMode\('summary'\)\} onCancel=\{\(\) => setMode\('summary'\)\}/, 'same completion logic, nothing discarded');
});

test('OVERDUE: a due/booked visit whose date has passed says so on its card (the header no longer carries the job status)', () => {
  const past = wrap(<ScheduleVisitCard job={job([])} visit={visit('o', { scheduledDate: '2020-01-06' })} actor="x" technicians={technicians as any} variant="upcoming" />);
  assert.match(past, /data-testid="visit-overdue"[^>]*>· Overdue</);
  const future = wrap(<ScheduleVisitCard job={job([])} visit={visit('f', { scheduledDate: '2099-01-06' })} actor="x" technicians={technicians as any} variant="upcoming" />);
  assert.doesNotMatch(future, /visit-overdue/);
  const done = wrap(<ScheduleVisitCard job={job([])} visit={visit('d', { status: 'completed', scheduledDate: '2020-01-06' })} actor="x" technicians={technicians as any} variant="past" />);
  assert.doesNotMatch(done, /visit-overdue/);
});
