// Per-month cell derivation for the Month Matrix — expands the same real
// visit/schedule data deriveVisitState (mapJobRow.ts) already reads into 12
// independent monthly facts instead of one job-level status. Never reads
// frequency_raw/frequency_type/staging data; never fabricates a due month a
// schedule can't honestly support (see monthsDueInYear in scheduleFormat.ts).

import type { JobRow, JobVisitSummary } from '../domain/types';
import { monthsDueInYear } from './scheduleFormat';

export type MonthCellStateKind =
  | 'done_approved'
  | 'completed_awaiting_review'
  | 'booked'
  | 'overdue'
  | 'missed'
  | 'due_no_date'
  | 'not_due'
  | 'schedule_not_determinable'
  | 'no_schedule'
  | 'ad_hoc';

export interface MonthCellState {
  kind: MonthCellStateKind;
  /** Real visits dated in this month (0 for every schedule-derived state). */
  visitCount: number;
  /** Tooltip text — always describes real data, never invents a reason. */
  label: string;
}

/** Worst-first when a month has more than one real visit (e.g. weekly jobs) — never silently drops the others (see visitCount). */
const VISIT_KIND_PRIORITY: Record<'missed' | 'overdue' | 'booked' | 'completed_awaiting_review' | 'done_approved', number> = {
  missed: 0,
  overdue: 1,
  booked: 2,
  completed_awaiting_review: 3,
  done_approved: 4,
};

function classifyVisit(v: JobVisitSummary, todayISO: string): keyof typeof VISIT_KIND_PRIORITY {
  if (v.status === 'missed') return 'missed';
  if (v.status === 'completed') return v.reportReviewStatus === 'approved' ? 'done_approved' : 'completed_awaiting_review';
  return v.scheduledDate! < todayISO ? 'overdue' : 'booked';
}

const VISIT_LABEL: Record<keyof typeof VISIT_KIND_PRIORITY, string> = {
  missed: 'Missed',
  overdue: 'Overdue',
  booked: 'Booked',
  completed_awaiting_review: 'Completed, awaiting review',
  done_approved: 'Done & approved',
};

/**
 * 12 entries, index 0 = January. Reads only `job.visits`/`job.schedule` —
 * both already embedded in `JobRow` by mapJobRow.ts, so this needs no new
 * query. Purely a read/derivation; never writes anything.
 */
export function deriveMonthCellStates(job: JobRow, year: number, todayISO: string): MonthCellState[] {
  const dueMonths =
    job.schedule && job.schedule.scheduleType !== 'ad_hoc' ? monthsDueInYear(job.schedule) : null;

  const cells: MonthCellState[] = [];

  for (let month = 1; month <= 12; month++) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const monthVisits = job.visits.filter((v) => v.status !== 'cancelled' && v.scheduledDate?.startsWith(prefix));

    if (monthVisits.length > 0) {
      let best: keyof typeof VISIT_KIND_PRIORITY | null = null;
      for (const v of monthVisits) {
        const kind = classifyVisit(v, todayISO);
        if (best === null || VISIT_KIND_PRIORITY[kind] < VISIT_KIND_PRIORITY[best]) best = kind;
      }
      const label = monthVisits.length > 1 ? `${VISIT_LABEL[best!]} (${monthVisits.length} visits)` : VISIT_LABEL[best!];
      cells.push({ kind: best!, visitCount: monthVisits.length, label });
      continue;
    }

    if (!job.schedule) {
      cells.push({ kind: 'no_schedule', visitCount: 0, label: 'No schedule set for this job' });
    } else if (job.schedule.scheduleType === 'ad_hoc') {
      cells.push({ kind: 'ad_hoc', visitCount: 0, label: 'Ask / ad-hoc — booked on request, never automatically due' });
    } else if (dueMonths === null) {
      cells.push({ kind: 'schedule_not_determinable', visitCount: 0, label: "Schedule set, but this month can't be determined from it" });
    } else if (dueMonths.has(month)) {
      cells.push({ kind: 'due_no_date', visitCount: 0, label: 'Due this month — no date set yet' });
    } else {
      cells.push({ kind: 'not_due', visitCount: 0, label: 'Not due this month' });
    }
  }

  return cells;
}
