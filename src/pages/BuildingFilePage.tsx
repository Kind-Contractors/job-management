import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listBuildingHistory, listBuildingPhotos, listBuildingRows } from '../repository/buildingsRepository';
import { listJobRows } from '../repository/jobsRepository';
import { listContactsForClient } from '../repository/contactsRepository';
import { signReportPhotoUrls } from '../repository/reportsRepository';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';
import JobCreator from '../components/jobs/JobCreator';
import BuildingEditor from '../components/jobs/BuildingEditor';
import BuildingAccessEditor from '../components/jobs/BuildingAccessEditor';

type Tab = 'site' | 'history';

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}

/** Human-readable title per activity_events.event_type — new event kinds fall back to the raw string rather than breaking the timeline. */
const HISTORY_EVENT_LABEL: Record<string, string> = {
  building_created: 'Building created',
  building_details_updated: 'Building details updated',
  site_instructions_updated: 'Site instructions updated',
  access_info_updated: 'Access details updated',
  contact_added: 'Contact added',
  contact_updated: 'Contact updated',
  job_created: 'Job created',
  job_details_updated: 'Job details updated',
  job_price_changed: 'Price changed',
  job_frequency_changed: 'Frequency changed',
  job_default_technician_changed: 'Default technician changed',
  visit_created: 'Visit scheduled',
  visit_rescheduled: 'Visit rescheduled',
  visit_technician_assigned: 'Technician assigned',
  visit_technician_changed: 'Technician changed',
  visit_technician_unassigned: 'Technician unassigned',
  visit_completed: 'Visit completed',
  visit_missed: 'Visit missed',
  visit_cancelled: 'Visit cancelled',
  report_submitted: 'Report submitted',
  report_approved: 'Report approved',
  report_returned: 'Report returned for correction',
  report_resubmitted: 'Report resubmitted',
  report_sent_to_client: 'Sent to client',
  report_sent_to_accounts: 'Sent to accounts',
};

const PHOTO_PHASE_LABEL = { before: 'Before', during: 'During', after: 'After' } as const;

