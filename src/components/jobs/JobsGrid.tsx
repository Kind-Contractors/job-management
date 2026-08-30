import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, RowClassParams } from 'ag-grid-community';
import type { JobRow } from '../../domain/types';
import type { GridBlock, GroupBy } from '../../lib/grouping';
import { buildGridBlocks } from '../../lib/grouping';
import { dueColorClass } from '../../lib/statusPresentation';
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
        return <StatusPill status={job.status} />;
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

  return (
    <div className="min-h-0 flex-1">
      <AgGridReact<GridBlock>
        theme={managerGridTheme}
        rowData={blocks}
        columnDefs={columnDefs}
        getRowId={(params: GetRowIdParams<GridBlock>) => params.data.id}
        isFullWidthRow={(params) => params.rowNode.data?.kind === 'band'}
        fullWidthCellRenderer={GridBandRow}
        getRowHeight={(params) => (params.data?.kind === 'band' ? 34 : 38)}
        getRowClass={(params: RowClassParams<GridBlock>) =>
          params.data?.kind === 'row' && params.data.job.id === selectedJobId ? 'bg-teal-100' : undefined
        }
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
