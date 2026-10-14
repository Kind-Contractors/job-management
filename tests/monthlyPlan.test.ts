// The Monthly Plan derivation (src/lib/monthlyPlan.ts): what wants doing in one month, what is already booked,
// and what was due earlier and never got booked. Pure logic, no React, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMonthlyPlan, carriedOverLabel, needsBookingCount, shiftMonthPrefix, visitsOnDate } from '../src/lib/monthlyPlan';
import type { JobRow, JobVisitSummary, Schedule } from '../src/domain/types';

const TODAY = '2026-08-20';

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  jobId: 'j1', scheduleType: 'fixed_date', intervalUnit: 'month', intervalCount: 1,
  weekday: null, weekOrdinal: null, dayOfMonth: 10, rollForwardOnWeekend: false,
  dueMonth: null, anchorDate: null, notes: null, ...over,
});

const visit = (over: Partial<JobVisitSummary> = {}): JobVisitSummary =>
  ({ id: 'v1', scheduledDate: '2026-08-10', status: 'booked', technicianId: null, reportId: null, reportReviewStatus: null, ...over }) as JobVisitSummary;

const job = (over: Partial<JobRow> = {}): JobRow =>
  ({
    id: 'j1', buildingName: 'Flair', clientName: 'ABC', jobSummary: 'Communal cleaning',
    division: 'General', schedule: schedule(), visits: [], serviceEndsOn: null,
    defaultTechnicianId: null, schedulePattern: 'Monthly, on the 10th', ...over,
  }) as JobRow;

const only = (entries: ReturnType<typeof buildMonthlyPlan>) => {
  assert.equal(entries.length, 1, `expected one entry, got ${entries.length}`);
  return entries[0];
};

// ---- the four kinds ------------------------------------------------------------------------------------------------
test('DUE, no date: a monthly job with nothing booked that month, with the real day suggested', () => {
  const e = only(buildMonthlyPlan([job()], '2026-08', TODAY));
  assert.equal(e.kind, 'due_no_date');
  assert.equal(e.suggestedDate, '2026-08-10');
  assert.deepEqual(e.visitsInMonth, []);
  assert.equal(e.dueFromMonth, null);
});

test('BOOKED: a real visit in the month wins, and is handed back so the row can show it', () => {
  const e = only(buildMonthlyPlan([job({ visits: [visit()] })], '2026-08', TODAY));
  assert.equal(e.kind, 'booked');
  assert.equal(e.visitsInMonth.length, 1);
  assert.equal(e.visitsInMonth[0].scheduledDate, '2026-08-10');
});

test('A CANCELLED visit is not a booking: the month still wants doing', () => {
  const e = only(buildMonthlyPlan([job({ visits: [visit({ status: 'cancelled' })] })], '2026-08', TODAY));
  assert.equal(e.kind, 'due_no_date');
  assert.deepEqual(e.visitsInMonth, []);
});

