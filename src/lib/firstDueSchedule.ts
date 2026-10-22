// Turning one "first due date" into a real `schedules` row — the shortcut that lets a recurring job be created
// and scheduled in one step, instead of creating it and then remembering to open it and add a schedule.
//
// WHY A DATE ALONE IS NOT ENOUGH. The App Master Reference §3.3 lists four scheduling cases and says plainly:
// "Do not reduce these to one simplistic repeat-every-X-months field." A single date cannot tell them apart.
// Wednesday 18 November 2026 is simultaneously "the 18th", "the 3rd Wednesday" and "some time in November",
// and those three diverge the moment the cycle advances - proven against the real recurrence functions:
//
//     quarterly, counted from 2026-11-18
//       fixed_date    (the 18th)      -> 2027-02-18  2027-05-18  2027-08-18  2027-11-18
//       fixed_weekday (3rd Wednesday) -> 2027-02-17  2027-05-19  2027-08-18  2027-11-17
//
// Three of four dates differ; monthly differs in eleven of twelve. So this module never infers the pattern. It
// offers the manager the readings of the date they typed, each labelled with what it would actually mean, and
// builds a schedule only from the one they pick. The date supplies the cycle's PHASE (`anchor_date`) and, for
// `fixed_date`/`fixed_weekday`, the day within the month; nothing else is invented.
//
// WEEKLY, FORTNIGHTLY AND 6 WEEKLY ARE DELIBERATELY ABSENT. A week-unit interval has no whole-month step, so
// `isMonthInCycle` cannot answer for it and the Monthly Plan shows it as "can't tell" - anchored or not. Until
// that is designed (see docs/monthly-plan-weekly-occurrences.md) this module refuses to build a schedule that
// would land in that state, and the form says so instead of pretending.

import type { FrequencyType, ScheduleIntervalUnit, ScheduleWeekOrdinal, ScheduleWeekday } from '../domain/types';
import type { ScheduleInput } from '../repository/schedulesRepository';

/** Which of the three dated patterns a first-due date is being read as. `ad_hoc` is never reachable from a date. */
export type FirstDuePattern = 'fixed_date' | 'fixed_weekday' | 'due_month';

/**
 * The cadence each pricing frequency means, in the units `schedules` stores. A faithful restatement of the same
 * model `VISITS_PER_YEAR_BY_TYPE` already encodes (12/4/2/1 a year), not an inference.
 *
 * `weekly`/`fortnightly`/`six_weekly` map to week units, which `stepMonths` cannot convert to whole months - they are listed
 * here so `isWeekBasedFrequency` has one source, and `buildFirstDueSchedule` refuses them explicitly.
 */
const INTERVAL_BY_FREQUENCY: Partial<Record<FrequencyType, { unit: ScheduleIntervalUnit; count: number }>> = {
  weekly: { unit: 'week', count: 1 },
  fortnightly: { unit: 'week', count: 2 },
  six_weekly: { unit: 'week', count: 6 },
  monthly: { unit: 'month', count: 1 },
  bimonthly: { unit: 'month', count: 2 },
  quarterly: { unit: 'quarter', count: 1 },
  biannual: { unit: 'month', count: 6 },
  annual: { unit: 'year', count: 1 },
};

/** Frequencies that recur on a whole-month cadence — the only ones this shortcut can honestly schedule. */
export function isMonthBasedFrequency(f: FrequencyType | null): boolean {
  const interval = f == null ? undefined : INTERVAL_BY_FREQUENCY[f];
  return interval != null && interval.unit !== 'week';
}

/** Weekly/fortnightly/6 weekly: genuinely recurring, but not expressible as a month cadence (see the file header). */
export function isWeekBasedFrequency(f: FrequencyType | null): boolean {
  const interval = f == null ? undefined : INTERVAL_BY_FREQUENCY[f];
  return interval != null && interval.unit === 'week';
}

/**
 * True when a job of this frequency genuinely repeats and therefore wants a schedule. `ask_adhoc` and `one_off`
 * are not failures to schedule — they are jobs that correctly have none (CLAUDE.md §6), so they never warn.
 */
export function isRecurringFrequency(f: FrequencyType | null): boolean {
  return isMonthBasedFrequency(f) || isWeekBasedFrequency(f);
}

const WEEKDAY_BY_INDEX: ScheduleWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_LABEL: Record<ScheduleWeekday, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const MONTH_LABEL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function ordinalSuffix(day: number): string {
  if (day % 10 === 1 && day !== 11) return `${day}st`;
  if (day % 10 === 2 && day !== 12) return `${day}nd`;
  if (day % 10 === 3 && day !== 13) return `${day}rd`;
  return `${day}th`;
}

export interface ParsedFirstDue {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
  weekday: ScheduleWeekday;
  /** Which occurrence of that weekday the date is: '1st'…'4th', or 'last' for a 5th (which is always the last). */
  weekOrdinal: ScheduleWeekOrdinal;
}

/**
 * Parses a 'YYYY-MM-DD' into the facts the three patterns need, or null when it is not a real calendar date.
 * Validated by round-tripping through `Date` so 2026-02-30 and 2026-13-01 are rejected rather than rolled over,
 * and built from the LOCAL constructor so no timezone can shift the day (the same rule as scheduleFormat.ts).
 */
