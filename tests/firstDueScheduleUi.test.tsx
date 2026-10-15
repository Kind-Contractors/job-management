// The New Job form's recurrence section and the two "this job has no schedule" warnings, rendered to static
// markup in the style of the other *Ui tests. The write path (createJob then upsertSchedule) is exercised in
// the browser test against DEV; what is pinned here is what the form OFFERS and what it SAYS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import JobCreator from '../src/components/jobs/JobCreator';
import ScheduleEditor from '../src/components/jobs/ScheduleEditor';
import MonthlyPlanRow from '../src/components/monthlyPlan/MonthlyPlanRow';
import type { MonthlyPlanEntry } from '../src/lib/monthlyPlan';
import type { FrequencyType, JobRow, Schedule } from '../src/domain/types';

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>,
  );

const creator = (defaultFrequencyType?: FrequencyType) =>
  wrap(<JobCreator defaultFrequencyType={defaultFrequencyType} onCreated={() => {}} onCancel={() => {}} />);

// ---- the form ---------------------------------------------------------------------------------------------------
test('The frequency field says it is for pricing, and that recurrence is set separately', () => {
  const html = creator();
  assert.match(html, /Frequency \(for pricing\)/);
  assert.match(html, /Used for the monthly and yearly totals\. When the work actually falls is set below\./);
  assert.doesNotMatch(html, /Frequency \(optional\)/, 'the old, misleading label is gone');
});

test('No frequency chosen: no recurrence section, no warning — an unchanged blank form', () => {
  const html = creator();
  assert.doesNotMatch(html, /data-testid="recurrence-section"/);
  assert.doesNotMatch(html, /data-testid="no-schedule-warning"/);
  assert.doesNotMatch(html, /data-testid="week-based-note"/);
});

for (const f of ['monthly', 'quarterly', 'biannual', 'annual'] as FrequencyType[]) {
  test(`${f.toUpperCase()}: the First due date is offered, and its absence is warned about up front`, () => {
    const html = creator(f);
    assert.match(html, /data-testid="recurrence-section"/);
    assert.match(html, /aria-label="First due date"/);
    assert.match(html, /First due date \(optional\)/, 'optional — a blank one must stay allowed');
    // Nothing is typed yet, so no pattern can be offered and no schedule can exist.
    assert.doesNotMatch(html, /data-testid="recurrence-pattern"/);
    assert.doesNotMatch(html, /data-testid="recurrence-preview"/);
    assert.match(html, /data-testid="no-schedule-warning"/);
    assert.match(html, /won.t appear on the Monthly\s+Plan/);
  });
}

for (const f of ['weekly', 'fortnightly'] as FrequencyType[]) {
  test(`${f.toUpperCase()}: no First due date is offered, and the gap is stated rather than papered over`, () => {
    const html = creator(f);
    assert.doesNotMatch(html, /data-testid="recurrence-section"/, 'a week cadence must not be schedulable from here');
    assert.match(html, /data-testid="week-based-note"/);
    assert.match(html, /can.t be placed on the Monthly Plan yet/);
    assert.doesNotMatch(html, /data-testid="no-schedule-warning"/, 'one message, not two');
  });
}

for (const f of ['one_off', 'ask_adhoc'] as FrequencyType[]) {
  test(`${f.toUpperCase()}: no recurrence asked for and no warning — these correctly have no schedule`, () => {
    const html = creator(f);
    assert.doesNotMatch(html, /data-testid="recurrence-section"/);
    assert.doesNotMatch(html, /data-testid="no-schedule-warning"/);
    assert.doesNotMatch(html, /data-testid="week-based-note"/);
  });
}

// ---- the existing-job warning -------------------------------------------------------------------------------------
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  jobId: 'j1', scheduleType: 'fixed_date', intervalUnit: 'month', intervalCount: 1, weekday: null,
  weekOrdinal: null, dayOfMonth: 10, rollForwardOnWeekend: false, dueMonth: null, anchorDate: null, notes: null, ...over,
});

