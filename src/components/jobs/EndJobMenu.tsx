import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export type EndJobChoice = 'completed' | 'lost' | 'cancelled';

const CHOICES: { choice: EndJobChoice; label: string; danger?: boolean }[] = [
  { choice: 'completed', label: 'Mark as completed' },
  { choice: 'lost', label: 'Mark as lost' },
  { choice: 'cancelled', label: 'Mark as cancelled', danger: true },
];

/**
 * "End this job" in the Schedule drawer's Details tab: a disclosure button and a small group of choices (not an ARIA menu, which
 * promises more keyboard behaviour than three buttons need). Tab / ↑ ↓ move between choices; Escape closes and returns focus to the
 * button; a press outside, or focus leaving, closes it. Choosing only reports the choice - the drawer opens the existing dialog.
 */
export default function EndJobMenu({ onSelect }: { onSelect: (choice: EndJobChoice) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Closing on a press anywhere else on the page needs a document listener - a real subscription, so an effect, attached only while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-end-job-choice]') ?? [])];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
      items[next].focus();
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative ml-auto"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // Focus left the button and its choices - Tab past the last one, or out of the page (no relatedTarget at all).
        if (open && !rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="end-job-toggle"
        className="cursor-pointer rounded-md px-2 py-1.5 text-[12.5px] font-semibold text-neutral-700 hover:bg-neutral-100"
      >
        End this job <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="End this job"
          data-testid="end-job-choices"
          // A press on the panel's text (not a choice) must not move focus to the page, which would close it as "focus left".
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest('button')) e.preventDefault();
          }}
          className="absolute right-0 bottom-full z-10 mb-1 w-56 rounded-md border border-neutral-300 bg-white p-1.5 shadow-lg"
        >
          <div className="px-2 pt-1 pb-1.5 text-[11.5px] text-neutral-500">Moves the job to Historical jobs.</div>
          {CHOICES.map((c) => (
            <button
              key={c.choice}
              type="button"
              data-end-job-choice
              onClick={() => {
                setOpen(false);
                onSelect(c.choice);
              }}
              className={`block w-full cursor-pointer rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-neutral-100 focus:bg-neutral-100 ${c.danger ? 'text-missed-fg' : 'text-ink'}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
