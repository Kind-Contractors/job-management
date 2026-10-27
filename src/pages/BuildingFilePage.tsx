import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listBuildingHistory, listBuildingPhotos, listBuildingRows } from '../repository/buildingsRepository';
import { listHistoricalJobRows, listJobRows } from '../repository/jobsRepository';
import { listContactsForClient } from '../repository/contactsRepository';
import { signReportPhotoUrls } from '../repository/reportsRepository';
import JobInspectorDrawer from '../components/jobs/JobInspectorDrawer';
import JobCreator from '../components/jobs/JobCreator';
import BuildingEditor from '../components/jobs/BuildingEditor';
import BuildingAccessEditor from '../components/jobs/BuildingAccessEditor';
import BuildingDefaultRecipientPanel from '../components/jobs/BuildingDefaultRecipientPanel';
import BuildingReportsPanel from '../components/buildings/BuildingReportsPanel';
import ChangeBuildingClientPanel from '../components/buildings/ChangeBuildingClientPanel';
import BuildingManagementHistory from '../components/buildings/BuildingManagementHistory';
import BuildingAddContactForm from '../components/buildings/BuildingAddContactForm';
import LinkXeroContactDialog from '../components/jobs/LinkXeroContactDialog';
import { refreshAfterXeroLink } from '../components/jobs/UnlinkedRecipientsList';
import type { Contact } from '../domain/types';
import { isUsableRecipient, linkStatusLabel, localLinkStatus } from '../lib/xeroLinkStatus';
import { contactInitials } from '../lib/contactDisplay';
import { buildingReports } from '../lib/buildingReports';
import Breadcrumbs from '../components/shell/Breadcrumbs';
import { HISTORY_EVENT_LABEL, historyEventDetail } from '../lib/historyEventLabels';

type Tab = 'site' | 'history';

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}


const PHOTO_PHASE_LABEL = { before: 'Before', during: 'During', after: 'After' } as const;

