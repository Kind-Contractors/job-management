import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, GridApi, RowClassParams } from 'ag-grid-community';
import type { JobRow } from '../../domain/types';
import type { GridBlock, GroupBy } from '../../lib/grouping';
import { buildGridBlocks } from '../../lib/grouping';
import { dueColorClass, getStatusPresentation } from '../../lib/statusPresentation';
import { managerGridTheme } from '../../lib/gridTheme';
import GridBandRow from './GridBandRow';
import StatusPill from './StatusPill';

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}

function jobOf(params: { data?: GridBlock }): JobRow | undefined {
  return params.data?.kind === 'row' ? params.data.job : undefined;
}

export const COLUMN_IDS = ['building', 'job', 'frequency', 'price', 'perYear', 'nextDue', 'status', 'team'] as const;
export type JobsGridColumnId = (typeof COLUMN_IDS)[number];

/** Shared with AllLiveJobsPage's "Columns" show/hide control — one label per column, defined once. */
export const COLUMN_LABELS: Record<JobsGridColumnId, string> = {
  building: 'Building',
  job: 'Job',
  frequency: 'Frequency',
  price: 'Price',
  perYear: 'Per year',
  nextDue: 'Next due',
  status: 'Status',
  team: 'Team',
};

function buildColumnDefs(hiddenColumns: ReadonlySet<JobsGridColumnId>): ColDef<GridBlock>[] {
  const hide = (id: JobsGridColumnId) => hiddenColumns.has(id);

  return [
    {
      colId: 'building',
      headerName: COLUMN_LABELS.building,
      flex: 2,
      minWidth: 180,
      hide: hide('building'),
      cellRenderer: (p: { data?: GridBlock }) => {
        const job = jobOf(p);
        if (!job) return null;
        return (
          <span>
            <span className="font-semibold">{job.buildingName}</span>
            {job.postcode && <span className="text-neutral-600"> · {job.postcode}</span>}
          </span>
        );
      },
    },
    { colId: 'job', headerName: COLUMN_LABELS.job, flex: 2, minWidth: 180, hide: hide('job'), valueGetter: (p) => jobOf(p)?.jobSummary },
    {
      colId: 'frequency',
      headerName: COLUMN_LABELS.frequency,
      flex: 1,
      minWidth: 100,
      hide: hide('frequency'),
      valueGetter: (p) => jobOf(p)?.frequencyRaw,
    },
    {
      colId: 'price',
      headerName: COLUMN_LABELS.price,
      flex: 0.8,
      minWidth: 84,
      type: 'rightAligned',
      hide: hide('price'),
      valueGetter: (p) => jobOf(p)?.pricePerVisit,
      valueFormatter: (p) => (p.value == null ? '' : money(p.value)),
      cellClass: 'tabular-nums',
    },
    {
      colId: 'perYear',
      headerName: COLUMN_LABELS.perYear,
      flex: 0.9,
      minWidth: 96,
      type: 'rightAligned',
      hide: hide('perYear'),
      valueGetter: (p) => jobOf(p)?.yearlyValue,
      valueFormatter: (p) => (!p.value ? '—' : money(p.value)),
      cellClass: 'tabular-nums text-neutral-700',
    },
    {
      colId: 'nextDue',
      headerName: COLUMN_LABELS.nextDue,
      flex: 1.1,
      minWidth: 110,
      hide: hide('nextDue'),
      cellRenderer: (p: { data?: GridBlock }) => {
        const job = jobOf(p);
        if (!job) return null;
        const soft = job.nextDueLabel.includes('no date');
        return <span className={`tabular-nums ${dueColorClass(job.status, soft)}`}>{job.nextDueLabel}</span>;
      },
    },
    {
      colId: 'status',
      headerName: COLUMN_LABELS.status,
      flex: 1.3,
      minWidth: 140,
      hide: hide('status'),
      cellRenderer: (p: { data?: GridBlock }) => {
        const job = jobOf(p);
        if (!job) return null;
        const presentation = getStatusPresentation(job.status);
        // A bordered/tinted pill, not just the bare dot+text StatusPill uses
        // elsewhere (Job Inspector, Report Review) — this column sits among
        // many rows of plain text, so it needs to read as a chip at a glance,
        // not just a colored label. Same colors, no new ones: the tint is
        // just the existing border color at low opacity.
        return (
          <span className={`inline-flex items-center border px-1.5 py-0.5 ${presentation.border} ${presentation.bg}`}>
            <StatusPill presentation={presentation} />
          </span>
        );
      },
    },
    { colId: 'team', headerName: COLUMN_LABELS.team, flex: 0.9, minWidth: 90, hide: hide('team'), valueGetter: (p) => jobOf(p)?.team },
  ];
}

