import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createVisit } from '../../repository/techniciansRepository';
import { cancelActivity, createActivity, updateActivity } from '../../repository/activitiesRepository';
import VisitTechnicianPicker from '../jobs/VisitTechnicianPicker';
import DayBookingsList from './DayBookingsList';
import ActivityForm from './ActivityForm';
import TimeRangeFields from './TimeRangeFields';
import { activeSelection, splitPrimary } from '../../lib/visitTechnicianSelection';
import { listBuildingRows } from '../../repository/buildingsRepository';
import type { JobRow, ScheduleActivity, Technician, WeekVisit } from '../../domain/types';
import type { ActivityFormValues } from '../../lib/activityInput';
import { timeRangeError } from '../../lib/timeRange';
import SearchableSelect from '../shared/SearchableSelect';
import JobCreator from '../jobs/JobCreator';

const DATE_HEADER_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * The right-side day drawer for the Schedule page — opened by clicking an
 * empty day cell, a day/date header, or a "+N more" overflow (never by
 * clicking an existing booking, which keeps opening JobInspectorDrawer
 * exactly as it does today; see ThisWeekPage.tsx). Shows this date's real
 * bookings, then a single "Add booking" section that books through the
 * exact same `createVisit` mutation every other booking path in this app
 * already uses — no second write path, no new booking concept. Client →
 * Building → Job is derived entirely from the already-loaded `jobRows`
 * (which already carry buildingId/buildingName/clientId/clientName
 * denormalized) — no new query for the cascade itself. `listBuildingRows()`
 * is fetched only for its `siteInstructions`/`postcode` fields (not
 * present on JobRow), reusing the exact query key BuildingsPage/
 * BuildingFilePage/JobCreator already populate, so it's typically already
 * cached rather than a fresh round trip.
 *
 * "+ Add new job for this building" (once a building is selected) opens
 * the existing JobCreator in its building-preset mode as a small overlay
 * on top of this drawer — no new job-creation form, no new repository
 * function. Defaults its Frequency to 'one_off' (Luke's own stated
 * scenario — a single one-off job like jet washing, not a recurring
 * contract), still changeable in the form itself. On success, the new
 * job's id is dropped straight into the existing `jobId` state (the
 * already-selected date/technician are never touched by any of this), so
 * the manager lands back in "Add booking" with the new job already
 * selected and just clicks the same "Save booking" as any other job —
 * booking itself still only ever calls `createVisit`, never a second job.
 *
 * Activities (non-job items such as a quote visit or picking up keys) share this drawer: they are listed
 * in the same ordered day list as the jobs, a "Job visit | Activity" switch picks which kind to add, and
 * selecting an activity opens it here for editing / cancelling. Activities are written through
 * activitiesRepository only - never createVisit - so they cannot enter the job/report/invoice workflow.
 */
