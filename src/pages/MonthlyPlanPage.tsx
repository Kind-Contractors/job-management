// "These are all the jobs due in August" — the month Luke plans from, replacing the spreadsheet he copies due
// jobs into. A different question from the Month Matrix (a year of coverage) and from All Live Jobs (one status
// per job): this is one month's worklist.
//
// Everything here is DERIVED from the same cached `['jobRows']` query every other view uses, so a booking made
// here shows up on Schedule, the Month Matrix and the technician app immediately, and nothing needs generating,
// storing or regenerating. There is no plan to save: booking writes a real visit the moment it is pressed.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { listJobRows } from '../repository/jobsRepository';
import { listTechnicians } from '../repository/techniciansRepository';
import type { JobRow } from '../domain/types';
import { buildGridBlocks, type GroupBy } from '../lib/grouping';
import {
  buildMonthlyPlan,
  monthlyPlanCounts,
  parseMonthPrefix,
  shiftMonthPrefix,
  type MonthlyPlanEntry,
  type MonthlyPlanKind,
} from '../lib/monthlyPlan';
import MonthlyPlanRow from '../components/monthlyPlan/MonthlyPlanRow';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';
import JobCreator from '../components/jobs/JobCreator';

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthLabel(monthPrefix: string): string {
  const { year, month } = parseMonthPrefix(monthPrefix);
  return new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

const FILTERS: { key: MonthlyPlanKind | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'due_no_date', label: 'To book' },
  { key: 'carried_over', label: 'Overdue' },
  { key: 'booked', label: 'Booked' },
  { key: 'not_determinable', label: 'Can’t tell' },
];

