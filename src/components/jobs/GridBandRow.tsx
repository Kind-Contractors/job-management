import type { ICellRendererParams } from 'ag-grid-community';
import type { GridBlock } from '../../lib/grouping';

/** AG Grid Community full-width row renderer for a band/group header — see grouping.ts. */
export default function GridBandRow(params: ICellRendererParams<GridBlock>) {
  const block = params.data;
  if (!block || block.kind !== 'band') return null;
  return (
    <div className="flex h-full items-center gap-2.5 border-t border-b border-neutral-300 bg-neutral-200 px-5">
      <span className="font-heading text-[12.5px] font-semibold tracking-[0.11em] uppercase">
        ▾ {block.title}
      </span>
      <span className="text-[11.5px] text-neutral-600">{block.subtitle}</span>
      <span className="ml-auto text-[11.5px] text-neutral-700 tabular-nums">{block.rightLabel}</span>
    </div>
  );
}
