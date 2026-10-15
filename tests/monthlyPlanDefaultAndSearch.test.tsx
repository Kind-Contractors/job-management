// Two Monthly Plan fixes, tested on the REAL components (server-rendered to static markup from a seeded query cache;
// there is no DOM library in this repo):
//
//  1. The default view is what is DUE this month. Jobs with NO schedule are not due in any month, so listing them
//     in the default view buried the worklist as soon as real data arrived (418 imported jobs have no schedule).
//     They stay reachable behind "Needs a schedule", counted, and an empty month says how many are waiting.
//
//  2. The global search box was disabled on the Monthly Plan because TopBar keeps a hardcoded allowlist of routes
//     whose page reads `?q=`, and the Monthly Plan was never added (nor did it read `q`). Now it does both.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import MonthlyPlanPage from '../src/pages/MonthlyPlanPage';
import TopBar, { SEARCHABLE_ROUTES, isSearchableRoute } from '../src/components/shell/TopBar';
import { matchesJobSearch } from '../src/lib/jobSearch';
import { AuthContext } from '../src/auth/AuthProvider';
import type { JobRow, JobVisitSummary, Schedule } from '../src/domain/types';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

// Any network request during a render would mean searching or planning had side effects. There must be none.
const requests: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  requests.push(`${(init?.method ?? 'GET').toUpperCase()} ${typeof input === 'string' ? input : input.url}`);
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// ---- fixtures ---------------------------------------------------------------------------------------------------
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  jobId: 'x', scheduleType: 'fixed_date', intervalUnit: 'month', intervalCount: 1, weekday: null,
  weekOrdinal: null, dayOfMonth: 10, rollForwardOnWeekend: false, dueMonth: null, anchorDate: null, notes: null, ...over,
});

const job = (id: string, building: string, over: Partial<JobRow> = {}): JobRow =>
  ({
    id, buildingId: `b-${id}`, buildingName: building, clientId: `c-${id}`, clientName: `${building} Ltd`,
    clientInvoiceAddress: '1 Test Way', jobSummary: 'Communal cleaning', division: 'General', lifecycleStatus: 'active',
    frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 100, yearlyValue: 1200,
    monthlyValue: 100, postcode: 'AB1 2CD', technician: 'Unassigned', defaultTechnicianId: null,
    schedulePattern: 'Monthly', schedule: null, visits: [], serviceEndsOn: null, status: 'unscheduled', ...over,
  }) as unknown as JobRow;

/** A monthly job WITH a schedule: due in every month, so due in November. */
const DUE = job('due', 'Flair House', { schedule: schedule(), schedulePattern: '10th' });
/** Already booked in November. */
const BOOKED = job('booked', 'Granite Court', {
  schedule: schedule(),
  schedulePattern: '10th',
  visits: [{ id: 'v1', scheduledDate: '2026-11-12', status: 'booked', technicianName: 'Anna', additionalTechnicians: [], reportReviewStatus: null } as unknown as JobVisitSummary],
});
/** Priced monthly, but NO schedule: not due in any month. */
const UNSCHEDULED_A = job('u1', 'Hollis Mews');
const UNSCHEDULED_B = job('u2', 'Ivy Lodge', { frequencyRaw: 'Quarterly', frequency: 'Quarterly', frequencyType: 'quarterly' });

const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };

