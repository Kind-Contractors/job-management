// Pure formatting of a real Schedule row — mirrors statusPresentation.ts's
// separation of concerns (data access lives in schedulesRepository.ts, not
// here). Every value formatted here was explicitly typed by a manager;
// nothing here computes or generates a date/visit — see the reviewed plan's
// "how this integrates with This Week" section for why that line is never
// crossed.

import type { Schedule, ScheduleIntervalUnit, ScheduleWeekOrdinal, ScheduleWeekday } from '../domain/types';

const WEEKDAY_LABEL: Record<ScheduleWeekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const MONTH_LABEL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAY_SHORT_LABEL: Record<ScheduleWeekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const MONTH_SHORT_LABEL = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function everyLabel(unit: ScheduleIntervalUnit, count: number): string {
  const plural = count === 1 ? unit : `${unit}s`;
  return count === 1 ? `Every ${plural}` : `Every ${count} ${plural}`;
}

function ordinalWeekdayLabel(weekOrdinal: ScheduleWeekOrdinal, weekday: ScheduleWeekday): string {
  return `${weekOrdinal} ${WEEKDAY_LABEL[weekday]}`;
}

function dayOfMonthSuffix(day: number): string {
  if (day % 10 === 1 && day !== 11) return `${day}st`;
  if (day % 10 === 2 && day !== 12) return `${day}nd`;
  if (day % 10 === 3 && day !== 13) return `${day}rd`;
  return `${day}th`;
}

export function describeSchedule(s: Schedule): string {
  switch (s.scheduleType) {
    case 'ad_hoc':
      return 'Ask / ad-hoc — booked on request';
    case 'fixed_weekday':
      return `${everyLabel(s.intervalUnit!, s.intervalCount!)}, ${ordinalWeekdayLabel(s.weekOrdinal!, s.weekday!)}`;
    case 'fixed_date': {
      const base = `${everyLabel(s.intervalUnit!, s.intervalCount!)}, on the ${dayOfMonthSuffix(s.dayOfMonth!)}`;
      return s.rollForwardOnWeekend ? `${base} (rolls to next working day if it falls on a weekend)` : base;
    }
    case 'due_month':
      return `Due in ${MONTH_LABEL[s.dueMonth! - 1]}, ${everyLabel(s.intervalUnit!, s.intervalCount!).toLowerCase()}`;
  }
}

/**
 * A deliberately concise variant for badge/pill contexts (see
 * JobInspectorDrawer.tsx's header) — describeSchedule()'s full sentences
 * break a small fixed-style tag. Same real fields, just abbreviated;
 * nothing inferred that describeSchedule() doesn't already state.
 */
export function describeScheduleShort(s: Schedule): string {
  switch (s.scheduleType) {
    case 'ad_hoc':
      return 'Ask / ad-hoc';
    case 'fixed_weekday':
      return `${s.weekOrdinal} ${WEEKDAY_SHORT_LABEL[s.weekday!]}`;
    case 'fixed_date':
      return dayOfMonthSuffix(s.dayOfMonth!);
    case 'due_month':
      return `Due ${MONTH_SHORT_LABEL[s.dueMonth! - 1]}`;
  }
}

const WEEKDAY_INDEX: Record<ScheduleWeekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEK_ORDINAL_INDEX: Record<string, number> = { '1st': 0, '2nd': 1, '3rd': 2, '4th': 3 };

/** Formats a Date's own LOCAL calendar day — never `.toISOString()` here, which converts to UTC and would shift the date in any timezone ahead of UTC (a real bug caught by this function's own verification trace). */
function toISODate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The Nth (or last) `weekday` of the given month — always exists (every month has ≥4 of each weekday), so this never fails. */
function nthWeekdayOfMonth(year: number, month: number, weekOrdinal: ScheduleWeekOrdinal, weekday: ScheduleWeekday): Date {
  const targetDow = WEEKDAY_INDEX[weekday];
  if (weekOrdinal === 'last') {
    const lastDay = new Date(year, month + 1, 0);
    lastDay.setDate(lastDay.getDate() - ((lastDay.getDay() - targetDow + 7) % 7));
    return lastDay;
  }
  const firstDow = new Date(year, month, 1).getDay();
  const day = 1 + ((targetDow - firstDow + 7) % 7) + WEEK_ORDINAL_INDEX[weekOrdinal] * 7;
  return new Date(year, month, day);
}

/** `dayOfMonth` in the given month, or null if that day doesn't exist there (e.g. 31 in February) — never clamped to a different day. */
function fixedDateInMonth(year: number, month: number, dayOfMonth: number): Date | null {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return dayOfMonth > daysInMonth ? null : new Date(year, month, dayOfMonth);
}

function rollForwardWeekend(d: Date): Date {
  const dow = d.getDay();
  if (dow === 6) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2);
  if (dow === 0) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return d;
}

/**
 * A deterministic next-occurrence date, or null when the schedule doesn't
 * store enough information to compute one without guessing — see the
 * reviewed plan for the full case-by-case rationale. Only ever computed
 * from the schedule's own fields and today's date, never from visit
 * history (schedules and visits stay decoupled). Purely a UI suggestion:
 * nothing here creates a visit or writes anything.
 *
 * Deliberately narrow: only `fixed_weekday`/`fixed_date` with
 * `intervalUnit === 'month' && intervalCount === 1` (literally monthly,
 * so every month is genuinely "in the cycle" with nothing to guess) ever
 * returns a date. `ad_hoc` and `due_month` never do (no day is ever
 * stored for either). `week`/`quarter`/`year` intervals, or `month` with
 * `intervalCount > 1`, never do either — the schema has no stored anchor
 * saying which specific week/quarter/year-cycle or which of the N months
 * the recurrence is phased against, so picking one would be inventing
 * information the schedule doesn't provide. Do not extend this to those
 * cases without a schema change that adds a real anchor field.
 */
