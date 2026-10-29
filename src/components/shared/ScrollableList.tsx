import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Lists longer than this scroll within their card. */
export const LIST_SCROLL_AFTER = 5;

interface ScrollableListProps {
  /** How many rows the list has (each direct child is one row). */
  count: number;
  /** Names the scrolling region for screen readers, e.g. "Jobs at this building". */
  label: string;
  maxItems?: number;
  children: ReactNode;
}

/**
 * Shows every row when there are at most `maxItems` (5); beyond that the list scrolls inside its card, showing the first five rows
 * and half of the sixth, so it is clear there is more. Headers, filters and totals stay outside, always visible. The height comes
 * from the real rows (they differ: wrapped names, report dates, contact details), measured after layout - a genuine DOM side
 * effect, hence the layout effect; it is measured again when rows are added or removed and when the window is resized. Until
 * measured (and where layout cannot run, such as server rendering), a fixed fallback height applies.
 */
export default function ScrollableList({ count, label, maxItems = LIST_SCROLL_AFTER, children }: ScrollableListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const scrolls = count > maxItems;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!scrolls || !el) return;
    const measure = () => {
      const rows = Array.from(el.children) as HTMLElement[];
      const shown = rows.slice(0, maxItems).reduce((sum, row) => sum + row.offsetHeight, 0);
      const peek = Math.round((rows[maxItems]?.offsetHeight ?? 0) / 2);
      setMaxHeight(shown + peek);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [scrolls, count, maxItems]);

  if (!scrolls) return <>{children}</>;
  return (
    <div
      ref={ref}
      data-scroll-list="true"
      role="region"
      aria-label={`${label} (scroll for more)`}
      // Focusable so the list can also be scrolled with the keyboard.
      tabIndex={0}
      className={`overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-teal ${maxHeight === null ? 'max-h-[320px]' : ''}`}
      style={maxHeight === null ? undefined : { maxHeight }}
    >
      {children}
    </div>
  );
}