export default function BuildingFilePage() {
  const { buildingId } = useParams<{ buildingId: string }>();
  const [tab, setTab] = useState<Tab>('site');
  // Collapsed by default — the activity log can get long over time, and
  // Work Photos (always shown in full below it) shouldn't require
  // scrolling past it to reach.
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [editingBuilding, setEditingBuilding] = useState(false);
  const [changingClient, setChangingClient] = useState(false);
  const [clientNotice, setClientNotice] = useState<string | null>(null);
  const [addingContact, setAddingContact] = useState(false);
  const [contactNotice, setContactNotice] = useState<string | null>(null);
  // The contact just added here: the notice offers to link it to its existing Xero contact straight away (optional).
  const [justAddedContactId, setJustAddedContactId] = useState<string | null>(null);
  // The contact whose "Link to Xero" was pressed: opens the shared LinkXeroContactDialog for exactly that contact.
  const [linkingContact, setLinkingContact] = useState<Contact | null>(null);
  const queryClient = useQueryClient();
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
  // Completed, lost and cancelled jobs (same query and cache as Historical jobs): their reports stay downloadable here.
  const historicalJobs = useQuery({ queryKey: ['historicalJobRows'], queryFn: listHistoricalJobRows });
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
      <div className="p-5">
        <Breadcrumbs items={[{ label: 'Buildings', to: '/buildings' }, { label: '…' }]} />
        <div className="mt-3 font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading building…</div>
      </div>
    );
  }

  if (buildingsError || jobsError) {
    const errorObj = buildingsError ? buildingsErrorObj : jobsErrorObj;
    return (
      <div className="p-5">
        <Breadcrumbs items={[{ label: 'Buildings', to: '/buildings' }, { label: "Couldn't load" }]} />
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
        <Breadcrumbs items={[{ label: 'Buildings', to: '/buildings' }, { label: 'Building not found' }]} />
        <div className="mt-4 text-sm text-neutral-600">Building not found. It may have been removed, or the link is wrong.</div>
      </div>
    );
  }

  const buildingJobs = jobRows.filter((j) => j.buildingId === building.id);
  const yearlyTotal = buildingJobs.reduce((a, j) => a + (j.yearlyValue ?? 0), 0);
  // Jobs whose yearly value can't be derived (variable price, or frequency unknown) are left out of the total and said so.
  const jobsWithoutYearlyValue = buildingJobs.filter((j) => j.yearlyValue == null).length;
  // The same split the Job reports panel shows (ready = marked Completed or sent to the client).
  const reports = buildingReports(building.id, jobRows, historicalJobs.data ?? []);
  const linkedContacts = contacts.filter(isUsableRecipient).length;
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
      {/* Buildings › client (plain text: there is no client page yet) › this building. The client level is left out when unknown. */}
      <div className="mb-3">
        <Breadcrumbs
          items={[{ label: 'Buildings', to: '/buildings' }, { label: building.clientName ?? '' }, { label: building.buildingName || 'Building' }]}
        />
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
            Building · {building.id.slice(0, 8)}
          </div>
          <h1 className="mt-1 font-heading text-[28px] leading-tight font-semibold">{building.buildingName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-neutral-600">
            {(building.address || building.postcode) && (
              <span className="inline-flex items-center gap-1.5">
                <Icon paths={['M12 21s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z', 'M12 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z']} />
                {[building.address, building.postcode].filter(Boolean).join(', ')}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Icon paths={['M3 21h18M5 21V7l7-4 7 4v14']} />
              Managed by <span className="font-semibold text-ink">{building.clientName || '—'}</span>
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => {
              setEditingBuilding(true);
              setChangingClient(false);
            }}
            className="cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
          >
            Edit building
          </button>
          <button
            onClick={() => {
              setChangingClient((c) => !c);
              setEditingBuilding(false);
              setClientNotice(null);
            }}
            className="cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
          >
            {changingClient ? 'Close' : 'Change client'}
          </button>
          <button
            onClick={() => {
              setSelectedJobId(null);
              setCreatingJob(true);
            }}
            className="flex cursor-pointer items-center gap-1 bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          >
            <Icon paths={['M12 5v14M5 12h14']} />
            Add job
          </button>
        </div>
      </div>

      {/* The numbers this page is about, read from the same rows as the panels below (nothing stored twice). */}
      <div data-testid="building-stats" className="mt-4 grid grid-cols-4 border border-neutral-300 bg-white">
        <Stat label="Live jobs" value={String(buildingJobs.length)} />
        <Stat label="Value per year" value={yearlyTotal ? money(yearlyTotal) : '—'} />
        <Stat
          label="Reports ready"
          value={historicalJobs.isLoading ? '…' : String(reports.available.length)}
          note={reports.notYetAvailable > 0 ? `${reports.notYetAvailable} not ready yet` : undefined}
        />
        <Stat
          label="Contacts"
          value={contactsLoading || contactsError ? '…' : String(contacts.length)}
          note={contactsLoading || contactsError ? undefined : `${linkedContacts} linked to Xero`}
        />
      </div>

      {/* A dialog over the page (name, postcode, address, invoice details, site instructions). */}
      {editingBuilding && <BuildingEditor building={building} onDone={() => setEditingBuilding(false)} />}

      {changingClient && (
        <div className="mt-4">
          <ChangeBuildingClientPanel
            building={building}
            buildingJobs={[...buildingJobs, ...(historicalJobs.data ?? []).filter((j) => j.buildingId === building.id)]}
            onDone={(message) => {
              setChangingClient(false);
              setClientNotice(message);
            }}
            onCancel={() => setChangingClient(false)}
          />
        </div>
      )}
      {clientNotice && (
        <div role="status" className="mt-4 max-w-[640px] border border-teal-700/40 bg-teal-100 p-2 text-[12.5px] text-teal-700">
          {clientNotice}
        </div>
      )}

      <div className="mt-4 mb-4 flex gap-1 border-b border-divider">
        {(['site', 'history'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'cursor-pointer rounded-none border-b-2 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em]',
              tab === t ? 'border-teal text-teal-700' : 'border-transparent text-neutral-600',
            ].join(' ')}
          >
            {t === 'site' ? 'Site file' : 'History'}
          </button>
        ))}
      </div>

      {tab === 'site' ? (
        <div className="grid grid-cols-[minmax(0,3fr)_minmax(360px,2fr)] items-start gap-5">
          {/* The right column carries more (invoicing, contacts, history, access), so it gets the larger share of the width. */}
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex items-start gap-3 border border-neutral-300 bg-white p-4">
              <span className="grid h-8 w-8 flex-none place-items-center bg-teal text-white">
                <Icon paths={['M12 3v18M12 3l7 4-7 4']} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                  Site instructions
                </div>
                <div className="mt-1 text-[13.5px] leading-relaxed whitespace-pre-line text-ink">
                  {building.siteInstructions || <span className="text-neutral-500">Not recorded.</span>}
                </div>
              </div>
            </div>

            {/* Site instructions, then this building's jobs, then its job reports. */}
            <div data-testid="building-jobs" className="border border-neutral-300 bg-white">
              <div className="border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                Jobs at this building · {buildingJobs.length}
              </div>
              {buildingJobs.length === 0 ? (
                <div className="px-4 py-3 text-[12.5px] text-neutral-500">No jobs recorded at this building.</div>
              ) : (
                <>
                  <div className="grid grid-cols-[minmax(0,1fr)_140px_110px] gap-4 border-b border-divider px-4 py-1.5 text-[11px] text-neutral-600">
                    <span>Service</span>
                    <span>Repeats</span>
                    <span className="text-right">Price per visit</span>
                  </div>
                  {buildingJobs.map((job) => (
                    <div
                      key={job.id}
                      onClick={() => {
                        setCreatingJob(false);
                        setSelectedJobId(job.id);
                      }}
                      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_140px_110px] items-center gap-4 border-b border-divider px-4 py-2 text-[12.5px] hover:bg-neutral-100"
                    >
                      <span className="truncate font-medium text-ink">{job.jobSummary}</span>
                      <span className="min-w-0">
                        <span className="inline-block max-w-full truncate border border-neutral-300 px-1.5 py-0.5 align-middle text-[11px] text-neutral-700">
                          {job.frequencyRaw || '—'}
                        </span>
                      </span>
                      <span className="text-right tabular-nums">
                        {job.pricePerVisit == null ? (
                          <span className="text-neutral-600 italic">Variable</span>
                        ) : (
                          <span className="font-semibold">{money(job.pricePerVisit)}</span>
                        )}
                      </span>
                    </div>
                  ))}
                  <div className="flex justify-between gap-3 bg-neutral-100 px-4 py-2 text-[12px] text-neutral-600">
                    <span>
                      {jobsWithoutYearlyValue > 0
                        ? `${jobsWithoutYearlyValue} ${jobsWithoutYearlyValue === 1 ? 'job has' : 'jobs have'} no yearly value (variable price or frequency unknown) and ${jobsWithoutYearlyValue === 1 ? 'is' : 'are'} not in the yearly total.`
                        : 'Yearly total is derived from price × frequency.'}
                    </span>
                    <span className="flex-none font-semibold text-ink tabular-nums">{yearlyTotal ? `${money(yearlyTotal)} / yr` : '—'}</span>
                  </div>
                </>
              )}
            </div>

            <BuildingReportsPanel
              buildingId={building.id}
              jobLists={[jobRows, historicalJobs.data ?? []]}
              historicalLoading={historicalJobs.isLoading}
              historicalError={historicalJobs.isError}
              onRetryHistorical={() => void historicalJobs.refetch()}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <div data-testid="building-contacts" className="border border-neutral-300 bg-white">
              <div className="flex items-center gap-2 border-b border-neutral-300 px-4 py-2.5">
                <span className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Contacts · {contacts.length}</span>
                <button
                  type="button"
                  onClick={() => {
                    setAddingContact(true);
                    setContactNotice(null);
                    setJustAddedContactId(null);
                  }}
                  disabled={contactsLoading || contactsError}
                  className="ml-auto cursor-pointer text-[11.5px] font-semibold text-teal-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
                >
                  + Add contact
                </button>
              </div>
              {contactNotice && (
                <div role="status" className="border-b border-divider bg-teal-100 px-4 py-2 text-[12px] text-teal-700">
                  {contactNotice}
                  {(() => {
                    // Offered, never done for the manager: the new contact is linked only if they choose and confirm a Xero contact.
                    const added = justAddedContactId ? contacts.find((c) => c.id === justAddedContactId) : undefined;
                    if (!added) return null;
                    return isUsableRecipient(added) ? (
                      <> {linkStatusLabel(added)}.</>
                    ) : (
                      <>
                        {' '}
                        To invoice it, link it to its existing Xero contact.{' '}
                        <button type="button" onClick={() => setLinkingContact(added)} className="cursor-pointer font-semibold underline">
                          Link to Xero contact now
                        </button>
                      </>
                    );
                  })()}
                </div>
              )}
              {contactsLoading ? (
                <div className="px-4 py-3 text-[12.5px] text-neutral-500">Loading contacts…</div>
              ) : contactsError ? (
                <div className="px-4 py-3 text-[12.5px] text-missed-fg">Couldn't load contacts.</div>
              ) : contacts.length === 0 ? (
                <div className="px-4 py-3 text-[12.5px] text-neutral-500">No contacts recorded for this client.</div>
              ) : (
                contacts.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 border-b border-divider px-4 py-2.5 text-[12.5px] last:border-b-0">
                    <span aria-hidden="true" className="grid h-8 w-8 flex-none place-items-center bg-neutral-200 font-heading text-[11px] font-semibold text-teal-700">
                      {contactInitials(c.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <span className="font-semibold text-ink">{c.name}</span>
                        {c.isPrimary && (
                          <span className="border border-teal-700 bg-teal-100 px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">
                            Primary
                          </span>
                        )}
                        {c.isAccountsContact && (
                          <span className="border border-teal-700 bg-teal-100 px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">
                            Accounts only
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11.5px] text-neutral-600">
                        {[c.email ?? c.phoneNumber ?? 'No email or phone', c.role].filter(Boolean).join(' · ')}
                      </div>
                      {localLinkStatus(c) !== 'not_linked' && (
                        <div className={`truncate text-[11px] ${localLinkStatus(c) === 'linked' ? 'text-teal-700' : 'text-due-fg'}`}>
                          {localLinkStatus(c) === 'linked' ? '✓ ' : ''}
                          {linkStatusLabel(c)}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setLinkingContact(c)}
                      aria-label={`${localLinkStatus(c) === 'not_linked' ? 'Link' : 'Change the Xero link of'} ${c.name}`}
                      className={[
                        'flex-none cursor-pointer px-2 py-1 text-[11px] font-semibold',
                        localLinkStatus(c) === 'linked'
                          ? 'border border-neutral-300 text-teal-700 hover:bg-neutral-100'
                          : 'border border-dashed border-neutral-500 text-neutral-700 hover:bg-neutral-100',
                      ].join(' ')}
                    >
                      {localLinkStatus(c) === 'linked' ? 'Change Xero link' : 'Link to Xero'}
                    </button>
                  </div>
                ))
              )}
              {/* A dialog over the page (see BuildingAddContactForm). */}
              {addingContact && !contactsLoading && !contactsError && (
                <BuildingAddContactForm
                  clientId={building.clientId}
                  clientName={building.clientName}
                  buildingId={building.id}
                  contacts={contacts}
                  onClose={() => setAddingContact(false)}
                  onCreated={(contact) => {
                    setAddingContact(false);
                    setContactNotice(`Contact added: ${contact.name}.`);
                    setJustAddedContactId(contact.id);
                  }}
                />
              )}
            </div>

            {linkingContact && (
              // The shared link dialog: the email lookup lists every Xero contact with this contact's email and picks none; the name
              // search is pre-filled with this building's name (Xero often has one contact per building). Nothing is linked until the
              // manager chooses and confirms; replacing a link needs its own confirmation, and a contact that is any building's
              // default recipient cannot be re-linked (the server refuses until that default is cleared).
              <LinkXeroContactDialog
                localContactId={linkingContact.id}
                localContactName={linkingContact.name}
                localContactEmail={linkingContact.email}
                suggestedTerm={building.name || building.buildingName || linkingContact.name}
                currentXeroContactId={linkingContact.xeroContactId}
                onClose={() => setLinkingContact(null)}
                onLinked={() => refreshAfterXeroLink(queryClient)}
              />
            )}

            {/* Invoicing: the default invoice recipient and the invoice details. Needs the contacts (only linked ones can be chosen). */}
            {contactsLoading ? (
              <div className="border border-neutral-300 bg-white px-4 py-3 text-[12.5px] text-neutral-500">Loading invoicing…</div>
            ) : (
              !contactsError && <BuildingDefaultRecipientPanel building={building} contacts={contacts} />
            )}

            <BuildingManagementHistory buildingId={building.id} currentClientName={building.clientName} />

            <div className="border border-dashed border-neutral-400 bg-neutral-100 p-3">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                  <Icon paths={['M5 11h14v10H5z', 'M8 11V8a4 4 0 018 0v3']} />
                  Internal only · access
                </div>
                <button
                  onClick={() => {
                    setRevealed((r) => !r);
                    setEditingAccess(false);
                  }}
                  aria-expanded={revealed}
                  className="ml-auto cursor-pointer border border-neutral-300 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 hover:bg-neutral-100"
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
                      {historyEventDetail(event.eventType, event.detail) && <div className="text-neutral-600">{historyEventDetail(event.eventType, event.detail)}</div>}
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

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border-l border-divider px-4 py-3 first:border-l-0">
      <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="font-heading text-2xl font-semibold text-ink tabular-nums">{value}</span>
        {note && <span className="text-[11.5px] text-neutral-600">{note}</span>}
      </div>
    </div>
  );
}

/** A small line icon; each entry of `paths` is one SVG path. Decorative only. */
function Icon({ paths }: { paths: string[] }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
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
