import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface SearchableSelectOption {
  id: string;
  label: string;
  sublabel?: string;
}

interface SearchableSelectProps {
  value: string;
  onChange: (id: string) => void;
  options: SearchableSelectOption[];
  placeholder: string;
  disabled?: boolean;
  /** Shown in place of the input while disabled — falls back to `placeholder` if omitted. */
  disabledMessage?: string;
  noMatchesLabel?: string;
  /** Caps how many filtered rows render at once — matches JobCreator/BuildingCreator's own cap, not a real pagination boundary. */
  resultLimit?: number;
  'aria-label'?: string;
}

/**
 * A small, reusable combobox — extracted from the two near-identical
 * hand-rolled pickers already in JobCreator.tsx (Building) and
 * BuildingCreator.tsx (Client), which are left exactly as they are, plus one
 * behavior those didn't have: focusing/clicking it opens the FULL options
 * list immediately (like a native `<select>`), not just once something is
 * typed. Typing still narrows that list live via a client-side substring
 * filter — no server-side search, pagination, or debouncing, matching this
 * app's actual scale (dozens to a few hundred rows, not thousands).
 *
 * Once a value is chosen it collapses to a "selected chip + Change" row,
 * matching the two original implementations exactly.
 *
 * Selection commits on mousedown, not click, so a fast click doesn't lose
 * the selection to a race with the input's own blur — same reasoning as
 * the two original implementations this was extracted from.
 */
export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  disabledMessage,
  noMatchesLabel = 'No matches',
  resultLimit = 20,
  ...rest
}: SearchableSelectProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.id === value);

  // Empty query -> the full list (like a native <select>'s dropdown, no
  // cap — this app's option lists are at most a few hundred rows, trivial
  // to scroll unfiltered). A typed query narrows it via substring match,
  // capped at resultLimit the same way the original pickers were.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.sublabel ?? ''}`.toLowerCase().includes(q)).slice(0, resultLimit);
  }, [options, query, resultLimit]);

  // Click-outside-to-close — independent of the row selection's own
  // mousedown handler below, so the two never race each other.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  const commit = (id: string) => {
    onChange(id);
    setQuery('');
    setOpen(false);
  };

  if (disabled) {
    return (
      <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[12.5px] text-neutral-400">
        {disabledMessage ?? placeholder}
      </div>
    );
  }

  if (selected) {
    return (
      <div className="flex items-center gap-2 border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink">
        <span className="flex-1 truncate">
          {selected.label}
          {selected.sublabel ? ` · ${selected.sublabel}` : ''}
        </span>
        <button type="button" onClick={() => onChange('')} className="cursor-pointer text-[11px] text-teal-700 hover:underline">
          Change
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        {...rest}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlightedIndex((i) => Math.min(i + 1, matches.length - 1));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightedIndex((i) => Math.max(i - 1, 0));
            return;
          }
          if (e.key === 'Enter') {
            const target = matches[highlightedIndex];
            if (target) {
              e.preventDefault();
              commit(target.id);
            }
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal"
      />
      {open && (
        <div id={listId} role="listbox" className="max-h-60 overflow-y-auto border border-t-0 border-neutral-300">
          {matches.length > 0 ? (
            matches.map((m, i) => (
              <div
                key={m.id}
                role="option"
                aria-selected={i === highlightedIndex}
                onMouseDown={(e) => {
                  // mousedown, not click: fires before the input's blur (and
                  // before the click-outside listener above can act on it),
                  // so the selection can never be lost to that race.
                  e.preventDefault();
                  commit(m.id);
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
                className={`cursor-pointer border-b border-divider px-2 py-1.5 text-[12px] last:border-b-0 ${
                  i === highlightedIndex ? 'bg-neutral-100' : 'hover:bg-neutral-100'
                }`}
              >
                <div className="font-semibold">{m.label}</div>
                {m.sublabel && <div className="text-neutral-500">{m.sublabel}</div>}
              </div>
            ))
          ) : (
            <div className="px-2 py-1.5 text-[12px] text-neutral-500">{noMatchesLabel}</div>
          )}
        </div>
      )}
    </div>
  );
}
