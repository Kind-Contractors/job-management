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
import { buildGridBlocks, collapseBlocks, type GroupBy } from '../lib/grouping';
import {
  buildMonthlyPlan,
  monthlyPlanCounts,
  needsScheduleCount,
  parseMonthPrefix,
  shiftMonthPrefix,
  type MonthlyPlanEntry,
  type MonthlyPlanKind,
} from '../lib/monthlyPlan';
import MonthlyPlanRow, { MONTHLY_PLAN_COLUMNS } from '../components/monthlyPlan/MonthlyPlanRow';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';
import JobCreator from '../components/jobs/JobCreator';
import BandToggle from '../components/shared/BandToggle';
import SetScheduleDialog from '../components/monthlyPlan/SetScheduleDialog';

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
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

const NO_COLLAPSED_BANDS: ReadonlySet<string> = new Set();

export default function MonthlyPlanPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [presetVisitDate, setPresetVisitDate] = useState<string | undefined>(undefined);
  const [creatingOneOff, setCreatingOneOff] = useState(false);
  // Collapsed band ids — a view state only; every entry is still derived, counted and totalled.
  const [collapsedBands, setCollapsedBands] = useState<ReadonlySet<string>>(NO_COLLAPSED_BANDS);
  /** The job whose schedule is being set in the focused modal, or null. */
  const [schedulingJobId, setSchedulingJobId] = useState<string | null>(null);

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
  // Planned value is the same derivation All Live Jobs uses: price x frequency, with variable-priced jobs
  // counted as excluded rather than guessed at (CLAUDE.md section 14.2).
  const planned = useMemo(() => {
    const jobs = entries.map((e) => e.job);
    return {
      value: jobs.reduce((a, j) => a + (j.yearlyValue ?? 0), 0),
      variable: jobs.filter((j) => j.yearlyValue === null).length,
      clients: new Set(jobs.map((j) => j.clientId)).size,
    };
  }, [entries]);

  const shown = useMemo(() => {
    const match = FILTERS.find((f) => f.key === filter)?.match ?? (() => true);
    return entries.filter(match);
  }, [entries, filter]);
  const byJobId = useMemo(() => new Map<string, MonthlyPlanEntry>(shown.map((e) => [e.job.id, e])), [shown]);
  const blocks = useMemo(
    () => collapseBlocks(buildGridBlocks(shown.map((e) => e.job), group), collapsedBands),
    [shown, group, collapsedBands],
  );
  const toggleBand = (bandId: string) =>
    setCollapsedBands((prev) => {
      const next = new Set(prev);
      if (!next.delete(bandId)) next.add(bandId);
      return next;
    });

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
  // Read from allRows, not from the entry that opened it, so the modal shows the job as it stands right now.
  const schedulingJob: JobRow | undefined = allRows.find((j) => j.id === schedulingJobId);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-end gap-3.5 px-5 pt-4 pb-3">
          <div>
            <h1 className="font-heading text-[26px] leading-none font-semibold">Monthly plan</h1>
            {/* The month stepper sits under the title, the way Month Matrix's year stepper does: a period
                switcher belongs to what the heading names, not among the page's actions. It is drawn as a real
                control - bordered buttons either side of a 17px label - because which month you are planning is
                the single most important fact on this screen, and as plain ‹ › glyphs it read as decoration. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <div className="flex items-stretch border border-neutral-300 bg-white">
                <button
                  onClick={() => stepMonth(-1)}
                  aria-label="Previous month"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center border-r border-neutral-300 text-[15px] leading-none text-ink hover:bg-neutral-100"
                >
                  ‹
                </button>
                <span className="flex min-w-[158px] items-center justify-center px-3 font-heading text-[17px] leading-none font-semibold text-ink tabular-nums">
                  {monthLabel(monthPrefix)}
                </span>
                <button
                  onClick={() => stepMonth(1)}
                  aria-label="Next month"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center border-l border-neutral-300 text-[15px] leading-none text-ink hover:bg-neutral-100"
                >
                  ›
                </button>
              </div>
              {monthPrefix !== defaultMonth && (
                <button onClick={() => setParam('month', null)} className="cursor-pointer text-xs text-teal-700 hover:underline">
                  Back to next month
                </button>
              )}
              <span className="text-xs text-neutral-600 tabular-nums">
                {counts.due_no_date + counts.carried_over} to book · {counts.booked} booked
                {counts.not_determinable > 0 && ` · ${counts.not_determinable} can’t tell`}
                {needsSchedule > 0 && ` · ${needsSchedule} need a schedule`}
              </span>
            </div>
          </div>
          <div className="ml-auto flex items-start gap-1.5">
            <button
              onClick={() => {
                // The old band ids mean nothing under the other grouping, so the collapse state goes with them
                // rather than silently hiding rows under bands the manager never shut.
                setCollapsedBands(NO_COLLAPSED_BANDS);
                setParam('group', group === 'client' ? 'frequency' : null);
              }}
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

        {/* Four facts about the month, in the house language: square, hairline, tabular figures. Only the two
            that mean WORK take a functional colour; the rest stay neutral (CLAUDE.md section 4). */}
        <div className="grid flex-none grid-cols-2 gap-px border-y border-neutral-300 bg-neutral-300 px-0 lg:grid-cols-4" data-testid="monthly-plan-summary">
          <SummaryTile label="To book" value={String(counts.due_no_date + counts.carried_over)} note="jobs this month" valueClass="text-due-fg" />
          <SummaryTile label="Booked" value={String(counts.booked)} note={`of ${counts.booked + counts.due_no_date + counts.carried_over} due`} valueClass="text-teal-700" />
          <SummaryTile label="Need a schedule" value={String(needsSchedule)} note="won’t come due" valueClass="text-ink" />
          <SummaryTile
            label="Planned value"
            value={money(planned.value)}
            note={`per year · ${planned.clients} client${planned.clients === 1 ? '' : 's'}${planned.variable > 0 ? ` · ${planned.variable} variable, excluded` : ''}`}
            valueClass="text-ink"
          />
        </div>

        <div className="flex flex-none flex-wrap items-center gap-1.5 px-5 pt-3 pb-3">
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
            {/* Said ONCE here instead of on every affected row: six jobs each repeating the same paragraph was
                what made this page read as loose strips. The row keeps a short version in its own columns. */}
            {needsSchedule > 0 && filter !== 'needs_schedule' && (
              <div
                className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border border-due bg-due/10 px-3 py-2 text-[12px] text-due-fg"
                data-testid="needs-schedule-banner"
              >
                <span>
                  <strong className="font-semibold">
                    {needsSchedule} job{needsSchedule === 1 ? ' is' : 's are'} priced but ha{needsSchedule === 1 ? 's' : 've'} no schedule,
                  </strong>{' '}
                  so {needsSchedule === 1 ? 'it' : 'they'} never come due. Set one to start planning {needsSchedule === 1 ? 'it' : 'them'}.
                </span>
                <button
                  onClick={() => setFilter('needs_schedule')}
                  className="ml-auto cursor-pointer border border-due px-2 py-0.5 text-[11.5px] font-semibold text-due-fg hover:bg-due/10"
                >
                  Review {needsSchedule}
                </button>
              </div>
            )}
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
              <div
                className={`grid ${MONTHLY_PLAN_COLUMNS} gap-4 border-b border-neutral-300 bg-neutral-200 px-3 py-2 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase`}
              >
                <span>Job</span>
                <span>Repeats</span>
                <span>Status</span>
                <span>Date</span>
                <span>Technician</span>
                <span className="text-right">Action</span>
              </div>
              {blocks.map((block) =>
                block.kind === 'band' ? (
                  // The whole band toggles, so the hit target is the row rather than a 12px glyph; the caret is
                  // still a real button carrying aria-expanded and a spoken label.
                  <div
                    key={block.id}
                    onClick={() => toggleBand(block.id)}
                    data-testid="monthly-plan-band"
                    className="flex cursor-pointer items-center gap-2.5 border-b border-neutral-300 bg-neutral-200 px-3 py-1.5 hover:bg-neutral-300/70"
                  >
                    <BandToggle collapsed={block.collapsed === true} title={block.title} onToggle={() => toggleBand(block.id)} />
                    <span className="font-heading text-[12.5px] font-semibold tracking-[0.11em] uppercase">{block.title}</span>
                    {block.subtitle && <span className="text-[11.5px] text-neutral-600">{block.subtitle}</span>}
                    {block.collapsed && (
                      <span className="text-[11.5px] text-neutral-500 tabular-nums">
                        {block.rowCount} job{block.rowCount === 1 ? '' : 's'} hidden
                      </span>
                    )}
                    <span className="ml-auto text-[11.5px] text-neutral-700 tabular-nums">{block.rightLabel}</span>
                  </div>
                ) : (
                  byJobId.has(block.job.id) && (
                    <MonthlyPlanRow
                      // Keyed by job AND the date its schedule now suggests: the row seeds its date field once,
                      // at mount, so after a schedule is set (or changed) the newly derived suggestion would
                      // otherwise never reach the field and the row would read "To book" with an empty date.
                      // A date the manager typed is unaffected - the suggestion only moves when the schedule does.
                      key={`${block.job.id}:${byJobId.get(block.job.id)!.suggestedDate ?? 'none'}`}
                      entry={byJobId.get(block.job.id)!}
                      technicians={technicians}
                      onOpenJob={openJob}
                      onSetSchedule={setSchedulingJobId}
                    />
                  )
                ),
              )}
            </div>
          </div>
        )}
      </div>

      {/* Set-a-schedule is a MODAL, not the drawer: the manager is planning a month, and the one thing in the way
          is this job's missing schedule. It writes only that schedule, then closes and the plan re-derives. */}
      {schedulingJob && <SetScheduleDialog job={schedulingJob} onClose={() => setSchedulingJobId(null)} />}

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

function SummaryTile({ label, value, note, valueClass }: { label: string; value: string; note: string; valueClass: string }) {
  return (
    <div className="bg-white px-4 py-2.5">
      <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">{label}</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <span className={`font-heading text-[22px] leading-none font-semibold tabular-nums ${valueClass}`}>{value}</span>
        <span className="text-[11.5px] text-neutral-600">{note}</span>
      </div>
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