export function parseFirstDueDate(iso: string): ParsedFirstDue | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;

  // A 5th occurrence is always also the last one, and '5th' is not a value `week_ordinal` accepts.
  const nth = Math.ceil(day / 7);
  const weekOrdinal: ScheduleWeekOrdinal = nth >= 5 ? 'last' : (`${ordinalSuffix(nth)}` as ScheduleWeekOrdinal);

  return { year, month, day, weekday: WEEKDAY_BY_INDEX[d.getDay()], weekOrdinal };
}

export interface FirstDuePatternOption {
  pattern: FirstDuePattern;
  /** What choosing this would mean, written out from the date itself — never generic. */
  label: string;
}

/**
 * The three honest readings of a first-due date, labelled from that date. Null when the date is not valid, so
 * the caller shows nothing rather than options built on a half-typed value.
 *
 * `fixed_date` comes first because it is the most literal reading of a typed date, and it is what the form
 * preselects — a visible, labelled default the manager can see and change, not a silent assumption.
 */
export function firstDuePatternOptions(firstDueISO: string): FirstDuePatternOption[] | null {
  const parsed = parseFirstDueDate(firstDueISO);
  if (parsed == null) return null;

  const weekday = WEEKDAY_LABEL[parsed.weekday];
  const ordinal = parsed.weekOrdinal === 'last' ? 'last' : parsed.weekOrdinal;
  return [
    { pattern: 'fixed_date', label: `On the ${ordinalSuffix(parsed.day)} of the month` },
    { pattern: 'fixed_weekday', label: `The ${ordinal} ${weekday} of the month` },
    { pattern: 'due_month', label: `Some time in ${MONTH_LABEL[parsed.month - 1]} — no fixed date` },
  ];
}

export interface FirstDueScheduleInput {
  frequencyType: FrequencyType | null;
  /** 'YYYY-MM-DD', or '' when the manager left it blank. */
  firstDueISO: string;
  pattern: FirstDuePattern;
  /** Only meaningful for `fixed_date`; the other patterns store the column's default. */
  rollForwardOnWeekend: boolean;
}

/**
 * The `ScheduleInput` a first-due date means under the chosen pattern, or **null** whenever a schedule must not
 * be created: a blank or invalid date, a non-recurring frequency (`ask_adhoc`/`one_off`/none), or a week-based
 * one. Null is always "create the job with no schedule, exactly as before" — never a partial or guessed row.
 *
 * Every branch sets `anchorDate` to the typed date. For a monthly cadence that is redundant (a step of one month
 * is in cycle every month regardless), but it is still true, it costs nothing, and it is what gives `due_month`
 * a day to suggest. For quarterly/biannual/annual it is the difference between a plannable job and one the
 * Monthly Plan has to report as "can't tell".
 */
export function buildFirstDueSchedule(input: FirstDueScheduleInput): ScheduleInput | null {
  const { frequencyType, firstDueISO, pattern, rollForwardOnWeekend } = input;
  if (!isMonthBasedFrequency(frequencyType)) return null;

  const interval = INTERVAL_BY_FREQUENCY[frequencyType!]!;
  const parsed = parseFirstDueDate(firstDueISO);
  if (parsed == null) return null;

  const common = { intervalUnit: interval.unit, intervalCount: interval.count, anchorDate: firstDueISO, notes: null };

  switch (pattern) {
    case 'fixed_date':
      return { ...common, scheduleType: 'fixed_date', dayOfMonth: parsed.day, rollForwardOnWeekend };
    case 'fixed_weekday':
      return { ...common, scheduleType: 'fixed_weekday', weekday: parsed.weekday, weekOrdinal: parsed.weekOrdinal };
    case 'due_month':
      return { ...common, scheduleType: 'due_month', dueMonth: parsed.month };
  }
}

/**
 * The pattern fields a real due date implies — the day it lands on, under each of the dated patterns.
 *
 * `schedules.anchor_date` is defined as "a date this job was genuinely due on", so the pattern MUST land on it:
 * a job due on 19 October is due on the 19th (fixed_date), on the 3rd Monday (fixed_weekday), in October
 * (due_month). Deriving these is therefore a restatement of the anchor, not an inference about it.
 *
 * It exists because the two forms disagreed. JobCreator's "First due date" built the whole schedule from one
 * date; ScheduleEditor's anchor field set only the phase and left `day_of_month` on its default of 1 — so
 * picking 19 October there saved "the 1st of every month", and the plan correctly showed 1 November, rolled to
 * Monday the 2nd. Both forms now put the same date through this one function.
 *
 * Null for a date that is not a real calendar date, so a half-typed value changes nothing.
 */
export function patternFieldsForAnchor(anchorISO: string): {
  dayOfMonth: number;
  weekday: ScheduleWeekday;
  weekOrdinal: ScheduleWeekOrdinal;
  dueMonth: number;
} | null {
  const parsed = parseFirstDueDate(anchorISO);
  if (parsed == null) return null;
  return { dayOfMonth: parsed.day, weekday: parsed.weekday, weekOrdinal: parsed.weekOrdinal, dueMonth: parsed.month };
}
