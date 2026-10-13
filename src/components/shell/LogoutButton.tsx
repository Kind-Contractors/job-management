/**
 * The Manager header's log-out control. It only calls the `signOut` handed to
 * it (AuthProvider's — which also purges this user's own persisted read cache
 * and leaves the offline queue alone); it never touches auth or storage itself.
 *
 * Touch-sized (44px) below the `lg` breakpoint so it is easy to hit on a phone,
 * and back to the original compact header button from `lg` up.
 */
export default function LogoutButton({ onLogout }: { onLogout: () => void }) {
  return (
    <button
      type="button"
      onClick={onLogout}
      aria-label="Log out"
      className="inline-flex min-h-11 min-w-11 flex-none cursor-pointer items-center justify-center border border-neutral-300 px-3 text-[12px] whitespace-nowrap text-neutral-600 hover:bg-neutral-200 lg:min-h-0 lg:min-w-0 lg:px-2 lg:py-1 lg:text-[11px]"
    >
      Log out
    </button>
  );
}
