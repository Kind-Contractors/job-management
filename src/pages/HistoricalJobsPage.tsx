import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { listHistoricalJobRows } from '../repository/jobsRepository';
import type { JobRow } from '../domain/types';
import { getHistoricalLifecycleStatusPresentation, getVisitStatusPresentation } from '../lib/statusPresentation';
import StatusPill from '../components/jobs/StatusPill';

type HistoricalLifecycle = 'completed' | 'lost' | 'cancelled';

const HISTORICAL_STATUS_CHIPS: { key: HistoricalLifecycle | null; label: string }[] = [
  { key: null, label: 'All historical' },
  { key: 'completed', label: 'Completed' },
  { key: 'lost', label: 'Lost' },
  { key: 'cancelled', label: 'Cancelled' },
];

function money(n: number | null): string {
  return n == null ? 'Variable' : `£${n.toLocaleString('en-GB')}`;
}

/** Narrows JobRow.lifecycleStatus to the three values this page ever deals with — listHistoricalJobRows() never returns 'active'/'on_hold', so the fallback branch is unreachable in practice, not a real case to design for. */
function asHistoricalLifecycle(status: JobRow['lifecycleStatus']): HistoricalLifecycle | null {
  return status === 'completed' || status === 'lost' || status === 'cancelled' ? status : null;
}

/**
 * A deliberately separate, self-contained read-only detail view — NOT
 * JobInspectorDrawer. That component (booking a visit, assigning a
 * technician, the schedule editor, JobEditor, and VisitRow's own per-visit
 * mutations) is built entirely around a job that's still live/operational;
 * safely stripping every mutation path out of it would mean threading a
 * read-only mode through it AND VisitRow.tsx AND ScheduleEditor.tsx AND
 * JobEditor.tsx — real, multi-file surgery on a component every other
 * active-job screen also depends on, for a phase explicitly scoped to
 * "read-only, do not touch active-job behavior." A small amount of
 * duplicated presentation here (header/facts layout) is the safer trade.
 */
