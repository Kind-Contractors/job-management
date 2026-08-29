import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listBuildingHistory, listBuildingRows } from '../repository/buildingsRepository';
import { listJobRows } from '../repository/jobsRepository';

const NOT_BUILT_TITLE = 'Not built yet — this pass only covers the Buildings view and Building File basics';

type Tab = 'site' | 'history';

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}

export default function BuildingFilePage() {
  const { buildingId } = useParams<{ buildingId: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('site');
  const [revealed, setRevealed] = useState(false);

  const { data: buildings = [], isLoading: buildingsLoading } = useQuery({
    queryKey: ['buildingRows'],
    queryFn: listBuildingRows,
  });
  const { data: jobRows = [], isLoading: jobsLoading } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });
  const {
    data: history = [],
    isLoading: historyLoading,
    isError: historyError,
  } = useQuery({
    queryKey: ['buildingHistory', buildingId],
    queryFn: () => listBuildingHistory(buildingId!),
    enabled: Boolean(buildingId) && tab === 'history',
  });

  if (buildingsLoading || jobsLoading) {
    return (
      <div className="p-5 font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
        Loading building…
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
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
          <div title={NOT_BUILT_TITLE} className="cursor-not-allowed border border-neutral-300 px-3 py-1.5 text-xs text-neutral-500">
            Print site sheet
          </div>
          <div title={NOT_BUILT_TITLE} className="cursor-not-allowed bg-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-500">
            + Add job here
          </div>
        </div>
      </div>

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
            <div className="border border-neutral-300 p-4">
              <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                Site instructions
              </div>
              <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
                {building.siteInstructions || 'Not recorded.'}
              </div>
            </div>

            <div className="border border-neutral-300">
              <div className="border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                Jobs at this building ({buildingJobs.length})
              </div>
              {buildingJobs.length === 0 ? (
                <div className="px-4 py-3 text-[12.5px] text-neutral-500">No jobs recorded at this building.</div>
              ) : (
                buildingJobs.map((job) => (
                  <div key={job.id} className="flex justify-between border-b border-divider px-4 py-2 text-[12.5px] last:border-b-0">
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
            <div className="border border-neutral-300 p-4">
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

            <div className="border border-dashed border-neutral-400 bg-neutral-100 p-3">
              <div className="flex items-center gap-2">
                <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                  Internal only · access
                </div>
                <button
                  onClick={() => setRevealed((r) => !r)}
                  className="ml-auto cursor-pointer text-[11.5px] text-teal-700 hover:underline"
                >
                  {revealed ? 'Hide' : 'Reveal'}
                </button>
              </div>
              {revealed ? (
                building.access ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {accessFields.map(([label, value]) => (
                      <Fact key={label} label={label} value={value || 'Not recorded'} />
                    ))}
                  </div>
                ) : (
                  <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
                    Access details not yet recorded for this building.
                  </div>
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
        <div className="border border-neutral-300 p-4">
          {historyLoading ? (
            <div className="text-[12.5px] text-neutral-500">Loading history…</div>
          ) : historyError ? (
            <div className="text-[12.5px] text-missed-fg">Couldn't load history.</div>
          ) : history.length === 0 ? (
            <div className="text-[12.5px] text-neutral-500">No history recorded yet for this building.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {history.map((event) => (
                <div key={event.id} className="flex gap-2.5 text-[12.5px]">
                  <i className="mt-1 block h-1.5 w-1.5 flex-none bg-teal-700" />
                  <div>
                    <div className="font-semibold">{event.eventType}</div>
                    {event.detail && <div className="text-neutral-600">{event.detail}</div>}
                    <div className="text-[11px] text-neutral-500">
                      {new Date(event.occurredAt).toLocaleDateString('en-GB')}
                      {event.actor ? ` · ${event.actor}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
