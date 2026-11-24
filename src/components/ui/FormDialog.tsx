import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FormDialogProps {
  /** Small upper-case label above the title, e.g. "Edit job". */
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  /** Max width in px (it is never wider than the screen). */
  width?: number;
  /** Actions pinned under the scrolling body, so the main button is always in reach however long the form is. */
  footer?: ReactNode;
}

/**
 * A form in a dialog over the page - the same rules as the building editor's dialog (BuildingEditor.tsx): closed only deliberately
 * (the close button, a Cancel in the form, or Escape) and never by a click outside it, so a half-filled form is never lost by a stray
 * click. Focus moves into it when it opens, stays inside it (Tab wraps around), and goes back to whatever opened it when it closes.
 * The body scrolls on its own, so a long form never stretches the page.
 */
export default function FormDialog({ eyebrow, title, onClose, children, testId, width = 640, footer }: FormDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  // What had focus when the dialog opened (read before any field inside takes focus), to give focus back on close.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));

  // Focus is a real side effect on the page (not React state): move it into the dialog once, and hand it back on close.
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30 p-2"
      data-testid={testId}
      // A click on the backdrop does nothing - and keeps focus in the dialog, so Escape still closes it afterwards.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`${eyebrow}: ${title}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ width: `min(${width}px, 100%)` }}
        className="flex max-h-[90vh] flex-col border border-neutral-300 bg-white shadow-xl outline-none"
      >
        <div className="flex flex-none items-center gap-2 border-b border-divider px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">{eyebrow}</div>
            <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex-none cursor-pointer px-2 py-1 text-[15px] leading-none text-neutral-600 hover:bg-neutral-100">
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex-none border-t border-divider bg-neutral-50 px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}