export default function BuildingFilePage() {
  const { buildingId } = useParams<{ buildingId: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('site');
  // Collapsed by default — the activity log can get long over time, and
  // Work Photos (always shown in full below it) shouldn't require
  // scrolling past it to reach.
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [editingBuilding, setEditingBuilding] = useState(false);
  const [editingAccess, setEditingAccess] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [creatingJob, setCreatingJob] = useState(false);

  const {
    data: buildings = [],
    isLoading: buildingsLoading,
    isError: buildingsError,
    error: buildingsErrorObj,
  } = useQuery({
    queryKey: ['buildingRows'],
    queryFn: listBuildingRows,
  });
  const {
    data: jobRows = [],
    isLoading: jobsLoading,
    isError: jobsError,
    error: jobsErrorObj,
  } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });
  const clientId = buildings.find((b) => b.id === buildingId)?.clientId;
  const {
    data: contacts = [],
    isLoading: contactsLoading,
    isError: contactsError,
  } = useQuery({
    queryKey: ['contacts', clientId],
    queryFn: () => listContactsForClient(clientId!),
    enabled: Boolean(clientId),
  });
  const {
    data: history = [],
    isLoading: historyLoading,
    isError: historyError,
  } = useQuery({
    queryKey: ['buildingHistory', buildingId],
    queryFn: () => listBuildingHistory(buildingId!),
    enabled: Boolean(buildingId) && tab === 'history',
  });
  const {
    data: photoGroups = [],
    isLoading: photosLoading,
    isError: photosError,
  } = useQuery({
    queryKey: ['buildingPhotos', buildingId],
    queryFn: () => listBuildingPhotos(buildingId!),
    enabled: Boolean(buildingId) && tab === 'history',
  });
  const allBuildingPhotos = useMemo(() => photoGroups.flatMap((g) => g.photos), [photoGroups]);
  const { data: photoUrls = {} } = useQuery({
    queryKey: ['buildingPhotoUrls', buildingId, allBuildingPhotos.map((p) => p.id).join(',')],
    queryFn: () => signReportPhotoUrls(allBuildingPhotos),
    enabled: allBuildingPhotos.length > 0,
  });
  // Same groups, re-partitioned by job for display — groups are already
  // date-descending from listBuildingPhotos(), so each job's own bucket
  // stays in that order too.
  const photoGroupsByJob = useMemo(() => {
    const map = new Map<string, { jobSummary: string; groups: typeof photoGroups }>();
    for (const g of photoGroups) {
      const entry = map.get(g.jobId) ?? { jobSummary: g.jobSummary, groups: [] };
      entry.groups.push(g);
      map.set(g.jobId, entry);
    }
    return Array.from(map.entries()).map(([jobId, entry]) => ({ jobId, ...entry }));
  }, [photoGroups]);

  if (buildingsLoading || jobsLoading) {
    return (
      <div className="p-5 font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
        Loading building…
      </div>
    );
  }

  if (buildingsError || jobsError) {
    const errorObj = buildingsError ? buildingsErrorObj : jobsErrorObj;
    return (
      <div className="p-5">
        <button onClick={() => navigate('/buildings')} className="cursor-pointer text-xs text-teal-700 hover:underline">
          ← Back to Buildings
        </button>
        <div className="mt-4 border border-missed bg-missed/10 p-4">
          <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
            Couldn't load this building
          </div>
          <div className="mt-1.5 text-[13px] text-ink">
            {errorObj instanceof Error ? errorObj.message : 'Something went wrong.'}
          </div>
        </div>
      </div>
    );
  }

  const building = buildings.find((b) => b.id === buildingId);

  if (!building) {
    return (
      <div className="p-5">
        <button onClick={() => navigate('/buildings')} className="cursor-pointer text-xs text-teal-700 hover:underline">
          ← Back to Buildings
        </button>
        <div className="mt-4 text-sm text-neutral-600">Building not found.</div>
      </div>
    );
  }

  const buildingJobs = jobRows.filter((j) => j.buildingId === building.id);
  const yearlyTotal = buildingJobs.reduce((a, j) => a + (j.yearlyValue ?? 0), 0);
  const selectedJob = jobRows.find((j) => j.id === selectedJobId);
  const siblings = selectedJob ? buildingJobs.filter((j) => j.id !== selectedJob.id) : [];

  const accessFields: [string, string | null][] = building.access
    ? [
        ['Key safe code', building.access.keySafeCode],
        ['Keyholder', building.access.keyholderName],
        ['Keyholder phone', building.access.keyholderPhone],
        ['Parking', building.access.parkingNotes],
        ['Access notes', building.access.accessNotes],
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1">
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
      <button onClick={() => navigate('/buildings')} className="mb-3 w-fit cursor-pointer text-xs text-teal-700 hover:underline">
        ← Back to Buildings
      </button>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
            Building · {building.id.slice(0, 8)}
          </div>
          <h1 className="mt-1 font-heading text-2xl leading-tight font-semibold">{building.buildingName}</h1>
          <div className="text-[13px] text-neutral-600">
            {[building.address, building.postcode].filter(Boolean).join(', ')} · {building.clientName}
          </div>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => setEditingBuilding((e) => !e)}
            className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
          >
            {editingBuilding ? 'Close editor' : 'Edit'}
          </button>
          <button
            onClick={() => {
              setSelectedJobId(null);
              setCreatingJob(true);
            }}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          >
            + Add job here
          </button>
        </div>
      </div>

      {editingBuilding && (
        <div className="mb-4">
          <BuildingEditor building={building} onDone={() => setEditingBuilding(false)} />
        </div>
      )}

      <div className="mb-4 flex gap-1 border-b border-divider">
        {(['site', 'history'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'cursor-pointer border-b-2 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em]',
              tab === t ? 'border-teal text-teal-700' : 'border-transparent text-neutral-600',
            ].join(' ')}
          >
            {t === 'site' ? 'Site file' : 'History'}
          </button>
        ))}
      </div>

      {tab === 'site' ? (
        <div className="grid grid-cols-[1fr_320px] gap-5">
          <div className="flex flex-col gap-4">
            <div className="border border-neutral-300 bg-white p-4">
              <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                Site instructions
              </div>
              <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
                {building.siteInstructions || 'Not recorded.'}
              </div>
            </div>

            <div className="border border-neutral-300 bg-white">
              <div className="border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                Jobs at this building ({buildingJobs.length})
              </div>
              {buildingJobs.length === 0 ? (
                <div className="px-4 py-3 text-[12.5px] text-neutral-500">No jobs recorded at this building.</div>
              ) : (
                buildingJobs.map((job) => (
                  <div
                    key={job.id}
                    onClick={() => {
                      setCreatingJob(false);
                      setSelectedJobId(job.id);
                    }}
                    className="flex cursor-pointer justify-between border-b border-divider px-4 py-2 text-[12.5px] last:border-b-0 hover:bg-neutral-100"
                  >
                    <span>
                      {job.jobSummary} <span className="text-neutral-500">· {job.frequencyRaw}</span>
                    </span>
                    <span className="tabular-nums text-neutral-600">
                      {job.pricePerVisit == null ? 'Variable' : money(job.pricePerVisit)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="border border-neutral-300 bg-white p-4">
              <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                At a glance
              </div>
              <div className="mt-2 flex flex-col gap-1.5 text-[12.5px]">
                <Fact label="Client" value={building.clientName || '—'} />
                <Fact label="Invoice details" value={building.invoiceDetails || '—'} />
                <Fact label="Jobs" value={String(buildingJobs.length)} />
                <Fact label="Per year" value={yearlyTotal ? money(yearlyTotal) : '—'} />
              </div>
            </div>

            <div className="border border-neutral-300 bg-white">
              <div className="border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                Contacts ({contacts.length})
              </div>
              {contactsLoading ? (
                <div className="px-4 py-3 text-[12.5px] text-neutral-500">Loading contacts…</div>
              ) : contactsError ? (
                <div className="px-4 py-3 text-[12.5px] text-missed-fg">Couldn't load contacts.</div>
              ) : contacts.length === 0 ? (
                <div className="px-4 py-3 text-[12.5px] text-neutral-500">No contacts recorded for this client.</div>
              ) : (
                contacts.map((c) => (
                  <div key={c.id} className="flex justify-between gap-3 border-b border-divider px-4 py-2 text-[12.5px] last:border-b-0">
                    <span>
                      {c.name}
                      {c.role && <span className="text-neutral-500"> · {c.role}</span>}
                      {c.isPrimary && (
                        <span className="ml-1.5 border border-teal-700 bg-teal-100 px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">
                          Primary
                        </span>
                      )}
                      {c.isAccountsContact && (
                        <span className="ml-1.5 border border-teal-700 bg-teal-100 px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">
                          Accounts
                        </span>
                      )}
                    </span>
                    <span className="text-right text-neutral-600">{c.email ?? c.phoneNumber ?? '—'}</span>
                  </div>
                ))
              )}
            </div>

            <div className="border border-dashed border-neutral-400 bg-neutral-100 p-3">
              <div className="flex items-center gap-2">
                <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                  Internal only · access
                </div>
                <button
                  onClick={() => {
                    setRevealed((r) => !r);
                    setEditingAccess(false);
                  }}
                  className="ml-auto cursor-pointer text-[11.5px] text-teal-700 hover:underline"
                >
                  {revealed ? 'Hide' : 'Reveal'}
                </button>
              </div>
              {revealed ? (
                editingAccess ? (
                  <BuildingAccessEditor
                    buildingId={building.id}
                    access={building.access}
                    onDone={() => setEditingAccess(false)}
                  />
                ) : (
                  <>
                    {building.access ? (
                      <div className="mt-2 flex flex-col gap-1">
                        {accessFields.map(([label, value]) => (
                          <Fact key={label} label={label} value={value || 'Not recorded'} />
                        ))}
                      </div>
                    ) : (
                      <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
                        Access details not yet recorded for this building.
                      </div>
                    )}
                    <button
                      onClick={() => setEditingAccess(true)}
                      className="mt-2 cursor-pointer text-[11.5px] text-teal-700 hover:underline"
                    >
                      Edit access details
                    </button>
                  </>
                )
              ) : (
                <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
                  Hidden. Reveal to show key safe, keyholder and parking details.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="border border-neutral-300 bg-white p-4">
            <div className="flex items-center gap-2">
              <span className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                Activity
              </span>
              {!historyLoading && !historyError && (
                <span className="text-[11px] text-neutral-500 tabular-nums">({history.length})</span>
              )}
              {!historyLoading && !historyError && history.length > 0 && (
                <button
                  onClick={() => setHistoryExpanded((e) => !e)}
                  className="ml-auto cursor-pointer text-[11px] text-teal-700 hover:underline"
                >
                  {historyExpanded ? 'Hide' : 'Show'}
                </button>
              )}
            </div>
            {historyLoading ? (
              <div className="mt-1.5 text-[12.5px] text-neutral-500">Loading history…</div>
            ) : historyError ? (
              <div className="mt-1.5 text-[12.5px] text-missed-fg">Couldn't load history.</div>
            ) : history.length === 0 ? (
              <div className="mt-1.5 text-[12.5px] text-neutral-500">No history recorded yet for this building.</div>
            ) : historyExpanded ? (
              <div className="mt-2 flex flex-col gap-3">
                {history.map((event) => (
                  <div key={event.id} className="flex gap-2.5 text-[12.5px]">
                    <i className="mt-1 block h-1.5 w-1.5 flex-none bg-teal-700" />
                    <div>
                      <div className="font-semibold">
                        {HISTORY_EVENT_LABEL[event.eventType] ?? event.eventType}
                        {event.jobSummary ? ` — ${event.jobSummary}` : ''}
                      </div>
                      {event.detail && <div className="text-neutral-600">{event.detail}</div>}
                      <div className="text-[11px] text-neutral-500">
                        {new Date(event.occurredAt).toLocaleDateString('en-GB')}
                        {event.actor ? ` · ${event.actor}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* Read-only retrospective of uploaded work photos — no include/exclude,
              editing, deletion, or send/approve actions; see listBuildingPhotos(). Always
              shown in full (no collapse) — Activity above is what collapses, so photos
              never require scrolling past a long activity log to reach. */}
          <div className="border border-neutral-300 bg-white p-4">
            <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
              Work photos
            </div>
            {photosLoading ? (
              <div className="mt-1.5 text-[12.5px] text-neutral-500">Loading photos…</div>
            ) : photosError ? (
              <div className="mt-1.5 text-[12.5px] text-missed-fg">Couldn't load photos.</div>
            ) : photoGroupsByJob.length === 0 ? (
              <div className="mt-1.5 text-[12.5px] text-neutral-500">No work photos uploaded yet for this building.</div>
            ) : (
              <div className="mt-2 flex flex-col gap-4">
                {photoGroupsByJob.map(({ jobId, jobSummary, groups }) => (
                  <div key={jobId}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-600 uppercase">
                        {jobSummary}
                      </span>
                      <button
                        onClick={() => {
                          setCreatingJob(false);
                          setSelectedJobId(jobId);
                        }}
                        className="cursor-pointer text-[11px] text-teal-700 hover:underline"
                      >
                        View job
                      </button>
                    </div>
                    <div className="flex flex-col gap-3">
                      {groups.map((g) => (
                        <div key={g.reportId} className="border-l-2 border-neutral-200 pl-3">
                          <div className="mb-1 text-[11px] text-neutral-500 tabular-nums">
                            Visit {g.scheduledDate ? new Date(g.scheduledDate).toLocaleDateString('en-GB') : 'date unknown'}
                          </div>
                          <div className="grid grid-cols-3 gap-3">
                            {(['before', 'during', 'after'] as const).map((phase) => {
                              const phasePhotos = g.photos.filter((p) => p.phase === phase);
                              if (phasePhotos.length === 0) return null;
                              return (
                                <div key={phase}>
                                  <div className="mb-1 font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                                    {PHOTO_PHASE_LABEL[phase]} ({phasePhotos.length})
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {phasePhotos.map((p) =>
                                      photoUrls[p.id] ? (
                                        <a key={p.id} href={photoUrls[p.id]} target="_blank" rel="noreferrer">
                                          <img
                                            src={photoUrls[p.id]}
                                            alt=""
                                            className="h-20 w-20 border border-neutral-300 object-cover"
                                          />
                                        </a>
                                      ) : (
                                        <div key={p.id} className="h-20 w-20 animate-shimmer border border-neutral-300 bg-neutral-200" />
                                      ),
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>

    {creatingJob ? (
      <JobCreator
        buildingId={building.id}
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-divider py-1">
      <span className="text-neutral-600">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}
