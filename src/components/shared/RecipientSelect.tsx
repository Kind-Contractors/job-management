import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

/** The list's tallest size (matches max-h-[280px]) and the room kept free for a sticky action bar at the bottom of the screen. */
const LIST_MAX_HEIGHT = 280;
const BOTTOM_RESERVE = 64;

export interface RecipientOption {
  value: string;
  /** The main text, in the normal colour (for example "Sam — sam@client.test"). */
  text: string;
  /** Optional words after it: a "warn" note (e.g. "not linked to Xero yet") is amber; a plain note is the normal colour. */
  note?: { text: string; warn?: boolean };
  disabled?: boolean;
}

interface RecipientSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: RecipientOption[];
  /** Names the field for screen readers (the visible heading above it). */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A dropdown for choosing a recipient that can colour PART of an option - only the warning words (e.g. "not linked to Xero yet",
 * "Accounts only") are amber, the name and email keep the normal colour. A native <select> can only colour a whole option.
 * Behaves like a select: click or Enter / Space / Alt+Down opens it; Up / Down / Home / End move; Enter or a click chooses; Escape or
 * a click outside closes; typing a letter jumps to the next option starting with it. Disabled options cannot be chosen. ARIA:
 * a select-only combobox with a listbox. The list is always rendered (hidden while closed), so every option is in the page.
 */
export default function RecipientSelect({ value, onChange, options, label, disabled = false, className = '' }: Readonly<RecipientSelectProps>) {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selectedIndex);
  // Opens upwards when there is not room for the list below the box (e.g. near the bottom of the screen, above a sticky action bar).
  const [upwards, setUpwards] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];

  // A click anywhere outside closes the open list (a document listener is a genuine side effect).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keeps the highlighted option in view while moving through a long list with the keyboard (scrolling is a DOM side effect).
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    setOpen(false);
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i;
    return from;
  };
  const openList = () => {
    const box = rootRef.current?.getBoundingClientRect();
    if (box) {
      const wanted = Math.min(LIST_MAX_HEIGHT, options.length * 28 + 8);
      const below = window.innerHeight - box.bottom - BOTTOM_RESERVE;
      setUpwards(below < wanted && box.top > below);
    }
    setActive(selectedIndex);
    setOpen(true);
  };

  // The next option (after the highlighted one, wrapping) whose text starts with the typed letter.
  const jumpTo = (letter: string) => {
    const k = letter.toLowerCase();
    for (let n = 1; n <= options.length; n += 1) {
      const i = (active + n) % options.length;
      if (!options[i].disabled && options[i].text.toLowerCase().startsWith(k)) return i;
    }
    return active;
  };
  // What each key does while the list is open.
  const openKeys: Record<string, () => void> = {
    ArrowDown: () => setActive((a) => step(a, 1)),
    ArrowUp: () => setActive((a) => step(a, -1)),
    Home: () => setActive(step(-1, 1)),
    End: () => setActive(step(options.length, -1)),
    Enter: () => choose(active),
    ' ': () => choose(active),
    Escape: () => setOpen(false),
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    const action = openKeys[e.key];
    if (action) {
      e.preventDefault();
      // Escape closes the list only, never a dialog the dropdown sits in.
      if (e.key === 'Escape') e.stopPropagation();
      action();
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      setActive(jumpTo(e.key));
    }
  };

  return (
    <div ref={rootRef} data-recipient-select className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-o${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className="flex w-full cursor-pointer items-center gap-2 border border-neutral-300 bg-white px-2 py-1 text-left text-[12.5px] text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-500"
      >
        <span className="min-w-0 flex-1 truncate">{selected ? optionText(selected) : null}</span>
        <span aria-hidden="true" className="flex-none text-[10px] text-neutral-500">▼</span>
      </button>
      <ul
        ref={listRef}
        id={`${id}-list`}
        role="listbox"
        aria-label={label}
        hidden={!open}
        className={`absolute right-0 left-0 z-30 max-h-[280px] overflow-y-auto border border-neutral-300 bg-white py-0.5 text-[12.5px] text-ink shadow-md ${
          upwards ? 'bottom-full mb-0.5' : 'top-full mt-0.5'
        }`}
      >
        {options.map((o, i) => (
          <li
            key={o.value}
            id={`${id}-o${i}`}
            role="option"
            data-value={o.value}
            aria-selected={o.value === value}
            aria-disabled={o.disabled ? true : undefined}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus on the button
              choose(i);
            }}
            onMouseEnter={() => !o.disabled && setActive(i)}
            className={[
              'px-2 py-1',
              o.disabled ? 'cursor-default text-neutral-400' : 'cursor-pointer',
              i === active && !o.disabled ? 'bg-teal-100' : '',
              o.value === value ? 'font-semibold' : '',
            ].join(' ')}
          >
            {optionText(o)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The option's words: the main text in the normal colour, then its note (amber when it is a warning). */
function optionText(o: RecipientOption) {
  return (
    <>
      <span>{o.text}</span>
      {o.note && <span className={o.note.warn ? 'text-due-fg' : undefined}>{` · ${o.note.text}`}</span>}
    </>
  );
}
