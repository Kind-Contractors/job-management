import { useMemo, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  createTechnician,
  createVisit,
  listTechnicians,
  listVisitsForRange,
  rescheduleVisit,
  setTechnicianActive,
} from '../repository/techniciansRepository';
import { listJobRows } from '../repository/jobsRepository';
import { setUserActive } from '../repository/usersRepository';
import type { JobRow, WeekVisit } from '../domain/types';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';
import MonthGrid, { type MonthGridDay } from '../components/calendar/MonthGrid';
import ScheduleTechnicianGrid from '../components/calendar/ScheduleTechnicianGrid';
import ScheduleDayDrawer from '../components/calendar/ScheduleDayDrawer';
import ScheduleHeader from '../components/calendar/ScheduleHeader';
import ScheduleToolbar from '../components/calendar/ScheduleToolbar';

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const RANGE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

/**
 * The drag-source panel's two groups — deliberately distinct labels, never
 * "due", since 'unscheduled' carries no stored evidence of when (or whether)
 * a job is actually due, only that nothing has ever been booked for it. See
 * the Calendar plan's §3.3 for the full rationale.
 */
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
  const [mode, setMode] = useState<'day' | 'week' | 'month'>('week');
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [dayOffset, setDayOffset] = useState(0);
  const [manageTechniciansOpen, setManageTechniciansOpen] = useState(false);
  const [newTechnicianName, setNewTechnicianName] = useState('');
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ jobId: string; date: string } | null>(null);
  const [pendingTechnicianId, setPendingTechnicianId] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

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
  const technicianDisplayDays = mode === 'day' ? [dayViewDate] : days;
  const rangeStartDate = mode === 'month' ? monthStartDate : mode === 'day' ? dayISO : startDate;
  const rangeEndDate = mode === 'month' ? monthEndDate : mode === 'day' ? dayISO : endDate;
  const todayISO = toISODate(new Date());
  /** Division has one home — the left rail's control (NavRail.tsx). This page only ever reads the shared URL param, never renders its own toggle for it (tried and removed per feedback). */
  const division = searchParams.get('division') ?? 'Both';
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();

  const dateRangeLabel =
    mode === 'month'
      ? MONTH_LABEL_FORMAT.format(monthAnchorDate)
      : mode === 'day'
        ? `${DAY_LABEL.format(dayViewDate)} ${RANGE_FORMAT.format(dayViewDate)}`
        : `${RANGE_FORMAT.format(days[0])} – ${RANGE_FORMAT.format(days[days.length - 1])}`;
  const isAtToday = mode === 'month' ? monthOffset === 0 : mode === 'day' ? dayOffset === 0 : weekOffset === 0;
  const datePickerValue = mode === 'month' ? toISODate(monthAnchorDate) : mode === 'day' ? dayISO : startDate;

  const setQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('q', value);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  const handlePrev = () => {
    if (mode === 'month') setMonthOffset((m) => m - 1);
    else if (mode === 'day') setDayOffset((d) => d - 1);
    else setWeekOffset((w) => w - 1);
  };
  const handleNext = () => {
    if (mode === 'month') setMonthOffset((m) => m + 1);
    else if (mode === 'day') setDayOffset((d) => d + 1);
    else setWeekOffset((w) => w + 1);
  };
  const handleToday = () => {
    if (mode === 'month') setMonthOffset(0);
    else if (mode === 'day') setDayOffset(0);
    else setWeekOffset(0);
  };

  /** Jumps the current mode's own offset to an arbitrary picked date — never mixes offsets across modes (picking a date in Month mode only ever changes monthOffset, etc.). */
  const handleDatePick = (value: string) => {
    if (!value) return;
    const picked = new Date(`${value}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (mode === 'day') {
      setDayOffset(Math.round((picked.getTime() - today.getTime()) / 86400000));
      return;
    }

    const mondayOf = (d: Date) => {
      const monday = new Date(d);
      const dow = d.getDay();
      monday.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
      return monday;
    };

    if (mode === 'week') {
      setWeekOffset(Math.round((mondayOf(picked).getTime() - mondayOf(today).getTime()) / (7 * 86400000)));
    } else {
      setMonthOffset((picked.getFullYear() - today.getFullYear()) * 12 + (picked.getMonth() - today.getMonth()));
    }
  };

  const {
    data: technicians = [],
    isLoading: techniciansLoading,
    isError: techniciansError,
    error: techniciansErrorObj,
  } = useQuery({ queryKey: ['technicians'], queryFn: listTechnicians });
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

  const createTechnicianMutation = useMutation({
    mutationFn: (name: string) => createTechnician(name),
    onSuccess: () => {
      setNewTechnicianName('');
      queryClient.invalidateQueries({ queryKey: ['technicians'] });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => setTechnicianActive(id, isActive),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['technicians'] }),
  });

  /**
   * A technician linked to a real login (technician.appUserId set — created
   * via the Users screen) must be activated/deactivated through the same
   * admin-users Edge Function the Users screen itself uses, which keeps
   * BOTH technicians.is_active and that login's own app_users.is_active in
   * sync. Reusing plain setTechnicianActive for a linked technician would
   * silently desync them: a manager's client-side session has no write
   * access to another user's app_users row at all (only self_select RLS),
   * so the login side would never actually change, and the person would
   * become invisible/stuck on the Users screen despite Schedule showing
   * them as active — exactly the bug this fixes.
   */
  const setLinkedUserActiveMutation = useMutation({
    mutationFn: ({ appUserId, isActive }: { appUserId: string; isActive: boolean }) => setUserActive(appUserId, isActive),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['technicians'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const bookMutation = useMutation({
    mutationFn: ({ jobId, technicianId, date }: { jobId: string; technicianId: string; date: string }) =>
      createVisit(jobId, technicianId, date),
    onSuccess: () => {
      setBookingError(null);
      setPendingDrop(null);
      setPendingTechnicianId('');
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
    },
    onError: (err) => setBookingError(err instanceof Error ? err.message : 'Failed to book visit.'),
  });

  /**
   * Reschedules an already-booked visit to a new date (dragged from one
   * calendar day to another) — updates the same visit row by id via
   * rescheduleVisit(), never createVisit(), so this can never create a
   * duplicate. Reuses the exact same ['jobRows']/['visits'] invalidation as
   * every other booking mutation, so Month Matrix, All Live Jobs, and the
   * technician app's Today/Upcoming all pick up the new date the same way
   * they already pick up a brand-new booking.
   */
  const rescheduleMutation = useMutation({
    mutationFn: ({ visitId, date }: { visitId: string; date: string }) => rescheduleVisit(visitId, date),
    onSuccess: () => {
      setBookingError(null);
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
    },
    onError: (err) => setBookingError(err instanceof Error ? err.message : 'Failed to reschedule visit.'),
  });

  const activeTechnicians = useMemo(() => technicians.filter((t) => t.isActive), [technicians]);

  const handleDropJob = (jobId: string, date: string) => {
    setBookingError(null);
    setPendingTechnicianId('');
    setPendingDrop({ jobId, date });
  };

  /** Immediate — unlike a brand-new booking, a reschedule never needs a technician picked (it keeps its existing one), so there's no pending-confirmation step here. */
  const handleRescheduleVisit = (visitId: string, date: string) => {
    setBookingError(null);
    rescheduleMutation.mutate({ visitId, date });
  };

  const handleConfirmBooking = () => {
    if (!pendingDrop || !pendingTechnicianId) return;
    bookMutation.mutate({ jobId: pendingDrop.jobId, technicianId: pendingTechnicianId, date: pendingDrop.date });
  };

  const handleCancelBooking = () => {
    setPendingDrop(null);
    setPendingTechnicianId('');
  };

  const jobById = useMemo(() => new Map(jobRows.map((j) => [j.id, j])), [jobRows]);
  const technicianById = useMemo(() => new Map(technicians.map((t) => [t.id, t])), [technicians]);

  /** Search and Division narrow what's rendered on the calendar itself only — the day drawer always shows a day's complete, unfiltered bookings, since these are viewing aids for the grid, not a claim that other bookings don't exist. */
  const displayVisits = useMemo(() => {
    return visits.filter((v) => {
      const job = jobById.get(v.jobId);
      if (division !== 'Both' && job?.division !== division) return false;
      if (!q) return true;
      const technician = v.technicianId ? technicianById.get(v.technicianId) : undefined;
      const haystack = `${job?.buildingName ?? ''} ${job?.jobSummary ?? ''} ${technician?.name ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [visits, q, division, jobById, technicianById]);

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

  /** The day drawer and JobInspectorDrawer are mutually exclusive — opening one always closes the other, mirroring the existing selectedJobId/creatingJob split in BuildingFilePage.tsx. */
  const openDay = (dateISO: string) => {
    setSelectedJobId(null);
    setSelectedDate(dateISO);
  };
  const openJob = (jobId: string) => {
    setSelectedDate(null);
    setSelectedJobId(jobId);
  };

  const handleDrop = (technicianId: string, dateISO: string) => (e: DragEvent) => {
    e.preventDefault();
    // An already-booked chip carries its visit id under this dedicated mime
    // type (set by the chip's own onDragStart in ScheduleTechnicianGrid) —
    // checked first so dropping it reschedules the SAME visit rather than
    // falling through and creating a new one. Deliberately ignores
    // `technicianId` (which row/day it was dropped on) for this path — the
    // visit's own assigned technician is left exactly as it was, per the
    // reschedule requirement; only the date changes.
    const visitId = e.dataTransfer.getData('application/x-visit-id');
    if (visitId) {
      handleRescheduleVisit(visitId, dateISO);
      return;
    }
    const jobId = e.dataTransfer.getData('text/plain');
    if (!jobId) return;
    bookMutation.mutate({ jobId, technicianId, date: dateISO });
  };

  const isLoading = techniciansLoading || visitsLoading || jobRowsLoading;
  const isError = techniciansError || visitsError || jobRowsError;
  const errorObj = techniciansError ? techniciansErrorObj : visitsError ? visitsErrorObj : jobRowsErrorObj;

  const selectedJob: JobRow | undefined = jobRows.find((j) => j.id === selectedJobId);
  const siblings = selectedJob ? jobRows.filter((j) => j.buildingId === selectedJob.buildingId && j.id !== selectedJob.id) : [];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScheduleHeader onAddBooking={() => openDay(todayISO)} />

        <ScheduleToolbar
          mode={mode}
          onModeChange={setMode}
          dateRangeLabel={dateRangeLabel}
          onPrev={handlePrev}
          onNext={handleNext}
          onToday={handleToday}
          isAtToday={isAtToday}
          datePickerValue={datePickerValue}
          onDatePick={handleDatePick}
          q={q}
          onQueryChange={setQuery}
          overdueJobs={overdueJobs}
          needsBookingJobs={needsBookingJobs}
        />

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
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {bookingError && (
              <div className="mb-3 border border-missed bg-missed/10 px-3 py-1.5 text-[12px] text-missed-fg">{bookingError}</div>
            )}

            {mode === 'month' ? (
              <MonthGrid
                days={monthDays}
                visits={displayVisits}
                jobById={jobById}
                technicianById={technicianById}
                visitStatusStyle={VISIT_STATUS_STYLE}
                activeTechnicians={activeTechnicians}
                pendingDrop={pendingDrop}
                pendingTechnicianId={pendingTechnicianId}
                onPendingTechnicianChange={setPendingTechnicianId}
                onDropJob={handleDropJob}
                onRescheduleVisit={handleRescheduleVisit}
                onConfirmBooking={handleConfirmBooking}
                onCancelBooking={handleCancelBooking}
                bookingPending={bookMutation.isPending}
                onSelectVisit={openJob}
                onSelectDay={openDay}
                todayISO={todayISO}
                selectedDateISO={selectedDate}
              />
            ) : (
              <>
                <div className="mb-2.5 flex items-center gap-3">
                  <span className="text-[12px] text-neutral-600">
                    {technicians.length} technician{technicians.length === 1 ? '' : 's'}
                  </span>
                  <button
                    onClick={() => setManageTechniciansOpen((o) => !o)}
                    className="cursor-pointer text-[12px] text-teal-700 hover:underline"
                  >
                    {manageTechniciansOpen ? 'Close' : 'Manage technicians'}
                  </button>
                </div>

                {manageTechniciansOpen && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newTechnicianName.trim()) createTechnicianMutation.mutate(newTechnicianName.trim());
                    }}
                    className="mb-2.5 flex items-center gap-1.5"
                  >
                    <input
                      value={newTechnicianName}
                      onChange={(e) => setNewTechnicianName(e.target.value)}
                      placeholder="New technician name"
                      className="border border-neutral-300 px-2 py-1.5 text-xs text-ink outline-none focus:border-teal"
                    />
                    <button
                      type="submit"
                      disabled={!newTechnicianName.trim() || createTechnicianMutation.isPending}
                      className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      + Add technician
                    </button>
                  </form>
                )}

                <ScheduleTechnicianGrid
                  days={technicianDisplayDays}
                  technicians={technicians}
                  visits={visits}
                  displayVisits={displayVisits}
                  jobById={jobById}
                  visitStatusStyle={VISIT_STATUS_STYLE}
                  todayISO={todayISO}
                  selectedDateISO={selectedDate}
                  onSelectDay={openDay}
                  onSelectVisit={openJob}
                  onDrop={handleDrop}
                  onToggleTechnicianActive={(id, isActive) => {
                    const technician = technicians.find((t) => t.id === id);
                    if (technician?.appUserId) {
                      setLinkedUserActiveMutation.mutate({ appUserId: technician.appUserId, isActive });
                    } else {
                      toggleActiveMutation.mutate({ id, isActive });
                    }
                  }}
                />
              </>
            )}
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
      {selectedDate && (
        <ScheduleDayDrawer
          key={selectedDate}
          dateISO={selectedDate}
          visits={visits}
          jobRows={jobRows}
          technicians={technicians}
          visitStatusStyle={VISIT_STATUS_STYLE}
          onClose={() => setSelectedDate(null)}
          onSelectVisit={openJob}
        />
      )}
    </div>
  );
}
