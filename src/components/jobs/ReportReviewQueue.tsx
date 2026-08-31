import type { JobRow, JobVisitSummary } from '../../domain/types';
import { REVIEW_LABEL } from './ReportPanel';

export interface ReportQueueRow {
  job: JobRow;
  visit: JobVisitSummary;
}

interface ReportReviewQueueProps {
  rows: ReportQueueRow[];
  selectedReportId: string | null;
  onSelect: (reportId: string) => void;
}

/**
 * Presentational only — the list of actionable reports. Orchestration
 * (the jobRows query, selection state, Prev/Next) lives in
 * ReportReviewPage.tsx, per CLAUDE.md section 12.
 */
export default function ReportReviewQueue({ rows, selectedReportId, onSelect }: ReportReviewQueueProps) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-5 text-center">
        <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">Queue clear</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {rows.map(({ job, visit }) => {
        const isSelected = visit.reportId === selectedReportId;
        const completedLabel = visit.completedAt ? new Date(visit.completedAt).toLocaleDateString('en-GB') : 'Completed date unknown';
        return (
          <div
            key={visit.reportId}
            onClick={() => onSelect(visit.reportId!)}
            className={`cursor-pointer border-b border-divider px-3.5 py-2.5 ${isSelected ? 'bg-teal-100' : 'hover:bg-neutral-100'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-[12.5px] font-semibold text-ink">{job.buildingName}</span>
              <span
                className={`flex-none font-heading text-[9.5px] font-semibold tracking-[0.07em] uppercase ${
                  visit.reportReviewStatus === 'returned_for_correction' ? 'text-due-fg' : 'text-teal-700'
                }`}
              >
                {visit.reportReviewStatus ? REVIEW_LABEL[visit.reportReviewStatus] : ''}
              </span>
            </div>
            <div className="text-[11.5px] text-neutral-600">{job.clientName} · {job.jobSummary}</div>
            <div className="mt-0.5 text-[11px] text-neutral-500 tabular-nums">Completed {completedLabel}</div>
          </div>
        );
      })}
    </div>
  );
}
