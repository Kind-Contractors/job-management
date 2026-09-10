import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { startSyncEngine, useSyncStatus } from './offline/syncEngine';
import kindContractorsLogo from '../assets/kind_Contractors_logo.png';

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/**
 * The technician app's own, deliberately minimal shell — no left rail, no
 * global search, no division filter. None of the Manager <AppShell>'s
 * navigation applies to a one-screen-at-a-time phone flow. Never imports
 * from, or is imported by, anything under src/components/shell or src/pages.
 */
export default function TechnicianShell() {
  const { signOut } = useAuth();
  const sync = useSyncStatus();

  // Started once, here — every technician screen mounts under this shell,
  // so this is the one place that's guaranteed to run for the life of the
  // technician session. Wholly separate from AuthProvider.tsx's own
  // visibilitychange handling; never touches auth/session state.
  useEffect(() => {
    startSyncEngine();
  }, []);

  const hasPending = sync.pendingPhotoCount > 0 || sync.failedDraftCount > 0;

  return (
    <div className="flex h-screen min-h-[640px] flex-col overflow-hidden bg-neutral-200">
      <header className="flex h-[46px] flex-none items-center gap-2.5 border-b border-divider bg-neutral-100 px-4">
        <img src={kindContractorsLogo} alt="Kind Contractors" className="h-9 w-auto object-contain" />
        <div className="border-l border-divider pl-2.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Technician
        </div>
        {!sync.online ? (
          <span className="border border-missed bg-missed/10 px-1.5 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.08em] text-missed-fg uppercase">
            Offline
          </span>
        ) : sync.failedDraftCount > 0 ? (
          <span className="border border-missed bg-missed/10 px-1.5 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.08em] text-missed-fg uppercase">
            Sync failed
          </span>
        ) : (
          hasPending && (
            <span className="border border-due bg-due/10 px-1.5 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.08em] text-due-fg uppercase">
              Syncing {sync.pendingPhotoCount}
            </span>
          )
        )}
        <span className="ml-auto font-heading text-[11px] font-semibold tracking-[0.1em] text-neutral-600 uppercase">
          {dateFormatter.format(new Date())}
        </span>
        <button
          onClick={() => void signOut()}
          className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-200"
        >
          Sign out
        </button>
      </header>
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
        <div className="w-full max-w-[420px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
