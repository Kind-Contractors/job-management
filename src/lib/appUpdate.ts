// New app versions, safely. The service worker caches the app (vite.config.ts). After a deploy, a page that is already open keeps
// running the old code until it is reloaded - which is how a brand-new waste reporter could be told "Not set up for access" by a
// version that did not know that role yet, until he refreshed. This module:
//
//   1. registers the service worker itself (instead of the plugin's injected script), so the app knows when a new version arrives;
//   2. checks for a new version when the app opens, when it comes back to the screen, and every hour;
//   3. when a new version has taken over, reloads only when nothing can be lost (see decideReload) - otherwise it shows a
//      "new version ready" bar (UpdateBar) and reloads later at a safe moment, or when the user taps Reload;
//   4. never loops: at most one automatic reload per build per tab session, never two within a minute, and if a reload did not bring
//      the new build the bar is shown instead of trying again;
//   5. answers the service worker's "who handles updates?" question, so public/sw-update.js leaves pages of this version alone.
//
// Nothing here touches the offline data: drafts, queued files and uploads live in IndexedDB and are unaffected by a reload; a resumable
// video upload continues from its last chunk. Even so, a waste reporter's page is never reloaded while an upload is running.

export type AuthStateForUpdate = { status: 'loading' | 'signed_out' | 'unauthorized' | 'check_failed' | 'authorized'; role: string | null };

export type ReloadDecision =
  /** Reload at once. */
  | 'now'
  /** Reload as soon as the page is not on screen (and the condition still holds). */
  | 'when-hidden'
  /** Wait for the waste uploads to stop, then decide again. */
  | 'when-uploads-stop'
  /** Never automatically: the bar's Reload button only. */
  | 'ask';

export interface ReloadContext {
  auth: AuthStateForUpdate;
  hidden: boolean;
  wasteUploadBusy: boolean;
  unsavedEdits: boolean;
}

/**
 * When a page that has a new version waiting may be reloaded.
 *   - Not signed in, or the access check screens (signing in, "Not set up", "couldn't check"): at once - no work can exist there,
 *     and an old version's "Not set up" is exactly what this fixes.
 *   - Waste reporter: never while an upload runs; otherwise once the app is off screen (typing is saved as it happens anyway).
 *   - Manager: once the tab is off screen, and only with no unsaved edits.
 *   - Technician: never automatically on the working screens (the bar's Reload only).
 */
export function decideReload(ctx: ReloadContext): ReloadDecision {
  if (ctx.auth.status !== 'authorized') return 'now';
  if (ctx.auth.role === 'waste_reporter') {
    if (ctx.wasteUploadBusy) return 'when-uploads-stop';
    return ctx.hidden ? 'now' : 'when-hidden';
  }
  if (ctx.auth.role === 'manager') {
    if (ctx.unsavedEdits) return 'ask';
    return ctx.hidden ? 'now' : 'when-hidden';
  }
  return 'ask';
}

// ---- loop guard (per tab session) ------------------------------------------------------------------------------------------------

const RELOAD_KEY = 'kc-app-update-reload';
const MIN_GAP_MS = 60_000;

interface ReloadRecord {
  fromBuild: string;
  at: number;
}

/** False when an automatic reload would repeat: the last one did not bring a new build, or one happened less than a minute ago. */
export function autoReloadAllowed(storage: Pick<Storage, 'getItem'>, currentBuild: string, now: number): boolean {
  let record: ReloadRecord | null = null;
  try {
    record = JSON.parse(storage.getItem(RELOAD_KEY) ?? 'null') as ReloadRecord | null;
  } catch {
    record = null;
  }
  if (!record) return true;
  if (record.fromBuild === currentBuild) return false; // the last reload did not bring the new build: don't try again
  return now - record.at >= MIN_GAP_MS;
}

export function recordAutoReload(storage: Pick<Storage, 'setItem'>, currentBuild: string, now: number): void {
  try {
    storage.setItem(RELOAD_KEY, JSON.stringify({ fromBuild: currentBuild, at: now } satisfies ReloadRecord));
  } catch {
    // Without session storage there is no loop guard - so no automatic reload either (see safeSessionStorage).
  }
}

// ---- the live state (an external store for the bar) -------------------------------------------------------------------------------

export const APP_BUILD_ID: string = typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : 'dev';

export interface AppUpdateState {
  /** A new version has taken over this page's service worker; this page still runs the old code. */
  ready: boolean;
  /** Why it has not reloaded by itself yet (shown in the bar). */
  waitingFor: 'upload' | 'unsaved' | 'screen' | 'you' | null;
}