export default function ScheduleDayDrawer({
  dateISO,
  visits,
  activities = [],
  jobRows,
  technicians,
  visitStatusStyle,
  initialTechnicianId,
  initialActivityId,
  onClose,
  onSelectVisit,
}: {
  dateISO: string;
  visits: WeekVisit[];
  /** Every activity in the loaded range (any date); this drawer shows the ones on `dateISO`. */
  activities?: ScheduleActivity[];
  jobRows: JobRow[];
  technicians: Technician[];
  visitStatusStyle: Record<WeekVisit['status'], string>;
  /** Opens this activity straight into edit mode (used when an activity chip was clicked on the calendar). */
  initialActivityId?: string | null;
  /** Pre-selects the Technician field when opened from a specific technician's row/cell in Week or Day mode (see ScheduleTechnicianGrid's "+" affordance) — omitted (or null) when opened from Month mode or the day header, which carry no technician context. */
  initialTechnicianId?: string | null;
  onClose: () => void;
  onSelectVisit: (jobId: string) => void;
}) {
  const queryClient = useQueryClient();

  const jobById = useMemo(() => new Map(jobRows.map((j) => [j.id, j])), [jobRows]);
  const technicianById = useMemo(() => new Map(technicians.map((t) => [t.id, t])), [technicians]);

  // Ordering (running order within the day) is applied by DayBookingsList itself.
  const dayVisits = useMemo(() => visits.filter((v) => v.scheduledDate === dateISO), [visits, dateISO]);
  // `?? []`: activities restored from a cache written before they existed must not crash the drawer.
  const dayActivities = useMemo(() => (activities ?? []).filter((a) => a.scheduledDate === dateISO), [activities, dateISO]);
  const liveCount = dayVisits.filter((v) => v.status !== 'cancelled').length + dayActivities.filter((a) => (a.cancelledAt ?? null) == null).length;

  const { data: buildingRows = [] } = useQuery({ queryKey: ['buildingRows'], queryFn: listBuildingRows });
  const buildingById = useMemo(() => new Map(buildingRows.map((b) => [b.id, b])), [buildingRows]);

  const [clientId, setClientId] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [jobId, setJobId] = useState('');
  // Selected technician ids in selection order; the first becomes the visit's primary (see createVisit).
  const [technicianIds, setTechnicianIds] = useState<string[]>(initialTechnicianId ? [initialTechnicianId] : []);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  // Toggles the "+ Add new job for this building" overlay — deliberately
  // its own flag rather than reusing `jobId`, so opening/cancelling it
  // never touches the already-selected client/building/date/technician
  // state below.
  const [creatingJob, setCreatingJob] = useState(false);
  // Optional time for a new job booking (display only - it never orders the visit).
  const [visitStart, setVisitStart] = useState('');
  const [visitEnd, setVisitEnd] = useState('');
  // What the "Add" section creates: a job visit (unchanged) or a non-job Activity.
  const [addKind, setAddKind] = useState<'job' | 'activity'>('job');
  const [editingActivityId, setEditingActivityId] = useState<string | null>(initialActivityId ?? null);
  // Bumped after an activity is created so the create form remounts empty.
  const [activityFormKey, setActivityFormKey] = useState(0);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityMessage, setActivityMessage] = useState<string | null>(null);
  const editingActivity = editingActivityId ? dayActivities.find((a) => a.id === editingActivityId) : undefined;

  const clients = useMemo(() => {
    const seen = new Map<string, string>();
    for (const j of jobRows) seen.set(j.clientId, j.clientName);
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [jobRows]);

  const buildingsForClient = useMemo(() => {
    const seen = new Map<string, string>();
    for (const j of jobRows) if (j.clientId === clientId) seen.set(j.buildingId, j.buildingName);
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [jobRows, clientId]);

  const jobsForBuilding = useMemo(
    () => jobRows.filter((j) => j.buildingId === buildingId).sort((a, b) => a.jobSummary.localeCompare(b.jobSummary)),
    [jobRows, buildingId],
  );

  const selectedBuilding = buildingId ? buildingById.get(buildingId) : undefined;

  const bookMutation = useMutation({
    mutationFn: () => {
      const { primaryId, additionalIds } = splitPrimary(activeSelection(technicianIds, technicians));
      return createVisit(jobId, primaryId, dateISO, additionalIds, { startTime: visitStart, endTime: visitEnd });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
      setSaveMessage('Visit booked.');
      setJobId('');
      setTechnicianIds([]);
      setVisitStart('');
      setVisitEnd('');
    },
    onError: (err) => setSaveMessage(err instanceof Error ? err.message : 'Failed to book visit.'),
  });

  const toActivityInput = (values: ActivityFormValues) => ({
    description: values.description,
    scheduledDate: values.scheduledDate,
    technicianId: values.technicianId === '' ? null : values.technicianId,
    location: values.location,
    notes: values.notes,
    startTime: values.startTime,
    endTime: values.endTime,
  });

  const refreshActivities = () => {
    queryClient.invalidateQueries({ queryKey: ['activities'] });
    queryClient.invalidateQueries({ queryKey: ['visits'] });
  };

  const createActivityMutation = useMutation({
    mutationFn: (values: ActivityFormValues) => createActivity(toActivityInput({ ...values, scheduledDate: dateISO })),
    onSuccess: () => {
      refreshActivities();
      setActivityError(null);
      setActivityMessage('Activity added.');
      setActivityFormKey((k) => k + 1);
    },
    onError: (err) => setActivityError(err instanceof Error ? err.message : 'Failed to add the activity.'),
  });

  const updateActivityMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: ActivityFormValues }) => updateActivity(id, toActivityInput(values)),
    onSuccess: () => {
      refreshActivities();
      setActivityError(null);
      setActivityMessage('Activity saved.');
      setEditingActivityId(null);
    },
    onError: (err) => setActivityError(err instanceof Error ? err.message : 'Failed to save the activity.'),
  });

  const cancelActivityMutation = useMutation({
    mutationFn: (id: string) => cancelActivity(id),
    onSuccess: () => {
      refreshActivities();
      setActivityError(null);
      setActivityMessage('Activity cancelled.');
      setEditingActivityId(null);
    },
    onError: (err) => setActivityError(err instanceof Error ? err.message : 'Failed to cancel the activity.'),
  });

  const activityFormInitial = (a?: ScheduleActivity): ActivityFormValues => ({
    description: a?.description ?? '',
    scheduledDate: a?.scheduledDate ?? dateISO,
    technicianId: a ? (a.technicianId ?? '') : (initialTechnicianId ?? ''),
    location: a?.location ?? '',
    notes: a?.notes ?? '',
    startTime: a?.startTime ?? '',
    endTime: a?.endTime ?? '',
  });

  return (
    <>
    <div className="fixed inset-0 z-40 bg-ink/30" onClick={onClose} />
    <div className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-full flex-none flex-col overflow-y-auto border-l border-neutral-300 bg-white shadow-xl">
      <div className="flex items-start gap-2 border-b border-neutral-300 bg-teal-100 px-5 py-4">
        <div className="min-w-0">
          <div className="font-heading text-[10px] font-semibold tracking-[0.14em] text-teal-700 uppercase">Schedule</div>
          <h2 className="mt-0.5 font-heading text-xl leading-tight font-semibold text-ink">
            {DATE_HEADER_FORMAT.format(new Date(`${dateISO}T00:00:00`))}
          </h2>
        </div>
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="ml-auto cursor-pointer px-1 text-neutral-600 hover:text-ink"
        >
          ✕
        </button>
      </div>

      <div className="border-b border-neutral-300 px-5 py-4">
        <div className="mb-2 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
          Bookings &amp; activities ({liveCount})
        </div>
        {dayVisits.length === 0 && dayActivities.length === 0 ? (
          <div className="text-[12.5px] text-neutral-500">Nothing booked for this day yet.</div>
        ) : (
          <DayBookingsList
            dayVisits={dayVisits}
            dayActivities={dayActivities}
            dateISO={dateISO}
            jobById={jobById}
            technicianById={technicianById}
            visitStatusStyle={visitStatusStyle}
            onSelectVisit={onSelectVisit}
            onSelectActivity={(a) => {
              setActivityError(null);
              setActivityMessage(null);
              setEditingActivityId(a.id);
            }}
          />
        )}
      </div>

      {editingActivity ? (
        <div className="flex flex-col gap-2.5 px-5 py-4">
          <div className="mb-0.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Edit activity</div>
          <ActivityForm
            key={editingActivity.id}
            mode="edit"
            initial={activityFormInitial(editingActivity)}
            technicians={technicians}
            showDate
            pending={updateActivityMutation.isPending || cancelActivityMutation.isPending}
            error={activityError}
            doneNote={(editingActivity.doneAt ?? null) != null ? 'The assigned technician has marked this done.' : null}
            onSubmit={(values) => {
              setActivityError(null);
              updateActivityMutation.mutate({ id: editingActivity.id, values });
            }}
            onClose={() => {
              setActivityError(null);
              setEditingActivityId(null);
            }}
            onCancelActivity={() => {
              setActivityError(null);
              cancelActivityMutation.mutate(editingActivity.id);
            }}
          />
        </div>
      ) : (
      <div className="flex flex-col gap-2.5 px-5 py-4">
        <div className="mb-0.5 flex items-center gap-2">
          <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Add</div>
          <div className="segmented ml-auto flex border border-neutral-300" role="group" aria-label="What to add">
            {(['job', 'activity'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={addKind === kind}
                onClick={() => setAddKind(kind)}
                className={`cursor-pointer px-2.5 py-1 text-[11px] font-semibold ${
                  addKind === kind ? 'bg-teal text-white' : 'bg-white text-neutral-700 hover:bg-neutral-100'
                }`}
              >
                {kind === 'job' ? 'Job visit' : 'Activity'}
              </button>
            ))}
          </div>
        </div>

        {addKind === 'activity' ? (
          <>
            <ActivityForm
              key={`new-${activityFormKey}`}
              mode="create"
              initial={activityFormInitial()}
              technicians={technicians}
              showDate={false}
              pending={createActivityMutation.isPending}
              error={activityError}
              onSubmit={(values) => {
                setActivityError(null);
                setActivityMessage(null);
                createActivityMutation.mutate(values);
              }}
            />
            {activityMessage && <div className="text-[11.5px] text-neutral-700">{activityMessage}</div>}
          </>
        ) : (
        <>
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Client
          <SearchableSelect
            value={clientId}
            onChange={(id) => {
              setClientId(id);
              setBuildingId('');
              setJobId('');
            }}
            options={clients.map((c) => ({ id: c.id, label: c.name }))}
            placeholder="Search clients…"
            aria-label="Search for a client"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Building
          <SearchableSelect
            value={buildingId}
            onChange={(id) => {
              setBuildingId(id);
              setJobId('');
            }}
            options={buildingsForClient.map((b) => ({ id: b.id, label: b.name, sublabel: buildingById.get(b.id)?.postcode ?? undefined }))}
            placeholder="Search buildings…"
            disabled={!clientId}
            disabledMessage="Select a client first"
            aria-label="Search for a building"
          />
        </label>

        {selectedBuilding && (
          <div className="text-[11.5px] text-neutral-600">
            {selectedBuilding.address}
            {selectedBuilding.postcode ? `, ${selectedBuilding.postcode}` : ''}
          </div>
        )}

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Job
          <select
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            disabled={!buildingId}
            className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            <option value="">Select a job…</option>
            {jobsForBuilding.map((j) => (
              <option key={j.id} value={j.id}>
                {j.jobSummary} · {j.frequencyRaw}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => setCreatingJob(true)}
          disabled={!buildingId}
          title={!buildingId ? 'Select a building first' : undefined}
          className="cursor-pointer self-start border border-teal-700 px-2 py-1 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 disabled:cursor-not-allowed disabled:border-neutral-300 disabled:text-neutral-400"
        >
          + Add new job for this building
        </button>

        <VisitTechnicianPicker technicians={technicians} selectedIds={technicianIds} onChange={setTechnicianIds} />

        {selectedBuilding?.siteInstructions && (
          <div className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-600">
            <div className="mb-0.5 font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
              Site instructions
            </div>
            {selectedBuilding.siteInstructions}
          </div>
        )}

        <TimeRangeFields start={visitStart} end={visitEnd} onChange={(s, e) => { setVisitStart(s); setVisitEnd(e); }} label="Visit" disabled={bookMutation.isPending} />

        <button
          onClick={() => {
            setSaveMessage(null);
            bookMutation.mutate();
          }}
          disabled={!jobId || bookMutation.isPending || timeRangeError(visitStart, visitEnd) != null}
          className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {bookMutation.isPending ? 'Booking…' : 'Save booking'}
        </button>
        {saveMessage && <div className="text-[11.5px] text-neutral-700">{saveMessage}</div>}
        </>
        )}
      </div>
      )}
    </div>
    {creatingJob && (
      <div className="fixed inset-0 z-[60] flex justify-end bg-ink/30" onClick={() => setCreatingJob(false)}>
        <div onClick={(e) => e.stopPropagation()}>
          <JobCreator
            buildingId={buildingId}
            defaultFrequencyType="one_off"
            onCreated={(newJobId) => {
              // Building/date/technician are untouched by this whole
              // overlay — only the newly created job is selected, so the
              // manager lands straight back in "Add booking" with
              // everything else exactly as they left it, ready for the
              // same "Save booking" click as any other job.
              setCreatingJob(false);
              setJobId(newJobId);
              setSaveMessage(null);
            }}
            onCancel={() => setCreatingJob(false)}
          />
        </div>
      </div>
    )}
    </>
  );
}