test('An existing recurring job with no schedule is warned about, with the consequence spelled out', () => {
  const html = wrap(<ScheduleEditor jobId="j1" schedule={null} frequencyType="quarterly" />);
  assert.match(html, /data-testid="missing-schedule-warning"/);
  assert.match(html, /never become due on its own/);
  assert.match(html, />Add schedule</, 'and the fix is right there');
});

test('A weekly job with no schedule gets the honest weekly message instead', () => {
  const html = wrap(<ScheduleEditor jobId="j1" schedule={null} frequencyType="weekly" />);
  assert.match(html, /data-testid="missing-schedule-warning"/);
  assert.match(html, /weekly cadences can.t be placed on the Monthly Plan yet/);
});

test('Ad-hoc, one-off and unpriced jobs with no schedule are never warned about', () => {
  for (const frequencyType of ['ask_adhoc', 'one_off', null] as (FrequencyType | null)[]) {
    const html = wrap(<ScheduleEditor jobId="j1" schedule={null} frequencyType={frequencyType} />);
    assert.doesNotMatch(html, /data-testid="missing-schedule-warning"/, `${frequencyType} must not warn`);
    assert.match(html, /No schedule set for this job\./, 'it is still stated as a plain fact');
  }
});

test('A job that HAS a schedule never warns, whatever it is priced as', () => {
  const html = wrap(<ScheduleEditor jobId="j1" schedule={schedule()} frequencyType="monthly" />);
  assert.doesNotMatch(html, /data-testid="missing-schedule-warning"/);
});

// ---- discoverability on the Monthly Plan ----------------------------------------------------------------------
const job = (over: Partial<JobRow> = {}): JobRow =>
  ({
    id: 'j1', buildingName: 'Flair House', clientName: 'ABC Property', jobSummary: 'Communal cleaning',
    buildingId: 'b1', clientId: 'c1', division: 'General', visits: [], serviceEndsOn: null, frequencyRaw: 'Monthly',
    defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, frequencyType: 'monthly', ...over,
  }) as JobRow;

const entry = (over: Partial<MonthlyPlanEntry> = {}): MonthlyPlanEntry => ({
  job: job(), kind: 'no_schedule', visitsInMonth: [], dueFromMonth: null, suggestedDate: null,
  label: 'No schedule set — this job can never become due', needsSchedule: true, ...over,
});

const row = (e: MonthlyPlanEntry) =>
  wrap(<MonthlyPlanRow entry={e} technicians={[]} onOpenJob={() => {}} onSetSchedule={() => {}} />);

test('A no-schedule job appears on the plan explaining itself, with no booking form offered', () => {
  const html = row(entry());
  assert.match(html, /data-testid="no-schedule-explainer"/);
  assert.match(html, /Won’t come due until a schedule is set\./);
  assert.match(html, />Set a schedule</);
  assert.match(html, />No schedule</, 'the badge');
  // Nothing may be booked into a cycle that does not exist — that is the invented due-ness this avoids.
  assert.doesNotMatch(html, /aria-label="Date for Flair House"/);
  assert.doesNotMatch(html, />Book</);
});

test('A booked job that is still missing its schedule carries the chip, so next month is not a surprise', () => {
  const visit = { id: 'v1', scheduledDate: '2026-08-12', status: 'booked', technicianName: null, additionalTechnicians: [] };
  const html = row(entry({ kind: 'booked', visitsInMonth: [visit as never], label: 'Booked' }));
  assert.match(html, /data-testid="needs-schedule-chip"/);
  assert.match(html, /data-testid="booked-visits"/);
});

test('A properly scheduled job carries no chip and no explainer', () => {
  const html = row(entry({ kind: 'due_no_date', job: job({ schedule: schedule() }), needsSchedule: false, suggestedDate: '2026-08-10' }));
  assert.doesNotMatch(html, /data-testid="needs-schedule-chip"/);
  assert.doesNotMatch(html, /data-testid="no-schedule-explainer"/);
  assert.match(html, />Book</, 'and it is bookable as before');
});
