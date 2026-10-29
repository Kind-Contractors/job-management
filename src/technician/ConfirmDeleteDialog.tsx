import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { backdropDismiss } from '../lib/dialogHooks';

interface ConfirmDeleteDialogProps {
  /** For screen readers, e.g. "Delete before photo". */
  ariaLabel: string;
  /** The question, e.g. "Are you sure you want to delete this photo?" */
  message: ReactNode;
  /** True while the delete runs: both buttons are disabled and "Delete" reads "Deleting…". */
  busy: boolean;
  /** Cancel / click outside / Escape. Ignored while busy. */
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The centred "are you sure?" popup over a dimmed page, shared by photos (PhotoDeleteButton) and videos (TechnicianVideos) so both
 * look and behave the same. It is rendered in a portal so a small tile cannot clip it; where there is no document (server-side
 * rendering in the tests) it is rendered in place instead, so its markup can still be checked.
 */
export default function ConfirmDeleteDialog({ ariaLabel, message, busy, onCancel, onConfirm }: ConfirmDeleteDialogProps) {
  // Closes on a backdrop click only when the press also started on the backdrop (never mid-typing: see backdropDismiss).
  const backdrop = backdropDismiss(busy ? undefined : onCancel);
  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/50 p-4"
      {...backdrop}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="w-full max-w-xs rounded-lg border border-neutral-300 bg-white px-5 py-6 text-center shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm leading-snug text-ink">{message}</p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={onCancel}
            className="h-11 flex-1 cursor-pointer rounded-md border border-neutral-300 bg-white text-sm font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="h-11 flex-1 cursor-pointer rounded-md bg-missed text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
