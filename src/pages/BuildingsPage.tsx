import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, RowClickedEvent } from 'ag-grid-community';
import { listBuildingRows } from '../repository/buildingsRepository';
import { listJobRows } from '../repository/jobsRepository';
import type { BuildingRow } from '../domain/types';
import { managerGridTheme } from '../lib/gridTheme';

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}

interface BuildingListRow extends BuildingRow {
  jobCount: number;
  yearlyTotal: number;
}

const COLUMN_DEFS: ColDef<BuildingListRow>[] = [
  {
    headerName: 'Building',
    flex: 2,
    minWidth: 200,
    cellRenderer: (p: { data?: BuildingListRow }) => {
      if (!p.data) return null;
      return (
        <span>
          <span className="font-semibold">{p.data.buildingName}</span>
          {p.data.postcode && <span className="text-neutral-600"> · {p.data.postcode}</span>}
        </span>
      );
    },
  },
  { headerName: 'Client', flex: 1.4, minWidth: 160, valueGetter: (p) => p.data?.clientName },
  { headerName: 'Postcode', flex: 0.8, minWidth: 90, valueGetter: (p) => p.data?.postcode || '—' },
  {
    headerName: 'Jobs',
    flex: 0.6,
    minWidth: 70,
    type: 'rightAligned',
    valueGetter: (p) => p.data?.jobCount,
    cellClass: 'tabular-nums',
  },
  {
    headerName: 'Per year',
    flex: 0.9,
    minWidth: 100,
    type: 'rightAligned',
    valueGetter: (p) => p.data?.yearlyTotal,
    valueFormatter: (p) => (!p.value ? '—' : money(p.value)),
    cellClass: 'tabular-nums text-neutral-700',
  },
  { headerName: 'Next visit', flex: 1, minWidth: 110, valueGetter: () => 'Not yet scheduled', cellClass: 'text-neutral-600' },
  { headerName: 'Last visit', flex: 1, minWidth: 110, valueGetter: () => 'No visits recorded', cellClass: 'text-neutral-600' },
  {
    headerName: 'Flags',
    flex: 1,
    minWidth: 130,
    cellRenderer: () => (
      <span className="flex items-center gap-1.5 font-heading text-[10.5px] font-semibold tracking-[0.07em] text-neutral-500 uppercase">
        <i className="block h-1.5 w-1.5 border border-neutral-400 bg-transparent" />
        No visit data yet
      </span>
    ),
  },
];

export default function BuildingsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();

  const {
    data: buildingRows = [],
    isLoading: buildingsLoading,
    isError: buildingsError,
    error: buildingsErrorObj,
  } = useQuery({ queryKey: ['buildingRows'], queryFn: listBuildingRows });
  const { data: jobRows = [], isLoading: jobsLoading } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const isLoading = buildingsLoading || jobsLoading;

  const rows = useMemo<BuildingListRow[]>(() => {
    const jobsByBuilding = new Map<string, typeof jobRows>();
    for (const job of jobRows) {
      const list = jobsByBuilding.get(job.buildingId) ?? [];
      list.push(job);
      jobsByBuilding.set(job.buildingId, list);
    }

    const withCounts = buildingRows.map((b) => {
      const jobs = jobsByBuilding.get(b.id) ?? [];
      return {
        ...b,
        jobCount: jobs.length,
        yearlyTotal: jobs.reduce((a, j) => a + (j.yearlyValue ?? 0), 0),
      };
    });

    if (!q) return withCounts;
    return withCounts.filter((b) => {
      const haystack = `${b.buildingName} ${b.address} ${b.clientName} ${b.postcode}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [buildingRows, jobRows, q]);

  const totalBuildings = buildingRows.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-end gap-3.5 px-5 pt-4 pb-3">
        <div>
          <h1 className="font-heading text-[26px] leading-none font-semibold">Buildings</h1>
          <div className="mt-1 text-xs text-neutral-600 tabular-nums">
            {totalBuildings} building{totalBuildings === 1 ? '' : 's'} · {rows.length} shown
          </div>
        </div>
      </div>

      {isLoading ? (
        <LoadingSkeleton />
      ) : buildingsError ? (
        <ErrorState message={buildingsErrorObj instanceof Error ? buildingsErrorObj.message : 'Something went wrong loading buildings.'} />
      ) : (
        <div className="min-h-0 flex-1">
          <AgGridReact<BuildingListRow>
            theme={managerGridTheme}
            rowData={rows}
            columnDefs={COLUMN_DEFS}
            getRowId={(params) => params.data.id}
            onRowClicked={(event: RowClickedEvent<BuildingListRow>) => {
              if (event.data) navigate(`/buildings/${event.data.id}`);
            }}
            headerHeight={30}
            rowHeight={38}
            suppressCellFocus
            domLayout="normal"
            className="h-full cursor-pointer"
          />
        </div>
      )}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="p-5">
      <div className="border border-missed bg-missed/10 p-4">
        <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
          Couldn't load buildings
        </div>
        <div className="mt-1.5 text-[13px] text-ink">{message}</div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  const opacities = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44, 0.36, 0.3];
  return (
    <div className="p-5">
      <div className="grid gap-1.5">
        {opacities.map((o, i) => (
          <div key={i} className="h-[30px] animate-shimmer bg-neutral-300" style={{ opacity: o }} />
        ))}
      </div>
      <div className="mt-4.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
        Loading buildings…
      </div>
    </div>
  );
}
