import { useSyncExternalStore } from 'react';
import { getAppUpdateState, reloadNow, subscribeAppUpdate, type AppUpdateState } from '../../lib/appUpdate';

const WHY: Record<NonNullable<AppUpdateState['waitingFor']>, string> = {
  upload: 'It will load when the photos and videos have finished uploading.',
  unsaved: 'Save your changes first - or reload now and lose them.',
  screen: 'It will load next time you come back to the app.',
  you: 'Reload when it suits you.',
};

/** Presentational: the "new version ready" bar. */
export function UpdateBarView({ waitingFor, onReload }: { waitingFor: AppUpdateState['waitingFor']; onReload: () => void }) {
  return (
    <div
      role="status"
      data-testid="update-bar"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-teal-700 bg-teal-100 px-4 py-2 text-[12.5px] text-ink"
    >
      <span className="font-semibold">A new version of the app is ready.</span>
      {waitingFor && <span className="text-neutral-700">{WHY[waitingFor]}</span>}
      <button type="button" onClick={onReload} className="ml-auto cursor-pointer bg-teal px-3 py-1 text-[12px] font-semibold text-white">
        Reload
      </button>
    </div>
  );
}

/** Shown only while a new version waits for a safe moment to load (see lib/appUpdate.ts). */
export default function UpdateBar() {
  const state = useSyncExternalStore(subscribeAppUpdate, getAppUpdateState, getAppUpdateState);
  if (!state.ready) return null;
  return <UpdateBarView waitingFor={state.waitingFor} onReload={reloadNow} />;
}
