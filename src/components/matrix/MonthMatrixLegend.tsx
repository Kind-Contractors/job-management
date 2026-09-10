import type { MonthCellStateKind } from '../../lib/monthMatrix';
import { getMonthCellPresentation } from '../../lib/statusPresentation';

/**
 * Every real state `deriveMonthCellStates` (lib/monthMatrix.ts) can
 * actually produce, in the exact order a manager scans a row left to
 * right: what's already happened, what's booked, what's due, then the
 * "nothing booked" cases. No entry here for a state the grid can't
 * render — this only documents what's really on screen.
 */
const LEGEND_ENTRIES: { kind: MonthCellStateKind; label: string }[] = [
  { kind: 'done_approved', label: 'Completed & approved' },
  { kind: 'completed_awaiting_review', label: 'Completed, awaiting review' },
  { kind: 'booked', label: 'Booked' },
  { kind: 'overdue', label: 'Overdue' },
  { kind: 'missed', label: 'Missed' },
  { kind: 'due_no_date', label: 'Due this month — no date set yet' },
  { kind: 'not_due', label: 'Not due this month' },
  { kind: 'no_schedule', label: 'No schedule set for this job' },
  { kind: 'schedule_not_determinable', label: "Schedule set, but this month can't be determined from it" },
  { kind: 'ad_hoc', label: 'Ask / ad-hoc — booked on request' },
];

/** A small static key explaining every cell state — CLAUDE.md §4 calls for one; the grid previously had none, distinguishing several blank-looking states only via hover tooltip. */
export default function MonthMatrixLegend() {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-neutral-600">
      {LEGEND_ENTRIES.map(({ kind, label }) => {
        const presentation = getMonthCellPresentation(kind);
        return (
          <span key={kind} className="flex items-center gap-1.5">
            <i
              className={`flex h-3 w-3 flex-none items-center justify-center border text-[8px] leading-none font-semibold ${presentation.className} ${
                presentation.hollow ? 'text-neutral-400' : 'text-transparent'
              }`}
            >
              {presentation.marker}
            </i>
            {label}
          </span>
        );
      })}
    </div>
  );
}
