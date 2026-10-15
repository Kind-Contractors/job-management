// REGRESSION: "I picked 19 October 2026 as the first due date, and the Monthly Plan shows 2 November 2026."
//
// The recurrence maths was never wrong. The row saved on DEV was:
//
//     schedule_type: fixed_date · interval month x 1 · day_of_month: 1 · anchor_date: 2026-10-19
//                                                      ^^^^^^^^^^^^^^^
//
// 1 November 2026 is a Sunday, roll_forward_on_weekend moves it to Monday the 2nd, and the plan opens on NEXT
// month — so 2 November was a faithful rendering of "the 1st of every month".
//
// The day was 1 because ScheduleEditor's anchor field set only the cycle's PHASE and left `day_of_month` on its
// default, while JobCreator's "First due date" built the whole schedule from one date. One date, two forms,
// opposite behaviour. `patternFieldsForAnchor` is now the single rule both use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { patternFieldsForAnchor, buildFirstDueSchedule } from '../src/lib/firstDueSchedule';
import { scheduleFromInput } from '../src/repository/schedulesRepository';
import { suggestDateInMonth } from '../src/lib/scheduleFormat';
import type { Schedule } from '../src/domain/types';

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

const base: Schedule = {
  jobId: 'j1', scheduleType: 'fixed_date', intervalUnit: 'month', intervalCount: 1, weekday: null,
  weekOrdinal: null, dayOfMonth: 1, rollForwardOnWeekend: true, dueMonth: null, anchorDate: '2026-10-19', notes: null,
};

// ---- the bug, pinned exactly as DEV held it ---------------------------------------------------------------------
test('THE BUG: day_of_month 1 with anchor 19 Oct really does produce 2 November — the maths was faithful', () => {
  assert.equal(suggestDateInMonth(base, 2026, 11), '2026-11-02');
  // ...because 1 Nov 2026 is a Sunday and roll-forward moves it to the Monday.
  assert.equal(new Date(2026, 10, 1).getDay(), 0, '1 Nov 2026 is a Sunday');
  assert.equal(suggestDateInMonth({ ...base, rollForwardOnWeekend: false }, 2026, 11), '2026-11-01');
  // Nothing about the interval or the anchor moved the date: October is the 1st too.
  assert.equal(suggestDateInMonth(base, 2026, 10), '2026-10-01');
});

test('THE FIX: a due date of 19 October now sets the day to 19, so the plan shows the 19th', () => {
  const fields = patternFieldsForAnchor('2026-10-19');
  assert.deepEqual(fields, { dayOfMonth: 19, weekday: 'mon', weekOrdinal: '3rd', dueMonth: 10 });

  const fixed: Schedule = { ...base, dayOfMonth: fields!.dayOfMonth };
  assert.equal(suggestDateInMonth(fixed, 2026, 10), '2026-10-19', 'the month it was picked in');
  assert.equal(suggestDateInMonth(fixed, 2026, 11), '2026-11-19', 'and every month after');
  assert.notEqual(suggestDateInMonth(fixed, 2026, 11), '2026-11-02');
});

test('THE FIX applies to the weekday and due-month patterns too', () => {
  const f = patternFieldsForAnchor('2026-10-19')!;
  // 19 Oct 2026 is the 3rd Monday.
  const weekday: Schedule = { ...base, scheduleType: 'fixed_weekday', dayOfMonth: null, weekday: f.weekday, weekOrdinal: f.weekOrdinal };
  assert.equal(suggestDateInMonth(weekday, 2026, 10), '2026-10-19');
  assert.equal(new Date(2026, 9, 19).getDay(), 1, '19 Oct 2026 is a Monday');
  const dueMonth: Schedule = { ...base, scheduleType: 'due_month', dayOfMonth: null, dueMonth: f.dueMonth };
  assert.equal(dueMonth.dueMonth, 10);
});

test('BOTH FORMS now put the same date through the same rule', () => {
  // JobCreator has always derived the day; ScheduleEditor now derives it from the same function.
  const built = buildFirstDueSchedule({ frequencyType: 'monthly', firstDueISO: '2026-10-19', pattern: 'fixed_date', rollForwardOnWeekend: true })!;
  assert.equal(scheduleFromInput('j1', built).dayOfMonth, patternFieldsForAnchor('2026-10-19')!.dayOfMonth);

  const editor = src('components/jobs/ScheduleEditor.tsx');
  assert.match(editor, /patternFieldsForAnchor\(anchorDate\)/, 'the editor derives the day from the date');
  assert.match(editor, /dayOfMonth: String\(fields\.dayOfMonth\)/);
  assert.match(editor, /weekday: fields\.weekday/);
  assert.match(editor, /weekOrdinal: fields\.weekOrdinal/);
  assert.match(editor, /dueMonth: String\(fields\.dueMonth\)/);
  assert.doesNotMatch(editor, /onChange=\{\(e\) => setForm\(\{ \.\.\.form, anchorDate: e\.target\.value \}\)\}/, 'the old straight-to-state handler is gone');
});

test('A HALF-TYPED OR IMPOSSIBLE DATE changes no pattern field', () => {
  for (const bad of ['', '2026-10', '2026-13-01', '2026-02-30', '19/10/2026']) {
    assert.equal(patternFieldsForAnchor(bad), null, `"${bad}" must not set anything`);
  }
  assert.deepEqual(patternFieldsForAnchor('2028-02-29'), { dayOfMonth: 29, weekday: 'tue', weekOrdinal: 'last', dueMonth: 2 });
});

// ---- the preview that would have shown this before saving --------------------------------------------------------
test('THE EDITOR PREVIEWS what will be saved, through the same functions the saved row is read with', () => {
  const editor = src('components/jobs/ScheduleEditor.tsx');
  assert.match(editor, /data-testid="schedule-preview"/);
  assert.match(editor, /scheduleFromInput\(jobId, input\)/);
  assert.match(editor, /describeSchedule\(preview\)/);
  assert.match(editor, /suggestNextDate\(preview, todayISO\(\)\)/);
});

test('scheduleFromInput maps an input to exactly the row that will be saved', () => {
  const s = scheduleFromInput('j1', {
    scheduleType: 'fixed_date', intervalUnit: 'month', intervalCount: 1,
    dayOfMonth: 19, rollForwardOnWeekend: true, anchorDate: '2026-10-19', notes: null,
  });
  assert.deepEqual(s, { ...base, dayOfMonth: 19 });
  // The preview is therefore the same date the plan will show.
  assert.equal(suggestDateInMonth(s, 2026, 11), '2026-11-19');
});

// ---- unrelated recurrence behaviour is untouched -------------------------------------------------------------------
test('NOTHING ELSE MOVED: roll-forward, month-end and anchorless cadences behave exactly as before', () => {
  // mid-month weekend roll, still forward
  assert.equal(suggestDateInMonth({ ...base, dayOfMonth: 15, anchorDate: null }, 2027, 5), '2027-05-17');
  // month end, still backward so it cannot leave its own month
  assert.equal(suggestDateInMonth({ ...base, dayOfMonth: 31, anchorDate: null }, 2027, 1), '2027-01-29');
  // a day that does not exist, still null rather than clamped
  assert.equal(suggestDateInMonth({ ...base, dayOfMonth: 31, anchorDate: null }, 2027, 2), null);
  // an anchorless longer cadence is still honestly undeterminable
  assert.equal(suggestDateInMonth({ ...base, intervalUnit: 'quarter', anchorDate: null }, 2027, 2), null);
});
