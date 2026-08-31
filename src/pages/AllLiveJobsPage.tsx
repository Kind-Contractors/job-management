import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { listJobRows } from '../repository/jobsRepository';
import type { JobRow, JobStatus } from '../domain/types';
import { buildGridBlocks, type GridBlock, type GroupBy } from '../lib/grouping';
import JobsGrid, { COLUMN_IDS, COLUMN_LABELS, type JobsGridColumnId } from '../components/jobs/JobsGrid';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';
import JobCreator from '../components/jobs/JobCreator';
import { getStatusPresentation, isVisitReadyForAccounts } from '../lib/statusPresentation';

// 'ask' is a mock-only JobStatus value that the real mapping path never
// produces (no ad-hoc-tracking data exists) — omitted here so this list only
// offers filters that can ever actually match a real job. 'review' IS real —
// see deriveVisitState in mapJobRow.ts.
const STATUS_CHIPS: { key: JobStatus | null; label: string }[] = [
  { key: null, label: 'All statuses' },
  { key: 'review', label: 'To review' },
  { key: 'needs_booking', label: 'Needs booking' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'missed', label: 'Missed' },
];

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Exports exactly the fields already shown in the grid, for exactly the
 * rows currently passed in (already filtered by division/status/search) —
 * variable pricing/unknown yearly value become empty cells, never a
 * fabricated number. Row order matches whatever's currently on screen: it
 * reuses buildGridBlocks (the same function JobsGrid renders from) rather
 * than re-deriving client/frequency ordering here, so the export can never
 * drift out of sync with the visible grouping.
 */
