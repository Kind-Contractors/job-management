// Turning a "first due date" into a real schedule (src/lib/firstDueSchedule.ts).
//
// The point under test is that the four App Master Reference §3.3 cases stay four cases. Every assertion about
// what a schedule MEANS is made by running the real recurrence functions over the schedule this module builds,
// not by inspecting its fields — a schedule that stores the right columns but lands on the wrong dates would
// pass a field check and fail the job.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFirstDueSchedule,
  firstDuePatternOptions,
  isMonthBasedFrequency,
  isRecurringFrequency,
  isWeekBasedFrequency,
  parseFirstDueDate,
  type FirstDuePattern,
} from '../src/lib/firstDueSchedule';
import { monthsDueInYear, suggestDateInMonth } from '../src/lib/scheduleFormat';
import type { FrequencyType, Schedule } from '../src/domain/types';
import type { ScheduleInput } from '../src/repository/schedulesRepository';

/** The ScheduleInput as a Schedule, so the real recurrence functions can be run over exactly what would be saved. */
function asSchedule(input: ScheduleInput): Schedule {
  return {
    jobId: 'j1',
    scheduleType: input.scheduleType,
    intervalUnit: 'intervalUnit' in input ? input.intervalUnit : null,
    intervalCount: 'intervalCount' in input ? input.intervalCount : null,
    weekday: 'weekday' in input ? input.weekday : null,
    weekOrdinal: 'weekOrdinal' in input ? input.weekOrdinal : null,
    dayOfMonth: 'dayOfMonth' in input ? input.dayOfMonth : null,
    rollForwardOnWeekend: 'rollForwardOnWeekend' in input ? input.rollForwardOnWeekend : true,
    dueMonth: 'dueMonth' in input ? input.dueMonth : null,
    anchorDate: 'anchorDate' in input ? input.anchorDate : null,
    notes: null,
  };
}

const build = (
  frequencyType: FrequencyType | null,
  firstDueISO: string,
  pattern: FirstDuePattern = 'fixed_date',
  rollForwardOnWeekend = false,
) => buildFirstDueSchedule({ frequencyType, firstDueISO, pattern, rollForwardOnWeekend });

/** The dates a built schedule actually lands on across `year`. */
const datesIn = (input: ScheduleInput, year: number): string[] => {
  const s = asSchedule(input);
  const months = monthsDueInYear(s, year);
  assert.notEqual(months, null, 'a schedule built from a first-due date must always be determinable');
  return [...months!].map((m) => suggestDateInMonth(s, year, m) ?? `${year}-${String(m).padStart(2, '0')}-TBC`);
};

// ---- each supported month-based frequency ---------------------------------------------------------------------
// Wed 18 Nov 2026 is deliberately the 18th AND the 3rd Wednesday, so the two dated patterns start identically
// and can only be told apart by where the cycle goes next.
const FIRST = '2026-11-18';

test('MONTHLY: every month of the following year, on the typed day', () => {
  const dates = datesIn(build('monthly', FIRST)!, 2027);
  assert.equal(dates.length, 12);
  assert.deepEqual(dates.slice(0, 3), ['2027-01-18', '2027-02-18', '2027-03-18']);
});

test('QUARTERLY: four months, phased from the typed date — not January/April/July/October by default', () => {
  assert.deepEqual(datesIn(build('quarterly', FIRST)!, 2027), ['2027-02-18', '2027-05-18', '2027-08-18', '2027-11-18']);
});

test('BIANNUAL: twice a year, six months apart', () => {
  assert.deepEqual(datesIn(build('biannual', FIRST)!, 2027), ['2027-05-18', '2027-11-18']);
});

test('ANNUAL: once, in the typed month', () => {
  assert.deepEqual(datesIn(build('annual', FIRST)!, 2027), ['2027-11-18']);
});

// ---- the patterns are genuinely different (Master Reference §3.3) ----------------------------------------------
test('FIXED WEEKDAY and FIXED DATE are not interchangeable: the same first-due date sends them to different days', () => {
  const byDate = datesIn(build('quarterly', FIRST, 'fixed_date')!, 2027);
  const byWeekday = datesIn(build('quarterly', FIRST, 'fixed_weekday')!, 2027);

  assert.deepEqual(byDate, ['2027-02-18', '2027-05-18', '2027-08-18', '2027-11-18']);
  assert.deepEqual(byWeekday, ['2027-02-17', '2027-05-19', '2027-08-18', '2027-11-17']);
  // Three of the four differ. This is exactly why the pattern is asked for and never inferred from the date.
  assert.equal(byDate.filter((d, i) => d !== byWeekday[i]).length, 3);
});

test('FIXED WEEKDAY: "3rd Wednesday every quarter" — the Master Reference’s own example — survives the round trip', () => {
  const input = build('quarterly', FIRST, 'fixed_weekday')!;
  assert.equal(input.scheduleType, 'fixed_weekday');
  assert.deepEqual(
    { weekday: (input as never as Schedule).weekday, weekOrdinal: (input as never as Schedule).weekOrdinal },
    { weekday: 'wed', weekOrdinal: '3rd' },
  );
  // ...and every date it produces really is a 3rd Wednesday.
  for (const d of datesIn(input, 2027)) {
    const day = Number(d.slice(8, 10));
    assert.equal(new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, day).getDay(), 3, `${d} is not a Wednesday`);
    assert.ok(day > 14 && day <= 21, `${d} is not the 3rd Wednesday`);
  }
});

