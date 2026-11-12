import { useState, useSyncExternalStore } from 'react';
import { getAppUpdateState, reloadNow, subscribeAppUpdate, type AppUpdateState } from '../../lib/appUpdate';

/** Only the waits that change what "Reload now" means are spelled out; the others are covered by the main text. */
const WHY: Partial<Record<NonNullable<AppUpdateState['waitingFor']>, string>> = {
  upload: 'It will load when the photos and videos have finished uploading.',
  unsaved: 'Save your changes first - or reload now and lose them.',
};

interface UpdateBarViewProps {
  waitingFor: AppUpdateState['waitingFor'];
  onReload: () => void;
  /** Hides the card for now; the new version still loads at the next safe moment (see lib/appUpdate.ts). */
  onLater: () => void;
  /** Release notes, when there are any to link to. */
  whatsNewUrl?: string;
}

/** Presentational: the "new version ready" card. */
export function UpdateBarView({ waitingFor, onReload, onLater, whatsNewUrl }: UpdateBarViewProps) {
  const why = waitingFor ? WHY[waitingFor] : undefined;
  return (
    <div
      role="status"
      aria-labelledby="update-bar-title"
      data-testid="update-bar"
      className="fixed right-4 bottom-4 left-4 z-50 overflow-hidden rounded-2xl border border-neutral-200 bg-white text-ink shadow-xl sm:left-auto sm:w-[420px]"
    >
      <div className="flex gap-4 px-5 pt-5 pb-4">
        <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-teal text-white">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" />
            <path d="M20 4v7h-7" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h2 id="update-bar-title" className="flex-1 text-[15px] leading-snug font-semibold text-ink">
              A new version is ready
            </h2>
            <button
              type="button"
              onClick={onLater}
              aria-label="Close"
              className="-mt-1 -mr-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[18px] leading-none text-neutral-600 hover:bg-neutral-100 hover:text-ink"
            >
              ×
            </button>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-700">
            Reload to get the latest fixes. It only takes a moment. If you&rsquo;d rather finish what you&rsquo;re doing, it will update the next
            time you open the app.
          </p>
          {why && <p className="mt-1.5 text-[12.5px] leading-relaxed font-semibold text-due-fg">{why}</p>}
          {whatsNewUrl && (
            <a href={whatsNewUrl} target="_blank" rel="noreferrer" className="mt-2.5 inline-block text-[13px] font-semibold text-teal underline underline-offset-2">
              See what&rsquo;s new
            </a>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2.5 border-t border-neutral-200 bg-neutral-100 px-5 py-3.5">
        <button
          type="button"
          onClick={onLater}
          className="cursor-pointer rounded-lg border border-neutral-300 bg-white px-4 py-2 text-[13.5px] font-medium text-ink hover:bg-neutral-100"
        >
          Later
        </button>
        <button type="button" onClick={onReload} className="cursor-pointer rounded-lg bg-teal px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-teal-700">
          Reload now
        </button>
      </div>
    </div>
  );
}

/** Shown only while a new version waits for a safe moment to load (see lib/appUpdate.ts). */
export default function UpdateBar() {
  const state = useSyncExternalStore(subscribeAppUpdate, getAppUpdateState, getAppUpdateState);
  const [hidden, setHidden] = useState(false);
  if (!state.ready || hidden) return null;
  return <UpdateBarView waitingFor={state.waitingFor} onReload={reloadNow} onLater={() => setHidden(true)} />;
}
