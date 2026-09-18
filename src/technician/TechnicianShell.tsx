import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import ChangePasswordDialog from '../auth/ChangePasswordDialog';
import { startSyncEngine, subscribeReportSynced, useSyncStatus } from './offline/syncEngine';
import { getCurrentTechnician } from './api';
import kindContractorsLogo from '../assets/kind_Contractors_logo.png';

/**
 * The three list queries a newly booked/assigned visit, or a newly
 * synced/returned report, could affect — invalidated together below rather
 * than a broader "invalidate everything technician" so an unrelated cache
 * entry (e.g. technicianWhoAmI) is never forced to refetch by this.
 */
const VISIT_LIST_QUERY_KEYS: readonly (readonly string[])[] = [
  ['technician', 'todayVisits'],
  ['technician', 'upcomingVisits'],
  ['technician', 'needsCorrection'],
];

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
  const queryClient = useQueryClient();
  const [changingPassword, setChangingPassword] = useState(false);
  // Cached indefinitely for the session — a technician's own name never
  // changes mid-session, so there's no reason to refetch it on every
  // navigation the way visit data does.
  const { data: technician } = useQuery({
    queryKey: ['technicianWhoAmI'],
    queryFn: getCurrentTechnician,
    staleTime: Infinity,
  });

  // Started once, here — every technician screen mounts under this shell,
  // so this is the one place that's guaranteed to run for the life of the
  // technician session. Wholly separate from AuthProvider.tsx's own
  // visibilitychange handling; never touches auth/session state.
  useEffect(() => {
    startSyncEngine();
  }, []);

  // Newly booked/assigned jobs, and reports returned for correction, are
  // changes the app has no way to detect on its own — they happen on
  // someone else's device. Re-checking immediately the moment this device
  // is actually able to reach the server again (reconnects, or the tab/app
  // comes back to the foreground) closes the gap the 5-minute staleTime on
  // these queries would otherwise leave open, without lowering that
  // staleTime globally (see DayViewPage.tsx's own comment on why it stays
  // 5 minutes for the "already fresh enough, don't bother" case).
  // invalidateQueries only ever triggers a real network request for an
  // ACTIVE (mounted) query, and TanStack Query's default networkMode
  // ('online') defers even that until the browser is actually online — so
  // this is a safe no-op while offline or while no technician screen that
  // reads these keys is mounted.
  useEffect(() => {
    const refreshVisitLists = () => {
      for (const queryKey of VISIT_LIST_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshVisitLists();
    };
    window.addEventListener('online', refreshVisitLists);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', refreshVisitLists);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queryClient]);

  // The targeted bridge from the (deliberately framework-agnostic) offline
  // sync engine to TanStack Query — fires only for a genuine server-
  // confirmed report outcome (a real success, or a safely-resolved
  // duplicate; see syncEngine.ts's trySubmitIfReady()), never for routine
  // photo-upload progress. Invalidating visitDetail for the specific visit
  // (rather than every cached visit) plus the three list queries is what
  // makes JobFilePage/JobReportPage's existing "already submitted" checks
  // see the true state promptly instead of waiting out their own
  // staleTime.
  useEffect(() => {
    return subscribeReportSynced((visitId) => {
      void queryClient.invalidateQueries({ queryKey: ['technician', 'visitDetail', visitId] });
      for (const queryKey of VISIT_LIST_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
    });
  }, [queryClient]);

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
        {technician?.name && <span className="text-[12px] text-ink">{technician.name}</span>}
        <button
          onClick={() => setChangingPassword(true)}
          className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-200"
        >
          Change password
        </button>
        <button
          onClick={() => void signOut()}
          className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-200"
        >
          Sign out
        </button>
      </header>
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
        <div className="w-full max-w-[420px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
