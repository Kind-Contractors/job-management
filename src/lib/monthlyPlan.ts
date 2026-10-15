// "These are all the jobs due in August" — the month-at-a-time worklist Luke plans from.
//
// This answers a different question from the Month Matrix (a year of coverage for every job) and from
// deriveVisitState (one headline status per job, current month only). It asks: for ONE month, what wants
// doing, what is already booked, and what was due earlier and never got booked?
//
// It derives, it never writes, and it never invents due-ness:
//   * every month's facts come from deriveMonthCellStates (monthMatrix.ts), so there is exactly one rule in
//     the codebase for "is this job due in this month" - real visits win, service-end and ad-hoc are handled;
//   * a job with no schedule, or an ad-hoc one, is NEVER listed as due. It appears only when it has a real
//     visit in the month - which is how a one-off job booked into August shows up on August's plan;
//   * a cadence the schedule cannot phase (no anchor_date) is surfaced as 'not_determinable' rather than
//     guessed or silently dropped, because silently dropping work is the spreadsheet failure this replaces.
//
// Carry-over exists because deriveVisitState only ever looks at the current month: a quarterly job due in
// August and never booked simply reads as 'unscheduled' in September, and the demand disappears. Here it is
// carried forward and flagged with the month it came from.

import type { JobRow, JobVisitSummary } from '../domain/types';
import { deriveMonthCellStates, type MonthCellState } from './monthMatrix';
import { isRecurringFrequency } from './firstDueSchedule';
import { suggestDateInMonth } from './scheduleFormat';

export type MonthlyPlanKind = 'booked' | 'due_no_date' | 'carried_over' | 'not_determinable' | 'no_schedule';

export interface MonthlyPlanEntry {
  job: JobRow;
  kind: MonthlyPlanKind;
  /** Real, non-cancelled visits already dated in the planned month. Empty for every schedule-derived kind. */
  visitsInMonth: JobVisitSummary[];
  /** 'YYYY-MM' of the earliest earlier month this job was due in and never booked, else null. */
  dueFromMonth: string | null;
  /** An honest pre-fill for the booking date, or null — the caller falls back to the first of the month. */
  suggestedDate: string | null;
  /** Row text describing real data, never an invented reason. */
  label: string;
  /**
   * The job is priced as recurring but has no `schedules` row, so nothing can ever make it due. Carried on EVERY
   * entry, not only the 'no_schedule' kind, so a job that happens to be booked this month is still flagged as
   * unplannable next month. `ask_adhoc`/`one_off` are correctly schedule-less and are never flagged.
   */
  needsSchedule: boolean;
}

/** How far back carry-over looks. A year catches an annual job missed once without inventing ancient history. */
export const CARRY_OVER_LOOKBACK_MONTHS = 12;

const prefixOf = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

/** 'YYYY-MM' → { year, month } (month 1-12). */
export function parseMonthPrefix(monthPrefix: string): { year: number; month: number } {
  return { year: Number(monthPrefix.slice(0, 4)), month: Number(monthPrefix.slice(5, 7)) };
}

/** Steps a 'YYYY-MM' by whole months, forwards or backwards. */
export function shiftMonthPrefix(monthPrefix: string, delta: number): string {
  const { year, month } = parseMonthPrefix(monthPrefix);
  const idx = year * 12 + (month - 1) + delta;
  return prefixOf(Math.floor(idx / 12), (((idx % 12) + 12) % 12) + 1);
}

const VISIT_KINDS: MonthCellState['kind'][] = ['booked', 'overdue', 'missed', 'completed_awaiting_review', 'done_approved'];

/**
 * The plan for one month.
 *
 * `jobs` is `listJobRows()` output (already active jobs only), division-filtered by the caller. `monthPrefix`
 * is the month being planned, 'YYYY-MM'. Entries come back in input order; grouping and sorting are the
 * caller's business.
 */
