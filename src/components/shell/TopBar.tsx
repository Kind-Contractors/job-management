import { useSearchParams } from 'react-router-dom';

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export default function TopBar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';

  const onSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('q', value);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  return (
    <header className="flex h-[46px] flex-none items-center gap-4 border-b border-divider bg-neutral-100 px-4">
      <div className="flex items-center gap-2">
        <div className="flex h-[22px] w-[22px] items-center justify-center bg-teal font-heading text-xs font-bold text-white">
          K
        </div>
        <div className="font-heading text-sm font-semibold tracking-[0.1em] uppercase">Kind Contractors</div>
        <div className="border-l border-divider pl-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Operations
        </div>
      </div>

      <div className="flex flex-1 justify-center">
        <label className="flex h-7 w-[460px] items-center gap-2 border border-neutral-300 bg-neutral-200 px-2.5 text-[12.5px]">
          <span className="text-neutral-500">⌕</span>
          <input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search clients, buildings, jobs, reports"
            className="flex-1 border-0 bg-transparent text-ink outline-none placeholder:text-neutral-500"
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
            AR
          </i>
          A. Reyes
        </span>
      </div>
    </header>
  );
}