let state: AppUpdateState = { ready: false, waitingFor: null };
const listeners = new Set<() => void>();
function setState(next: AppUpdateState) {
  state = next;
  for (const fn of listeners) fn();
}
export function subscribeAppUpdate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getAppUpdateState(): AppUpdateState {
  return state;
}

let auth: AuthStateForUpdate = { status: 'loading', role: null };
let wasteUploadBusy: () => boolean = () => false;
let unsavedEdits: () => boolean = () => false;

/** The app tells this module who is signed in (App.tsx), so the reload rule can be applied. */
export function noteAuthState(next: AuthStateForUpdate): void {
  auth = next;
  if (state.ready) consider();
}

/** Wired once at start-up (main.tsx) - kept as callbacks so this module imports neither the waste engine nor the report guard. */
export function setReloadSafetyChecks(checks: { wasteUploadBusy: () => boolean; unsavedEdits: () => boolean }): void {
  wasteUploadBusy = checks.wasteUploadBusy;
  unsavedEdits = checks.unsavedEdits;
}

function safeSessionStorage(): Storage | null {
  try {
    const s = window.sessionStorage;
    s.setItem('kc-probe', '1');
    s.removeItem('kc-probe');
    return s;
  } catch {
    return null;
  }
}

/** Reload now (the bar's button, or the "Not set up" screen's): the user chose it, so no guard - but it is still recorded. */
export function reloadNow(): void {
  const s = safeSessionStorage();
  if (s) recordAutoReload(s, APP_BUILD_ID, Date.now());
  window.location.reload();
}

let waitTimer: ReturnType<typeof setInterval> | null = null;

function consider(): void {
  if (!state.ready) return;
  const decision = decideReload({ auth, hidden: document.visibilityState === 'hidden', wasteUploadBusy: wasteUploadBusy(), unsavedEdits: unsavedEdits() });
  const s = safeSessionStorage();
  const allowed = !!s && autoReloadAllowed(s, APP_BUILD_ID, Date.now());
  if (decision === 'now' && allowed && s) {
    recordAutoReload(s, APP_BUILD_ID, Date.now());
    window.location.reload();
    return;
  }
  const waitingFor: AppUpdateState['waitingFor'] = !allowed
    ? 'you'
    : decision === 'when-uploads-stop'
      ? 'upload'
      : decision === 'ask'
        ? auth.role === 'manager'
          ? 'unsaved'
          : 'you'
        : 'screen';
  if (state.waitingFor !== waitingFor) setState({ ready: true, waitingFor });
  // While uploads run, look again every few seconds; the moment they stop the rule is applied again.
  if (decision === 'when-uploads-stop' && allowed && !waitTimer) {
    waitTimer = setInterval(() => {
      if (!wasteUploadBusy()) {
        if (waitTimer) clearInterval(waitTimer);
        waitTimer = null;
        consider();
      }
    }, 5_000);
  }
}

/** The new version took over: from now on this page is out of date. */
function newVersionReady(): void {
  if (state.ready) return;
  setState({ ready: true, waitingFor: null });
  consider();
}

let registration: ServiceWorkerRegistration | null = null;

/** Asks the browser to check for a new version now (the "Not set up" screen does this before suggesting a problem). */
export async function checkForAppUpdate(): Promise<void> {
  try {
    await registration?.update();
  } catch {
    // Offline or the check failed: nothing to do.
  }
}

let started = false;

/** Registers the service worker and starts watching for new versions. Once, from main.tsx. */
export function startAppUpdates(): void {
  if (started || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  started = true;
  const sw = navigator.serviceWorker;

  // public/sw-update.js asks every open page whether it handles updates itself; this version does.
  sw.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'KC_WHO_HANDLES_UPDATES' && event.ports[0]) event.ports[0].postMessage({ type: 'KC_UPDATE_AWARE' });
  });
  sw.startMessages();

  // A page that was already controlled when it loaded is out of date once the controller changes. A page that was not controlled
  // yet (the very first visit) is not: the first worker taking over changes nothing about the code it runs.
  const hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (hadController) newVersionReady();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForAppUpdate();
    consider();
  });
  setInterval(() => void checkForAppUpdate(), 60 * 60_000);

  // Same worker, file and scope as the plugin's injected registration was (dev serves its own development worker).
  const url = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js';
  const options: RegistrationOptions = import.meta.env.DEV ? { scope: '/', type: 'module' } : { scope: '/' };
  const register = () =>
    sw
      .register(url, options)
      .then((r) => {
        registration = r;
      })
      .catch(() => undefined);
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}
