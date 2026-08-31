import { useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import kindContractorsLogo from '../../assets/kind_Contractors_logo.png';

/** The only two routes whose page actually reads the `q` search param — see AllLiveJobsPage.tsx/BuildingsPage.tsx. Exact match, not startsWith, so /buildings/:id (Building File) is correctly excluded. */
const SEARCHABLE_ROUTES = ['/jobs', '/buildings'];

function initialsFor(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const initials = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return initials.toUpperCase();
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export default function TopBar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const { session, signOut } = useAuth();
  const q = searchParams.get('q') ?? '';
  const email = session?.user.email ?? '';
  const searchable = SEARCHABLE_ROUTES.includes(pathname);

  const onSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('q', value);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  return (
    <header className="flex h-[46px] flex-none items-center gap-4 border-b border-divider bg-neutral-100 px-4">
      <div className="flex items-center gap-2.5">
        <img src={kindContractorsLogo} alt="Kind Contractors" className="h-9 w-auto object-contain" />
        <div className="border-l border-divider pl-2.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Operations
        </div>
      </div>

      <div className="flex flex-1 justify-center">
        <label className="flex h-7 w-[460px] items-center gap-2 border border-neutral-300 bg-neutral-200 px-2.5 text-[12.5px]">
          <span className="text-neutral-500">⌕</span>
          <input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search jobs & buildings"
            disabled={!searchable}
            title={searchable ? undefined : 'Search is only available on the Jobs and Buildings views'}
            className="flex-1 border-0 bg-transparent text-ink outline-none placeholder:text-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="border border-neutral-300 px-1 font-heading text-[10px] font-semibold text-neutral-600">
            ⌘K
          </span>
        </label>
      </div>

      <div className="flex items-center gap-3.5 text-xs text-neutral-600">
        <span className="font-heading text-[11px] font-semibold tracking-[0.1em] uppercase">
          {dateFormatter.format(new Date())}
        </span>
        <span className="flex items-center gap-1.5 text-ink">
          <i className="flex h-5 w-5 items-center justify-center border border-teal-100 bg-teal-100 font-heading text-[9.5px] font-semibold text-teal-700 not-italic">
            {email ? initialsFor(email) : ''}
          </i>
          {email}
        </span>
        <button
          onClick={() => void signOut()}
          className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-200"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
