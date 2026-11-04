import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { backdropDismiss } from '../lib/dialogHooks';

interface WasteConfirmDialogProps {
  ariaLabel: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button for something that throws work away. */
  destructive?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** A centred "are you sure?" popup for the waste reporter's screens (send with an empty section, discard a draft, remove a file). */
export default function WasteConfirmDialog({ ariaLabel, message, confirmLabel, cancelLabel = 'Go back', destructive, busy = false, onCancel, onConfirm }: WasteConfirmDialogProps) {
  const backdrop = backdropDismiss(busy ? undefined : onCancel);
  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/50 p-4"
      {...backdrop}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel();
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-label={ariaLabel} className="w-full max-w-xs border border-neutral-300 bg-white px-5 py-6 text-center shadow-xl" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm leading-snug text-ink">{message}</p>
        <div className="mt-5 flex gap-2">
          <button type="button" autoFocus disabled={busy} onClick={onCancel} className="flex-1 cursor-pointer border border-neutral-300 py-2.5 text-sm text-neutral-700 disabled:opacity-60">
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`flex-1 cursor-pointer py-2.5 text-sm font-semibold text-white disabled:opacity-60 ${destructive ? 'bg-missed' : 'bg-teal'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
