// BOTH booking entry points must stop substituting a date the schedule never named, and must make the manager
// choose one before Book does anything.
//
//   Entry point 1 - the Monthly Plan row's inline Book form.
//   Entry point 2 - JobInspectorDrawer's booking panel, which is what the Month Matrix opens when a due cell is
//                   clicked (MonthMatrixPage hands it the preset date).
//
// Rendered to static markup on the real components, in the style of the other *Ui tests.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import MonthlyPlanRow from '../src/components/monthlyPlan/MonthlyPlanRow';
import JobInspectorDrawer from '../src/components/jobs/JobInspectorDrawer';
import { AuthContext } from '../src/auth/AuthProvider';
import { suggestDateInMonth } from '../src/lib/scheduleFormat';
import type { MonthlyPlanEntry } from '../src/lib/monthlyPlan';
import type { JobRow, Schedule } from '../src/domain/types';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};

const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{el}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  jobId: 'j1', scheduleType: 'due_month', intervalUnit: 'quarter', intervalCount: 1, weekday: null,
  weekOrdinal: null, dayOfMonth: null, rollForwardOnWeekend: true, dueMonth: 11, anchorDate: '2026-11-18', notes: null, ...over,
});

const job = (over: Partial<JobRow> = {}): JobRow =>
  ({
    id: 'j1', buildingId: 'b1', buildingName: 'Flair House', clientId: 'c1', clientName: 'ABC Property',
    jobSummary: 'Communal cleaning', division: 'General', lifecycleStatus: 'active', serviceEndsOn: null,
    frequency: 'Quarterly', frequencyRaw: 'Quarterly', frequencyType: 'quarterly', pricePerVisit: 100,
    yearlyValue: 400, monthlyValue: 33.33, nextDueLabel: '', status: 'needs_booking', technician: 'Unassigned',
    defaultTechnicianId: null, schedulePattern: 'Due Nov', schedule: schedule(), visits: [], lostReason: null,
    recontactDueAt: null, recontactNotes: null, recontactIntervalMonths: null, street: '', postcode: 'AB1',
    buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: null, clientContacts: [],
  }) as unknown as JobRow;

const entry = (over: Partial<MonthlyPlanEntry> = {}): MonthlyPlanEntry => ({
  job: job(), kind: 'due_no_date', visitsInMonth: [], dueFromMonth: null, suggestedDate: null,
  label: 'Due this month — no date set yet', needsSchedule: false, ...over,
});

const row = (e: MonthlyPlanEntry) => wrap(<MonthlyPlanRow entry={e} technicians={[]} onOpenJob={noop} />);

// ---- entry point 1: the Monthly Plan row ------------------------------------------------------------------------
test('PLAN ROW: a due_month job outside its anchor month gets an EMPTY date and must be chosen', () => {
  const html = row(entry());
  assert.doesNotMatch(html, /value="2026-\d\d-01"/, 'never the 1st of the month');
  assert.doesNotMatch(html, /value="\d{4}-\d\d-18"/, 'and never the anchor’s day');
  assert.match(html, /data-testid="no-set-date-hint"/);
  assert.match(html, /No set date for this month — choose one\./);
  assert.match(html, /disabled=""/, 'Book is disabled while there is no date');
});

test('PLAN ROW: a schedule that DOES name the day still pre-fills it, unchanged', () => {
  const html = row(entry({ suggestedDate: '2026-11-18' }));
  assert.match(html, /value="2026-11-18"/);
  assert.doesNotMatch(html, /data-testid="no-set-date-hint"/);
});

test('PLAN ROW: the anchor’s own month is pre-filled — the manager really did type that date', () => {
  // What the derivation hands the row for November 2026 vs February 2027, end to end.
  assert.equal(suggestDateInMonth(schedule(), 2026, 11), '2026-11-18');
  assert.equal(suggestDateInMonth(schedule(), 2027, 2), null);
  assert.match(row(entry({ suggestedDate: suggestDateInMonth(schedule(), 2026, 11) })), /value="2026-11-18"/);
  assert.match(row(entry({ suggestedDate: suggestDateInMonth(schedule(), 2027, 2) })), /data-testid="no-set-date-hint"/);
});

// ---- entry point 2: the drawer, as the Month Matrix opens it -----------------------------------------------------
test('DRAWER: an EMPTY preset leaves the date empty, says why, and disables Book', () => {
  const html = wrap(<JobInspectorDrawer job={job()} siblings={[]} onClose={noop} onSelectSibling={noop} forceShowBooking presetVisitDate="" />);
  assert.match(html, /data-testid="no-set-date-hint"/);
  assert.match(html, /This job has no set date for this month — choose one\./);
  assert.doesNotMatch(html, /value="\d{4}-\d\d-01"/, 'never the 1st');
  assert.match(html, /Book this visit/);
  assert.match(html, /disabled=""/);
});

test('DRAWER: a real preset is still used as-is', () => {
  const html = wrap(<JobInspectorDrawer job={job()} siblings={[]} onClose={noop} onSelectSibling={noop} forceShowBooking presetVisitDate="2026-11-18" />);
  assert.match(html, /value="2026-11-18"/);
  assert.doesNotMatch(html, /data-testid="no-set-date-hint"/);
});

test('DRAWER: an ABSENT preset still falls back to today — only an EMPTY one means "not set"', () => {
  // The distinction is load-bearing: `'' ?? today` is `''`, `undefined ?? today` is today. Opening the drawer
  // normally (no preset) must keep its old behaviour.
  const html = wrap(<JobInspectorDrawer job={job()} siblings={[]} onClose={noop} onSelectSibling={noop} />);
  assert.doesNotMatch(html, /data-testid="no-set-date-hint"/);
  assert.match(html, /value="\d{4}-\d\d-\d\d"/);
});

// ---- the Month Matrix hands over that empty preset ----------------------------------------------------------------
test('MONTH MATRIX no longer substitutes the 1st of the clicked month', () => {
  const src = readFileSync(join(process.cwd(), 'src/pages/MonthMatrixPage.tsx'), 'utf8');
  assert.match(src, /setPresetVisitDate\(suggested \?\? ''\)/, 'an unnamed day becomes an empty preset');
  assert.doesNotMatch(src, /firstOfMonthISO/, 'the first-of-month fallback is gone entirely');
});

test('MONTHLY PLAN PAGE no longer substitutes the 1st for a brand-new one-off job either', () => {
  const src = readFileSync(join(process.cwd(), 'src/pages/MonthlyPlanPage.tsx'), 'utf8');
  assert.doesNotMatch(src, /openJob\(jobId, `\$\{monthPrefix\}-01`\)/);
  assert.match(src, /openJob\(jobId, ''\)/);
});
