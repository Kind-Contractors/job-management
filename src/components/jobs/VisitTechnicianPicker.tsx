import { useEffect, useRef, useState } from 'react';
import type { Technician } from '../../domain/types';
import { activeSelection } from '../../lib/visitTechnicianSelection';

interface VisitTechnicianPickerProps {
  /** Every technician - only active ones are ever offered. */
  technicians: Technician[];
  /** Selected technician ids in selection order. The first is stored as the visit's primary; the UI does not expose that distinction. */
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  /** Text size class shared by the host form's other inputs. */
  textClass?: string;
}

/**
 * One "Technician(s)" checkbox dropdown for a NEW booking - any number of
 * active technicians, shown as removable chips. Presentational only: the host
 * form owns the selection and calls createVisit(), which stores the first
 * selected technician as visits.technician_id and the rest in
 * visit_technicians. No cap; a checkbox is either ticked or not, so no
 * duplicates; inactive technicians are never offered.
 */
export default function VisitTechnicianPicker({ technicians, selectedIds, onChange, textClass = 'text-[12.5px]' }: VisitTechnicianPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = technicians.filter((t) => t.isActive);
  const byId = new Map(technicians.map((t) => [t.id, t]));
  // What is shown and counted: a stale (since-deactivated) job default never appears as a selection.
  const selected = activeSelection(selectedIds, technicians);
  const selectedSet = new Set(selected);
  const noneAvailable = active.length === 0;

  // Click-outside-to-close for the popover - a genuine DOM side effect (a
  // document-level listener), same approach as SearchableSelect.tsx.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const toggle = (id: string) => {
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const triggerLabel = noneAvailable ? 'No active technicians' : selected.length === 0 ? 'Unassigned - select technicians' : `${selected.length} selected`;

  return (
    <div ref={containerRef} className="relative flex flex-col gap-1 text-[11px] text-neutral-600">
      Technician(s)
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        disabled={noneAvailable}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Technicians"
        className={`flex cursor-pointer items-center justify-between border border-neutral-300 px-2 py-1.5 text-left ${textClass} text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400`}
      >
        <span>{triggerLabel}</span>
        <span aria-hidden className="text-neutral-400">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          className="absolute top-full right-0 left-0 z-10 mt-0.5 max-h-48 overflow-y-auto border border-neutral-300 bg-white shadow-md"
        >
          {active.map((t) => (
            <label key={t.id} className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 ${textClass} text-ink hover:bg-neutral-100`}>
              <input type="checkbox" checked={selectedSet.has(t.id)} onChange={() => toggle(t.id)} />
              {t.name}
            </label>
          ))}
        </div>
      )}

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {selected.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 border border-neutral-300 px-1.5 py-0.5 text-[11px] text-ink">
              {byId.get(id)?.name ?? 'Unknown'}
              <button
                type="button"
                onClick={() => toggle(id)}
                aria-label={`Remove ${byId.get(id)?.name ?? 'technician'}`}
                className="cursor-pointer text-neutral-500 hover:text-missed-fg"
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