export function suggestNextDate(s: Schedule, todayISO: string): string | null {
  if (s.scheduleType === 'ad_hoc' || s.scheduleType === 'due_month') return null;
  if (s.intervalUnit !== 'month' || s.intervalCount !== 1) return null;

  const today = new Date(`${todayISO}T00:00:00`);
  const year = today.getFullYear();
  const month = today.getMonth();

  if (s.scheduleType === 'fixed_weekday') {
    if (!s.weekOrdinal || !s.weekday) return null;
    const thisMonth = nthWeekdayOfMonth(year, month, s.weekOrdinal, s.weekday);
    if (toISODate(thisMonth) >= todayISO) return toISODate(thisMonth);
    return toISODate(nthWeekdayOfMonth(year, month + 1, s.weekOrdinal, s.weekday));
  }

  if (s.scheduleType === 'fixed_date') {
    if (s.dayOfMonth == null) return null;
    for (let offset = 0; offset <= 12; offset++) {
      const raw = fixedDateInMonth(year, month + offset, s.dayOfMonth);
      if (!raw) continue;
      const candidate = s.rollForwardOnWeekend ? rollForwardWeekend(raw) : raw;
      const candidateISO = toISODate(candidate);
      if (candidateISO >= todayISO) return candidateISO;
    }
    return null;
  }

  return null;
}

/**
 * The set of calendar months (1-12) this schedule is honestly "due" in,
 * every year — or `null` when that can't be safely computed from what's
 * stored (see the Month Matrix plan's §3.1 for the full case-by-case
 * rationale). Only ever called for a real structured (non-`ad_hoc`)
 * schedule; the caller decides `ad_hoc`/no-schedule separately.
 *
 * `fixed_weekday`/`fixed_date`: determinable only for literally-monthly
 * cadence (`intervalUnit === 'month' && intervalCount === 1`) — every
 * month is genuinely in the cycle, same restriction `suggestNextDate`
 * already enforces. Any other interval never stores an anchor month, so
 * no specific month(s) can be named without guessing.
 *
 * `due_month`: does store a real anchor month, so the full set is
 * computed by stepping forward from `dueMonth` by the schedule's own
 * interval, converted to whole months (`week` never converts cleanly to
 * a fixed calendar month — not determinable). Only returned when the
 * step evenly divides 12, so the same set of months recurs identically
 * every calendar year shown — a step that doesn't (e.g. every 5 months)
 * would put different months in-cycle in different years, and there's no
 * stored anchor *year* to resolve that, so it's left undetermined rather
 * than guessed.
 */
export function monthsDueInYear(s: Schedule): Set<number> | null {
  if (s.scheduleType === 'fixed_weekday' || s.scheduleType === 'fixed_date') {
    if (s.intervalUnit === 'month' && s.intervalCount === 1) {
      return new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
    return null;
  }

  if (s.scheduleType === 'due_month') {
    if (s.dueMonth == null || s.intervalUnit == null || s.intervalCount == null) return null;
    if (s.intervalUnit === 'week') return null;

    const stepMonths = s.intervalUnit === 'month' ? s.intervalCount : s.intervalUnit === 'quarter' ? s.intervalCount * 3 : s.intervalCount * 12;
    if (stepMonths <= 0 || 12 % stepMonths !== 0) return null;

    const months = new Set<number>();
    let m = ((s.dueMonth - 1) % 12 + 12) % 12;
    for (let i = 0; i < 12 / stepMonths; i++) {
      months.add(m + 1);
      m = (m + stepMonths) % 12;
    }
    return months;
  }

  return null;
}

/**
 * The real date this schedule falls on within a specific `year`/`month`
 * (1-12) — for pre-filling the Month Matrix's booking form when a manager
 * clicks a due cell. `null` whenever no honest day can be computed:
 * `due_month` (no day ever stored), `ad_hoc` (no date at all), or any
 * interval other than literally-monthly (same restriction as
 * `suggestNextDate`/`monthsDueInYear` — never guess which month/week/
 * quarter-cycle phase a non-monthly schedule is on).
 */
export function suggestDateInMonth(s: Schedule, year: number, month: number): string | null {
  const monthIndex = month - 1;

  if (s.scheduleType === 'fixed_weekday') {
    if (s.intervalUnit !== 'month' || s.intervalCount !== 1 || !s.weekOrdinal || !s.weekday) return null;
    return toISODate(nthWeekdayOfMonth(year, monthIndex, s.weekOrdinal, s.weekday));
  }

  if (s.scheduleType === 'fixed_date') {
    if (s.intervalUnit !== 'month' || s.intervalCount !== 1 || s.dayOfMonth == null) return null;
    const raw = fixedDateInMonth(year, monthIndex, s.dayOfMonth);
    if (!raw) return null;
    return toISODate(s.rollForwardOnWeekend ? rollForwardWeekend(raw) : raw);
  }

  return null;
}