export function buildMonthlyPlan(jobs: JobRow[], monthPrefix: string, todayISO: string): MonthlyPlanEntry[] {
  const { year, month } = parseMonthPrefix(monthPrefix);
  const todayPrefix = todayISO.slice(0, 7);
  // Work that is genuinely late: never report a month that has not happened yet as overdue, even when planning
  // several months ahead.
  const overdueBefore = monthPrefix < todayPrefix ? monthPrefix : todayPrefix;

  const entries: MonthlyPlanEntry[] = [];

  for (const job of jobs) {
    // One year of cells is not enough when January is being planned, so the previous year comes too.
    const cellsByPrefix = new Map<string, MonthCellState>();
    for (const y of [year - 1, year]) {
      deriveMonthCellStates(job, y, todayISO).forEach((cell, i) => cellsByPrefix.set(prefixOf(y, i + 1), cell));
    }

    const cell = cellsByPrefix.get(monthPrefix)!;
    const suggestedDate = job.schedule ? suggestDateInMonth(job.schedule, year, month) : null;
    const needsSchedule = job.schedule == null && isRecurringFrequency(job.frequencyType ?? null);

    // The earliest earlier month that was due and never booked. 'due_no_date' already means exactly that: a
    // month holding any real visit yields a visit kind instead, so nothing further needs checking.
    //
    // Bounded by the job's OWN history: never look back past its first real visit. Without that bound a job
    // added last week reads as "overdue from a year ago", because every month before it existed was
    // technically in cycle and technically unbooked. A job with no visits at all therefore carries nothing -
    // there is no evidence it was being serviced earlier, and inventing missed work is worse than missing it.
    const firstVisitMonth = job.visits
      .filter((v) => v.status !== 'cancelled' && v.scheduledDate != null)
      .map((v) => v.scheduledDate!.slice(0, 7))
      .sort()[0];

    let dueFromMonth: string | null = null;
    if (firstVisitMonth != null) {
      for (let back = CARRY_OVER_LOOKBACK_MONTHS; back >= 1; back -= 1) {
        const earlier = shiftMonthPrefix(monthPrefix, -back);
        if (earlier >= overdueBefore || earlier < firstVisitMonth) continue;
        if (cellsByPrefix.get(earlier)?.kind === 'due_no_date') {
          dueFromMonth = earlier;
          break;
        }
      }
    }

    if (VISIT_KINDS.includes(cell.kind)) {
      entries.push({
        job,
        kind: 'booked',
        visitsInMonth: job.visits.filter((v) => v.status !== 'cancelled' && v.scheduledDate?.startsWith(monthPrefix)),
        dueFromMonth,
        suggestedDate,
        label: cell.label,
        needsSchedule,
      });
      continue;
    }

    if (cell.kind === 'due_no_date') {
      entries.push({ job, kind: 'due_no_date', visitsInMonth: [], dueFromMonth, suggestedDate, label: cell.label, needsSchedule });
      continue;
    }

    if (cell.kind === 'schedule_not_determinable') {
      entries.push({ job, kind: 'not_determinable', visitsInMonth: [], dueFromMonth, suggestedDate, label: cell.label, needsSchedule });
      continue;
    }

    // 'not_due', 'no_schedule' and 'ad_hoc' are not due this month and have no visit in it. They belong on the
    // plan only if earlier work was left unbooked...
    if (dueFromMonth != null) {
      entries.push({ job, kind: 'carried_over', visitsInMonth: [], dueFromMonth, suggestedDate, label: cell.label, needsSchedule });
      continue;
    }

    // ...or if they are recurring work that nothing can ever make due. This is NOT a claim that the job is due
    // this month - it has no cycle to be due in. It is listed so an unscheduled recurring job is findable in the
    // place Luke plans from, instead of being silently absent from every month forever.
    if (needsSchedule) {
      entries.push({
        job, kind: 'no_schedule', visitsInMonth: [], dueFromMonth: null, suggestedDate: null,
        label: 'No schedule set — this job can never become due', needsSchedule,
      });
    }
  }

  return entries;
}

export function monthlyPlanCounts(entries: MonthlyPlanEntry[]): Record<MonthlyPlanKind, number> {
  const counts: Record<MonthlyPlanKind, number> = { booked: 0, due_no_date: 0, carried_over: 0, not_determinable: 0, no_schedule: 0 };
  for (const e of entries) counts[e.kind] += 1;
  return counts;
}

/**
 * Everything still wanting a date — what the nav badge counts. Deliberately excludes 'no_schedule': those jobs
 * are not due (nothing can make them due), so counting them as work to book would be the invented due-ness this
 * module exists to avoid. They have their own filter instead.
 */
export function needsBookingCount(entries: MonthlyPlanEntry[]): number {
  return entries.filter((e) => e.kind === 'due_no_date' || e.kind === 'carried_over').length;
}

/** Recurring jobs with no schedule — flagged wherever they appear, not only when 'no_schedule' is their kind. */
export function needsScheduleCount(entries: MonthlyPlanEntry[]): number {
  return entries.filter((e) => e.needsSchedule).length;
}

/** "Overdue from June — never booked", or null. Used on the row and in its tooltip. */
export function carriedOverLabel(entry: MonthlyPlanEntry): string | null {
  if (entry.dueFromMonth == null) return null;
  const { year, month } = parseMonthPrefix(entry.dueFromMonth);
  const name = new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long' });
  return `Overdue from ${name} — never booked`;
}

/**
 * Non-cancelled visits this job already has on `dateISO`. The Monthly Plan shows these before booking and asks
 * before adding another, because `visits` has no unique (job_id, scheduled_date) constraint and genuinely
 * cannot have a naive one: cancel-then-rebook legitimately leaves two rows on one date, and a real second
 * visit in a day does happen. See the plan's "Double-booking guard".
 */
export function visitsOnDate(job: JobRow, dateISO: string): JobVisitSummary[] {
  return job.visits.filter((v) => v.status !== 'cancelled' && v.scheduledDate === dateISO);
}
