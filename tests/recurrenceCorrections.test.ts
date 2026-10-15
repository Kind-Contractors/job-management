// The two recurrence corrections, and proof that everything around them is unchanged.
//
//  1. due_month gives back the anchor date ONLY in the anchor's own month (see scheduleAnchor.test.ts for the
//     derivation side; this file covers what the booking screens then do with a null).
//  2. A fixed_date weekend adjustment never leaves its own due month: forward normally, backward to the last
//     working day when forward would cross the boundary.
//
// A working day is Monday-Friday. There is no public-holiday calendar in this codebase and these tests do not
// assume one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { monthsDueInYear, suggestDateInMonth, suggestNextDate } from '../src/lib/scheduleFormat';
import { deriveMonthCellStates } from '../src/lib/monthMatrix';
import { buildMonthlyPlan } from '../src/lib/monthlyPlan';
import type { JobRow, JobVisitSummary, Schedule } from '../src/domain/types';

const sched = (over: Partial<Schedule>): Schedule => ({
  jobId: 'j1', scheduleType: 'fixed_date', intervalUnit: 'month', intervalCount: 1, weekday: null,
  weekOrdinal: null, dayOfMonth: 31, rollForwardOnWeekend: true, dueMonth: null, anchorDate: null, notes: null, ...over,
});

const dayOfWeek = (iso: string) =>
  new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))).getDay();

const assertWorkingDayIn = (iso: string | null, monthPrefix: string, label: string) => {
  assert.notEqual(iso, null, `${label}: expected a date`);
  assert.equal(iso!.slice(0, 7), monthPrefix, `${label}: ${iso} left its own month`);
  const d = dayOfWeek(iso!);
  assert.ok(d >= 1 && d <= 5, `${label}: ${iso} is not a working day`);
};

// ---- month-end: forward would cross the boundary, so it goes backward ----------------------------------------
test('MONTH END, Sunday: 31 Jan 2027 moves BACK to Friday 29th, not forward into February', () => {
  assert.equal(suggestDateInMonth(sched({}), 2027, 1), '2027-01-29');
});

test('MONTH END, Saturday: 31 Jul 2027 moves BACK to Friday 30th, not forward into August', () => {
  assert.equal(suggestDateInMonth(sched({}), 2027, 7), '2027-07-30');
});

test('MONTH END on the 30th of a 30-day month: 30 Apr 2028 (Sunday) moves back to Friday 28th', () => {
  assert.equal(suggestDateInMonth(sched({ dayOfMonth: 30 }), 2028, 4), '2028-04-28');
});

test('MONTH END is about crossing the boundary, not about being the last day: 30 May 2026 (Sat) moves back', () => {
  // May has 31 days, so the 30th is not month end - but forward (+2) would still land on 1 June.
  assert.equal(suggestDateInMonth(sched({ dayOfMonth: 30 }), 2026, 5), '2026-05-29');
});

test('...and when forward still fits, it goes FORWARD: 29 May 2027 (Sat) becomes Monday 31 May', () => {
  assert.equal(suggestDateInMonth(sched({ dayOfMonth: 29 }), 2027, 5), '2027-05-31');
});

test('EVERY month of a 31st schedule stays inside its own month, and is always a working day', () => {
  const s = sched({});
  for (const month of monthsDueInYear(s, 2027)!) {
    const iso = suggestDateInMonth(s, 2027, month);
    if (iso == null) continue; // months with no 31st — see the dedicated test below
    assertWorkingDayIn(iso, `2027-${String(month).padStart(2, '0')}`, `month ${month}`);
  }
});

// ---- mid-month: completely unchanged ---------------------------------------------------------------------------
test('MID-MONTH weekends still roll FORWARD — the rule as CLAUDE.md §6 states it for "the 15th"', () => {
  const s = sched({ dayOfMonth: 15 });
  assert.equal(suggestDateInMonth(s, 2027, 5), '2027-05-17', '15 May 2027 is a Saturday -> Monday 17th');
  assert.equal(suggestDateInMonth(s, 2027, 8), '2027-08-16', '15 Aug 2027 is a Sunday -> Monday 16th');
  // The whole year, pinned: nothing about a mid-month schedule changed.
  assert.deepEqual(
    [...monthsDueInYear(s, 2027)!].map((m) => suggestDateInMonth(s, 2027, m)),
    ['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-17', '2027-06-15',
     '2027-07-15', '2027-08-16', '2027-09-15', '2027-10-15', '2027-11-15', '2027-12-15'],
  );
});