test('DUE MONTH: the right months, and no claim to a day the manager never gave beyond the anchor’s own', () => {
  const input = build('quarterly', FIRST, 'due_month')!;
  assert.equal(input.scheduleType, 'due_month');
  assert.equal((input as never as Schedule).dueMonth, 11);
  assert.deepEqual([...monthsDueInYear(asSchedule(input), 2027)!], [2, 5, 8, 11]);
});

test('FIXED DATE: the weekend roll-forward is carried through as chosen, not defaulted', () => {
  const on = asSchedule(build('quarterly', '2026-11-15', 'fixed_date', true)!);
  const off = asSchedule(build('quarterly', '2026-11-15', 'fixed_date', false)!);
  assert.equal(on.rollForwardOnWeekend, true);
  assert.equal(off.rollForwardOnWeekend, false);
  // 15 May 2027 is a Saturday.
  assert.equal(suggestDateInMonth(on, 2027, 5), '2027-05-17');
  assert.equal(suggestDateInMonth(off, 2027, 5), '2027-05-15');
});

// ---- the anchor is what makes the longer cadences answerable at all --------------------------------------------
test('ANCHORING is what a first-due date buys: the same quarterly job is unplannable without one', () => {
  const anchored = asSchedule(build('quarterly', FIRST, 'fixed_weekday')!);
  assert.equal(anchored.anchorDate, FIRST);
  assert.notEqual(monthsDueInYear(anchored, 2027), null);
  // Strip the anchor and the honest answer becomes "can't tell" — the state this shortcut exists to avoid.
  assert.equal(monthsDueInYear({ ...anchored, anchorDate: null }, 2027), null);
});

test('A month BEFORE the first due date is still phased correctly — the anchor is a phase, not a start date', () => {
  // `jobs.service_ends_on` is the only end boundary; nothing here bounds the start.
  assert.deepEqual(datesIn(build('quarterly', FIRST, 'fixed_date')!, 2026), ['2026-02-18', '2026-05-18', '2026-08-18', '2026-11-18']);
});

// ---- blank, invalid, and non-recurring: never a schedule --------------------------------------------------------
test('A BLANK first due date creates no schedule — the form behaves exactly as it did before', () => {
  for (const f of ['monthly', 'quarterly', 'biannual', 'annual'] as FrequencyType[]) {
    assert.equal(build(f, ''), null, `${f} with a blank date must not create a schedule`);
  }
});

test('An INVALID or half-typed date creates no schedule, rather than a guessed or partial one', () => {
  for (const bad of ['2026-11', '2026-13-01', '2026-02-30', '2026-00-10', '2026-11-00', '18/11/2026', 'today', '2026-11-1']) {
    assert.equal(build('monthly', bad), null, `"${bad}" must not produce a schedule`);
    assert.equal(parseFirstDueDate(bad), null, `"${bad}" must not parse`);
  }
  assert.notEqual(parseFirstDueDate('2026-02-28'), null, 'a real date must still parse');
  assert.notEqual(parseFirstDueDate('2028-02-29'), null, 'a real leap day must still parse');
  assert.equal(parseFirstDueDate('2027-02-29'), null, 'a leap day in a non-leap year must not');
});

test('ONE-OFF and AD-HOC jobs never get a schedule, whatever date is typed — they are correctly schedule-less', () => {
  for (const f of ['one_off', 'ask_adhoc', null] as (FrequencyType | null)[]) {
    assert.equal(build(f, FIRST), null, `${f} must not produce a schedule`);
    assert.equal(isRecurringFrequency(f), false, `${f} must never be warned about as unscheduled`);
  }
});

test('WEEKLY and FORTNIGHTLY are refused: the Monthly Plan cannot place a week cadence, so none is written', () => {
  for (const f of ['weekly', 'fortnightly'] as FrequencyType[]) {
    assert.equal(build(f, FIRST), null);
    assert.equal(isMonthBasedFrequency(f), false);
    assert.equal(isWeekBasedFrequency(f), true, 'but they are still recurring, so a missing schedule still warns');
    assert.equal(isRecurringFrequency(f), true);
  }
});

// ---- the choice offered to the manager --------------------------------------------------------------------------
test('The three patterns are offered labelled with what the typed date would actually mean', () => {
  assert.deepEqual(firstDuePatternOptions(FIRST), [
    { pattern: 'fixed_date', label: 'On the 18th of the month' },
    { pattern: 'fixed_weekday', label: 'The 3rd Wednesday of the month' },
    { pattern: 'due_month', label: 'Some time in November — no fixed date' },
  ]);
  assert.equal(firstDuePatternOptions('2026-11')?.length, undefined, 'nothing is offered for an incomplete date');
  assert.equal(firstDuePatternOptions(''), null);
});

test('A 5th occurrence is offered as "last", the only ordinal the schedule can store for it', () => {
  // Tue 29 Dec 2026 is the 5th Tuesday of December.
  const parsed = parseFirstDueDate('2026-12-29')!;
  assert.deepEqual({ weekday: parsed.weekday, weekOrdinal: parsed.weekOrdinal }, { weekday: 'tue', weekOrdinal: 'last' });
  assert.match(firstDuePatternOptions('2026-12-29')![1].label, /The last Tuesday/);
  assert.deepEqual(datesIn(build('monthly', '2026-12-29', 'fixed_weekday')!, 2027).slice(0, 2), ['2027-01-26', '2027-02-23']);
});

test('Ordinals are read from the date, not assumed: the 1st, 2nd and 4th of a weekday all come back right', () => {
  assert.equal(parseFirstDueDate('2026-11-04')!.weekOrdinal, '1st');
  assert.equal(parseFirstDueDate('2026-11-11')!.weekOrdinal, '2nd');
  assert.equal(parseFirstDueDate('2026-11-25')!.weekOrdinal, '4th');
});