function buildJobsCsv(rows: JobRow[], groupBy: GroupBy): string {
  const orderedJobs = buildGridBlocks(rows, groupBy)
    .filter((b): b is Extract<GridBlock, { kind: 'row' }> => b.kind === 'row')
    .map((b) => b.job);
  const header = ['Job ID', 'Building', 'Postcode', 'Client', 'Job', 'Frequency', 'Price per visit', 'Per year', 'Next due', 'Status', 'Team'];
  const lines = orderedJobs.map((job) =>
    [
      job.id,
      job.buildingName,
      job.postcode,
      job.clientName,
      job.jobSummary,
      job.frequencyRaw,
      job.pricePerVisit == null ? '' : job.pricePerVisit.toFixed(2),
      job.yearlyValue == null ? '' : job.yearlyValue.toFixed(2),
      job.nextDueLabel,
      getStatusPresentation(job.status).label,
      job.team,
    ]
      .map((v) => csvCell(String(v)))
      .join(','),
  );
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function AllLiveJobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<Set<JobsGridColumnId>>(new Set());
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [creatingJob, setCreatingJob] = useState(false);

  const {
    data: allRows = [],
    isLoading,
    isError,
    error,
  } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const status = (searchParams.get('status') as JobStatus | null) ?? null;
  const readyForAccounts = searchParams.get('readyForAccounts') === '1';
  const group: GroupBy = searchParams.get('group') === 'frequency' ? 'frequency' : 'client';
  const division = searchParams.get('division') ?? 'Both';
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();

  const rows = useMemo(() => {
    return allRows.filter((job) => {
      if (division !== 'Both' && job.division !== division) return false;
      if (status && job.status !== status) return false;
      if (readyForAccounts && !job.visits.some(isVisitReadyForAccounts)) return false;
      if (!q) return true;
      const haystack = `${job.buildingName} ${job.jobSummary} ${job.clientName} ${job.postcode} ${job.frequency} ${job.team} ${job.schedulePattern} ${job.id}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [allRows, division, status, readyForAccounts, q]);

  const clearFilters = () => {
    const params = new URLSearchParams(searchParams);
    params.delete('status');
    params.delete('readyForAccounts');
    params.delete('q');
    params.delete('division');
    setSearchParams(params, { replace: true });
  };

  const setStatus = (next: JobStatus | null) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('status', next);
    else params.delete('status');
    params.delete('readyForAccounts');
    setSearchParams(params, { replace: true });
  };

  const toggleReadyForAccounts = () => {
    const params = new URLSearchParams(searchParams);
    if (readyForAccounts) params.delete('readyForAccounts');
    else params.set('readyForAccounts', '1');
    params.delete('status');
    setSearchParams(params, { replace: true });
  };

  const toggleGroup = () => {
    const params = new URLSearchParams(searchParams);
    if (group === 'client') params.set('group', 'frequency');
    else params.delete('group');
    setSearchParams(params, { replace: true });
  };

  const selectedJob: JobRow | undefined = allRows.find((j) => j.id === selectedJobId);
  const siblings = selectedJob ? allRows.filter((j) => j.buildingId === selectedJob.buildingId && j.id !== selectedJob.id) : [];

  const title = readyForAccounts
    ? 'Ready for accounts'
    : status
      ? STATUS_CHIPS.find((c) => c.key === status)?.label
      : group === 'frequency'
        ? 'Jobs by frequency'
        : 'All live jobs';
  const clientCount = new Set(rows.map((j) => j.clientId)).size;
  const buildingCount = new Set(rows.map((j) => j.buildingId)).size;
  const totalValue = rows.reduce((a, b) => a + (b.yearlyValue ?? 0), 0);
  const excludedCount = rows.filter((r) => r.yearlyValue === null).length;
  const excludedNote = excludedCount > 0 ? ` (${excludedCount} variable, excluded)` : '';

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-end gap-3.5 px-5 pt-4 pb-3">
          <div>
            <h1 className="font-heading text-[26px] leading-none font-semibold">{title}</h1>
            <div className="mt-1 text-xs text-neutral-600 tabular-nums">
              {clientCount} client{clientCount === 1 ? '' : 's'} · {buildingCount} building{buildingCount === 1 ? '' : 's'} ·{' '}
              {rows.length} job{rows.length === 1 ? '' : 's'} shown · {money(totalValue)} contracted per year
              {excludedNote}
            </div>
          </div>
          <div className="ml-auto flex items-start gap-1.5">
            <div className="relative">
              <button
                onClick={() => setColumnsMenuOpen((open) => !open)}
                className="cursor-pointer border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
              >
                Columns
              </button>
              {columnsMenuOpen && (
                <div className="absolute right-0 z-10 mt-1.5 w-48 border border-neutral-300 bg-white p-2 shadow-md">
                  {COLUMN_IDS.map((id) => (
                    <label key={id} className="flex items-center gap-2 py-1 text-[12.5px] text-ink">
                      <input
                        type="checkbox"
                        checked={!hiddenColumns.has(id)}
                        onChange={(e) => {
                          setHiddenColumns((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(id);
                            else next.add(id);
                            return next;
                          });
                        }}
                      />
                      {COLUMN_LABELS[id]}
                    </label>
                  ))}
                  <button
                    onClick={() => setHiddenColumns(new Set())}
                    className="mt-1.5 w-full cursor-pointer border border-neutral-300 py-1 text-[11.5px] text-neutral-600 hover:bg-neutral-100"
                  >
                    Reset
                  </button>
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={() => {
                  setExportError(null);
                  try {
                    const stamp = new Date().toISOString().slice(0, 10);
                    downloadCsv(buildJobsCsv(rows, group), `jobs-${stamp}.csv`);
                  } catch {
                    setExportError('Failed to export.');
                  }
                }}
                disabled={rows.length === 0}
                className="cursor-pointer border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400 disabled:hover:bg-transparent"
              >
                Export
              </button>
              {exportError && <div className="text-[11px] text-missed-fg">{exportError}</div>}
            </div>
            <button
              onClick={() => {
                setSelectedJobId(null);
                setCreatingJob(true);
              }}
              className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              + New job
            </button>
          </div>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-1.5 px-5 pb-3">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.label}
              onClick={() => setStatus(chip.key)}
              className={[
                'cursor-pointer border px-2.5 py-1 text-xs',
                status === chip.key ? 'border-teal bg-teal-100 text-teal-700' : 'border-neutral-300 text-neutral-700',
              ].join(' ')}
            >
              {chip.label}
            </button>
          ))}
          <button
            onClick={toggleReadyForAccounts}
            className={[
              'cursor-pointer border px-2.5 py-1 text-xs',
              readyForAccounts ? 'border-teal bg-teal-100 text-teal-700' : 'border-neutral-300 text-neutral-700',
            ].join(' ')}
          >
            Ready for accounts
          </button>
          <button onClick={toggleGroup} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700">
            Group: {group === 'client' ? 'Client' : 'Frequency'} ⇄
          </button>
          <span className="ml-auto text-[11.5px] text-neutral-600">Grouped by {group}</span>
        </div>

        {isLoading ? (
          <LoadingSkeleton />
        ) : isError ? (
          <ErrorState message={error instanceof Error ? error.message : 'Something went wrong loading jobs.'} />
        ) : rows.length === 0 ? (
          <NoResultsState allRowsEmpty={allRows.length === 0} query={q} onClearFilters={clearFilters} />
        ) : (
          <>
            <JobsGrid
              rows={rows}
              groupBy={group}
              selectedJobId={selectedJobId}
              onSelectJob={(jobId) => {
                setCreatingJob(false);
                setSelectedJobId(jobId);
              }}
              hiddenColumns={hiddenColumns}
            />
            <div className="flex h-[34px] flex-none items-center gap-4 border-t border-neutral-400 bg-neutral-200 px-5 text-xs text-neutral-700 tabular-nums">
              <span>Showing {rows.length} of {allRows.length} rows</span>
              <span>·</span>
              <span>Visible total {money(totalValue)}/yr{excludedNote}</span>
              <span className="ml-auto font-heading text-[10px] font-semibold tracking-[0.13em] uppercase">
                Yearly total is derived from price × frequency
              </span>
            </div>
          </>
        )}
      </div>

      {creatingJob ? (
        <JobCreator
          onCreated={(jobId) => {
            setCreatingJob(false);
            setSelectedJobId(jobId);
          }}
          onCancel={() => setCreatingJob(false)}
        />
      ) : (
        selectedJob && (
          <JobInspectorDrawer
            key={selectedJob.id}
            job={selectedJob}
            siblings={siblings}
            onClose={() => setSelectedJobId(null)}
            onSelectSibling={setSelectedJobId}
          />
        )
      )}
    </div>
  );
}

function NoResultsState({
  allRowsEmpty,
  query,
  onClearFilters,
}: {
  allRowsEmpty: boolean;
  query: string;
  onClearFilters: () => void;
}) {
  return (
    <div className="p-5">
      <div className="border border-t-0 border-neutral-300 bg-white px-5 py-10 text-center">
        <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
          {allRowsEmpty ? 'No jobs in the system yet' : query ? `Nothing matches "${query}"` : 'No jobs match the current filters'}
        </div>
        {!allRowsEmpty && (
          <>
            <div className="mt-1.5 text-[13px] text-neutral-600">Try a different search or clear the filters below.</div>
            <button
              onClick={onClearFilters}
              className="mt-3 cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            >
              Clear filters
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="p-5">
      <div className="border border-missed bg-missed/10 p-4">
        <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
          Couldn't load jobs
        </div>
        <div className="mt-1.5 text-[13px] text-ink">{message}</div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  const opacities = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44, 0.36, 0.3];
  return (
    <div className="p-5">
      <div className="grid gap-1.5">
        {opacities.map((o, i) => (
          <div key={i} className="h-[30px] animate-shimmer bg-neutral-300" style={{ opacity: o }} />
        ))}
      </div>
      <div className="mt-4.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
        Loading jobs…
      </div>
    </div>
  );
}
