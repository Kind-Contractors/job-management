import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, GridApi, RowClassParams, TabToNextCellParams } from 'ag-grid-community';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Division, FrequencyType, JobRow, Technician } from '../../domain/types';
import type { GridBlock, GroupBy } from '../../lib/grouping';
import { buildGridBlocks } from '../../lib/grouping';
import { dueColorClass, getStatusPresentation } from '../../lib/statusPresentation';
import { managerGridTheme } from '../../lib/gridTheme';
import { computeDerivedPricing, FREQUENCY_TYPE_LABEL } from '../../repository/mapJobRow';
import { assignJobTechnician, patchJob, type JobPatchInput } from '../../repository/jobsRepository';
import { listTechnicians } from '../../repository/techniciansRepository';
import { parseJobSummary, parsePricePerVisit } from './JobEditor';
import SelectCellEditor from './SelectCellEditor';
import GridBandRow from './GridBandRow';
import StatusPill from './StatusPill';

const DIVISIONS: Division[] = ['General', 'Specialist'];
const FREQUENCY_TYPES = Object.keys(FREQUENCY_TYPE_LABEL) as FrequencyType[];

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}

/** Monthly values are rarely whole (e.g. weekly's price × 52 / 12) — always shown to the penny, unlike money() above. */
function moneyPrecise(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function jobOf(params: { data?: GridBlock }): JobRow | undefined {
  return params.data?.kind === 'row' ? params.data.job : undefined;
}

/** Mirrors mapJobRow.ts's own default-technician display string exactly, computed here from the same technicians list already fetched for the cell editor's options. */
function technicianLabel(id: string | null | undefined, technicianById: Map<string, Technician>): string {
  if (!id) return 'Unassigned';
  const t = technicianById.get(id);
  if (!t) return 'Unassigned';
  return t.isActive ? t.name : `${t.name} (inactive)`;
}

export const COLUMN_IDS = [
  'building',
  'job',
  'division',
  'frequency',
  'price',
  'perMonth',
  'perYear',
  'nextDue',
  'status',
  'technician',
] as const;
export type JobsGridColumnId = (typeof COLUMN_IDS)[number];

/** Shared with AllLiveJobsPage's "Columns" show/hide control — one label per column, defined once. */
export const COLUMN_LABELS: Record<JobsGridColumnId, string> = {
  building: 'Building',
  job: 'Job',
  division: 'Division',
  frequency: 'Frequency',
  price: 'Price',
  perMonth: 'Per month',
  perYear: 'Per year',
  nextDue: 'Next due',
  status: 'Status',
  technician: 'Default technician',
};

function buildColumnDefs(hiddenColumns: ReadonlySet<JobsGridColumnId>, technicians: Technician[]): ColDef<GridBlock>[] {
  const hide = (id: JobsGridColumnId) => hiddenColumns.has(id);
  const technicianById = new Map(technicians.map((t) => [t.id, t]));
  const activeTechnicianOptions = technicians.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name }));

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
    {
      colId: 'job',
      headerName: COLUMN_LABELS.job,
      flex: 2,
      minWidth: 180,
      hide: hide('job'),
      editable: (p: { data?: GridBlock }) => jobOf(p) != null,
      valueGetter: (p) => jobOf(p)?.jobSummary,
      valueSetter: (p) => {
        const job = jobOf(p);
        if (!job) return false;
        const next = parseJobSummary(String(p.newValue ?? ''));
        if (next == null || next === job.jobSummary) return false;
        job.jobSummary = next;
        return true;
      },
    },
    {
      colId: 'division',
      headerName: COLUMN_LABELS.division,
      flex: 0.8,
      minWidth: 104,
      hide: hide('division'),
      editable: (p: { data?: GridBlock }) => jobOf(p) != null,
      valueGetter: (p) => jobOf(p)?.division,
      cellEditor: SelectCellEditor,
      cellEditorParams: { options: DIVISIONS.map((d) => ({ value: d, label: d })) },
      valueSetter: (p) => {
        const job = jobOf(p);
        if (!job) return false;
        const next = p.newValue as Division;
        if (next === job.division) return false;
        job.division = next;
        return true;
      },
    },
    {
      colId: 'frequency',
      headerName: COLUMN_LABELS.frequency,
      flex: 1,
      minWidth: 110,
      hide: hide('frequency'),
      editable: (p: { data?: GridBlock }) => jobOf(p) != null,
      // Raw enum for editing — NOT frequencyRaw (the display label), which
      // isn't itself a valid write-back value. valueFormatter below
      // reproduces the exact display mapJobRow.ts already computes,
      // including its legacy-text fallback when frequencyType is null.
      valueGetter: (p) => jobOf(p)?.frequencyType ?? null,
      valueFormatter: (p) => {
        const job = jobOf(p);
        if (!job) return '';
        return job.frequencyType ? FREQUENCY_TYPE_LABEL[job.frequencyType] : job.frequencyRaw;
      },
      cellEditor: SelectCellEditor,
      cellEditorParams: {
        options: FREQUENCY_TYPES.map((f) => ({ value: f, label: FREQUENCY_TYPE_LABEL[f] })),
        blankLabel: 'Not set',
      },
      valueSetter: (p) => {
        const job = jobOf(p);
        if (!job) return false;
        const next = (p.newValue || null) as FrequencyType | null;
        if (next === job.frequencyType) return false;
        job.frequencyType = next;
        job.frequency = next ? FREQUENCY_TYPE_LABEL[next] : 'Unknown';
        // Only overwrite the display fallback when we have a real new label
        // to show — clearing back to "not set" has no legacy raw text to
        // restore locally (that lives server-side); the next jobRows
        // refetch (triggered right after this commits) settles it exactly.
        if (next) job.frequencyRaw = FREQUENCY_TYPE_LABEL[next];
        const derived = computeDerivedPricing(job.pricePerVisit == null ? 'variable' : 'fixed', next, job.pricePerVisit);
        job.yearlyValue = derived.yearlyValue;
        job.monthlyValue = derived.monthlyValue;
        return true;
      },
    },
    {
      colId: 'price',
      headerName: COLUMN_LABELS.price,
      flex: 0.8,
      minWidth: 84,
      type: 'rightAligned',
      hide: hide('price'),
      // Only fixed-pricing jobs have a real price to edit — a variable job's
      // pricePerVisit is null by construction (see JobEditor/JobCreator),
      // which naturally disables editing here without a separate flag.
      // Pricing type itself stays a JobEditor-only concern (coupled to this
      // field by a DB constraint) — never edited from this cell.
      editable: (p: { data?: GridBlock }) => jobOf(p)?.pricePerVisit != null,
      valueGetter: (p) => jobOf(p)?.pricePerVisit,
      valueFormatter: (p) => (p.value == null ? '' : money(p.value)),
      cellEditor: 'agNumberCellEditor',
      cellEditorParams: { min: 0.01 },
      valueSetter: (p) => {
        const job = jobOf(p);
        if (!job || job.pricePerVisit == null) return false;
        const next = parsePricePerVisit(String(p.newValue ?? ''));
        if (next == null || next === job.pricePerVisit) return false;
        job.pricePerVisit = next;
        const derived = computeDerivedPricing('fixed', job.frequencyType, next);
        job.yearlyValue = derived.yearlyValue;
        job.monthlyValue = derived.monthlyValue;
        return true;
      },
      cellClass: 'tabular-nums',
    },
    {
      colId: 'perMonth',
      headerName: COLUMN_LABELS.perMonth,
      flex: 0.9,
      minWidth: 96,
      type: 'rightAligned',
      hide: hide('perMonth'),
      // Calculated, never editable — see mapJobRow.ts's computeDerivedPricing().
      valueGetter: (p) => jobOf(p)?.monthlyValue,
      valueFormatter: (p) => (!p.value ? '—' : moneyPrecise(p.value)),
      cellClass: 'tabular-nums text-neutral-700',
    },
    {
      colId: 'perYear',
      headerName: COLUMN_LABELS.perYear,
      flex: 0.9,
      minWidth: 96,
      type: 'rightAligned',
      hide: hide('perYear'),
      // Calculated, never editable — see mapJobRow.ts's computeDerivedPricing().
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
      // Derived from real visits/reports rows — there is no column to edit; change a visit instead (Schedule, or the Job Inspector's visit list).
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
      // Derived from real visits/reports rows — same reasoning as nextDue above.
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
    {
      colId: 'technician',
      headerName: COLUMN_LABELS.technician,
      flex: 1,
      minWidth: 150,
      hide: hide('technician'),
      // jobs.default_technician_id — the job's usual/prefill technician,
      // deliberately NOT the same thing as a specific visit's own
      // technician_id (that's assigned per-visit via VisitRow, in the Job
      // Inspector's Visits list). The "Default technician" header exists
      // specifically so this cell is never mistaken for the other one.
      editable: (p: { data?: GridBlock }) => jobOf(p) != null,
      valueGetter: (p) => jobOf(p)?.defaultTechnicianId ?? null,
      valueFormatter: (p) => technicianLabel(p.value, technicianById),
      cellEditor: SelectCellEditor,
      cellEditorParams: { options: activeTechnicianOptions, blankLabel: 'Unassigned' },
      valueSetter: (p) => {
        const job = jobOf(p);
        if (!job) return false;
        const next = (p.newValue || null) as string | null;
        if (next === job.defaultTechnicianId) return false;
        job.defaultTechnicianId = next;
        return true;
      },
    },
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
  const queryClient = useQueryClient();
  const [editError, setEditError] = useState<string | null>(null);
  const { data: technicians = [] } = useQuery({ queryKey: ['technicians'], queryFn: listTechnicians });

  const blocks = useMemo(() => buildGridBlocks(rows, groupBy), [rows, groupBy]);
  const columnDefs = useMemo(() => buildColumnDefs(hiddenColumns, technicians), [hiddenColumns, technicians]);
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

  /**
   * Every editable-column commit lands here, keyed by colId, and persists
   * through the exact repository functions/security pattern already
   * established: patchJob() (a narrow, single-field UPDATE — see
   * jobsRepository.ts, same shape as reportsRepository.ts's
   * updateReport()) for the four plain job fields, and the existing
   * assignJobTechnician() — unchanged — for the Default technician column.
   * Both mutations invalidate ['jobRows'] on settle, the same
   * invalidation every other job/visit mutation in this app already uses,
   * so a failed save is corrected by the resulting refetch rather than
   * silently left showing the optimistic (locally-mutated, in the
   * valueSetters above) value.
   */
  const patchMutation = useMutation({
    mutationFn: ({ jobId, patch }: { jobId: string; patch: JobPatchInput }) => patchJob(jobId, patch),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['jobRows'] }),
    onError: (err) => setEditError(err instanceof Error ? err.message : 'Failed to save change.'),
  });

  const assignMutation = useMutation({
    mutationFn: ({ jobId, technicianId }: { jobId: string; technicianId: string | null }) =>
      assignJobTechnician(jobId, technicianId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['jobRows'] }),
    onError: (err) => setEditError(err instanceof Error ? err.message : 'Failed to assign technician.'),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editError && (
        <div className="mb-1.5 flex flex-none items-center gap-2 border border-missed bg-missed/10 px-3 py-1.5 text-[12px] text-missed-fg">
          {editError}
          <button onClick={() => setEditError(null)} className="ml-auto cursor-pointer underline">
            Dismiss
          </button>
        </div>
      )}
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
          onCellClicked={(event) => {
            if (event.data?.kind !== 'row') return;
            const editableFn = event.colDef.editable;
            // Narrow, self-contained cast: every `editable` callback defined
            // above only ever reads `.data` (see jobOf()), so a minimal
            // { data } param object is always sufficient here regardless of
            // AG Grid's richer EditableCallbackParams type.
            const isEditable =
              typeof editableFn === 'function'
                ? (editableFn as (p: { data?: GridBlock }) => boolean)({ data: event.data })
                : !!editableFn;
            // An editable cell starts editing on its own via singleClickEdit
            // below — opening the drawer too would fight that. A read-only
            // cell keeps opening the full drawer exactly as before.
            if (isEditable) return;
            onSelectJob(event.data.job.id);
          }}
          onCellValueChanged={(event) => {
            const job = jobOf(event);
            if (!job) return;
            setEditError(null);
            switch (event.column.getColId() as JobsGridColumnId) {
              case 'job':
                patchMutation.mutate({ jobId: job.id, patch: { jobSummary: job.jobSummary } });
                break;
              case 'division':
                patchMutation.mutate({ jobId: job.id, patch: { division: job.division } });
                break;
              case 'frequency':
                patchMutation.mutate({ jobId: job.id, patch: { frequencyType: job.frequencyType } });
                break;
              case 'price':
                patchMutation.mutate({ jobId: job.id, patch: { pricePerVisit: job.pricePerVisit } });
                break;
              case 'technician':
                assignMutation.mutate({ jobId: job.id, technicianId: job.defaultTechnicianId });
                break;
              default:
                break;
            }
          }}
          tabToNextCell={(params: TabToNextCellParams<GridBlock>) => {
            // Client/Frequency grouping interleaves full-width band rows
            // between job rows (see lib/grouping.ts) — without this, Tab
            // would land focus on a band row's non-editable full-width
            // cell instead of continuing across real job rows. AG Grid
            // already computed the normal next position (including
            // column wrap at row boundaries); we only need to keep
            // stepping past consecutive band rows in the same direction.
            let candidate = params.nextCellPosition;
            if (!candidate) return false;
            const step = params.backwards ? -1 : 1;
            while (candidate) {
              const rowNode = params.api.getDisplayedRowAtIndex(candidate.rowIndex);
              if (!rowNode) return false;
              if (rowNode.data?.kind !== 'band') return candidate;
              candidate = { ...candidate, rowIndex: candidate.rowIndex + step };
            }
            return false;
          }}
          headerHeight={30}
          singleClickEdit
          stopEditingWhenCellsLoseFocus
          domLayout="normal"
          className="h-full"
        />
      </div>
    </div>
  );
}