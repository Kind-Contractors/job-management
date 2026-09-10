import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { listJobRows } from '../repository/jobsRepository';
import type { JobRow } from '../domain/types';
import { buildGridBlocks, type GroupBy } from '../lib/grouping';
import { suggestDateInMonth } from '../lib/scheduleFormat';
import type { MonthCellState } from '../lib/monthMatrix';
import MonthMatrixGrid from '../components/matrix/MonthMatrixGrid';
import MonthMatrixLegend from '../components/matrix/MonthMatrixLegend';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';

function toISODate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Built directly from the year/month numbers, never via `new Date(...).toISOString()` — no timezone shift possible. */
function firstOfMonthISO(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export default function MonthMatrixPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [yearOffset, setYearOffset] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [forceShowBooking, setForceShowBooking] = useState(false);
  const [presetVisitDate, setPresetVisitDate] = useState<string | undefined>(undefined);

  const today = useMemo(() => new Date(), []);
  const todayISO = toISODate(today);
  const year = today.getFullYear() + yearOffset;

  const division = searchParams.get('division') ?? 'Both';
  const group: GroupBy = searchParams.get('group') === 'client' ? 'client' : 'frequency';

  const {
    data: allRows = [],
    isLoading,
    isError,
    error,
  } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const rows = useMemo(
    () => allRows.filter((j) => division === 'Both' || j.division === division),
    [allRows, division],
  );
  const blocks = useMemo(() => buildGridBlocks(rows, group), [rows, group]);

  const toggleGroup = () => {
    const params = new URLSearchParams(searchParams);
    if (group === 'frequency') params.set('group', 'client');
    else params.delete('group');
    setSearchParams(params, { replace: true });
  };

  const handleSelectCell = (job: JobRow, month: number, cell: MonthCellState) => {
    setSelectedJobId(job.id);
    if (cell.kind === 'due_no_date' && cell.visitCount === 0) {
      setForceShowBooking(true);
      // suggestDateInMonth only ever returns a real day for a literally-
      // monthly fixed_date/fixed_weekday schedule — every other case (in
      // particular due_month, which never stores a specific day) returns
      // null. That null used to fall through to JobInspectorDrawer's own
      // default of *today's real date*, so clicking e.g. a July due cell
      // while today happens to fall in April silently pre-filled April's
      // date. Falling back to the 1st of the CLICKED month instead keeps
      // the pre-fill inside the month actually clicked, without fabricating
      // a specific day this schedule never claimed to know.
      const suggested = job.schedule ? suggestDateInMonth(job.schedule, year, month) : null;
      setPresetVisitDate(suggested ?? firstOfMonthISO(year, month));
    } else {
      setForceShowBooking(false);
      setPresetVisitDate(undefined);
    }
  };

  const handleCloseDrawer = () => {
    setSelectedJobId(null);
    setForceShowBooking(false);
    setPresetVisitDate(undefined);
  };

  const handleSelectSibling = (jobId: string) => {
    setSelectedJobId(jobId);
    setForceShowBooking(false);
    setPresetVisitDate(undefined);
  };

  const selectedJob: JobRow | undefined = allRows.find((j) => j.id === selectedJobId);
  const siblings = selectedJob ? allRows.filter((j) => j.buildingId === selectedJob.buildingId && j.id !== selectedJob.id) : [];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-end gap-3.5 px-5 pt-4 pb-3">
          <div>
            <h1 className="font-heading text-[26px] leading-none font-semibold">Month matrix</h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-neutral-600 tabular-nums">
              <button onClick={() => setYearOffset((y) => y - 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                ‹
              </button>
              {year}
              <button onClick={() => setYearOffset((y) => y + 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                ›
              </button>
              {yearOffset !== 0 && (
                <button onClick={() => setYearOffset(0)} className="cursor-pointer text-teal-700 hover:underline">
                  This year
                </button>
              )}
            </div>
          </div>
          <button
            onClick={toggleGroup}
            className="ml-auto cursor-pointer border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
          >
            Group: {group === 'frequency' ? 'Frequency' : 'Client'} ⇄
          </button>
        </div>

        {isLoading ? (
          <div className="p-5">
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
              Loading month matrix…
            </div>
          </div>
        ) : isError ? (
          <div className="p-5">
            <div className="border border-missed bg-missed/10 p-4">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                Couldn't load the month matrix
              </div>
              <div className="mt-1.5 text-[13px] text-ink">
                {error instanceof Error ? error.message : 'Something went wrong.'}
              </div>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <div className="border border-t-0 border-neutral-300 bg-white px-5 py-10 text-center">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                No jobs match the current division filter
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto px-5 pb-5">
            <MonthMatrixLegend />
            <MonthMatrixGrid blocks={blocks} year={year} todayISO={todayISO} onSelectCell={handleSelectCell} />
          </div>
        )}
      </div>

      {selectedJob && (
        <JobInspectorDrawer
          // Keyed by job id AND the preset date — not just job id. Clicking
          // a different due-month cell for the SAME job changes
          // presetVisitDate without changing selectedJob.id, and
          // JobInspectorDrawer's visitDate state only reads its
          // (presetVisitDate ?? today) initializer once, at mount. Without
          // the preset date in the key, a second due-cell click for the
          // same job would leave the drawer showing the first cell's
          // stale date instead of the newly clicked month's.
          key={`${selectedJob.id}:${presetVisitDate ?? 'none'}`}
          job={selectedJob}
          siblings={siblings}
          onClose={handleCloseDrawer}
          onSelectSibling={handleSelectSibling}
          forceShowBooking={forceShowBooking}
          presetVisitDate={presetVisitDate}
        />
      )}
    </div>
  );
}
