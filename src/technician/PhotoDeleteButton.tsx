import { useState } from 'react';
import { createPortal } from 'react-dom';
import { HiOutlineTrash } from 'react-icons/hi2';

interface PhotoDeleteButtonProps {
  /** True for a photo that has already uploaded / is already in the report: the technician must confirm first. A photo that never left the device is removed straight away. */
  needsConfirm: boolean;
  /** Greys the control out (for example while the report is being completed). */
  disabled?: boolean;
  /** For screen readers, e.g. "Delete before photo". */
  ariaLabel: string;
  /** Does the actual deletion. Throw to report a failure - the photo then stays exactly as it was. */
  onDelete: () => Promise<void>;
  /** Called with the failure message so the screen can show it (the photo stays visible). */
  onError: (message: string) => void;
}

/**
 * The trash action on one photo tile. Must sit inside a `relative` tile: the trash icon is pinned to
 * its top-right corner.
 *
 *   idle  ->  (confirm dialog, if needed)  ->  deleting  ->  gone (the parent drops the tile) or back to idle with an error
 *
 * The confirmation is a centred dialog over a dimmed page (rendered in a portal so the small photo tile
 * cannot clip it). A photo that never left the device skips the dialog and shows "Deleting…" on its tile.
 */
export default function PhotoDeleteButton({ needsConfirm, disabled, ariaLabel, onDelete, onError }: PhotoDeleteButtonProps) {
  const [state, setState] = useState<'idle' | 'confirming' | 'deleting'>('idle');
  // True when the delete was confirmed in the dialog, so the dialog stays up (showing progress) until it finishes.
  const [confirmed, setConfirmed] = useState(false);

  const run = async (fromDialog: boolean) => {
    setConfirmed(fromDialog);
    setState('deleting');
    try {
      await onDelete();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'The photo could not be deleted.');
    } finally {
      setState('idle');
      setConfirmed(false);
    }
  };

  const busy = state === 'deleting';

  return (
    <>
      <button
        type="button"
        aria-label={ariaLabel}
        title="Delete photo"
        disabled={disabled || busy}
        onClick={() => (needsConfirm ? setState('confirming') : void run(false))}
        className="absolute -top-1.5 -right-1.5 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-missed bg-white text-missed hover:bg-missed hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        <HiOutlineTrash className="h-3 w-3" aria-hidden />
      </button>

      {busy && !confirmed && (
        <div
          role="status"
          className="absolute inset-0 z-20 flex items-center justify-center bg-white/95 text-center text-[9px] leading-tight text-ink"
        >
          Deleting…
        </div>
      )}

      {(state === 'confirming' || (busy && confirmed)) &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/50 p-4"
            onClick={() => {
              if (!busy) setState('idle');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !busy) setState('idle');
            }}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-label={ariaLabel}
              className="w-full max-w-xs rounded-lg border border-neutral-300 bg-white px-5 py-6 text-center shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm leading-snug text-ink">Are you sure you want to delete this photo?</p>
              <div className="mt-5 flex gap-3">
                <button
                  type="button"
                  autoFocus
                  disabled={busy}
                  onClick={() => setState('idle')}
                  className="h-11 flex-1 cursor-pointer rounded-md border border-neutral-300 bg-white text-sm font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(true)}
                  className="h-11 flex-1 cursor-pointer rounded-md bg-missed text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {busy ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
