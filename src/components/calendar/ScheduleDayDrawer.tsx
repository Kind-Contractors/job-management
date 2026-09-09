import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createVisit } from '../../repository/techniciansRepository';
import { listBuildingRows } from '../../repository/buildingsRepository';
import type { JobRow, Technician, WeekVisit } from '../../domain/types';

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
 */
export default function ScheduleDayDrawer({
  dateISO,
  visits,
  jobRows,
  technicians,
  visitStatusStyle,
  onClose,
  onSelectVisit,
}: {
  dateISO: string;
  visits: WeekVisit[];
  jobRows: JobRow[];
  technicians: Technician[];
  visitStatusStyle: Record<WeekVisit['status'], string>;
  onClose: () => void;
  onSelectVisit: (jobId: string) => void;
}) {
  const queryClient = useQueryClient();

  const jobById = useMemo(() => new Map(jobRows.map((j) => [j.id, j])), [jobRows]);
  const technicianById = useMemo(() => new Map(technicians.map((t) => [t.id, t])), [technicians]);

  const dayVisits = useMemo(
    () =>
      visits
        .filter((v) => v.scheduledDate === dateISO)
        .sort((a, b) => (jobById.get(a.jobId)?.buildingName ?? '').localeCompare(jobById.get(b.jobId)?.buildingName ?? '')),
    [visits, dateISO, jobById],
  );

  const { data: buildingRows = [] } = useQuery({ queryKey: ['buildingRows'], queryFn: listBuildingRows });
  const buildingById = useMemo(() => new Map(buildingRows.map((b) => [b.id, b])), [buildingRows]);

  const [clientId, setClientId] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [jobId, setJobId] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

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
    mutationFn: () => createVisit(jobId, technicianId || null, dateISO),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
      setSaveMessage('Visit booked.');
      setJobId('');
      setTechnicianId('');
    },
    onError: (err) => setSaveMessage(err instanceof Error ? err.message : 'Failed to book visit.'),
  });

  return (
    <div className="flex w-[380px] flex-none flex-col overflow-y-auto border-l border-neutral-300 bg-white shadow-[-2px_0_8px_rgba(0,0,0,0.04)]">
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
          Bookings ({dayVisits.length})
        </div>
        {dayVisits.length === 0 ? (
          <div className="text-[12.5px] text-neutral-500">Nothing booked for this day yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {dayVisits.map((v) => {
              const job = jobById.get(v.jobId);
              const technician = v.technicianId ? technicianById.get(v.technicianId) : undefined;
              return (
                <button
                  key={v.id}
                  onClick={() => onSelectVisit(v.jobId)}
                  className={`flex cursor-pointer flex-col items-start gap-0.5 border px-2 py-1.5 text-left text-[12px] ${visitStatusStyle[v.status]}`}
                >
                  <span className="truncate font-semibold">{job ? job.buildingName : 'Job'}</span>
                  <span className="truncate text-[11px] opacity-80">
                    {job?.jobSummary ?? '—'} · {technician ? technician.name : 'Unassigned'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2.5 px-5 py-4">
        <div className="mb-0.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Add booking</div>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Client
          <select
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setBuildingId('');
              setJobId('');
            }}
            className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal"
          >
            <option value="">Select a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Building
          <select
            value={buildingId}
            onChange={(e) => {
              setBuildingId(e.target.value);
              setJobId('');
            }}
            disabled={!clientId}
            className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            <option value="">Select a building…</option>
            {buildingsForClient.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
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

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Technician
          <select
            value={technicianId}
            onChange={(e) => setTechnicianId(e.target.value)}
            className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal"
          >
            <option value="">Unassigned</option>
            {technicians
              .filter((t) => t.isActive)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>

        {selectedBuilding?.siteInstructions && (
          <div className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-600">
            <div className="mb-0.5 font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
              Site instructions
            </div>
            {selectedBuilding.siteInstructions}
          </div>
        )}

        <button
          onClick={() => {
            setSaveMessage(null);
            bookMutation.mutate();
          }}
          disabled={!jobId || bookMutation.isPending}
          className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {bookMutation.isPending ? 'Booking…' : 'Save booking'}
        </button>
        {saveMessage && <div className="text-[11.5px] text-neutral-700">{saveMessage}</div>}
      </div>
    </div>
  );
}
