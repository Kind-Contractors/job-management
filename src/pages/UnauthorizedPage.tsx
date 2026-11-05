import { useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { APP_BUILD_ID, checkForAppUpdate, reloadNow } from '../lib/appUpdate';

/**
 * Shown for a signed-in Supabase Auth user who has no app_users row, or an
 * inactive one, or a role this version of the app doesn't know. RLS already
 * denies their data queries independently, but the app must never render the
 * Manager UI shell around that denial — this is the honest, explicit state instead.
 *
 * An OLD copy of the app (still cached after a deploy) can land here for a role
 * it doesn't know yet - so this screen first asks for a newer version (one that
 * has arrived reloads the page by itself, lib/appUpdate.ts), and says that
 * reloading may fix it rather than claiming the account is not set up.
 */
export default function UnauthorizedPage() {
  const { session, signOut } = useAuth();

  // Look for a newer app version straight away (the browser otherwise checks on its own schedule).
  useEffect(() => {
    void checkForAppUpdate();
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-200">
      <div className="w-[360px] border border-divider bg-white p-6 text-center" data-testid="unauthorized">
        <h1 className="mb-2 font-heading text-lg font-semibold">We couldn’t confirm access</h1>
        <p className="mb-1 text-[13px] text-neutral-700">
          {session?.user.email ? <span className="font-semibold">{session.user.email}</span> : 'This account'} couldn’t be confirmed for access.
        </p>
        <p className="mb-4 text-[13px] text-neutral-700">
          If you were just added, or the app was just updated, reload the page. If this keeps happening, contact your administrator.
        </p>
        <div className="flex justify-center gap-2">
          <button onClick={reloadNow} className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white">
            Reload
          </button>
          <button
            onClick={() => void signOut()}
            className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
          >
            Sign out
          </button>
        </div>
        <p className="mt-4 text-[10.5px] text-neutral-400">App version {APP_BUILD_ID}</p>
      </div>
    </div>
  );
}
