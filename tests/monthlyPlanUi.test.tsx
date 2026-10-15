// The Monthly Plan row (src/components/monthlyPlan/MonthlyPlanRow.tsx) rendered to static markup, in the style of
// the other *Ui tests. Interaction (actually booking) is checked in the browser test against DEV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import MonthlyPlanRow from '../src/components/monthlyPlan/MonthlyPlanRow';
import type { MonthlyPlanEntry } from '../src/lib/monthlyPlan';
import type { JobRow, JobVisitSummary, Technician } from '../src/domain/types';

const technicians: Technician[] = [
  { id: 't1', name: 'Anna', isActive: true } as Technician,
  { id: 't2', name: 'Ben', isActive: true } as Technician,
];

const job = (over: Partial<JobRow> = {}): JobRow =>
  ({
    id: 'j1', buildingName: 'Flair House', clientName: 'ABC Property', jobSummary: 'Communal cleaning',
    buildingId: 'b1', clientId: 'c1', division: 'General', visits: [], serviceEndsOn: null,
    defaultTechnicianId: null, schedulePattern: 'Every quarter, 3rd Wednesday', schedule: null, ...over,
  }) as JobRow;

const entry = (over: Partial<MonthlyPlanEntry> = {}): MonthlyPlanEntry => ({
  job: job(), kind: 'due_no_date', visitsInMonth: [], dueFromMonth: null, suggestedDate: '2026-08-19',
  label: 'Due this month — no date set yet', needsSchedule: false, ...over,
});

const render = (e: MonthlyPlanEntry) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MonthlyPlanRow entry={e} technicians={technicians} onOpenJob={() => {}} onSetSchedule={() => {}} />
    </QueryClientProvider>,
  );

test('TO BOOK: the row offers the schedule’s real suggested date, a technician picker and a Book button', () => {
  const html = render(entry());
  assert.match(html, /Flair House/);
  assert.match(html, /ABC Property · Communal cleaning/);
  assert.match(html, /value="2026-08-19"/, 'the suggested date, not the 1st');
  assert.match(html, /aria-label="Date for Flair House"/);
  assert.match(html, />Book</);
  assert.match(html, />To book</);
});

test('TO BOOK with no day named by the schedule leaves the date EMPTY and says so', () => {
  // Never the 1st, and never the anchor's day: substituting a date the schedule did not name makes an undecided
  // date look decided, and Book is one click away.
  const html = render(entry({ suggestedDate: null }));
  assert.doesNotMatch(html, /value="2026-08-01"/);
  assert.match(html, /aria-label="Date for Flair House"[^>]*value=""|value=""[^>]*aria-label="Date for Flair House"/);
  assert.match(html, /data-testid="no-set-date-hint"[^>]*>No set date — choose one\./);
  assert.match(html, /disabled=""/, 'Book stays disabled until a date is chosen');
});

test('OVERDUE: a carried-over job says which month it was missed from, and can still be booked', () => {
  const html = render(entry({ kind: 'carried_over', dueFromMonth: '2026-06' }));
  assert.match(html, /data-testid="overdue-chip"[^>]*>Overdue from June — never booked</);
  assert.match(html, />Book</, 'still bookable');
  assert.match(html, />Overdue</);
});

test('BOOKED: the month’s real visits are listed with who is on them, and no Book button is offered', () => {
  const visit = { id: 'v1', scheduledDate: '2026-08-12', status: 'booked', technicianName: 'Anna', additionalTechnicians: [{ technicianId: 't2' }] } as unknown as JobVisitSummary;
  const html = render(entry({ kind: 'booked', visitsInMonth: [visit], label: 'Booked' }));
  assert.match(html, /data-testid="booked-visits"/);
  assert.match(html, /12\/08\/2026/);
  assert.match(html, /Anna \+1/, 'the extra technician is counted, not hidden');
  assert.doesNotMatch(html, />Book</);
  assert.doesNotMatch(html, /aria-label="Date for Flair House"/);
});

test('BOOKED offers a way to change the existing visit, and never a second booking form', () => {
  const visit = { id: 'v1', scheduledDate: '2026-08-12', status: 'booked', technicianName: 'Anna', additionalTechnicians: [] } as unknown as JobVisitSummary;
  const html = render(entry({ kind: 'booked', visitsInMonth: [visit] }));
  assert.match(html, /data-testid="change-booking"[^>]*>Change</);
  // The booking form is what INSERTS a visit; a booked row must not show it, or a second visit could be made by
  // accident. Moving the existing one is an in-place update reached through the job drawer instead.
  assert.doesNotMatch(html, /aria-label="Date for Flair House"/);
  assert.doesNotMatch(html, />Book</);
});

test('TO BOOK does not offer the change link — there is nothing booked to change yet', () => {
  assert.doesNotMatch(render(entry()), /data-testid="change-booking"/);
});

test('BOOKED with nobody assigned says so rather than showing a blank', () => {
  const visit = { id: 'v1', scheduledDate: '2026-08-12', status: 'booked', technicianName: null, additionalTechnicians: [] } as unknown as JobVisitSummary;
  assert.match(render(entry({ kind: 'booked', visitsInMonth: [visit] })), /No technician yet/);
});

test('CAN’T TELL: an unphased cycle explains itself and offers the fix, instead of a booking form', () => {
  const html = render(entry({ kind: 'not_determinable', suggestedDate: null }));
  assert.match(html, /no “counted from” date/);
  assert.match(html, />Set it on the job</);
  assert.doesNotMatch(html, />Book</, 'nothing to book until the cycle is known');
});

test('A clash warning is not shown until Book is actually pressed', () => {
  const clashing = job({ visits: [{ id: 'v9', scheduledDate: '2026-08-19', status: 'booked' } as JobVisitSummary] });
  assert.doesNotMatch(render(entry({ job: clashing })), /data-testid="clash-warning"/);
});
