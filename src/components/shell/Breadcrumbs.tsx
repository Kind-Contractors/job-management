import { Link } from 'react-router-dom';

export interface BreadcrumbItem {
  label: string;
  /** Where the item links to. Left out for plain-text levels and for the current page (always the last item). */
  to?: string;
}

/**
 * A breadcrumb trail: parents first, the current page last. The last item is never a link and is marked aria-current="page";
 * an item with an empty label is skipped (so a missing parent never shows as an empty or broken level). Long labels are cut
 * with an ellipsis (full text in the tooltip) and the trail wraps on narrow screens.
 */
export default function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  const shown = items.filter((item) => item.label.trim() !== '');
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
        {shown.map((item, i) => {
          const current = i === shown.length - 1;
          return (
            <li key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && (
                <span aria-hidden="true" className="text-neutral-500">
                  ›
                </span>
              )}
              {current ? (
                <span aria-current="page" title={item.label} className="max-w-[40ch] truncate font-semibold text-ink">
                  {item.label}
                </span>
              ) : item.to ? (
                <Link to={item.to} title={item.label} className="max-w-[32ch] truncate font-semibold text-teal-700 hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span title={item.label} className="max-w-[32ch] truncate text-neutral-600">
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
