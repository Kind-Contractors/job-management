import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

type AutoGrowTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> & {
  /** Minimum height in text rows; the box grows past this to fit its content. */
  minRows?: number;
};

/**
 * A textarea that is always tall enough to show all of its text, so nothing
 * is hidden behind an inner scrollbar. Still a normal controlled textarea:
 * typing, pasting and editing work as usual and it re-fits on every change.
 */
export default function AutoGrowTextarea({ minRows = 3, className = '', ...props }: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Measuring the rendered height is a genuine DOM side effect: collapse to
  // 'auto' first so the box can also shrink, then fit it to the content.
  // Layout effect (not useEffect) so the resize lands before paint - no flicker.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);

  return <textarea ref={ref} rows={minRows} {...props} className={`resize-none overflow-hidden ${className}`} />;
}
