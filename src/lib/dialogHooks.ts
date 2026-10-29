import { useEffect, useState, type MouseEvent } from 'react';

/**
 * Backdrop handlers for a dialog that closes when its backdrop is clicked. A click counts only when the press ALSO started on
 * the backdrop: a browser fires `click` on the nearest common ancestor of the press and the release, so selecting text in a
 * field (or a small drag while clicking into one) that ends over the backdrop would otherwise close the dialog mid-typing.
 * Pass `undefined` while the dialog must not close (e.g. while saving). Not a hook: the "pressed here" mark is kept on the
 * backdrop element itself, so it also works where a component is called as a plain function.
 */
export function backdropDismiss(onClose: (() => void) | undefined) {
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      e.currentTarget.dataset.backdropPressed = e.target === e.currentTarget ? '1' : '';
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const close = e.currentTarget.dataset.backdropPressed === '1' && e.target === e.currentTarget;
      e.currentTarget.dataset.backdropPressed = '';
      if (close) onClose?.();
    },
  };
}

/**
 * `value`, once it has stopped changing for `delayMs` (search-as-you-type without a request per keystroke).
 * A timer is a genuine side effect, hence the effect; it is cleared on every change and on unmount.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
