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

const COLUMN_DEFS: ColDef<GridBlock>[] = [
  {
    headerName: 'Building',
    flex: 2,
    minWidth: 180,
    cellRenderer: (p: { data?: GridBlock }) => {
      const job = jobOf(p);
      if (!job) return null;
      return (
        <span>
          <span className="font-semibold">{job.buildingName}</span>
          <span className="text-neutral-600"> · {job.postcode}</span>
        </span>
      );
    },
  },
  { headerName: 'Job', flex: 2, minWidth: 180, valueGetter: (p) => jobOf(p)?.jobSummary },
  { headerName: 'Frequency', flex: 1, minWidth: 100, valueGetter: (p) => jobOf(p)?.frequency },
  {
    headerName: 'Price',
    flex: 0.8,
    minWidth: 84,
    type: 'rightAligned',
    valueGetter: (p) => jobOf(p)?.pricePerVisit,
    valueFormatter: (p) => (p.value == null ? '' : money(p.value)),
    cellClass: 'tabular-nums',
  },
  {
    headerName: 'Per year',
    flex: 0.9,
    minWidth: 96,
    type: 'rightAligned',
    valueGetter: (p) => jobOf(p)?.yearlyValue,
    valueFormatter: (p) => (!p.value ? '—' : money(p.value)),
    cellClass: 'tabular-nums text-neutral-700',
  },
  {
    headerName: 'Next due',
    flex: 1.1,
    minWidth: 110,
    cellRenderer: (p: { data?: GridBlock }) => {
      const job = jobOf(p);
      if (!job) return null;
      const soft = job.nextDueLabel.includes('no date');
      return <span className={`tabular-nums ${dueColorClass(job.status, soft)}`}>{job.nextDueLabel}</span>;
    },
  },
  {
    headerName: 'Status',
    flex: 1.3,
    minWidth: 140,
    cellRenderer: (p: { data?: GridBlock }) => {
      const job = jobOf(p);
      if (!job) return null;
      return <StatusPill status={job.status} />;
    },
  },
  { headerName: 'Team', flex: 0.9, minWidth: 90, valueGetter: (p) => jobOf(p)?.team },
];

interface JobsGridProps {
  rows: JobRow[];
  groupBy: GroupBy;
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
}

export default function JobsGrid({ rows, groupBy, selectedJobId, onSelectJob }: JobsGridProps) {
  const blocks = useMemo(() => buildGridBlocks(rows, groupBy), [rows, groupBy]);

  return (
    <div className="min-h-0 flex-1">
      <AgGridReact<GridBlock>
        theme={managerGridTheme}
        rowData={blocks}
        columnDefs={COLUMN_DEFS}
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
