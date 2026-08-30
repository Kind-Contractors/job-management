import { useAuth } from '../auth/AuthProvider';

/**
 * Shown when the app_users lookup itself failed (a real Supabase/network
 * error), not when it succeeded and said the account isn't a manager — see
 * AuthProvider.tsx's checkAuthorization(). Fully blocked from the app's
 * routes exactly like UnauthorizedPage, just with a retry instead of only
 * a dead end.
 */
export default function AuthCheckFailedPage() {
  const { recheck, signOut } = useAuth();

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-200">
      <div className="w-[360px] border border-divider bg-white p-6 text-center">
        <h1 className="mb-2 font-heading text-lg font-semibold">Couldn't verify your access</h1>
        <p className="mb-4 text-[13px] text-neutral-700">
          This is usually a temporary connection problem — try again, or sign out and back in.
        </p>
        <div className="flex justify-center gap-1.5">
          <button
            onClick={recheck}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          >
            Try again
          </button>
          <button
            onClick={() => void signOut()}
            className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
