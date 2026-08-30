import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { listJobRows } from '../repository/jobsRepository';
import type { JobRow, JobStatus } from '../domain/types';
import type { GroupBy } from '../lib/grouping';
import JobsGrid from '../components/jobs/JobsGrid';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';

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

export default function AllLiveJobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const {
    data: allRows = [],
    isLoading,
    isError,
    error,
  } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const status = (searchParams.get('status') as JobStatus | null) ?? null;
  const group: GroupBy = searchParams.get('group') === 'frequency' ? 'frequency' : 'client';
  const division = searchParams.get('division') ?? 'Both';
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();

  const rows = useMemo(() => {
    return allRows.filter((job) => {
      if (division !== 'Both' && job.division !== division) return false;
      if (status && job.status !== status) return false;
      if (!q) return true;
      const haystack = `${job.buildingName} ${job.jobSummary} ${job.clientName} ${job.postcode} ${job.frequency} ${job.team} ${job.schedulePattern} ${job.id}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [allRows, division, status, q]);

  const clearFilters = () => {
    const params = new URLSearchParams(searchParams);
    params.delete('status');
    params.delete('q');
    params.delete('division');
    setSearchParams(params, { replace: true });
  };

  const setStatus = (next: JobStatus | null) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('status', next);
    else params.delete('status');
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

  const title = status ? STATUS_CHIPS.find((c) => c.key === status)?.label : group === 'frequency' ? 'Jobs by frequency' : 'All live jobs';
  const clientCount = new Set(allRows.map((j) => j.clientId)).size;
  const buildingCount = new Set(allRows.map((j) => j.buildingId)).size;
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
          <div className="ml-auto flex gap-1.5">
            <div title="Not built yet" className="cursor-not-allowed border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-500">
              Columns
            </div>
            <div title="Not built yet" className="cursor-not-allowed border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-500">
              Export
            </div>
            <div title="Not built yet" className="cursor-not-allowed bg-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-500">
              + New job
            </div>
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
            <JobsGrid rows={rows} groupBy={group} selectedJobId={selectedJobId} onSelectJob={setSelectedJobId} />
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

      {selectedJob && (
        <JobInspectorDrawer
          key={selectedJob.id}
          job={selectedJob}
          siblings={siblings}
          onClose={() => setSelectedJobId(null)}
          onSelectSibling={setSelectedJobId}
        />
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
