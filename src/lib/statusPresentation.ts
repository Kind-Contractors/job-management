import type { JobStatus, JobVisitSummary, ReportReviewStatus, VisitStatus } from '../domain/types';
import type { MonthCellStateKind } from './monthMatrix';

export interface StatusPresentation {
  label: string;
  /** Text color (Tailwind class). */
  fg: string;
  /** Status dot fill (Tailwind class). */
  dot: string;
  /** Dot border, for the "not due" hollow-dot look. */
  border: string;
  /**
   * A light background tint of the same hue as `border` — a literal class
   * (never built at runtime: Tailwind's compiler only picks up classes it
   * can see as-written in source, so a string-concatenated class like
   * `${border.replace(...)}/10` would silently produce no CSS at all).
   * Used where a status needs to read as a chip among dense plain-text
   * rows (JobsGrid's status column) — StatusPill itself stays a bare
   * dot+text everywhere else, unchanged.
   */
  bg: string;
}

/**
 * Only a handful of colors carry meaning (the approved design's own rule —
 * see CLAUDE.md section 4): brand teal for "normal/active", and the three
 * functional tones (due/missed/done) for everything else. Never introduce a
 * new hue for a new status without updating that rule deliberately.
 */
const PRESENTATIONS: Record<JobStatus, StatusPresentation> = {
  booked: { label: 'Booked', fg: 'text-teal-700', dot: 'bg-teal', border: 'border-teal', bg: 'bg-teal/10' },
  needs_booking: { label: 'Needs booking', fg: 'text-due-fg', dot: 'bg-due', border: 'border-due', bg: 'bg-due/10' },
  not_due: { label: 'Not due yet', fg: 'text-neutral-600', dot: 'bg-transparent', border: 'border-neutral-400', bg: 'bg-neutral-400/10' },
  review: { label: 'Report to review', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700', bg: 'bg-teal-700/10' },
  onsite: { label: 'On site now', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700', bg: 'bg-teal-700/10' },
  missed: { label: 'Missed', fg: 'text-missed-fg', dot: 'bg-missed', border: 'border-missed', bg: 'bg-missed/10' },
  ask: { label: 'No schedule', fg: 'text-neutral-600', dot: 'bg-transparent', border: 'border-neutral-400', bg: 'bg-neutral-400/10' },
  unscheduled: { label: 'Not yet scheduled', fg: 'text-neutral-600', dot: 'bg-transparent', border: 'border-neutral-400', bg: 'bg-neutral-400/10' },
  overdue: { label: 'Overdue', fg: 'text-missed-fg', dot: 'bg-missed', border: 'border-missed', bg: 'bg-missed/10' },
};

export function getStatusPresentation(status: JobStatus): StatusPresentation {
  return PRESENTATIONS[status];
}

export function dueColorClass(status: JobStatus, softDate: boolean): string {
  if (status === 'missed' || status === 'overdue') return 'text-missed-fg';
  if (softDate) return 'text-due-fg';
  return 'text-ink';
}

/**
 * A report is "ready for accounts" once approved and not yet sent to
 * accounts — a per-visit condition, not a JobStatus (a job can have this
 * true on one visit while its overall status is anything else). The one
 * shared source of truth for this predicate — reused by NavRail's count,
 * AllLiveJobsPage's filter, and VisitRow's inline badge/auto-expand.
 */
export function isVisitReadyForAccounts(visit: JobVisitSummary): boolean {
  return visit.reportReviewStatus === 'approved' && !visit.sentToAccountsAt;
}

/**
 * A report is "ready for client" once approved and not yet sent to the
 * client — the same shape as isVisitReadyForAccounts above, just keyed on
 * sentToClientAt instead of sentToAccountsAt. The one shared source of
 * truth for this predicate — reused by NavRail's count and
 * ReadyForClientPage.tsx's own filter.
 */
export function isReportReadyForClient(visit: JobVisitSummary): boolean {
  return visit.reportReviewStatus === 'approved' && !visit.sentToClientAt;
}

export interface MonthCellPresentation {
  /** Background/border classes for a solid (real-visit-derived) cell. */
  className: string;
  /** True for every schedule-derived "nothing booked" state — rendered as the same restrained hollow style, distinguished only by tooltip text (CLAUDE.md §4/§9: only 3-4 functional colors). */
  hollow: boolean;
  /**
   * A single small, neutral (no new color) character shown in place of the
   * (always-zero) visit count for a hollow cell — the audit found the four
   * hollow states hard to tell apart at a glance, hover-only. Only the two
   * states that represent an administrative gap worth noticing get one
   * ('no_schedule', 'schedule_not_determinable'); 'not_due' and 'ad_hoc'
   * are both honest, structural "nothing to book here" cases and stay
   * blank, matching the majority/expected case. The full hover tooltip
   * (`MonthCellState.label`) is unchanged and still the authoritative text.
   */
  marker?: string;
}

/**
 * Month Matrix cell styling — reuses the same restrained functional
 * palette as `PRESENTATIONS` above (teal=normal/done, ochre/due=due,
 * brick/missed=missed/overdue), never a new hue per state. Every
 * schedule-derived "nothing booked" state (not due / no schedule / ad-hoc
 * / undeterminable) renders with the same restrained hollow style — the
 * primary difference is still the hover tooltip (`MonthCellState.label`),
 * with a small marker character added for the two states worth noticing
 * at a glance (see `MonthCellPresentation.marker`). Never a new color.
 */
const MONTH_CELL_PRESENTATIONS: Record<MonthCellStateKind, MonthCellPresentation> = {
  done_approved: { className: 'border-teal-700 bg-teal-700', hollow: false },
  completed_awaiting_review: { className: 'border-teal-700 bg-teal-100', hollow: false },
  booked: { className: 'border-teal bg-teal-100', hollow: false },
  overdue: { className: 'border-missed bg-missed/20', hollow: false },
  missed: { className: 'border-missed bg-missed/10', hollow: false },
  due_no_date: { className: 'border-due bg-due/10', hollow: false },
  not_due: { className: 'border-neutral-300 bg-transparent', hollow: true },
  schedule_not_determinable: { className: 'border-neutral-300 bg-transparent', hollow: true, marker: '?' },
  no_schedule: { className: 'border-neutral-300 bg-transparent', hollow: true, marker: '–' },
  ad_hoc: { className: 'border-neutral-300 bg-transparent', hollow: true },
};

export function getMonthCellPresentation(kind: MonthCellStateKind): MonthCellPresentation {
  return MONTH_CELL_PRESENTATIONS[kind];
}

/**
 * Visit-status chip colors — reuses the exact same values already
 * established for Calendar visit chips (ThisWeekPage.tsx/MonthGrid.tsx's
 * VISIT_STATUS_STYLE), just in the {label, fg, dot, border} shape StatusPill
 * already renders, so a real VisitStatus gets the same chip treatment as a
 * JobStatus rather than plain text. No new colors, no new statuses.
 */
const VISIT_STATUS_PRESENTATIONS: Record<VisitStatus, StatusPresentation> = {
  due: { label: 'Due', fg: 'text-neutral-700', dot: 'bg-neutral-400', border: 'border-neutral-400', bg: 'bg-neutral-400/10' },
  booked: { label: 'Booked', fg: 'text-teal-700', dot: 'bg-teal', border: 'border-teal', bg: 'bg-teal/10' },
  completed: { label: 'Completed', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700', bg: 'bg-teal-700/10' },
  missed: { label: 'Missed', fg: 'text-missed-fg', dot: 'bg-missed', border: 'border-missed', bg: 'bg-missed/10' },
  cancelled: { label: 'Cancelled', fg: 'text-neutral-400', dot: 'bg-transparent', border: 'border-neutral-300', bg: 'bg-neutral-300/10' },
};

export function getVisitStatusPresentation(status: VisitStatus): StatusPresentation {
  return VISIT_STATUS_PRESENTATIONS[status];
}

/**
 * Report review-status chip colors — same restrained palette: teal for
 * "in progress normally" and "approved/done", ochre/due for "sent back,
 * needs attention". Matches ReportPanel.tsx's existing REVIEW_LABEL strings
 * exactly; this only adds the dot/border chip shape around them.
 */
const REPORT_REVIEW_STATUS_PRESENTATIONS: Record<ReportReviewStatus, StatusPresentation> = {
  awaiting_review: { label: 'Awaiting review', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700', bg: 'bg-teal-700/10' },
  returned_for_correction: { label: 'Returned for correction', fg: 'text-due-fg', dot: 'bg-due', border: 'border-due', bg: 'bg-due/10' },
  approved: { label: 'Approved', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700', bg: 'bg-teal-700/10' },
};

export function getReportReviewStatusPresentation(status: ReportReviewStatus): StatusPresentation {
  return REPORT_REVIEW_STATUS_PRESENTATIONS[status];
}
