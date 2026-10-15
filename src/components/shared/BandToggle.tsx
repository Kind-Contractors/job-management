/**
 * The collapse/expand control on a client/frequency band, shared by all three banded screens — All Live Jobs
 * (via GridBandRow), the Monthly Plan and the Month Matrix — so the caret's size, weight and behaviour can only
 * ever be changed in one place.
 *
 * A real `<button>`, not a glyph: it carries `aria-expanded` and a spoken label, and is a 24px target rather
 * than a character. The band row behind it is usually clickable too, which is why the click is stopped here —
 * otherwise the toggle would run twice and cancel itself out.
 */
export default function BandToggle({
  collapsed,
  title,
  onToggle,
}: {
  collapsed: boolean;
  /** The band's own name, so the button can say what it will open or shut. */
  title: string;
  /** Omitted when the host cannot toggle — the control is then shown inert rather than offering a dead click. */
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      disabled={!onToggle}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
      className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center border border-neutral-400 bg-white text-[15px] leading-none text-ink hover:bg-neutral-100 disabled:cursor-default disabled:border-transparent disabled:bg-transparent"
    >
      <span aria-hidden="true" className={`block leading-none ${collapsed ? '-rotate-90' : ''}`}>
        ▾
      </span>
    </button>
  );
}