function HistoricalJobDetail({ job, onClose }: { job: JobRow; onClose: () => void }) {
  const navigate = useNavigate();
  const lifecycle = asHistoricalLifecycle(job.lifecycleStatus);

  const facts: [string, string][] = [
    ['Client', job.clientName],
    ['Building', [job.buildingName, job.postcode].filter(Boolean).join(', ') || '—'],
    ['Frequency', job.frequencyRaw],
    ['Price per visit', job.pricePerVisit == null ? 'Variable' : `£${job.pricePerVisit.toLocaleString('en-GB')}.00`],
  ];

  const recontactFacts: [string, string][] = [];
  if (lifecycle === 'lost' && job.lostReason) recontactFacts.push(['Lost reason', job.lostReason]);
  if (job.recontactDueAt) recontactFacts.push(['Recontact due', new Date(job.recontactDueAt).toLocaleDateString('en-GB')]);
  if (job.recontactIntervalMonths != null) recontactFacts.push(['Recontact interval', `${job.recontactIntervalMonths} months`]);
  if (job.recontactNotes) recontactFacts.push(['Recontact notes', job.recontactNotes]);

  return (
    <>
    <div className="fixed inset-0 z-40 hidden bg-ink/30 lg:block" onClick={onClose} />
    <aside className="fixed inset-y-0 right-0 z-50 hidden w-[344px] flex-none flex-col overflow-y-auto border-l border-divider bg-white shadow-xl lg:flex">
      <div className="border-b border-divider p-4">
        <div className="flex items-center gap-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Historical job · {job.id}
          <button onClick={onClose} className="ml-auto cursor-pointer font-body text-sm text-neutral-500 hover:text-ink">
            ✕
          </button>
        </div>
        <h2 className="mt-1.5 font-heading text-xl leading-tight font-semibold">{job.jobSummary}</h2>
        <div className="text-[13px] text-neutral-600">
          {[job.buildingName, [job.street, job.postcode].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span
            className={`px-2 py-0.5 font-heading text-[10.5px] font-semibold tracking-[0.09em] uppercase ${
              job.division === 'Specialist'
                ? 'border border-teal-700 bg-teal-100 text-teal-700'
                : 'border border-neutral-300 bg-neutral-200 text-neutral-700'
            }`}
          >
            {job.division}
          </span>
          {lifecycle && (
            <span className="border border-neutral-300 px-2 py-0.5">
              <StatusPill presentation={getHistoricalLifecycleStatusPresentation(lifecycle)} />
            </span>
          )}
        </div>
      </div>

      <div className="px-4 pt-3.5">
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-divider py-1.5 text-[12.5px]">
            <span className="text-neutral-600">{k}</span>
            <span className="text-right">{v}</span>
          </div>
        ))}
      </div>

      {recontactFacts.length > 0 && (
        <div className="m-3.5 border border-neutral-300 bg-neutral-100 p-3">
          <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
            Recontact
          </div>
          <div className="flex flex-col gap-1.5">
            {recontactFacts.map(([k, v]) => (
              <div key={k} className="text-[12.5px]">
                <span className="text-neutral-500">{k}: </span>
                <span className="text-ink">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 pb-1">
        <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Visits ({job.visits.length})
        </div>
        {job.visits.length === 0 ? (
          <div className="pb-2 text-[12.5px] text-neutral-500">No visits were ever recorded for this job.</div>
        ) : (
          job.visits.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-2 border-b border-divider py-1.5 text-[12.5px]">
              <span className="text-ink">{v.scheduledDate ? new Date(v.scheduledDate).toLocaleDateString('en-GB') : 'No date'}</span>
              <span className="text-neutral-600">{v.technicianName ?? 'Unassigned'}</span>
              <StatusPill presentation={getVisitStatusPresentation(v.status)} />
            </div>
          ))
        )}
      </div>

      <div className="mt-auto flex flex-wrap gap-1.5 border-t border-divider p-3.5">
        <button
          onClick={() => navigate(`/buildings/${job.buildingId}`)}
          className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
        >
          Building file
        </button>
      </div>
    </aside>
    </>
  );
}

/**
 * Read-only. No lifecycle mutation, no booking, no scheduling, no
 * technician assignment exists anywhere on this page or its detail panel —
 * see HistoricalJobDetail's own doc comment for why it doesn't reuse
 * JobInspectorDrawer. listJobRows()/All Live Jobs/scheduling/Month
 * Matrix/Report Review/Ready for Accounts/Ready for Client/technician
 * screens are all untouched by this page — it reads exclusively from the
 * separate listHistoricalJobRows() sibling query.
 */
export default function HistoricalJobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const {
    data: allRows = [],
    isLoading,
    isError,
    error,
  } = useQuery({ queryKey: ['historicalJobRows'], queryFn: listHistoricalJobRows });

  const status = (searchParams.get('status') as HistoricalLifecycle | null) ?? null;
  const division = searchParams.get('division') ?? 'Both';
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();

  const rows = useMemo(() => {
    return allRows.filter((job) => {
      if (division !== 'Both' && job.division !== division) return false;
      if (status && job.lifecycleStatus !== status) return false;
      if (!q) return true;
      const haystack = `${job.buildingName} ${job.jobSummary} ${job.clientName} ${job.postcode} ${job.frequency} ${job.technician} ${job.schedulePattern} ${job.id}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [allRows, division, status, q]);

  const setStatus = (next: HistoricalLifecycle | null) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('status', next);
    else params.delete('status');
    setSearchParams(params, { replace: true });
  };

  const setQuery = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('q', next);
    else params.delete('q');
    setSearchParams(params, { replace: true });
  };

  const clearFilters = () => {
    const params = new URLSearchParams(searchParams);
    params.delete('status');
    params.delete('q');
    setSearchParams(params, { replace: true });
  };

  const selectedJob = allRows.find((j) => j.id === selectedJobId);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-end gap-3.5 px-5 pt-4 pb-3">
          <div>
            <h1 className="font-heading text-[26px] leading-none font-semibold">Historical jobs</h1>
            <div className="mt-1 text-xs text-neutral-600 tabular-nums">
              {rows.length} job{rows.length === 1 ? '' : 's'} shown — completed, lost, or cancelled work, retained for
              future recontact
            </div>
          </div>
          <div className="ml-auto">
            <input
              value={q}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search client, building, job…"
              className="w-64 border border-neutral-300 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-teal"
            />
          </div>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-1.5 px-5 pb-3">
          {HISTORICAL_STATUS_CHIPS.map((chip) => (
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
        </div>

        {isLoading ? (
          <div className="p-5">
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
              Loading historical jobs…
            </div>
          </div>
        ) : isError ? (
          <div className="p-5">
            <div className="border border-missed bg-missed/10 p-4">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                Couldn't load historical jobs
              </div>
              <div className="mt-1.5 text-[13px] text-ink">{error instanceof Error ? error.message : 'Something went wrong.'}</div>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                {allRows.length === 0 ? 'No historical jobs' : q ? `Nothing matches "${q}"` : 'No jobs match the current filters'}
              </div>
              <div className="mt-1.5 text-[13px] text-neutral-600">
                {allRows.length === 0
                  ? 'Jobs marked completed, lost, or cancelled will appear here once that workflow exists.'
                  : 'Try a different search or clear the filters below.'}
              </div>
              {allRows.length > 0 && (
                <button
                  onClick={clearFilters}
                  className="mt-3 cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5">
            <table className="w-full border border-neutral-300 bg-white text-left text-[13px]">
              <thead>
                <tr className="border-b border-neutral-300 bg-neutral-100 font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                  <th className="px-3 py-2">Building</th>
                  <th className="px-3 py-2">Client</th>
                  <th className="px-3 py-2">Job</th>
                  <th className="px-3 py-2">Frequency</th>
                  <th className="px-3 py-2">Price per visit</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Recontact due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((job) => {
                  const lifecycle = asHistoricalLifecycle(job.lifecycleStatus);
                  return (
                    <tr
                      key={job.id}
                      onClick={() => setSelectedJobId(job.id)}
                      className={`cursor-pointer border-b border-divider last:border-b-0 hover:bg-neutral-100 ${
                        selectedJobId === job.id ? 'bg-teal-100' : ''
                      }`}
                    >
                      <td className="px-3 py-2 font-semibold text-ink">
                        {job.buildingName}
                        {job.postcode && <span className="ml-1 font-normal text-neutral-500">· {job.postcode}</span>}
                      </td>
                      <td className="px-3 py-2 text-neutral-600">{job.clientName}</td>
                      <td className="px-3 py-2 text-neutral-600">{job.jobSummary}</td>
                      <td className="px-3 py-2 text-neutral-600">{job.frequencyRaw}</td>
                      <td className="px-3 py-2 text-neutral-600 tabular-nums">{money(job.pricePerVisit)}</td>
                      <td className="px-3 py-2">{lifecycle && <StatusPill presentation={getHistoricalLifecycleStatusPresentation(lifecycle)} />}</td>
                      <td className="px-3 py-2 text-neutral-600 tabular-nums">
                        {job.recontactDueAt ? new Date(job.recontactDueAt).toLocaleDateString('en-GB') : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedJob && <HistoricalJobDetail job={selectedJob} onClose={() => setSelectedJobId(null)} />}
    </div>
  );
}