function page(jobs: JobRow[], search = '?month=2026-11') {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['jobRows'], jobs);
  qc.setQueryData(['technicians'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/monthly-plan${search}`]}>
        <MonthlyPlanPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const chip = (html: string, label: string) => new RegExp(`${label} \\((\\d+)\\)`).exec(html.replace(/<!-- -->/g, ''))?.[1];
const rowCount = (html: string) => (html.match(/data-testid="monthly-plan-row"/g) ?? []).length;
const flat = (html: string) => html.replace(/<!-- -->/g, '');

// ============================================================================================================
// 1. THE DEFAULT VIEW
// ============================================================================================================
test('DEFAULT: shows what is due and what is booked — and NOT the jobs that have no schedule', () => {
  const html = page([DUE, BOOKED, UNSCHEDULED_A, UNSCHEDULED_B]);
  assert.equal(rowCount(html), 2, 'only the two jobs in play this month');
  assert.match(html, /Flair House/, 'a due job is listed');
  assert.match(html, /Granite Court/, 'a booked job is listed');
  assert.doesNotMatch(html, /Hollis Mews/, 'an unscheduled job is not');
  assert.doesNotMatch(html, /Ivy Lodge/, 'neither is the other');
});

test('DEFAULT: the chip is labelled "This month" and counts exactly what it shows', () => {
  const html = page([DUE, BOOKED, UNSCHEDULED_A, UNSCHEDULED_B]);
  assert.equal(chip(html, 'This month'), '2');
  assert.doesNotMatch(flat(html), /Everything \(/, 'the old label claimed to show everything');
});

test('"Needs a schedule" keeps its count so the unscheduled jobs stay discoverable', () => {
  const html = page([DUE, BOOKED, UNSCHEDULED_A, UNSCHEDULED_B]);
  assert.equal(chip(html, 'Needs a schedule'), '2');
  assert.match(flat(html), /Review 2/, 'and the banner offers the way in');
  assert.match(flat(html), /2 jobs are priced but have no schedule/);
});

test('OVERDUE and CAN’T-TELL jobs are still in the default view — only no-schedule jobs moved out', () => {
  const src_ = src('pages/MonthlyPlanPage.tsx');
  assert.match(src_, /key: 'all', label: 'This month', match: \(e\) => e\.kind !== 'no_schedule'/);
  // every other chip is untouched
  for (const k of ['due_no_date', 'carried_over', 'booked', 'not_determinable']) {
    assert.match(src_, new RegExp(`key: '${k}'[^\\n]*match: \\(e\\) => e\\.kind === '${k}'`));
  }
  assert.match(src_, /key: 'needs_schedule'[^\n]*match: \(e\) => e\.needsSchedule/);
});

test('A job priced as recurring but booked this month is still shown (and still flagged as needing a schedule)', () => {
  const bookedNoSchedule = job('bn', 'Jasmine Row', {
    visits: [{ id: 'v9', scheduledDate: '2026-11-03', status: 'booked', technicianName: 'Anna', additionalTechnicians: [], reportReviewStatus: null } as unknown as JobVisitSummary],
  });
  const html = page([bookedNoSchedule]);
  assert.equal(rowCount(html), 1, 'a real booking is work in play whatever its schedule says');
  assert.match(html, /data-testid="needs-schedule-chip"/);
});


test('PLANNED VALUE describes this month’s plan, not the unscheduled jobs waiting outside it', () => {
  // DUE and BOOKED are worth 1,200 a year each; the two unscheduled jobs must add nothing to the tile.
  const tile = (html: string) => /Planned value[\s\S]*?(£[\d,]+)/i.exec(flat(html))?.[1];
  assert.equal(tile(page([DUE, BOOKED, UNSCHEDULED_A, UNSCHEDULED_B])), '£2,400');
  // A month with nothing due reads as nothing planned, however many unscheduled jobs exist.
  assert.equal(tile(page([UNSCHEDULED_A, UNSCHEDULED_B])), '£0');
});

// ---- the empty state ---------------------------------------------------------------------------------------------
test('EMPTY MONTH: names the month, says how many jobs are unscheduled, and offers the way in', () => {
  const html = page([UNSCHEDULED_A, UNSCHEDULED_B, job('u3', 'Kestrel Place')]);
  assert.equal(rowCount(html), 0);
  assert.match(html, /data-testid="monthly-plan-empty"/);
  assert.match(flat(html), /Nothing is due in November 2026/);
  assert.match(flat(html), /3 jobs have no schedule yet, so they can’t come due in any month\./);
  assert.match(flat(html), /Review 3 unscheduled jobs/);
});

test('EMPTY MONTH singularises for one unscheduled job', () => {
  const html = flat(page([UNSCHEDULED_A]));
  assert.match(html, /1 job has no schedule yet, so it can’t come due in any month\./);
  assert.match(html, /Review 1 unscheduled job</);
});

test('EMPTY MONTH with nothing unscheduled either is a plain, honest empty state', () => {
  const html = flat(page([]));
  assert.match(html, /Nothing is due in November 2026/);
  assert.doesNotMatch(html, /have no schedule yet/);
  assert.doesNotMatch(html, /Review \d+ unscheduled/);
});

test('The month in the empty state follows the month being planned', () => {
  assert.match(flat(page([UNSCHEDULED_A], '?month=2027-02')), /Nothing is due in February 2027/);
});

// ============================================================================================================
// 2. GLOBAL SEARCH
// ============================================================================================================
test('SEARCH: the allowlist now includes the Monthly Plan', () => {
  assert.equal(isSearchableRoute('/monthly-plan'), true);
  assert.ok(SEARCHABLE_ROUTES.includes('/monthly-plan'));
});

test('SEARCH: the pages that ALREADY filter on q are enabled too (their boxes were wrongly disabled)', () => {
  for (const route of ['/jobs', '/buildings', '/this-week', '/historical-jobs']) {
    assert.equal(isSearchableRoute(route), true, `${route} reads q`);
  }
  assert.match(src('pages/ThisWeekPage.tsx'), /searchParams\.get\('q'\)/);
  assert.match(src('pages/HistoricalJobsPage.tsx'), /searchParams\.get\('q'\)/);
});

test('SEARCH stays DISABLED where the page does not read q — a box that does nothing would mislead', () => {
  for (const route of ['/month-matrix', '/report-review', '/users', '/buildings/abc123', '/monthly-plan/extra']) {
    assert.equal(isSearchableRoute(route), false, `${route} must stay disabled`);
  }
  assert.doesNotMatch(src('pages/MonthMatrixPage.tsx'), /get\('q'\)/, 'Month Matrix really does not read q');
});

test('SEARCH: every route on the allowlist has a page that actually reads q', () => {
  const pageFor: Record<string, string> = {
    '/jobs': 'AllLiveJobsPage', '/buildings': 'BuildingsPage', '/this-week': 'ThisWeekPage',
    '/historical-jobs': 'HistoricalJobsPage', '/monthly-plan': 'MonthlyPlanPage',
  };
  for (const route of SEARCHABLE_ROUTES) {
    assert.ok(pageFor[route], `${route} has no page mapped - extend this test when adding a route`);
    assert.match(src(`pages/${pageFor[route]}.tsx`), /get\('q'\)/, `${route} is enabled but its page ignores q`);
  }
});

function topBar(path: string) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[path]}>{(<TopBar />) as ReactElement}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

test('SEARCH BOX: enabled on /monthly-plan, disabled on /month-matrix', () => {
  const on = topBar('/monthly-plan?month=2026-11');
  assert.match(on, /<input[^>]*placeholder="Search jobs &amp; buildings"/);
  assert.doesNotMatch(on, /<input[^>]*disabled=""/);
  assert.doesNotMatch(on, /Search isn.t available/);
  assert.match(topBar('/month-matrix'), /<input[^>]*disabled=""/);
});

test('SEARCH BOX keeps the planned month in the URL when it writes q', () => {
  const bar = src('components/shell/TopBar.tsx');
  assert.match(bar, /const next = new URLSearchParams\(searchParams\);/, 'it copies the existing params, so ?month= survives');
});

test('SEARCH filters the plan by building, client, job and postcode', () => {
  const jobs = [DUE, BOOKED, UNSCHEDULED_A];
  assert.deepEqual([...flat(page(jobs, '?month=2026-11&q=flair')).matchAll(/data-testid="monthly-plan-row"/g)].length, 1);
  assert.match(page(jobs, '?month=2026-11&q=flair'), /Flair House/);
  assert.doesNotMatch(page(jobs, '?month=2026-11&q=flair'), /Granite Court/);
  assert.match(page(jobs, '?month=2026-11&q=GRANITE%20COURT%20LTD'), /Granite Court/, 'client name, any case');
  assert.equal(rowCount(page(jobs, '?month=2026-11&q=ab1')), 2, 'postcode matches both in-play jobs');
});

test('SEARCH also narrows the unscheduled jobs, so "Needs a schedule" counts what matches', () => {
  const jobs = [DUE, UNSCHEDULED_A, UNSCHEDULED_B];
  assert.equal(chip(page(jobs, '?month=2026-11'), 'Needs a schedule'), '2');
  assert.equal(chip(page(jobs, '?month=2026-11&q=hollis'), 'Needs a schedule'), '1');
});

test('SEARCH with no match says what was searched and for which month', () => {
  const html = flat(page([DUE, BOOKED], '?month=2026-11&q=zzznothing'));
  assert.equal(rowCount(html), 0);
  assert.match(html, /Nothing matches “zzznothing” in November 2026/);
});

test('SEARCH never reads as "no schedule yet" — it is a different empty state', () => {
  const html = flat(page([DUE, UNSCHEDULED_A], '?month=2026-11&q=zzznothing'));
  assert.doesNotMatch(html, /have no schedule yet|has no schedule yet/);
});

test('SEARCH matches the same fields as All Live Jobs, case-insensitively and by substring', () => {
  assert.equal(matchesJobSearch(DUE, 'flair'), true);
  assert.equal(matchesJobSearch(DUE, 'COMMUNAL'), true);
  assert.equal(matchesJobSearch(DUE, 'ab1 2cd'), true);
  assert.equal(matchesJobSearch(DUE, 'monthly'), true, 'frequency');
  assert.equal(matchesJobSearch(DUE, '10th'), true, 'schedule pattern');
  assert.equal(matchesJobSearch(DUE, 'unassigned'), true, 'technician');
  assert.equal(matchesJobSearch(DUE, 'granite'), false);
  assert.equal(matchesJobSearch(DUE, ''), true);
  assert.equal(matchesJobSearch(DUE, '   '), true, 'whitespace is no query');
});

test('SEARCH is read-only: it never mutates a job, never writes, never calls the network', () => {
  const frozen = Object.freeze({ ...DUE });
  assert.doesNotThrow(() => matchesJobSearch(frozen as JobRow, 'flair'));

  requests.length = 0;
  page([DUE, BOOKED, UNSCHEDULED_A], '?month=2026-11&q=flair');
  page([DUE, BOOKED, UNSCHEDULED_A], '?month=2026-11&q=zzz');
  assert.deepEqual(requests, [], 'rendering and searching issued no request at all');

  const helper = src('lib/jobSearch.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(helper, /repository|supabase|fetch|upsert|createVisit|schedules/, 'the matcher touches no data layer');
});

test('SEARCH does not change recurrence: the schedule a job carries is identical before and after', () => {
  const before = JSON.stringify(DUE.schedule);
  matchesJobSearch(DUE, '10th');
  page([DUE], '?month=2026-11&q=flair');
  assert.equal(JSON.stringify(DUE.schedule), before);
});
