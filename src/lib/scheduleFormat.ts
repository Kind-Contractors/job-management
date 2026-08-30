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