// ---- year boundary ---------------------------------------------------------------------------------------------
test('YEAR BOUNDARY: 31 Dec 2028 (Sunday) stays in December 2028 and never becomes 1 Jan 2029', () => {
  const s = sched({});
  assert.equal(suggestDateInMonth(s, 2028, 12), '2028-12-29');
  assert.equal(suggestNextDate(s, '2028-12-01'), '2028-12-29', 'the next-date scan agrees');
  assert.equal(suggestDateInMonth(s, 2029, 1), '2029-01-31', 'and January 2029 is its own, separate occurrence');
});

// ---- the bug this fixes, end to end -----------------------------------------------------------------------------
test('REGRESSION: booking the suggested date now SATISFIES the month it was suggested for', () => {
  // Before: January's only offered date was 1 February, so January stayed "due, no date" for ever while February
  // held a visit it was never due in. The demand was unsatisfiable.
  const s = sched({});
  const suggested = suggestDateInMonth(s, 2027, 1)!;
  assert.equal(suggested, '2027-01-29');

  const job = {
    id: 'j1', frequencyType: 'monthly', serviceEndsOn: null, schedule: s,
    visits: [{ id: 'v1', scheduledDate: suggested, status: 'booked', reportReviewStatus: null, additionalTechnicians: [] } as unknown as JobVisitSummary],
  } as JobRow;

  const cells = deriveMonthCellStates(job, 2027, '2027-01-02');
  assert.equal(cells[0].kind, 'booked', 'January is satisfied by the visit booked for it');
  assert.equal(cells[0].visitCount, 1);
  assert.equal(cells[1].kind, 'due_no_date', 'February is due in its own right, holding no stray visit');
  assert.equal(cells[1].visitCount, 0);
  assert.equal(buildMonthlyPlan([job], '2027-01', '2027-01-02')[0].kind, 'booked');
});

// ---- everything else is untouched --------------------------------------------------------------------------------
test('ROLL-FORWARD OFF is untouched: the real date is returned, weekend or not, wherever it falls', () => {
  const s = sched({ rollForwardOnWeekend: false });
  assert.equal(suggestDateInMonth(s, 2027, 1), '2027-01-31', 'a Sunday, left alone');
  assert.equal(suggestDateInMonth(s, 2027, 7), '2027-07-31', 'a Saturday, left alone');
  assert.equal(suggestDateInMonth(sched({ dayOfMonth: 15, rollForwardOnWeekend: false }), 2027, 5), '2027-05-15');
});

test('DAY 29/30/31 in a month that has no such day is still NULL, never clamped to a different day', () => {
  const s = sched({});
  for (const m of [2, 4, 6, 9, 11]) assert.equal(suggestDateInMonth(s, 2027, m), null, `month ${m} has no 31st`);
  assert.equal(suggestDateInMonth(sched({ dayOfMonth: 30 }), 2027, 2), null, 'February has no 30th');
  assert.equal(suggestDateInMonth(sched({ dayOfMonth: 29 }), 2027, 2), null, '2027 is not a leap year');
  assert.equal(suggestDateInMonth(sched({ dayOfMonth: 29 }), 2028, 2), '2028-02-29', 'but 2028 is');
});

test('FIXED WEEKDAY is untouched by the weekend rule — a "last Saturday" schedule still returns Saturdays', () => {
  const s = sched({ scheduleType: 'fixed_weekday', dayOfMonth: null, weekday: 'sat', weekOrdinal: 'last', rollForwardOnWeekend: true });
  for (const m of [1, 2, 3, 4]) {
    const iso = suggestDateInMonth(s, 2027, m)!;
    assert.equal(dayOfWeek(iso), 6, `${iso} should still be a Saturday`);
    assert.equal(iso.slice(0, 7), `2027-${String(m).padStart(2, '0')}`);
  }
  assert.equal(suggestDateInMonth(s, 2027, 1), '2027-01-30');
});

test('NULL ANCHOR compatibility: a monthly schedule with no anchor behaves exactly as before', () => {
  const s = sched({ anchorDate: null, dayOfMonth: 10 });
  assert.deepEqual([...monthsDueInYear(s, 2027)!], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(suggestDateInMonth(s, 2027, 1), '2027-01-11', '10 Jan 2027 is a Sunday -> Monday 11th, mid-month');
  // And a longer unanchored cadence is still honestly undeterminable.
  assert.equal(monthsDueInYear(sched({ intervalUnit: 'quarter', intervalCount: 1 }), 2027), null);
});
