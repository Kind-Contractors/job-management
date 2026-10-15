// "These are all the jobs due in August" — the month Luke plans from, replacing the spreadsheet he copies due
// jobs into. A different question from the Month Matrix (a year of coverage) and from All Live Jobs (one status
// per job): this is one month's worklist.
//
// Everything here is DERIVED from the same cached `['jobRows']` query every other view uses, so a booking made
// here shows up on Schedule, the Month Matrix and the technician app immediately, and nothing needs generating,
// storing or regenerating. There is no plan to save: booking writes a real visit the moment it is pressed.
//
// LAYOUT follows the other operational screens exactly (All Live Jobs, Buildings, Month Matrix): a flex row whose
// first child is the page column and whose second is the single right-hand drawer slot; a 26px heading with its
// period switcher and live counts beneath it; filter chips on their own row; then one bordered white list.
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
  needsScheduleCount,
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

/**
 * `match` rather than a bare kind because "Needs a schedule" is a property of the JOB, not of this month: a
 * recurring job with no schedule is worth finding even in a month where it happens to be booked.
 */
type FilterKey = MonthlyPlanKind | 'all' | 'needs_schedule';
const FILTERS: { key: FilterKey; label: string; match: (e: MonthlyPlanEntry) => boolean }[] = [
  { key: 'all', label: 'Everything', match: () => true },
  { key: 'due_no_date', label: 'To book', match: (e) => e.kind === 'due_no_date' },
  { key: 'carried_over', label: 'Overdue', match: (e) => e.kind === 'carried_over' },
  { key: 'booked', label: 'Booked', match: (e) => e.kind === 'booked' },
  { key: 'not_determinable', label: 'Can’t tell', match: (e) => e.kind === 'not_determinable' },
  { key: 'needs_schedule', label: 'Needs a schedule', match: (e) => e.needsSchedule },
];

