// Stops the manager leaving Report Review with typing that is not safely stored. Three ways of leaving are covered:
//   * closing / reloading the tab or typing another address   -> the browser's own "Leave site?" warning (beforeunload);
//   * clicking a link elsewhere in the app (rail, top bar)     -> the click is held, the edits are saved, and the link is followed only
//                                                                  if that worked (or the manager chooses to leave anyway);
//   * choosing another report in the queue, Prev / Next        -> the page asks `confirmLeave()` first.
// React's unmount cleanup is only a last resort: it cannot show an error to anyone.
//
// A single guard is active at a time (one Report Review panel is mounted). Written without React so it is tested without a browser.

export interface UnsavedGuard {
  /** True while something typed is not safely stored. */
  hasUnsaved: () => boolean;
  /** Saves it; rejects if that fails. */
  flush: () => Promise<void>;
}

export const LEAVE_WARNING = 'Your changes to this report have not been saved. Leave anyway and lose them?';

let active: UnsavedGuard | null = null;

/** Makes `guard` the active one; returns the function that removes it. */
export function registerUnsavedGuard(guard: UnsavedGuard): () => void {
  active = guard;
  return () => {
    if (active === guard) active = null;
  };
}

export function hasUnsavedEdits(): boolean {
  return active?.hasUnsaved() ?? false;
}

/**
 * Call before leaving: resolves true when it is safe to go (nothing unsaved, or it has just been saved), and false when the save failed
 * and the manager chose to stay. If the save failed the manager is asked, with the reason, whether to leave and lose the text.
 */
export async function confirmLeave(ask: (message: string) => boolean = (m) => window.confirm(m)): Promise<boolean> {
  const guard = active;
  if (!guard || !guard.hasUnsaved()) return true;
  try {
    await guard.flush();
    return true;
  } catch (err) {
    const reason = err instanceof Error && err.message ? `\n\n${err.message}` : '';
    return ask(`${LEAVE_WARNING}${reason}`);
  }
}

/** The bits of the page the listeners need (injected so tests need no browser). */
export interface LeaveTargets {
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  ask?: (message: string) => boolean;
  origin?: string;
}

interface ClickLike {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: unknown;
  preventDefault: () => void;
  stopPropagation: () => void;
}
interface AnchorLike {
  target?: string;
  origin?: string;
  hasAttribute?: (name: string) => boolean;
  click: () => void;
}

/** Adds the tab-close warning and the in-app link guard. Returns the function that removes them. */
export function installLeaveWarnings({ win, doc, ask, origin }: LeaveTargets = { win: window, doc: document, origin: window.location.origin }): () => void {
  const beforeUnload = (e: { preventDefault: () => void; returnValue?: unknown }) => {
    if (!hasUnsavedEdits()) return;
    e.preventDefault();
    e.returnValue = ''; // some browsers only warn when this is set
  };

  let following = false; // true while we re-play a click we held, so it is not held again
  const onClick = (e: ClickLike) => {
    if (following || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target as { closest?: (selector: string) => unknown } | null;
    const anchor = (el?.closest?.('a[href]') ?? null) as AnchorLike | null;
    if (!anchor) return;
    if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute?.('download')) return;
    if (origin !== undefined && anchor.origin !== undefined && anchor.origin !== origin) return; // other sites: the browser's own warning covers it
    if (!hasUnsavedEdits()) return;
    e.preventDefault();
    e.stopPropagation();
    void confirmLeave(ask).then((ok) => {
      if (!ok) return;
      following = true;
      try {
        anchor.click();
      } finally {
        following = false;
      }
    });
  };

  win.addEventListener('beforeunload', beforeUnload as unknown as EventListener);
  doc.addEventListener('click', onClick as unknown as EventListener, true);
  return () => {
    win.removeEventListener('beforeunload', beforeUnload as unknown as EventListener);
    doc.removeEventListener('click', onClick as unknown as EventListener, true);
  };
}
