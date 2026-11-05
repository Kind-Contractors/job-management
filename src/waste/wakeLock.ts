// Keeps the phone's screen on while waste uploads are running (Screen Wake Lock API: Safari 16.4+ in a browser tab, iOS 18.4+ for a
// home-screen app, Chrome on Android). Uploads NEVER depend on it: where it is missing or refused, nothing changes - the screen
// simply tells Jack to keep it open. The browser drops the lock whenever the app is hidden; it is asked for again when the app is back
// on screen and uploads are still running.

export type WakeLockState = 'on' | 'off' | 'unsupported' | 'refused';

type WakeLockSentinelLike = { released: boolean; release: () => Promise<void>; addEventListener: (type: 'release', fn: () => void) => void };
type WakeLockApi = { request: (type: 'screen') => Promise<WakeLockSentinelLike> };

let sentinel: WakeLockSentinelLike | null = null;
let wanted = false;
let state: WakeLockState = 'off';
const listeners = new Set<() => void>();

function api(): WakeLockApi | null {
  if (typeof navigator === 'undefined') return null;
  return ((navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock ?? null) as WakeLockApi | null;
}

function set(next: WakeLockState) {
  if (state === next) return;
  state = next;
  for (const fn of listeners) fn();
}

export function getWakeLockState(): WakeLockState {
  return state;
}

export function subscribeWakeLock(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function acquire(): Promise<void> {
  const wl = api();
  if (!wl) return set('unsupported');
  if (sentinel && !sentinel.released) return set('on');
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return; // only allowed on screen
  try {
    sentinel = await wl.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
      if (!wanted) set('off');
    });
    if (!wanted) {
      await sentinel.release().catch(() => undefined);
      sentinel = null;
      return set('off');
    }
    set('on');
  } catch {
    sentinel = null;
    set('refused'); // e.g. low battery mode, or the browser said no - uploads carry on regardless
  }
}

async function release(): Promise<void> {
  const s = sentinel;
  sentinel = null;
  if (s && !s.released) await s.release().catch(() => undefined);
  if (state !== 'unsupported') set('off');
}

let visibilityHooked = false;

/** Keep the screen on (true) or let it sleep (false). Safe to call often; does nothing where unsupported. */
export function keepScreenAwake(on: boolean): void {
  wanted = on;
  if (!visibilityHooked && typeof document !== 'undefined') {
    visibilityHooked = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && wanted) void acquire();
    });
  }
  void (on ? acquire() : release());
}

let persistAsked = false;

/** Asks once for this site's stored data (drafts, queued files) to be kept even when the phone is short of space. Best effort. */
export async function askToKeepStoredData(): Promise<boolean | null> {
  if (persistAsked) return null;
  persistAsked = true;
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.persist) return null;
    if (storage.persisted && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}
