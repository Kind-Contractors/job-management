import { Fragment, useMemo, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { createTeam, createVisit, listTeams, listVisitsForRange, setTeamActive } from '../repository/teamsRepository';
import { listJobRows } from '../repository/jobsRepository';
import type { JobRow, WeekVisit } from '../domain/types';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';
import MonthGrid, { type MonthGridDay } from '../components/calendar/MonthGrid';

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const DAY_NUM = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const RANGE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

/**
 * The drag-source panel's two groups — deliberately distinct labels, never
 * "due", since 'unscheduled' carries no stored evidence of when (or whether)
 * a job is actually due, only that nothing has ever been booked for it. See
 * the Calendar plan's §3.3 for the full rationale.
 */
const DUE_GROUPS: { key: 'overdue' | 'unscheduled'; label: string; emptyLabel: string }[] = [
  { key: 'overdue', label: 'Overdue', emptyLabel: 'Nothing overdue' },
  { key: 'unscheduled', label: 'Needs booking', emptyLabel: 'Nothing waiting' },
];

const VISIT_STATUS_STYLE: Record<WeekVisit['status'], string> = {
  due: 'border-neutral-400 bg-neutral-200 text-neutral-700',
  booked: 'border-teal bg-teal-100 text-teal-700',
  completed: 'border-teal-700 bg-teal-700 text-white',
  missed: 'border-missed bg-missed/10 text-missed-fg',
  cancelled: 'border-neutral-300 bg-neutral-100 text-neutral-400 line-through',
};

/** Formats a Date's own LOCAL calendar day — never `.toISOString()` here, which converts to UTC and would shift the date in any timezone ahead of UTC (see scheduleFormat.ts's toISODate for the same fix, applied twice already this project). */
function toISODate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Earliest overdue scheduled_date for this job, or '' if none — used only to
 * sort the "Overdue" drag panel (most-overdue-first). Distinct from
 * mapJobRow.ts's own overdue selection (which picks the most *recent*
 * overdue date to display as nextDueLabel) — this picks the oldest, because
 * sorting and labeling are different concerns.
 */
function earliestOverdueDate(job: JobRow, todayISO: string): string {
  const dates = job.visits
    .filter((v) => v.scheduledDate != null && v.scheduledDate < todayISO && (v.status === 'due' || v.status === 'booked'))
    .map((v) => v.scheduledDate!)
    .sort();
  return dates[0] ?? '';
}

/**
 * A real calendar month's days, Monday-start, padded to complete weeks —
 * pure calendar arithmetic against `monthOffset`, exactly analogous to
 * workWeek()'s `weekOffset`. Leading/trailing days from the adjacent month
 * are real, valid dates (rendered muted, still a valid drop target) —
 * never a claim that they belong to the displayed month.
 */
function monthGridDays(monthOffset: number): MonthGridDay[] {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = first.getFullYear();
  const month = first.getMonth();
  const lastOfMonth = new Date(year, month + 1, 0);

  const leadingCount = (first.getDay() + 6) % 7; // days back to the preceding Monday
  const trailingCount = (7 - ((lastOfMonth.getDay() + 6) % 7) - 1 + 7) % 7; // days forward to the following Sunday

  const gridStart = new Date(year, month, 1 - leadingCount);
  const totalDays = leadingCount + lastOfMonth.getDate() + trailingCount;

  return Array.from({ length: totalDays }, (_, i) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    return { date, dateISO: toISODate(date), inMonth: date.getMonth() === month };
  });
}