test('NOT DETERMINABLE: a quarterly job with no anchor is surfaced for attention, never guessed and never dropped', () => {
  const e = only(buildMonthlyPlan([job({ schedule: schedule({ intervalUnit: 'quarter', intervalCount: 1 }) })], '2026-08', TODAY));
  assert.equal(e.kind, 'not_determinable');
  assert.equal(e.suggestedDate, null);
  // ...and once anchored it becomes a normal, answerable job.
  const anchored = job({ schedule: schedule({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-08-10' }) });
  assert.equal(only(buildMonthlyPlan([anchored], '2026-08', TODAY)).kind, 'due_no_date');
  assert.equal(buildMonthlyPlan([anchored], '2026-09', TODAY).length, 0, 'September is not in the quarterly cycle');
});

// ---- one-off / ad-hoc: bookable, but never "due" ---------------------------------------------------------------------
test('A ONE-OFF JOB (no schedule at all) appears once it is booked into the month, and never before', () => {
  const oneOff = job({ schedule: null, schedulePattern: 'One-off' });
  assert.equal(buildMonthlyPlan([oneOff], '2026-08', TODAY).length, 0, 'no cycle, so never listed as due');

  const booked = job({ schedule: null, visits: [visit({ scheduledDate: '2026-08-14' })] });
  const e = only(buildMonthlyPlan([booked], '2026-08', TODAY));
  assert.equal(e.kind, 'booked');
  assert.equal(e.visitsInMonth[0].scheduledDate, '2026-08-14');
});

test('AN AD-HOC job is never due either, but shows when booked', () => {
  const adhoc = schedule({ scheduleType: 'ad_hoc', intervalUnit: null, intervalCount: null, dayOfMonth: null });
  assert.equal(buildMonthlyPlan([job({ schedule: adhoc })], '2026-08', TODAY).length, 0);
  assert.equal(only(buildMonthlyPlan([job({ schedule: adhoc, visits: [visit()] })], '2026-08', TODAY)).kind, 'booked');
});

// ---- carry-over -------------------------------------------------------------------------------------------------------
test('CARRIED OVER: work due in an earlier month and never booked follows the plan forward, flagged with its month', () => {
  // Quarterly, anchored to February: due Feb, May, August. February was done; May and August never were.
  const quarterly = job({
    schedule: schedule({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-02-10' }),
    visits: [visit({ scheduledDate: '2026-02-10', status: 'completed' })],
  });
  const e = only(buildMonthlyPlan([quarterly], '2026-09', TODAY));
  assert.equal(e.kind, 'carried_over');
  assert.equal(e.dueFromMonth, '2026-05', 'the EARLIEST unbooked month, not the most recent');
  assert.match(carriedOverLabel(e) ?? '', /Overdue from May/);
});

test('CARRY-OVER needs evidence the job was running: a job with no visit history claims nothing', () => {
  // Same quarterly shape, but nothing has ever been booked for it. May/August are technically in cycle, yet
  // there is nothing to say the job existed then - so it is simply not due in September, not "overdue".
  const neverBooked = job({ schedule: schedule({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-02-10' }) });
  assert.equal(buildMonthlyPlan([neverBooked], '2026-09', TODAY).length, 0);
  // A brand-new monthly job does not arrive pre-loaded with a year of imaginary misses either.
  assert.equal(only(buildMonthlyPlan([job()], '2026-08', TODAY)).dueFromMonth, null);
});

test('CARRY-OVER crosses a year boundary', () => {
  // Serviced in October 2025, then nothing. Planning January 2026: November is the earliest month missed.
  const j = job({ visits: [visit({ scheduledDate: '2025-10-10', status: 'completed' })] });
  const e = only(buildMonthlyPlan([j], '2026-01', '2026-01-20'));
  assert.equal(e.kind, 'due_no_date', 'January itself is due');
  assert.equal(e.dueFromMonth, '2025-11', 'and November/December 2025 were missed');
});

test('CARRY-OVER never fires for months that have not happened yet', () => {
  // Serviced in June, nothing since. Planning December from 20 August: July is missed, but September to
  // November are due and simply have not come round yet - they must not be reported as overdue.
  const j = job({ visits: [visit({ scheduledDate: '2026-06-10', status: 'completed' })] });
  const e = only(buildMonthlyPlan([j], '2026-12', TODAY));
  assert.equal(e.kind, 'due_no_date');
  assert.equal(e.dueFromMonth, '2026-07', 'the only genuinely past, unbooked month');
});

test('A month that WAS booked does not carry over', () => {
  const quarterly = job({
    schedule: schedule({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-05-10' }),
    visits: [visit({ scheduledDate: '2026-05-10', status: 'completed' }), visit({ id: 'v2', scheduledDate: '2026-08-10', status: 'completed' })],
  });
  assert.equal(buildMonthlyPlan([quarterly], '2026-09', TODAY).length, 0, 'nothing outstanding, so not on the plan');
});

// ---- boundaries ---------------------------------------------------------------------------------------------------------
test('SERVICE ENDED: a job past its end date stops asking for work', () => {
  const ended = job({ serviceEndsOn: '2026-07-01', visits: [visit({ scheduledDate: '2026-06-10', status: 'completed' })] });
  assert.equal(buildMonthlyPlan([ended], '2026-08', TODAY).length, 0);
});

test('COUNTS and the nav badge count only what still wants a date', () => {
  const entries = buildMonthlyPlan(
    [job({ id: 'a' }), job({ id: 'b', visits: [visit()] }), job({ id: 'c', schedule: schedule({ intervalUnit: 'quarter', intervalCount: 1 }) })],
    '2026-08',
    TODAY,
  );
  assert.equal(entries.length, 3);
  assert.equal(needsBookingCount(entries), 1, 'only the un-booked, determinable one');
});

test('MONTH ARITHMETIC steps across year boundaries in both directions', () => {
  assert.equal(shiftMonthPrefix('2026-01', -1), '2025-12');
  assert.equal(shiftMonthPrefix('2026-12', 1), '2027-01');
  assert.equal(shiftMonthPrefix('2026-08', -12), '2025-08');
});

test('VISITS ON A DATE finds real clashes and ignores cancelled ones — the double-booking guard', () => {
  const j = job({ visits: [visit({ scheduledDate: '2026-08-10' }), visit({ id: 'v2', scheduledDate: '2026-08-10', status: 'cancelled' })] });
  assert.equal(visitsOnDate(j, '2026-08-10').length, 1, 'a cancelled visit is not a clash');
  assert.equal(visitsOnDate(j, '2026-08-11').length, 0);
});