export default function MonthlyPlanPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>('all');
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
  const needsSchedule = useMemo(() => needsScheduleCount(entries), [entries]);

  const shown = useMemo(() => {
    const match = FILTERS.find((f) => f.key === filter)?.match ?? (() => true);
    return entries.filter(match);
  }, [entries, filter]);
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
    setCreatingOneOff(false);
    setSelectedJobId(jobId);
    setPresetVisitDate(presetDate);
  };

  const selectedJob: JobRow | undefined = allRows.find((j) => j.id === selectedJobId);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-end gap-3.5 px-5 pt-4 pb-3">
          <div>
            <h1 className="font-heading text-[26px] leading-none font-semibold">Monthly plan</h1>
            {/* The month stepper sits under the title, the way Month Matrix's year stepper does: a period
                switcher belongs to what the heading names, not among the page's actions. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-600 tabular-nums">
              <span className="flex items-center gap-1">
                <button onClick={() => stepMonth(-1)} aria-label="Previous month" className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                  ‹
                </button>
                <span className="font-semibold text-ink">{monthLabel(monthPrefix)}</span>
                <button onClick={() => stepMonth(1)} aria-label="Next month" className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                  ›
                </button>
              </span>
              <span className="text-neutral-400">·</span>
              <span>
                {counts.due_no_date + counts.carried_over} to book · {counts.booked} booked
                {counts.not_determinable > 0 && ` · ${counts.not_determinable} can’t tell`}
                {needsSchedule > 0 && ` · ${needsSchedule} need a schedule`}
              </span>
              {monthPrefix !== defaultMonth && (
                <button onClick={() => setParam('month', null)} className="cursor-pointer text-teal-700 hover:underline">
                  Next month
                </button>
              )}
            </div>
          </div>
          <div className="ml-auto flex items-start gap-1.5">
            <button
              onClick={() => setParam('group', group === 'client' ? 'frequency' : null)}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            >
              Group: {group === 'client' ? 'Client' : 'Frequency'} ⇄
            </button>
            <button
              onClick={() => {
                setSelectedJobId(null);
                setPresetVisitDate(undefined);
                setCreatingOneOff(true);
              }}
              className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              + One-off job
            </button>
          </div>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-1.5 px-5 pb-3">
          {FILTERS.map((f) => {
            const n = f.key === 'all' ? entries.length : f.key === 'needs_schedule' ? needsSchedule : counts[f.key];
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={[
                  'cursor-pointer border px-2.5 py-1 text-xs',
                  filter === f.key ? 'border-teal bg-teal-100 text-teal-700' : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100',
                ].join(' ')}
              >
                {f.label} ({n})
              </button>
            );
          })}
        </div>

        {isLoading ? (
          <LoadingSkeleton month={monthLabel(monthPrefix)} />
        ) : isError ? (
          <ErrorState message={error instanceof Error ? error.message : 'Something went wrong.'} />
        ) : shown.length === 0 ? (
          <div className="p-5">
            <div className="border border-neutral-300 bg-white px-5 py-10 text-center" data-testid="monthly-plan-empty">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                {entries.length === 0
                  ? `Nothing is due in ${monthLabel(monthPrefix)}`
                  : `Nothing matches this filter for ${monthLabel(monthPrefix)}`}
              </div>
              {entries.length > 0 && (
                <button onClick={() => setFilter('all')} className="mt-1.5 cursor-pointer text-[13px] text-teal-700 hover:underline">
                  Show everything
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
            {creatingOneOff && (
              <div className="mb-3 text-[11.5px] text-neutral-600">
                A one-off job has no schedule, so it never becomes due by itself — it appears here once you book it.
              </div>
            )}
            {/* One bordered white surface, like every other list on the site: the band rows and job rows supply
                their own separators so the whole thing reads as a single table rather than loose strips. */}
            <div className="border border-neutral-300 bg-white" data-testid="monthly-plan">
              {/* The same column header the Month Matrix grid has — without one a grouped list reads as loose
                  strips rather than a table. */}
              <div className="flex items-center border-b border-neutral-300 bg-neutral-200 px-3 py-2 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
                <span>Job</span>
                <span className="ml-auto">When</span>
              </div>
              {blocks.map((block) =>
                block.kind === 'band' ? (
                  <div
                    key={block.id}
                    className="flex items-center gap-2.5 border-b border-neutral-300 bg-neutral-200 px-3 py-1.5"
                  >
                    <span className="font-heading text-[12.5px] font-semibold tracking-[0.11em] uppercase">▾ {block.title}</span>
                    {block.subtitle && <span className="text-[11.5px] text-neutral-600">{block.subtitle}</span>}
                    <span className="ml-auto text-[11.5px] text-neutral-700 tabular-nums">{block.rightLabel}</span>
                  </div>
                ) : (
                  byJobId.has(block.job.id) && (
                    <MonthlyPlanRow
                      key={block.job.id}
                      entry={byJobId.get(block.job.id)!}
                      technicians={technicians}
                      onOpenJob={openJob}
                    />
                  )
                ),
              )}
            </div>
          </div>
        )}
      </div>

      {/* The one-off creator and the job inspector share the single right-hand drawer slot every other page
          uses, so only one is ever open and neither squeezes the list out of shape. */}
      {creatingOneOff ? (
        <JobCreator
          defaultFrequencyType="one_off"
          onCreated={(jobId) => {
            // Opens the booking form with NO date: a one-off job has no schedule, so there is no day to
            // suggest and the 1st would be as invented as any other. The manager picks it.
            openJob(jobId, '');
          }}
          onCancel={() => setCreatingOneOff(false)}
        />
      ) : (
        selectedJob && (
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
        )
      )}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="p-5">
      <div className="border border-missed bg-missed/10 p-4">
        <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
          Couldn’t load the monthly plan
        </div>
        <div className="mt-1.5 text-[13px] text-ink">{message}</div>
      </div>
    </div>
  );
}

function LoadingSkeleton({ month }: { month: string }) {
  const opacities = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44, 0.36, 0.3];
  return (
    <div className="p-5">
      <div className="grid gap-1.5">
        {opacities.map((o, i) => (
          <div key={i} className="h-[30px] animate-shimmer bg-neutral-300" style={{ opacity: o }} />
        ))}
      </div>
      <div className="mt-4.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
        Loading {month}…
      </div>
    </div>
  );
}
