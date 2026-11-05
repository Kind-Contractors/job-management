import { useEffect, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import ChangePasswordDialog from '../auth/ChangePasswordDialog';
import { startWasteSyncEngine, subscribeWasteReportSent, useWasteSyncStatus } from './offline/wasteSyncEngine';
import { getMyDisplayName } from './wasteApi';
import { askToKeepStoredData, getWakeLockState, keepScreenAwake, subscribeWakeLock, type WakeLockState } from './wakeLock';
import kindContractorsLogo from '../assets/kind_Contractors_logo.png';

/** The query key of his own submitted reports (scoped to the signed-in user, like every per-user cache entry). */
export function myWasteReportsKey(userId: string) {
  return ['wasteMyReports', userId] as const;
}

const badge = 'px-1.5 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.08em] uppercase border';

/**
 * The waste reporter's whole app: a phone-sized shell with two tabs (New report / My reports). Like the technician shell it never
 * imports the manager's navigation; it only ever renders the waste screens.
 */
export default function WasteShell() {
  const { signOut, session } = useAuth();
  const userId = session?.user.id ?? '';
  const sync = useWasteSyncStatus();
  const queryClient = useQueryClient();
  const [changingPassword, setChangingPassword] = useState(false);
  const { data: name } = useQuery({ queryKey: ['wasteWhoAmI', userId], queryFn: getMyDisplayName, enabled: userId !== '', staleTime: 5 * 60_000 });

  // Starts the upload/send engine once for the life of the session (it keeps working whichever waste screen is open).
  useEffect(() => {
    startWasteSyncEngine();
    // Best effort: ask the browser to keep this site's drafts and queued files even when the phone runs short of space.
    void askToKeepStoredData();
  }, []);

  // While files are uploading the screen is kept on where the phone allows it (uploads pause when the phone locks or the app is in
  // the background - nothing a web app can change). Uploads never depend on it.
  const uploadingNow = sync.online && sync.uploading > 0;
  useEffect(() => {
    keepScreenAwake(uploadingNow);
  }, [uploadingNow]);
  const wakeLock = useSyncExternalStore(subscribeWakeLock, getWakeLockState, getWakeLockState);

  // A report confirmed by the server shows up in "My reports" straight away.
  useEffect(() => {
    return subscribeWasteReportSent(() => {
      void queryClient.invalidateQueries({ queryKey: ['wasteMyReports'] });
    });
  }, [queryClient]);

  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex-1 py-2.5 text-center text-[13px] ${isActive ? 'border-b-2 border-teal font-semibold text-teal' : 'border-b-2 border-transparent text-neutral-600'}`;

  return (
    <div className="flex h-screen min-h-[560px] flex-col overflow-hidden bg-neutral-200">
      <header className="flex h-[46px] flex-none items-center gap-2 border-b border-divider bg-neutral-100 px-3">
        <img src={kindContractorsLogo} alt="Kind Contractors" className="h-8 w-auto object-contain" />
        <div className="border-l border-divider pl-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Waste reports</div>
        {!sync.online ? (
          <span className={`${badge} border-missed bg-missed/10 text-missed-fg`}>Offline</span>
        ) : sync.failed > 0 || sync.refusedReports > 0 ? (
          <span className={`${badge} border-missed bg-missed/10 text-missed-fg`}>Needs attention</span>
        ) : (
          (sync.uploading > 0 || sync.waitingReports > 0) && <span className={`${badge} border-due bg-due/10 text-due-fg`}>Uploading</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {name && <span className="hidden text-[12px] text-ink min-[400px]:inline">{name}</span>}
          <button onClick={() => setChangingPassword(true)} className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600" aria-label="Change password">
            Password
          </button>
          <button onClick={() => void signOut()} className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600">
            Sign out
          </button>
        </div>
      </header>
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
        <div className="w-full max-w-[480px] bg-white">
          <nav className="sticky top-0 z-10 flex border-b border-divider bg-white">
            <NavLink to="/waste" end className={tab}>
              New report
            </NavLink>
            <NavLink to="/waste/reports" className={tab}>
              My reports{sync.waitingReports > 0 && ` (${sync.waitingReports} sending)`}
            </NavLink>
          </nav>
          {uploadingNow && <KeepOpenNotice wakeLock={wakeLock} />}
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/** Shown while files upload: uploads only move while this screen is open. */
export function KeepOpenNotice({ wakeLock }: { wakeLock: WakeLockState }) {
  return (
    <div data-testid="waste-keep-open" className="border-b border-due bg-due/10 px-4 py-2 text-[12px] text-due-fg">
      Uploading - keep this screen open until it’s finished. Uploads pause when the phone locks or you switch apps.
      {wakeLock === 'on' ? ' The screen will stay on meanwhile.' : ' Turn off Auto-Lock while it uploads if you can.'}
    </div>
  );
}
