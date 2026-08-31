import type { JobRow } from '../../domain/types';
import type { GridBlock } from '../../lib/grouping';
import { deriveMonthCellStates, type MonthCellState } from '../../lib/monthMatrix';
import { getMonthCellPresentation } from '../../lib/statusPresentation';

const MONTH_SHORT_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MonthMatrixGridProps {
  blocks: GridBlock[];
  year: number;
  todayISO: string;
  onSelectCell: (job: JobRow, month: number, cell: MonthCellState) => void;
}

/**
 * Presentational only — every query/mutation lives in MonthMatrixPage.tsx,
 * per CLAUDE.md section 12 (orchestration in the container, not here). Built
 * as a plain grid (matching MonthGrid.tsx's Calendar precedent), not an
 * AG Grid extension — see the reviewed plan's §6 for why.
 */
export default function MonthMatrixGrid({ blocks, year, todayISO, onSelectCell }: MonthMatrixGridProps) {
  return (
    <div className="min-w-[880px] border border-neutral-300">
      <div className="grid grid-cols-[minmax(220px,1fr)_repeat(12,56px)] border-b border-neutral-300 bg-neutral-200">
        <div className="px-3 py-2 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Job</div>
        {MONTH_SHORT_LABEL.map((m) => (
          <div
            key={m}
            className="border-l border-neutral-300 px-1 py-2 text-center font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase"
          >
            {m}
          </div>
        ))}
      </div>

      {blocks.map((block) => {
        if (block.kind === 'band') {
          return (
            <div key={block.id} className="grid grid-cols-[minmax(220px,1fr)_repeat(12,56px)] border-b border-neutral-300 bg-neutral-200">
              <div className="col-span-full flex items-center gap-2.5 px-3 py-1.5">
                <span className="font-heading text-[11.5px] font-semibold tracking-[0.09em] uppercase">▾ {block.title}</span>
                <span className="text-[11px] text-neutral-600">{block.subtitle}</span>
                <span className="ml-auto text-[11px] text-neutral-700 tabular-nums">{block.rightLabel}</span>
              </div>
            </div>
          );
        }

        const job = block.job;
        const cells = deriveMonthCellStates(job, year, todayISO);

        return (
          <div key={block.id} className="grid grid-cols-[minmax(220px,1fr)_repeat(12,56px)] border-b border-neutral-300 bg-white">
            <div className="truncate px-3 py-1.5 text-[12px]">
              <span className="font-semibold">{job.buildingName}</span>
              <span className="text-neutral-500"> · {job.jobSummary}</span>
            </div>
            {cells.map((cell, i) => {
              const presentation = getMonthCellPresentation(cell.kind);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSelectCell(job, i + 1, cell)}
                  title={cell.label}
                  className={`flex h-8 cursor-pointer items-center justify-center border-l border-neutral-300 text-[10px] font-semibold tabular-nums ${presentation.className} ${
                    presentation.hollow ? 'text-neutral-400' : 'text-ink'
                  }`}
                >
                  {cell.visitCount > 1 ? cell.visitCount : ''}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
