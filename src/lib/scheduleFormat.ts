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
  return s.anchorDate ? `${describeScheduleCore(s)}${anchorSuffix(s)}` : describeScheduleCore(s);
}

/** " (counted from Jul 2026)" — only worth saying for a cadence longer than a month, where it decides which months are in cycle. */
function anchorSuffix(s: Schedule): string {
  const step = stepMonths(s);
  if (s.anchorDate == null || step == null || step === 1) return '';
  const month = MONTH_SHORT_LABEL[Number(s.anchorDate.slice(5, 7)) - 1];
  return ` (counted from ${month} ${s.anchorDate.slice(0, 4)})`;
}

function describeScheduleCore(s: Schedule): string {
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

/** Whole months since year 0 for a 'YYYY-MM-DD' — string-sliced, never `new Date()`, so no timezone can shift the month. */
function monthIndexOfISO(iso: string): number {
  return Number(iso.slice(0, 4)) * 12 + (Number(iso.slice(5, 7)) - 1);
}

/** The schedule's cadence in whole calendar months, or null when it doesn't convert cleanly (a 'week' interval never does). */
function stepMonths(s: Schedule): number | null {
  if (s.intervalUnit == null || s.intervalCount == null || s.intervalCount < 1) return null;
  if (s.intervalUnit === 'week') return null;
  return s.intervalUnit === 'month' ? s.intervalCount : s.intervalUnit === 'quarter' ? s.intervalCount * 3 : s.intervalCount * 12;
}

/**
 * Is `year`/`month` (1-12) genuinely in this schedule's cycle? `true`/`false` when it can be said, `null` when it
 * cannot without guessing. This is the ONE phasing rule in the codebase; everything else below is a wrapper.
 *
 * With an `anchorDate` the answer is exact for any interval: count the whole months between the anchor's month and
 * this one and see whether the cadence divides it. The modulo is taken the long way round so a month BEFORE the
 * anchor answers correctly too — the anchor records the phase, it is not a start date (`jobs.service_ends_on` is
 * still the only end boundary).
 *
 * Without one, the behaviour is exactly what it was before anchors existed: a literally-monthly cadence is in cycle
 * every month, `due_month` repeats annually when its step divides 12, and anything else is simply not determinable.
 */
export function isMonthInCycle(s: Schedule, year: number, month: number): boolean | null {
  if (s.scheduleType === 'ad_hoc') return null;
  const step = stepMonths(s);
  if (step == null) return null;

  if (s.anchorDate != null) {
    const delta = year * 12 + (month - 1) - monthIndexOfISO(s.anchorDate);
    return (((delta % step) + step) % step) === 0;
  }

  if (s.scheduleType === 'due_month') {
    if (s.dueMonth == null) return null;
    if (12 % step !== 0) return null;
    return ((((month - s.dueMonth) % 12) + 12) % 12) % step === 0;
  }

  // fixed_weekday / fixed_date with no anchor: only a literally-monthly cadence is phase-free.
  return step === 1 ? true : null;
}

/**
 * A deterministic next-occurrence date, or null when the schedule doesn't store enough information to compute one
 * without guessing. Only ever computed from the schedule's own fields and today's date, never from visit history
 * (schedules and visits stay decoupled). Purely a UI suggestion: nothing here creates a visit or writes anything.
 *
 * With an `anchorDate` this works for ANY interval, because the anchor says which cycle the job is on. Without one
 * the old limit still applies and is the honest answer: only a literally-monthly `fixed_weekday`/`fixed_date` has
 * nothing to guess. `ad_hoc` never returns a date, and `due_month` only does when an anchor supplies the day.
 */
export function suggestNextDate(s: Schedule, todayISO: string): string | null {
  if (s.scheduleType === 'ad_hoc') return null;
  const step = stepMonths(s);
  if (step == null) return null;

  const todayIdx = monthIndexOfISO(todayISO);
  let startIdx: number;
  if (s.anchorDate == null) {
    if (step !== 1) return null; // no phase stored: only a literally-monthly cadence is knowable
    startIdx = todayIdx;
  } else {
    const anchorIdx = monthIndexOfISO(s.anchorDate);
    startIdx = anchorIdx + Math.max(0, Math.ceil((todayIdx - anchorIdx) / step)) * step;
  }

  // 13 steps preserves the old fixed_date behaviour of scanning a year ahead for a day that exists (e.g. the 31st).
  for (let i = 0; i < 13; i += 1) {
    const idx = startIdx + i * step;
    const candidate = suggestDateInMonth(s, Math.floor(idx / 12), (idx % 12) + 1);
    if (candidate != null && candidate >= todayISO) return candidate;
  }
  return null;
}

/**
 * The calendar months (1-12) this schedule is honestly "due" in during `year`, or `null` when that can't be said
 * without guessing. Thin wrapper over `isMonthInCycle`, which holds the one phasing rule.
 *
 * `year` matters once a schedule has an anchor: a cadence that doesn't divide 12 (every five months, say) genuinely
 * lands on different months in different years, so there is no single annual answer. It stays optional so existing
 * anchor-less callers keep working unchanged; without it, an anchored schedule can only be answered when its step
 * divides 12 and the set really does repeat every year.
 */
export function monthsDueInYear(s: Schedule, year?: number): Set<number> | null {
  if (year == null) {
    const step = stepMonths(s);
    if (s.anchorDate != null && (step == null || 12 % step !== 0)) return null;
    // Any reference year gives the same answer in the cases that reach here.
    return monthsDueInYear(s, Number(s.anchorDate?.slice(0, 4) ?? 2000));
  }

  const months = new Set<number>();
  for (let month = 1; month <= 12; month += 1) {
    const inCycle = isMonthInCycle(s, year, month);
    if (inCycle == null) return null;
    if (inCycle) months.add(month);
  }
  return months;
}

/**
 * The real date this schedule falls on within a specific `year`/`month` (1-12) — for pre-filling a booking form.
 * `null` whenever no honest day can be computed, and the caller then falls back to the first of the month itself.
 *
 * The month must first be genuinely in the cycle (`isMonthInCycle`), which is what makes any interval safe here once
 * an anchor exists. The DAY still comes only from what the schedule stores: `week_ordinal`+`weekday`, or
 * `day_of_month`, or — for `due_month`, which stores no day at all — the anchor's own day-of-month. A day that does
 * not exist in the target month (the 31st of February) returns `null` and is never clamped to a different day.
 */
export function suggestDateInMonth(s: Schedule, year: number, month: number): string | null {
  if (isMonthInCycle(s, year, month) !== true) return null;
  const monthIndex = month - 1;

  if (s.scheduleType === 'fixed_weekday') {
    if (!s.weekOrdinal || !s.weekday) return null;
    return toISODate(nthWeekdayOfMonth(year, monthIndex, s.weekOrdinal, s.weekday));
  }

  if (s.scheduleType === 'fixed_date') {
    if (s.dayOfMonth == null) return null;
    const raw = fixedDateInMonth(year, monthIndex, s.dayOfMonth);
    if (!raw) return null;
    return toISODate(s.rollForwardOnWeekend ? rollForwardWeekend(raw) : raw);
  }

  if (s.scheduleType === 'due_month') {
    // No day is stored for due_month, so only an anchor can supply one. Without it the month is right but the day is
    // genuinely unknown - which is the point of this schedule type.
    if (s.anchorDate == null) return null;
    const raw = fixedDateInMonth(year, monthIndex, Number(s.anchorDate.slice(8, 10)));
    if (!raw) return null;
    return toISODate(s.rollForwardOnWeekend ? rollForwardWeekend(raw) : raw);
  }

  return null;
}

/**
 * True when a job's service has ended for the given month: from the month containing `serviceEndsOn` onward the job no
 * longer asks for work, so nothing is derived as "due" or "needs booking" there. `monthPrefix` is 'YYYY-MM'. A job with
 * no end date is never ended. Visits that really happened earlier in that month are unaffected (they are real rows).
 */
export function isDemandEndedForMonth(monthPrefix: string, serviceEndsOn: string | null | undefined): boolean {
  if (!serviceEndsOn) return false;
  return monthPrefix >= serviceEndsOn.slice(0, 7);
}
