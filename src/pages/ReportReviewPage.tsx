import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { listJobRows } from '../repository/jobsRepository';
import { useAuth } from '../auth/AuthProvider';
import { isVisitReadyForAccounts } from '../lib/statusPresentation';
import ReportReviewQueue, { type ReportQueueRow } from '../components/jobs/ReportReviewQueue';
import ReportPanel from '../components/jobs/ReportPanel';

export default function ReportReviewPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const actor = session?.user.email ?? 'unknown';
  const [searchParams] = useSearchParams();
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);

  const division = searchParams.get('division') ?? 'Both';

  const {
    data: jobRows = [],
    isLoading,
    isError,
    error,
  } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const queue = useMemo<ReportQueueRow[]>(() => {
    const rows: ReportQueueRow[] = [];
    for (const job of jobRows) {
      if (division !== 'Both' && job.division !== division) continue;
      for (const visit of job.visits) {
        if (visit.reportId && (visit.reportReviewStatus === 'awaiting_review' || visit.reportReviewStatus === 'returned_for_correction')) {
          rows.push({ job, visit });
        }
      }
    }
    return rows.sort((a, b) => (a.visit.completedAt ?? '').localeCompare(b.visit.completedAt ?? ''));
  }, [jobRows, division]);

  const selected = queue.find((r) => r.visit.reportId === selectedReportId);
  const currentIndex = queue.findIndex((r) => r.visit.reportId === selectedReportId);

  const goToOffset = (offset: number) => {
    if (queue.length === 0) return;
    const nextIndex = (((currentIndex + offset) % queue.length) + queue.length) % queue.length;
    setSelectedReportId(queue[nextIndex].visit.reportId);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[300px] flex-none flex-col border-r border-divider bg-white">
        <div className="flex-none border-b border-divider px-3.5 py-3">
          <h1 className="font-heading text-lg font-semibold">Report review</h1>
          <div className="mt-0.5 text-xs text-neutral-600 tabular-nums">
            {queue.length} awaiting review
          </div>
        </div>

        {isLoading ? (
          <div className="p-3.5">
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
          </div>
        ) : isError ? (
          <div className="p-3.5">
            <div className="border border-missed bg-missed/10 p-3">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                Couldn't load reports
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink">
                {error instanceof Error ? error.message : 'Something went wrong.'}
              </div>
            </div>
          </div>
        ) : (
          <ReportReviewQueue rows={queue} selectedReportId={selectedReportId} onSelect={setSelectedReportId} />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-5 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              Nothing waiting on you
            </div>
          </div>
        ) : (
          <div className="max-w-[560px] p-5">
            <div className="flex items-start justify-between gap-3 border-b border-divider pb-3">
              <div>
                <h2 className="font-heading text-xl font-semibold">{selected.job.buildingName}</h2>
                <div className="mt-0.5 text-[13px] text-neutral-600">
                  {selected.job.clientName} · {selected.job.jobSummary}
                  {selected.visit.scheduledDate && ` · Visit ${new Date(selected.visit.scheduledDate).toLocaleDateString('en-GB')}`}
                </div>
                <button
                  onClick={() => navigate(`/buildings/${selected.job.buildingId}`)}
                  className="mt-1.5 cursor-pointer text-[11.5px] text-teal-700 hover:underline"
                >
                  Open building file
                </button>
              </div>
              <div className="flex flex-none items-center gap-1.5">
                <button
                  onClick={() => goToOffset(-1)}
                  disabled={queue.length < 2}
                  className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ‹ Prev
                </button>
                <button
                  onClick={() => goToOffset(1)}
                  disabled={queue.length < 2}
                  className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next report ›
                </button>
              </div>
            </div>

            <ReportPanel
              reportId={selected.visit.reportId!}
              reviewStatus={selected.visit.reportReviewStatus!}
              actor={actor}
              readyForAccounts={isVisitReadyForAccounts(selected.visit)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
