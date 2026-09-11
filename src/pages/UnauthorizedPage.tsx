import { useAuth } from '../auth/AuthProvider';

/**
 * Shown for a signed-in Supabase Auth user who has no app_users row, or an
 * inactive/non-manager one. RLS already denies their data queries
 * independently, but the app must never render the Manager UI shell around
 * that denial — this is the honest, explicit state instead.
 */
export default function UnauthorizedPage() {
  const { session, signOut } = useAuth();

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-200">
      <div className="w-[360px] border border-divider bg-white p-6 text-center">
        <h1 className="mb-2 font-heading text-lg font-semibold">Not set up for access</h1>
        <p className="mb-1 text-[13px] text-neutral-700">
          {session?.user.email ? <span className="font-semibold">{session.user.email}</span> : 'Your account'} isn't
          set up for access yet.
        </p>
        <p className="mb-4 text-[13px] text-neutral-700">Contact your administrator to be added.</p>
        <button
          onClick={() => void signOut()}
          className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
