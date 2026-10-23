import { useQuery } from '@tanstack/react-query';
import { listBuildingClientHistory } from '../../repository/buildingClientRepository';
import { managementHistory } from '../../lib/buildingClientChange';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DATE.format(d);
};

/**
 * The building's current client and the management companies before it, newest first - only from changes recorded by the app.
 * Nothing before the first recorded change is guessed: an earlier start reads "before changes were recorded".
 */
export default function BuildingManagementHistory({ buildingId, currentClientName }: { buildingId: string; currentClientName: string }) {
  const { data: changes = [], isLoading, isError } = useQuery({
    queryKey: ['buildingClientHistory', buildingId],
    queryFn: () => listBuildingClientHistory(buildingId),
  });
  const { current, previous } = managementHistory(currentClientName || '—', changes);

  return (
    <div data-testid="management-history" className="border border-neutral-300 bg-white p-4">
      <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Management history</div>
      <div className="mt-2 flex items-center gap-1.5 text-[12.5px]">
        <span className="border border-teal-700 bg-teal-100 px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">
          Current
        </span>
        <span className="font-semibold">{current.clientName}</span>
        <span className="text-neutral-500">{current.from ? `since ${day(current.from)}` : ''}</span>
      </div>
      {isLoading ? (
        <div className="mt-1.5 text-[12px] text-neutral-500">Loading history…</div>
      ) : isError ? (
        <div className="mt-1.5 text-[12px] text-missed-fg">Couldn&apos;t load the management history.</div>
      ) : previous.length === 0 ? (
        <div className="mt-1.5 text-[12px] text-neutral-500">No earlier management companies recorded. Changes made here are recorded from now on.</div>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Previously</div>
          {previous.map((p, i) => (
            <div key={i} className="border-l-2 border-neutral-200 pl-2 text-[12px]">
              <div className="text-neutral-700">{p.clientName}</div>
              <div className="text-[11px] text-neutral-500">
                {p.from ? day(p.from) : 'Before changes were recorded'} – {p.until ? day(p.until) : '—'}
                {p.changedBy ? ` · changed by ${p.changedBy}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