/** Monday–Saturday of the week `weekOffset` weeks from the current real week — the design's "6 working days". Never derived from job frequency. */
function workWeek(weekOffset: number): Date[] {
  const today = new Date();
  const day = today.getDay(); // 0=Sun..6=Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset + weekOffset * 7);
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

export default function ThisWeekPage() {
  const [mode, setMode] = useState<'week' | 'month' | 'day'>('week');
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [dayOffset, setDayOffset] = useState(0);
  const [newTeamName, setNewTeamName] = useState('');
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ jobId: string; date: string } | null>(null);
  const [pendingTeamId, setPendingTeamId] = useState('');
  const [searchParams] = useSearchParams();

  const queryClient = useQueryClient();
  const days = useMemo(() => workWeek(weekOffset), [weekOffset]);
  const startDate = toISODate(days[0]);
  const endDate = toISODate(days[days.length - 1]);
  const monthDays = useMemo(() => monthGridDays(monthOffset), [monthOffset]);
  const monthStartDate = monthDays[0].dateISO;
  const monthEndDate = monthDays[monthDays.length - 1].dateISO;
  const monthAnchorDate = useMemo(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  }, [monthOffset]);
  const dayViewDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [dayOffset]);
  const dayISO = toISODate(dayViewDate);
  const displayDays = mode === 'day' ? [dayViewDate] : days;
  const rangeStartDate = mode === 'month' ? monthStartDate : mode === 'day' ? dayISO : startDate;
  const rangeEndDate = mode === 'month' ? monthEndDate : mode === 'day' ? dayISO : endDate;
  const todayISO = toISODate(new Date());
  const division = searchParams.get('division') ?? 'Both';

  const {
    data: teams = [],
    isLoading: teamsLoading,
    isError: teamsError,
    error: teamsErrorObj,
  } = useQuery({ queryKey: ['teams'], queryFn: listTeams });
  const {
    data: visits = [],
    isLoading: visitsLoading,
    isError: visitsError,
    error: visitsErrorObj,
  } = useQuery({
    queryKey: ['visits', rangeStartDate, rangeEndDate],
    queryFn: () => listVisitsForRange(rangeStartDate, rangeEndDate),
  });
  const {
    data: jobRows = [],
    isLoading: jobRowsLoading,
    isError: jobRowsError,
    error: jobRowsErrorObj,
  } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const createTeamMutation = useMutation({
    mutationFn: (name: string) => createTeam(name),
    onSuccess: () => {
      setNewTeamName('');
      queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => setTeamActive(id, isActive),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams'] }),
  });

  const bookMutation = useMutation({
    mutationFn: ({ jobId, teamId, date }: { jobId: string; teamId: string; date: string }) =>
      createVisit(jobId, teamId, date),
    onSuccess: () => {
      setBookingError(null);
      setPendingDrop(null);
      setPendingTeamId('');
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
    },
    onError: (err) => setBookingError(err instanceof Error ? err.message : 'Failed to book visit.'),
  });

  const activeTeams = useMemo(() => teams.filter((t) => t.isActive), [teams]);

  const handleDropJob = (jobId: string, date: string) => {
    setBookingError(null);
    setPendingTeamId('');
    setPendingDrop({ jobId, date });
  };

  const handleConfirmBooking = () => {
    if (!pendingDrop || !pendingTeamId) return;
    bookMutation.mutate({ jobId: pendingDrop.jobId, teamId: pendingTeamId, date: pendingDrop.date });
  };

  const handleCancelBooking = () => {
    setPendingDrop(null);
    setPendingTeamId('');
  };

  const jobById = useMemo(() => new Map(jobRows.map((j) => [j.id, j])), [jobRows]);

  const divisionFilteredJobs = useMemo(
    () => jobRows.filter((j) => division === 'Both' || j.division === division),
    [jobRows, division],
  );
  const overdueJobs = useMemo(
    () =>
      divisionFilteredJobs
        .filter((j) => j.status === 'overdue')
        .sort((a, b) => earliestOverdueDate(a, todayISO).localeCompare(earliestOverdueDate(b, todayISO))),
    [divisionFilteredJobs, todayISO],
  );
  const needsBookingJobs = useMemo(
    () =>
      divisionFilteredJobs
        .filter((j) => j.status === 'unscheduled')
        .sort((a, b) => a.buildingName.localeCompare(b.buildingName)),
    [divisionFilteredJobs],
  );

  const handleDrop = (teamId: string, dateISO: string) => (e: DragEvent) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData('text/plain');
    if (!jobId) return;
    bookMutation.mutate({ jobId, teamId, date: dateISO });
  };

  const isLoading = teamsLoading || visitsLoading || jobRowsLoading;
  const isError = teamsError || visitsError || jobRowsError;
  const errorObj = teamsError ? teamsErrorObj : visitsError ? visitsErrorObj : jobRowsErrorObj;

  const selectedJob: JobRow | undefined = jobRows.find((j) => j.id === selectedJobId);
  const siblings = selectedJob ? jobRows.filter((j) => j.buildingId === selectedJob.buildingId && j.id !== selectedJob.id) : [];

  return (
    <div className="flex min-h-0 flex-1">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none items-end gap-3.5 px-5 pt-4 pb-3">
        <div>
          <h1 className="font-heading text-[26px] leading-none font-semibold">Schedule</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-neutral-600 tabular-nums">
            {mode === 'week' ? (
              <>
                <button onClick={() => setWeekOffset((w) => w - 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                  ‹
                </button>
                {RANGE_FORMAT.format(days[0])} – {RANGE_FORMAT.format(days[days.length - 1])}
                <button onClick={() => setWeekOffset((w) => w + 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                  ›
                </button>
                {weekOffset !== 0 && (
                  <button onClick={() => setWeekOffset(0)} className="cursor-pointer text-teal-700 hover:underline">
                    Today
                  </button>
                )}
              </>
            ) : mode === 'month' ? (
              <>
                <button onClick={() => setMonthOffset((m) => m - 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                  ‹
                </button>
                {MONTH_LABEL_FORMAT.format(monthAnchorDate)}
                <button onClick={() => setMonthOffset((m) => m + 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                  ›
                </button>
                {monthOffset !== 0 && (
                  <button onClick={() => setMonthOffset(0)} className="cursor-pointer text-teal-700 hover:underline">
                    This month
                  </button>
                )}
              </>
            ) : (
              <>
                <button onClick={() => setDayOffset((d) => d - 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                  ‹
                </button>
                {DAY_LABEL.format(dayViewDate)} {RANGE_FORMAT.format(dayViewDate)}
                <button onClick={() => setDayOffset((d) => d + 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
                  ›
                </button>
                {dayOffset !== 0 && (
                  <button onClick={() => setDayOffset(0)} className="cursor-pointer text-teal-700 hover:underline">
                    Today
                  </button>
                )}
              </>
            )}
            <span>· {teams.length} team{teams.length === 1 ? '' : 's'}</span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="flex border border-neutral-300">
            <button
              onClick={() => setMode('day')}
              className={`px-3 py-1.5 text-xs cursor-pointer ${
                mode === 'day' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              Day
            </button>
            <button
              onClick={() => setMode('week')}
              className={`border-l border-neutral-300 px-3 py-1.5 text-xs cursor-pointer ${
                mode === 'week' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              Week
            </button>
            <button
              onClick={() => setMode('month')}
              className={`border-l border-neutral-300 px-3 py-1.5 text-xs cursor-pointer ${
                mode === 'month' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              Month
            </button>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newTeamName.trim()) createTeamMutation.mutate(newTeamName.trim());
            }}
            className="flex items-center gap-1.5"
          >
            <input
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              placeholder="New team name"
              className="border border-neutral-300 px-2 py-1.5 text-xs text-ink outline-none focus:border-teal"
            />
            <button
              type="submit"
              disabled={!newTeamName.trim() || createTeamMutation.isPending}
              className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              + Add team
            </button>
          </form>
        </div>
      </div>

      {isLoading ? (
        <div className="p-5">
          <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
            Loading schedule…
          </div>
        </div>
      ) : isError ? (
        <div className="p-5">
          <div className="border border-missed bg-missed/10 p-4">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
              Couldn't load schedule
            </div>
            <div className="mt-1.5 text-[13px] text-ink">
              {errorObj instanceof Error ? errorObj.message : 'Something went wrong.'}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4 px-5 pb-5">
        <div className="min-w-0 flex-1">
          {bookingError && (
            <div className="mb-2 border border-missed bg-missed/10 px-3 py-1.5 text-[12px] text-missed-fg">
              {bookingError}
            </div>
          )}
          {mode === 'month' ? (
            <MonthGrid
              days={monthDays}
              visits={visits}
              jobById={jobById}
              visitStatusStyle={VISIT_STATUS_STYLE}
              activeTeams={activeTeams}
              pendingDrop={pendingDrop}
              pendingTeamId={pendingTeamId}
              onPendingTeamChange={setPendingTeamId}
              onDropJob={handleDropJob}
              onConfirmBooking={handleConfirmBooking}
              onCancelBooking={handleCancelBooking}
              bookingPending={bookMutation.isPending}
              onSelectVisit={setSelectedJobId}
            />
          ) : (
          <>
          <div className={`grid border border-neutral-300 ${displayDays.length === 1 ? 'grid-cols-[160px_1fr]' : 'grid-cols-[160px_repeat(6,1fr)]'}`}>
            <div className="border-b border-neutral-300 bg-neutral-200 px-3 py-2 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
              Team
            </div>
            {displayDays.map((d) => (
              <div
                key={d.toISOString()}
                className="border-b border-l border-neutral-300 bg-neutral-200 px-3 py-2 text-center font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase"
              >
                {DAY_LABEL.format(d)} <span className="tabular-nums normal-case">{DAY_NUM.format(d)}</span>
              </div>
            ))}

            {teams.map((team) => {
              const teamVisits = visits.filter((v) => v.teamId === team.id);
              return (
                <Fragment key={team.id}>
                  <div
                    className={`flex items-center gap-2 border-b border-neutral-300 px-3 py-2 text-[12.5px] ${
                      team.isActive ? '' : 'text-neutral-400'
                    }`}
                  >
                    <span className="font-semibold">{team.name}</span>
                    <span className="ml-auto text-[10.5px] text-neutral-500 tabular-nums">{teamVisits.length}</span>
                    <button
                      onClick={() => toggleActiveMutation.mutate({ id: team.id, isActive: !team.isActive })}
                      className="cursor-pointer text-[10.5px] text-teal-700 hover:underline"
                    >
                      {team.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                  {displayDays.map((d) => {
                    const cellDateISO = toISODate(d);
                    const dayVisits = teamVisits.filter((v) => v.scheduledDate === cellDateISO);
                    return (
                      <div
                        key={`${team.id}-${cellDateISO}`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop(team.id, cellDateISO)}
                        className="border-b border-l border-neutral-300 px-2 py-2"
                      >
                        {dayVisits.length === 0 ? (
                          <span className="text-[11px] text-neutral-400">free</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {dayVisits.map((v) => {
                              const job = jobById.get(v.jobId);
                              return (
                                <div
                                  key={v.id}
                                  onClick={() => setSelectedJobId(v.jobId)}
                                  className={`cursor-pointer truncate border px-1.5 py-0.5 text-[11px] ${VISIT_STATUS_STYLE[v.status]}`}
                                  title={job ? `${job.jobSummary} · ${job.buildingName}` : v.jobId}
                                >
                                  {job ? job.buildingName : 'Job'}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>

          {teams.length === 0 && (
            <div className="border border-t-0 border-neutral-300 bg-white px-5 py-10 text-center">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                No teams have been set up yet
              </div>
              <div className="mt-1.5 text-[13px] text-neutral-600">
                Add a team above to start booking visits for {mode === 'day' ? 'today' : 'this week'}.
              </div>
            </div>
          )}
          </>
          )}
        </div>

        <div className="flex w-[220px] flex-none flex-col overflow-y-auto border border-neutral-300 bg-white">
          <div className="border-b border-neutral-300 bg-neutral-200 px-3 py-2 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
            Needs booking
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2.5">
            {DUE_GROUPS.map(({ key, label, emptyLabel }) => {
              const groupJobs = key === 'overdue' ? overdueJobs : needsBookingJobs;
              return (
                <div key={key} className="mb-3.5 last:mb-0">
                  <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                    {label} <span className="text-neutral-400">({groupJobs.length})</span>
                  </div>
                  {groupJobs.length === 0 ? (
                    <div className="text-[11px] text-neutral-400">{emptyLabel}</div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {groupJobs.map((job) => (
                        <div
                          key={job.id}
                          draggable
                          onDragStart={(e) => e.dataTransfer.setData('text/plain', job.id)}
                          title={`${job.jobSummary} · ${job.buildingName}`}
                          className="cursor-grab border border-neutral-300 bg-white px-2 py-1.5 text-[11px] active:cursor-grabbing"
                        >
                          <div className="truncate font-semibold text-ink">{job.buildingName}</div>
                          <div className="truncate text-neutral-600">{job.jobSummary}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="border-t border-neutral-300 px-3 py-2 text-[10.5px] leading-normal text-neutral-500">
            Drag a job onto a team/day to book it.
          </div>
        </div>
        </div>
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
