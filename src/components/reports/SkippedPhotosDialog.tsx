// Shown before a report PDF is downloaded, viewed or sent when some photos could not be read. Used by the Send to client screen
// and the Building screen's job reports.
import { backdropDismiss } from "../../lib/dialogHooks";

interface SkippedPhotosDialogProps {
  count: number;
  action: "download" | "send" | "view";
  onCancel: () => void;
  onContinue: () => void;
}

/** Shown before Download/Send when some photos couldn't be read — the report is never sent or downloaded until the manager explicitly chooses to continue without them. */
export default function SkippedPhotosDialog({
  count,
  action,
  onCancel,
  onContinue,
}: SkippedPhotosDialogProps) {
  // Closes on a backdrop click only when the press also started on the backdrop (never mid-typing: see backdropDismiss).
  const backdrop = backdropDismiss(onCancel);
  const noun = count === 1 ? "photo" : "photos";
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30"
      {...backdrop}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] border border-missed bg-white p-4"
      >
        <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-missed-fg uppercase">
          {count} {noun} can't be included
        </div>
        <div className="mt-2 text-[12.5px] text-ink">
          {count} {noun} couldn't be read, so {count === 1 ? "it" : "they"} will
          be missing from this report. You can{" "}
          {action}{" "}the report without{" "}
          {count === 1 ? "it" : "them"}, or cancel and try again.
        </div>
        <div className="mt-3.5 flex gap-1.5">
          <button
            onClick={onContinue}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white"
          >
            {action === "send" ? "Send without them" : action === "view" ? "View without them" : "Download without them"}
          </button>
          <button
            onClick={onCancel}
            className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
