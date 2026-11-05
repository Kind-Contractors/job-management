import { useState } from 'react';

export const PAGE_SIZE = 25;

/**
 * Client-side paging for a list that is already filtered. `resetKey` is a string built from the filters: when it
 * changes the list starts again at page 1 (derived during render - no effect needed). The page is also clamped, so a
 * list that shrank never shows an empty page.
 */
export function usePaged<T>(rows: T[], resetKey: string, pageSize = PAGE_SIZE) {
  const [state, setState] = useState({ key: resetKey, page: 0 });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(state.key === resetKey ? state.page : 0, pageCount - 1);
  return {
    pageRows: rows.slice(page * pageSize, page * pageSize + pageSize),
    page,
    pageCount,
    total: rows.length,
    pageSize,
    setPage: (next: number) => setState({ key: resetKey, page: Math.max(0, Math.min(next, pageCount - 1)) }),
  };
}

/** "26–50 of 80" with Previous / Next. Hidden when everything fits on one page. */
export default function Pager({ page, pageCount, total, pageSize, setPage, label }: ReturnType<typeof usePaged> & { label: string }) {
  if (pageCount <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, from + pageSize - 1);
  const btn = 'cursor-pointer border border-neutral-300 bg-white px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <nav aria-label={`${label} pages`} data-testid="pager" className="flex items-center justify-end gap-2 border-t border-divider px-4 py-2 text-[11.5px] text-neutral-600">
      <span className="tabular-nums">
        {from}–{to} of {total}
      </span>
      <button type="button" className={btn} disabled={page === 0} onClick={() => setPage(page - 1)}>
        Previous
      </button>
      <span className="tabular-nums">
        Page {page + 1} of {pageCount}
      </span>
      <button type="button" className={btn} disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}