interface JobsGridProps {
  rows: JobRow[];
  groupBy: GroupBy;
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
  hiddenColumns?: ReadonlySet<JobsGridColumnId>;
}

const NO_HIDDEN_COLUMNS: ReadonlySet<JobsGridColumnId> = new Set();

export default function JobsGrid({ rows, groupBy, selectedJobId, onSelectJob, hiddenColumns = NO_HIDDEN_COLUMNS }: JobsGridProps) {
  const blocks = useMemo(() => buildGridBlocks(rows, groupBy), [rows, groupBy]);
  const columnDefs = useMemo(() => buildColumnDefs(hiddenColumns), [hiddenColumns]);
  const gridApiRef = useRef<GridApi<GridBlock> | null>(null);

  // getRowClass is only re-evaluated by AG Grid when it decides to (new
  // rowData, or an explicit redraw) — it does NOT automatically notice that
  // selectedJobId, an unrelated React prop, changed. Without this, clicking
  // a different row updates React state correctly but the grid keeps
  // showing the OLD row's highlight (or none) until something else happens
  // to force a redraw. redrawRows() is the correct, minimal way to tell AG
  // Grid "re-run getRowClass now" without touching rowData/columnDefs.
  useEffect(() => {
    gridApiRef.current?.redrawRows();
  }, [selectedJobId]);

  return (
    <div className="min-h-0 flex-1">
      <AgGridReact<GridBlock>
        theme={managerGridTheme}
        rowData={blocks}
        columnDefs={columnDefs}
        defaultColDef={{
          tooltipValueGetter: (p) => (p.data?.kind === 'row' ? 'Click to view job details' : undefined),
        }}
        getRowId={(params: GetRowIdParams<GridBlock>) => params.data.id}
        onGridReady={(params) => {
          gridApiRef.current = params.api;
        }}
        isFullWidthRow={(params) => params.rowNode.data?.kind === 'band'}
        fullWidthCellRenderer={GridBandRow}
        getRowHeight={(params) => (params.data?.kind === 'band' ? 34 : 38)}
        getRowClass={(params: RowClassParams<GridBlock>) => {
          if (params.data?.kind !== 'row') return undefined;
          // `!bg-teal-100` (Tailwind's important-modifier syntax), not plain
          // `bg-teal-100` — AG Grid's Theming API injects its own
          // `.ag-row-odd`/`.ag-row-even { background-color: ... }` rule at
          // grid-mount time, after Tailwind's stylesheet. Same specificity,
          // later in source order, so it silently wins ties and the plain
          // utility class never painted (confirmed via a real rendered row:
          // the class was present in the DOM but computed background-color
          // stayed white). The `!` forces `!important`, which beats it
          // regardless of source order.
          return params.data.job.id === selectedJobId ? 'cursor-pointer !bg-teal-100' : 'cursor-pointer';
        }}
        onRowClicked={(event) => {
          if (event.data?.kind === 'row') onSelectJob(event.data.job.id);
        }}
        headerHeight={30}
        suppressCellFocus
        domLayout="normal"
        className="h-full"
      />
    </div>
  );
}
