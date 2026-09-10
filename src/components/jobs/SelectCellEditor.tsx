import type { CustomCellEditorProps } from 'ag-grid-react';
import type { GridBlock } from '../../lib/grouping';

export interface SelectCellEditorOption {
  value: string;
  label: string;
}

export interface SelectCellEditorParams {
  options: SelectCellEditorOption[];
  /** Label for the blank/"clear" option — omit entirely to disallow clearing to blank. */
  blankLabel?: string;
}

/**
 * One generic dropdown cell editor, reused by JobsGrid's Frequency,
 * Division, and Technician columns — each needs a labeled select bound to
 * a raw enum/id, which AG Grid Community's built-in agSelectCellEditor
 * can't label distinctly from its stored value (it just stringifies
 * whatever's in `values`, which would show raw UUIDs for Technician).
 * Uses AG Grid's standard `value`/`onValueChange` contract directly — the
 * column's own valueGetter must return the raw editable value (not a
 * display label) for this to show the right option pre-selected. Commits
 * and closes the moment a choice is made, matching every plain `<select>`
 * already used elsewhere in this app (JobEditor, JobCreator,
 * JobInspectorDrawer) rather than requiring a separate Enter press. If the
 * user clicks away without choosing, `onValueChange` is simply never
 * called, so AG Grid's default stop-on-blur behavior commits the
 * unchanged original value — no explicit cancel handling needed.
 */
export default function SelectCellEditor(props: CustomCellEditorProps<GridBlock, string | null> & SelectCellEditorParams) {
  const { options, blankLabel, value, onValueChange, stopEditing } = props;

  return (
    <select
      autoFocus
      defaultValue={value ?? ''}
      onChange={(e) => {
        onValueChange(e.target.value || null);
        stopEditing();
      }}
      className="h-full w-full cursor-pointer border-0 bg-white px-2 text-[12.5px] text-ink outline-none"
    >
      {blankLabel != null && <option value="">{blankLabel}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}