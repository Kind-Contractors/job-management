// The cycle PHASE: which months a recurrence is genuinely due in, once schedules.anchor_date says which cycle it is on
// (migration 20261014164016). Two things matter here and are tested as a pair:
//   * an anchored schedule is answerable for ANY interval - this is Luke's "third Wednesday, every quarter";
//   * an UNANCHORED schedule answers exactly what it answered before anchors existed, down to the null.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeSchedule, isMonthInCycle, monthsDueInYear, suggestDateInMonth, suggestNextDate } from '../src/lib/scheduleFormat';
import type { Schedule } from '../src/domain/types';

const base: Schedule = {
  jobId: 'j1',
  scheduleType: 'fixed_weekday',
  intervalUnit: 'month',
  intervalCount: 1,
  weekday: 'wed',
  weekOrdinal: '3rd',
  dayOfMonth: null,
  rollForwardOnWeekend: true,
  dueMonth: null,
  anchorDate: null,
  notes: null,
};
const s = (over: Partial<Schedule>): Schedule => ({ ...base, ...over });
const months = (x: Set<number> | null) => (x === null ? null : [...x].sort((a, b) => a - b));

// ---- Luke's own example -------------------------------------------------------------------------------------------
test('THIRD WEDNESDAY, EVERY QUARTER, counted from July 2026: in cycle every third month and nowhere else', () => {
  const q = s({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-07-15' });
  for (const [y, m] of [[2026, 7], [2026, 10], [2027, 1], [2027, 4]] as const) {
    assert.equal(isMonthInCycle(q, y, m), true, `${y}-${m} should be in cycle`);
  }
  for (const [y, m] of [[2026, 8], [2026, 9], [2026, 11], [2027, 2]] as const) {
    assert.equal(isMonthInCycle(q, y, m), false, `${y}-${m} should not be`);
  }
  assert.deepEqual(months(monthsDueInYear(q, 2026)), [1, 4, 7, 10]);
  // ...and the suggested day really is a third Wednesday.
  assert.equal(suggestDateInMonth(q, 2026, 10), '2026-10-21');
  assert.equal(new Date('2026-10-21T00:00:00').getDay(), 3, 'a Wednesday');
  assert.equal(suggestDateInMonth(q, 2026, 8), null, 'not in cycle, so no date');
});

test('CROSSING A YEAR BOUNDARY: the cycle continues into the next year, and suggestNextDate steps into it', () => {
  const q = s({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-07-15' });
  assert.deepEqual(months(monthsDueInYear(q, 2027)), [1, 4, 7, 10]);
  assert.equal(suggestNextDate(q, '2026-12-01'), '2027-01-20', 'December looks forward into January');
  assert.equal(suggestNextDate(q, '2026-10-22'), '2027-01-20', 'the day after October’s date, so the next cycle');
});

test('BEFORE THE ANCHOR: the phase reads backwards too - an anchor records the cycle, it is not a start date', () => {
  const q = s({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-07-15' });
  assert.equal(isMonthInCycle(q, 2026, 4), true, 'April 2026 is in the same quarterly phase');
  assert.equal(isMonthInCycle(q, 2025, 10), true);
  assert.equal(isMonthInCycle(q, 2025, 11), false);
  assert.deepEqual(months(monthsDueInYear(q, 2025)), [1, 4, 7, 10], 'a past year in the Month Matrix is still right');
});

test('EVERY FIVE MONTHS: a cadence that does not divide 12 lands on different months each year, and is still exact', () => {
  const five = s({ scheduleType: 'fixed_date', intervalUnit: 'month', intervalCount: 5, weekday: null, weekOrdinal: null, dayOfMonth: 10, anchorDate: '2026-01-10' });
  assert.deepEqual(months(monthsDueInYear(five, 2026)), [1, 6, 11]);
  assert.deepEqual(months(monthsDueInYear(five, 2027)), [4, 9], 'genuinely different months the next year');
  assert.equal(suggestDateInMonth(five, 2026, 6), '2026-06-10');
  assert.equal(suggestDateInMonth(five, 2026, 7), null);
  // Without an anchor the same shape cannot be phased at all, and must say so rather than guess.
  assert.equal(monthsDueInYear(s({ ...five, anchorDate: null }), 2026), null);
  assert.equal(isMonthInCycle(s({ ...five, anchorDate: null }), 2026, 6), null);
});

// ---- backward compatibility: every anchor-less shape answers exactly what it did before ------------------------------
test('NO ANCHOR, monthly fixed_weekday: all twelve months, exactly as before', () => {
  assert.deepEqual(months(monthsDueInYear(base, 2026)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(months(monthsDueInYear(base)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'and with no year argument');
  assert.equal(suggestDateInMonth(base, 2026, 3), '2026-03-18');
});

test('NO ANCHOR, any longer interval: still not determinable, never guessed', () => {
  for (const over of [
    { intervalUnit: 'quarter' as const, intervalCount: 1 },
    { intervalUnit: 'month' as const, intervalCount: 2 },
    { intervalUnit: 'year' as const, intervalCount: 1 },
  ]) {
    const x = s(over);
    assert.equal(monthsDueInYear(x, 2026), null);
    assert.equal(suggestDateInMonth(x, 2026, 5), null);
    assert.equal(suggestNextDate(x, '2026-05-01'), null);
  }
});

test('NO ANCHOR, due_month: the annual set when the step divides 12, null when it does not, and never a day', () => {
  const everyOtherMonth = s({ scheduleType: 'due_month', weekday: null, weekOrdinal: null, dueMonth: 11, intervalUnit: 'month', intervalCount: 2 });
  assert.deepEqual(months(monthsDueInYear(everyOtherMonth, 2026)), [1, 3, 5, 7, 9, 11]);
  const quarterly = s({ scheduleType: 'due_month', weekday: null, weekOrdinal: null, dueMonth: 8, intervalUnit: 'quarter', intervalCount: 1 });
  assert.deepEqual(months(monthsDueInYear(quarterly, 2026)), [2, 5, 8, 11]);
  const everyFive = s({ scheduleType: 'due_month', weekday: null, weekOrdinal: null, dueMonth: 1, intervalUnit: 'month', intervalCount: 5 });
  assert.equal(monthsDueInYear(everyFive, 2026), null, 'does not divide 12 and has no anchor');
  assert.equal(suggestDateInMonth(everyOtherMonth, 2026, 11), null, 'due_month stores no day');
});

test('NO ANCHOR, monthly fixed_date on the 31st: February is still skipped, as before', () => {
  const end = s({ scheduleType: 'fixed_date', weekday: null, weekOrdinal: null, dayOfMonth: 31, rollForwardOnWeekend: false });
  assert.equal(suggestDateInMonth(end, 2026, 2), null, 'never clamped to the 28th');
  assert.equal(suggestDateInMonth(end, 2026, 3), '2026-03-31');
  assert.equal(suggestNextDate(end, '2026-02-01'), '2026-03-31', 'scans past the month that has no 31st');
});

test('AD HOC is never in a cycle and never has a date', () => {
  const adhoc = s({ scheduleType: 'ad_hoc', intervalUnit: null, intervalCount: null, weekday: null, weekOrdinal: null });
  assert.equal(isMonthInCycle(adhoc, 2026, 5), null);
  assert.equal(monthsDueInYear(adhoc, 2026), null);
  assert.equal(suggestNextDate(adhoc, '2026-05-01'), null);
});

test('A WEEK interval stays not-determinable in a month-shaped view, anchored or not', () => {
  const weekly = s({ intervalUnit: 'week', intervalCount: 2, anchorDate: '2026-01-07' });
  assert.equal(isMonthInCycle(weekly, 2026, 3), null);
  assert.equal(monthsDueInYear(weekly, 2026), null);
});

// ---- due_month + anchor: the anchor is the only thing that can supply a day ------------------------------------------
test('DUE_MONTH WITH AN ANCHOR gives back the anchor date ONLY in the anchor’s own month', () => {
  // "due_month" means the exact date is not set (App Master Reference §3.3). The anchor is a real date the manager
  // typed, so it is true for the month they typed it for - and says nothing whatever about any other month.
  const yearly = s({ scheduleType: 'due_month', weekday: null, weekOrdinal: null, dueMonth: 8, intervalUnit: 'year', intervalCount: 1, anchorDate: '2026-08-12', rollForwardOnWeekend: false });
  assert.equal(suggestDateInMonth(yearly, 2026, 8), '2026-08-12', 'the anchor’s own month: a real, typed date');
  assert.equal(suggestDateInMonth(yearly, 2027, 8), null, 'in cycle, but no day was ever recorded for 2027');
  assert.equal(suggestDateInMonth(yearly, 2027, 9), null, 'not in cycle at all');

  const quarterly = s({ scheduleType: 'due_month', weekday: null, weekOrdinal: null, dueMonth: 11, intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-11-18' });
  assert.equal(suggestDateInMonth(quarterly, 2026, 11), '2026-11-18');
  for (const [y, m] of [[2027, 2], [2027, 5], [2027, 8], [2027, 11]] as [number, number][]) {
    assert.equal(suggestDateInMonth(quarterly, y, m), null, `${y}-${m} is due, but its DAY is not set`);
  }
  // ...and the months are still right, which is the whole point of due_month.
  assert.deepEqual([...monthsDueInYear(quarterly, 2027)!], [2, 5, 8, 11]);
});

test('DUE_MONTH no longer impersonates FIXED_DATE — §3.3 keeps four cases, not three', () => {
  const common = { intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-11-18' } as const;
  const dueMonth = s({ ...common, scheduleType: 'due_month', weekday: null, weekOrdinal: null, dueMonth: 11 });
  const fixedDate = s({ ...common, scheduleType: 'fixed_date', weekday: null, weekOrdinal: null, dayOfMonth: 18 });
  assert.deepEqual([...monthsDueInYear(dueMonth, 2027)!], [...monthsDueInYear(fixedDate, 2027)!], 'same months');
  assert.equal(suggestDateInMonth(fixedDate, 2027, 2), '2027-02-18', 'fixed_date names the day');
  assert.equal(suggestDateInMonth(dueMonth, 2027, 2), null, 'due_month does not — that is the difference');
});

test('DUE_MONTH never applies a weekend roll to the anchor: the manager typed that exact date', () => {
  // 2026-11-21 is a Saturday. roll_forward_on_weekend is not even offered for due_month in ScheduleEditor, so it
  // only ever holds the column default here — it must not move a date a manager typed by hand.
  const sat = s({ scheduleType: 'due_month', weekday: null, weekOrdinal: null, dueMonth: 11, intervalUnit: 'month', intervalCount: 1, anchorDate: '2026-11-21', rollForwardOnWeekend: true });
  assert.equal(suggestDateInMonth(sat, 2026, 11), '2026-11-21');
});

test('DUE_MONTH with NO anchor is unchanged: right months, never a day', () => {
  const none = s({ scheduleType: 'due_month', weekday: null, weekOrdinal: null, dueMonth: 4, intervalUnit: 'quarter', intervalCount: 1, anchorDate: null });
  assert.deepEqual([...monthsDueInYear(none, 2027)!], [1, 4, 7, 10]);
  for (const m of [1, 4, 7, 10]) assert.equal(suggestDateInMonth(none, 2027, m), null);
});

test('DESCRIBE says which cycle an anchored long interval is on, and stays unchanged for monthly/unanchored', () => {
  assert.match(describeSchedule(s({ intervalUnit: 'quarter', intervalCount: 1, anchorDate: '2026-07-15' })), /counted from Jul 2026/);
  assert.doesNotMatch(describeSchedule(base), /counted from/, 'monthly needs no phase');
  assert.doesNotMatch(describeSchedule(s({ anchorDate: '2026-07-15' })), /counted from/, 'monthly with an anchor still needs none');
});
