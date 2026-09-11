import type { ICellRendererParams } from 'ag-grid-community';
import type { GridBlock } from '../../lib/grouping';

/** AG Grid Community full-width row renderer for a band/group header — see grouping.ts. */
export default function GridBandRow(params: ICellRendererParams<GridBlock>) {
  const block = params.data;
  if (!block || block.kind !== 'band') return null;
  return (
    // px-4 (16px) matches AG Grid's own real column inset here — the
    // Theming API's cellHorizontalPadding is spacing(8) * 2 = 16px, the
    // same padding the grid already applies to every header/body cell —
    // not an independently-picked value, so the group title lines up with
    // the column values directly beneath it.
    <div className="flex h-full items-center gap-2.5 border-t border-b border-neutral-300 bg-neutral-200 px-4">
      <span className="font-heading text-[12.5px] font-semibold tracking-[0.11em] uppercase">
        ▾ {block.title}
      </span>
      <span className="text-[11.5px] text-neutral-600">{block.subtitle}</span>
      <span className="ml-auto text-[11.5px] text-neutral-700 tabular-nums">{block.rightLabel}</span>
    </div>
  );
}
