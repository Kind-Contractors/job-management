import { useQuery } from '@tanstack/react-query';
import { useLocation, useSearchParams, useNavigate } from 'react-router-dom';
import { listJobRows } from '../../repository/jobsRepository';

type AttentionKey = 'review' | 'needs_booking' | 'missed';

const ATTENTION_ITEMS: { key: AttentionKey; label: string; dotClass: string }[] = [
  { key: 'review', label: 'Reports to review', dotClass: 'bg-teal-700' },
  { key: 'needs_booking', label: 'Due, not scheduled', dotClass: 'bg-due' },
  { key: 'missed', label: 'Missed visits', dotClass: 'bg-missed' },
];

/** Not modeled yet — no visits/reports schema exists (CLAUDE.md section 13). */
const NOT_YET_BUILT_ATTENTION = [{ label: 'Ready for accounts' }, { label: 'Photos uploading' }];

const NOT_YET_BUILT_VIEWS = ['Month matrix', 'This week', 'Buildings', 'Report review'];

const DIVISIONS = ['General', 'Specialist', 'Both'] as const;

function navLinkClasses(active: boolean) {
  return [
    'flex items-center gap-2.5 px-4 py-1.5 text-[13px] border-l-2 cursor-pointer hover:bg-neutral-200',
    active ? 'border-ink bg-neutral-200 font-semibold' : 'border-transparent font-normal',
  ].join(' ');
}

export default function NavRail() {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const { data: jobRows = [] } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const status = searchParams.get('status');
  const group = searchParams.get('group') ?? 'client';
  const division = searchParams.get('division') ?? 'Both';
  const onJobs = pathname === '/jobs';

  const divisionFiltered = jobRows.filter((j) => division === 'Both' || j.division === division);

  const counts: Record<AttentionKey, number> = {
    review: divisionFiltered.filter((j) => j.status === 'review').length,
    needs_booking: divisionFiltered.filter((j) => j.status === 'needs_booking').length,
    missed: divisionFiltered.filter((j) => j.status === 'missed').length,
  };

  const goToFilteredJobs = (key: AttentionKey) => {
    const next = new URLSearchParams(searchParams);
    next.set('status', key);
    next.delete('group');
    navigate(`/jobs?${next.toString()}`);
  };

  const goToView = (nextGroup: 'client' | 'frequency') => {
    const next = new URLSearchParams(searchParams);
    next.delete('status');
    if (nextGroup === 'frequency') next.set('group', 'frequency');
    else next.delete('group');
    navigate(`/jobs?${next.toString()}`);
  };

  const setDivision = (d: (typeof DIVISIONS)[number]) => {
    const next = new URLSearchParams(searchParams);
    if (d === 'Both') next.delete('division');
    else next.set('division', d);
    setSearchParams(next, { replace: true });
  };

  return (
    <nav className="flex w-[236px] flex-none flex-col overflow-y-auto border-r border-divider bg-neutral-100 py-4">
      <div className="px-4 pb-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
        Needs you · today
      </div>
      {ATTENTION_ITEMS.map((item) => (
        <div
          key={item.key}
          onClick={() => goToFilteredJobs(item.key)}
          className={navLinkClasses(onJobs && status === item.key)}
        >
          <i className={`block h-[7px] w-[7px] flex-none ${item.dotClass}`} />
          {item.label}
          <b className="ml-auto font-body text-xs tabular-nums">{counts[item.key]}</b>
        </div>
      ))}
      {NOT_YET_BUILT_ATTENTION.map((item) => (
        <div
          key={item.label}
          title="Not built yet — no visits/reports schema exists in this pass"
          className="flex cursor-default items-center gap-2.5 border-l-2 border-transparent px-4 py-1.5 text-[13px] text-neutral-500"
        >
          <i className="block h-[7px] w-[7px] flex-none bg-neutral-300" />
          {item.label}
          <b className="ml-auto font-body text-xs text-neutral-400">—</b>
        </div>
      ))}

      <div className="mx-4 my-4 h-px bg-divider" />

      <div className="px-4 pb-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
        Views of the same data
      </div>
      <div
        onClick={() => goToView('client')}
        className={navLinkClasses(onJobs && !status && group !== 'frequency')}
      >
        All live jobs
        <span className="ml-auto text-[11px] text-neutral-500 tabular-nums">{jobRows.length}</span>
      </div>
      <div
        onClick={() => goToView('frequency')}
        className={navLinkClasses(onJobs && !status && group === 'frequency')}
      >
        By frequency
        <span className="ml-auto text-[11px] text-neutral-500 tabular-nums">{jobRows.length}</span>
      </div>
      {NOT_YET_BUILT_VIEWS.map((label) => (
        <div
          key={label}
          title="Not built yet — this pass only covers All live jobs / By frequency"
          className="flex cursor-default items-center border-l-2 border-transparent px-4 py-1.5 text-[13px] text-neutral-400"
        >
          {label}
          <span className="ml-auto text-[11px] text-neutral-300">—</span>
        </div>
      ))}

      <div className="mt-auto px-4 pt-4 pb-2">
        <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Division
        </div>
        <div className="grid grid-cols-3 border border-neutral-300">
          {DIVISIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDivision(d)}
              className={[
                'border-l border-neutral-300 py-1 text-center text-[11.5px] first:border-l-0',
                division === d ? 'bg-teal font-semibold text-white' : 'font-normal text-neutral-700',
              ].join(' ')}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="mt-3 text-[11.5px] leading-normal text-neutral-600">
          One master record per job. Every view above reads the same row.
        </div>
      </div>
    </nav>
  );
}
