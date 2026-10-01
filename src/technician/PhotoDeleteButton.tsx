import { useState } from 'react';
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
 * its top-right corner, and the confirm / deleting states cover the tile.
 *
 *   idle  ->  (confirm, if needed)  ->  deleting  ->  gone (the parent drops the tile) or back to idle with an error
 */
export default function PhotoDeleteButton({ needsConfirm, disabled, ariaLabel, onDelete, onError }: PhotoDeleteButtonProps) {
  const [state, setState] = useState<'idle' | 'confirming' | 'deleting'>('idle');

  const run = async () => {
    setState('deleting');
    try {
      await onDelete();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'The photo could not be deleted.');
    } finally {
      setState('idle');
    }
  };

  if (state === 'idle') {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        title="Delete photo"
        disabled={disabled}
        onClick={() => (needsConfirm ? setState('confirming') : void run())}
        className="absolute -top-1.5 -right-1.5 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-neutral-400 bg-white text-neutral-600 hover:border-missed hover:text-missed-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        <HiOutlineTrash className="h-3 w-3" aria-hidden />
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-0.5 bg-white/95 text-center text-[9px] leading-tight text-ink"
    >
      {state === 'deleting' ? (
        <span>Deleting…</span>
      ) : (
        <>
          <span className="font-semibold">Delete?</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => void run()}
              className="cursor-pointer rounded-sm border border-missed bg-missed px-1.5 py-0.5 text-[9px] font-semibold text-white"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setState('idle')}
              className="cursor-pointer rounded-sm border border-neutral-400 bg-white px-1.5 py-0.5 text-[9px] text-neutral-700"
            >
              No
            </button>
          </div>
        </>
      )}
    </div>
  );
}