export default function MonthlyPlanPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<MonthlyPlanKind | 'all'>('all');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [presetVisitDate, setPresetVisitDate] = useState<string | undefined>(undefined);
  const [creatingOneOff, setCreatingOneOff] = useState(false);

  const todayISO = useMemo(() => toISODate(new Date()), []);
  // Luke plans ahead, so this opens on NEXT month; the stepper goes back to this one.
  const defaultMonth = shiftMonthPrefix(todayISO.slice(0, 7), 1);
  const monthPrefix = searchParams.get('month') ?? defaultMonth;

  const division = searchParams.get('division') ?? 'Both';
  const group: GroupBy = searchParams.get('group') === 'frequency' ? 'frequency' : 'client';

  const { data: allRows = [], isLoading, isError, error } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });
  const { data: technicians = [] } = useQuery({ queryKey: ['technicians'], queryFn: listTechnicians });

  const rows = useMemo(() => allRows.filter((j) => division === 'Both' || j.division === division), [allRows, division]);
  const entries = useMemo(() => buildMonthlyPlan(rows, monthPrefix, todayISO), [rows, monthPrefix, todayISO]);
  const counts = useMemo(() => monthlyPlanCounts(entries), [entries]);

  const shown = useMemo(() => (filter === 'all' ? entries : entries.filter((e) => e.kind === filter)), [entries, filter]);
  const byJobId = useMemo(() => new Map<string, MonthlyPlanEntry>(shown.map((e) => [e.job.id, e])), [shown]);
  const blocks = useMemo(() => buildGridBlocks(shown.map((e) => e.job), group), [shown, group]);

  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value === null) params.delete(key);
    else params.set(key, value);
    setSearchParams(params, { replace: true });
  };

  const stepMonth = (delta: number) => setParam('month', shiftMonthPrefix(monthPrefix, delta));
  const openJob = (jobId: string, presetDate?: string) => {
    setSelectedJobId(jobId);
    setPresetVisitDate(presetDate);
  };

  const selectedJob: JobRow | undefined = allRows.find((j) => j.id === selectedJobId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-divider px-5 py-3">
        <div>
          <h1 className="font-heading text-lg font-semibold">Monthly plan</h1>
          <div className="mt-0.5 text-xs text-neutral-600 tabular-nums">
            {counts.due_no_date + counts.carried_over} to book · {counts.booked} booked
            {counts.not_determinable > 0 && ` · ${counts.not_determinable} can’t tell`}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => stepMonth(-1)} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100">
            ‹
          </button>
          <span className="min-w-[130px] text-center font-heading text-[12.5px] font-semibold tabular-nums">{monthLabel(monthPrefix)}</span>
          <button onClick={() => stepMonth(1)} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100">
            ›
          </button>
          <button onClick={() => setParam('month', null)} className="ml-1 cursor-pointer text-[11.5px] text-teal-700 hover:underline">
            Next month
          </button>
        </div>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-divider px-5 py-2">
        {FILTERS.map((f) => {
          const n = f.key === 'all' ? entries.length : counts[f.key];
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`cursor-pointer border px-2 py-0.5 text-[11px] ${filter === f.key ? 'border-teal bg-teal text-white' : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100'}`}
            >
              {f.label} ({n})
            </button>
          );
        })}
        <button
          onClick={() => setParam('group', group === 'client' ? 'frequency' : null)}
          className="ml-auto cursor-pointer border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-100"
        >
          Group: {group === 'client' ? 'Client' : 'Frequency'}
        </button>
        <button onClick={() => setCreatingOneOff(true)} className="cursor-pointer border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-100">
          + Add a one-off job
        </button>
      </div>

      {/* A one-off job is just a job with no schedule: the existing JobCreator writes no `schedules` row, so
          nothing recurring is created. Once made, it is booked from its own row like anything else. */}
      {creatingOneOff && (
        <div className="flex-none border-b border-divider bg-neutral-100 px-5 py-3">
          <div className="mb-2 text-[11.5px] text-neutral-600">
            A one-off job has no schedule, so it never becomes due by itself — it appears here once you book it.
          </div>
          <JobCreator
            defaultFrequencyType="one_off"
            onCreated={(jobId) => {
              setCreatingOneOff(false);
              openJob(jobId, `${monthPrefix}-01`);
            }}
            onCancel={() => setCreatingOneOff(false)}
          />
        </div>
      )}

      {isLoading ? (
        <div className="p-5 font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
      ) : isError ? (
        <div className="p-5">
          <div className="border border-missed bg-missed/10 p-3">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">Couldn’t load the plan</div>
            <div className="mt-1.5 text-[12.5px] text-ink">{error instanceof Error ? error.message : 'Something went wrong.'}</div>
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div className="p-5 text-[12.5px] text-neutral-600" data-testid="monthly-plan-empty">
          {entries.length === 0
            ? `Nothing is due in ${monthLabel(monthPrefix)}.`
            : `Nothing matches this filter for ${monthLabel(monthPrefix)}.`}
        </div>
      ) : (
        <div className="min-h-0 flex-1" data-testid="monthly-plan">
          {blocks.map((block) =>
            block.kind === 'band' ? (
              <div key={block.id} className="flex flex-wrap items-baseline gap-2 border-b border-divider bg-neutral-100 px-3 py-1.5">
                <span className="font-heading text-[10.5px] font-semibold tracking-[0.1em] text-neutral-700 uppercase">{block.title}</span>
                {block.subtitle && <span className="text-[11px] text-neutral-500">{block.subtitle}</span>}
                <span className="ml-auto text-[11px] text-neutral-500 tabular-nums">{block.rightLabel}</span>
              </div>
            ) : (
              byJobId.has(block.job.id) && (
                <MonthlyPlanRow
                  key={block.job.id}
                  entry={byJobId.get(block.job.id)!}
                  technicians={technicians}
                  monthPrefix={monthPrefix}
                  onOpenJob={openJob}
                />
              )
            ),
          )}
        </div>
      )}

      {selectedJob && (
        <JobInspectorDrawer
          // Keyed by job AND preset date: the drawer reads its date initializer once at mount, so opening a
          // different month for the same job must remount it (same reasoning as MonthMatrixPage).
          key={`${selectedJob.id}:${presetVisitDate ?? 'none'}`}
          job={selectedJob}
          siblings={allRows.filter((j) => j.buildingId === selectedJob.buildingId)}
          onSelectSibling={(jobId) => openJob(jobId)}
          forceShowBooking={presetVisitDate != null}
          presetVisitDate={presetVisitDate}
          onClose={() => {
            setSelectedJobId(null);
            setPresetVisitDate(undefined);
          }}
        />
      )}
    </div>
  );
}
