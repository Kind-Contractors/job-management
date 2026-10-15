import type { ICellRendererParams } from 'ag-grid-community';
import type { GridBlock } from '../../lib/grouping';
import BandToggle from '../shared/BandToggle';

/** What JobsGrid puts on AG Grid's `context` so this renderer can drive collapsing. */
export interface GridBandContext {
  onToggleBand?: (bandId: string) => void;
}

/**
 * AG Grid Community full-width row renderer for a band/group header — see grouping.ts.
 *
 * Collapsing is real: AG Grid Community has no row grouping, so it is the flat-array filter in `collapseBlocks`,
 * triggered by the shared BandToggle. The whole band is clickable too, so the hit target is the full row.
 */
export default function GridBandRow(params: ICellRendererParams<GridBlock>) {
  const block = params.data;
  if (!block || block.kind !== 'band') return null;

  const { onToggleBand } = (params.context ?? {}) as GridBandContext;
  const collapsed = block.collapsed === true;
  const toggle = () => onToggleBand?.(block.id);

  return (
    // px-4 (16px) matches AG Grid's own real column inset here — the
    // Theming API's cellHorizontalPadding is spacing(8) * 2 = 16px, the
    // same padding the grid already applies to every header/body cell —
    // not an independently-picked value, so the group title lines up with
    // the column values directly beneath it.
    <div
      className={`flex h-full items-center gap-2.5 border-t border-b border-neutral-300 bg-neutral-200 px-4 ${
        onToggleBand ? 'cursor-pointer hover:bg-neutral-300/70' : ''
      }`}
      onClick={onToggleBand ? toggle : undefined}
    >
      <BandToggle collapsed={collapsed} title={block.title} onToggle={onToggleBand ? toggle : undefined} />
      <span className="font-heading text-[12.5px] font-semibold tracking-[0.11em] uppercase">{block.title}</span>
      <span className="text-[11.5px] text-neutral-600">{block.subtitle}</span>
      {collapsed && (
        <span className="text-[11.5px] text-neutral-500 tabular-nums">
          {block.rowCount} job{block.rowCount === 1 ? '' : 's'} hidden
        </span>
      )}
      <span className="ml-auto text-[11.5px] text-neutral-700 tabular-nums">{block.rightLabel}</span>
    </div>
  );
}
