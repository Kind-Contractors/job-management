// Device compatibility check (Waste Reports) - run ONLY when the reporter opens it and taps "Run the check"; sent ONLY when he taps
// "Send to Kind Contractors". Nothing here runs in the background, and nothing is sent on its own.
//
// It answers one question on the phone itself: can this browser keep a photo/video in the app's storage? It saves a small generated
// test file (1 KB, not a photo or video) in the app's own database, reads it back, compares it byte for byte, and removes it again.
// The test records are never linked to a report or a person (no ownerId), so no list in the app ever shows or uploads them.
//
// What is collected: technical browser/device facts (below). Never: report contents, addresses, client details, file names, photos
// or videos. Private Browsing can't be detected reliably, so it is never claimed - the storage test result is recorded instead.
import { APP_BUILD_ID } from '../lib/appUpdate';
import { wasteDbForDeviceCheck } from './offline/wasteDb';
import { getLastMediaSaveError, type MediaSaveErrorInfo } from './offline/wasteSyncEngine';

export const DEVICE_CHECK_KIND = 'waste-device-check';
const PRODUCTION_REF = 'rgcxybsnoqjnbywzycfx';
const DEV_REF = 'oewjoxttcxrgwhqcstqc';
const TEST_BLOB_BYTES = 1024;

export type CheckEnvironment = 'production' | 'dev' | 'other';
export interface ErrorFacts {
  name: string | null;
  message: string | null;
}
export interface StepResult {
  ok: boolean;
  ms: number;
  error: ErrorFacts | null;
}
export interface WriteResult extends StepResult {
  /** The put request itself (success / error). */
  request: 'success' | 'error' | 'threw' | 'not reached';
  /** The transaction's outcome: committed (complete) or aborted. */
  transaction: 'complete' | 'abort' | 'not reached';
}
export interface DeviceCheckReport {
  kind: typeof DEVICE_CHECK_KIND;
  version: 1;
  appVersion: string;
  environment: CheckEnvironment;
  checkedAt: string;
  device: {
    userAgent: string;
    platform: string | null;
    /** As the browser reports it in its user agent - newer Safari versions may report a fixed (older) number. */
    iosVersionReported: string | null;
    category: 'iPhone' | 'iPad' | 'Android' | 'desktop' | 'unknown';
    screen: { width: number | null; height: number | null };
    devicePixelRatio: number | null;
    touchPoints: number | null;
    language: string | null;
  };
  browser: {
    name: string;
    version: string | null;
    /** 'home-screen app' when started from the Home Screen; otherwise 'browser tab' (as far as the browser says). */
    displayMode: 'home-screen app' | 'browser tab' | 'unknown';
  };
  storage: {
    indexedDbAvailable: boolean;
    estimate: { usageBytes: number | null; quotaBytes: number | null } | 'unsupported' | 'failed';
    persisted: boolean | 'unsupported' | 'failed';
  };
  indexedDb: {
    target: string;
    open: StepResult;
    plainObject: WriteResult & { readBack: boolean };
    blob: WriteResult & { bytes: number; readBack: boolean; sizeMatches: boolean | null; bytesMatch: boolean | null; hashMatches: boolean | null };
    cleanup: StepResult;
  };
  lastMediaSaveError: MediaSaveErrorInfo | null;
}

export function environmentOf(supabaseUrl: string | undefined): CheckEnvironment {
  if (!supabaseUrl) return 'other';
  if (supabaseUrl.includes(PRODUCTION_REF)) return 'production';
  if (supabaseUrl.includes(DEV_REF)) return 'dev';
  return 'other';
}

/** A copy served from this computer must never send to the live system (local testing uses DEV). Null = allowed. */
export function submitBlockedReason(environment: CheckEnvironment, hostname: string): string | null {
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.local');
  if (local && environment === 'production') return 'This copy of the app is running on this computer but is set up for the live system, so the check can’t be sent from here.';
  return null;
}

// ---- device and browser (from what the browser reports; nothing is guessed beyond it) ------------------------------------------------
export function describeUserAgent(ua: string, touchPoints: number | null): { category: DeviceCheckReport['device']['category']; iosVersionReported: string | null; browser: { name: string; version: string | null } } {
  const ios = /(?:iPhone|iPad|iPod)[^)]*? OS (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
  const iPadDesktopMode = /Macintosh/.test(ua) && (touchPoints ?? 0) > 1; // iPadOS asks for the desktop site by default
  const category = /iPhone|iPod/.test(ua) ? 'iPhone' : /iPad/.test(ua) || iPadDesktopMode ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows|Macintosh|Linux|CrOS/.test(ua) ? 'desktop' : 'unknown';
  const pick = (re: RegExp) => re.exec(ua)?.[1] ?? null;
  let browser: { name: string; version: string | null };
  if (/FBAN|FBAV/.test(ua)) browser = { name: 'Facebook in-app browser', version: null };
  else if (/Instagram/.test(ua)) browser = { name: 'Instagram in-app browser', version: null };
  else if (/CriOS\//.test(ua)) browser = { name: 'Chrome (iOS)', version: pick(/CriOS\/([\d.]+)/) };
  else if (/FxiOS\//.test(ua)) browser = { name: 'Firefox (iOS)', version: pick(/FxiOS\/([\d.]+)/) };
  else if (/EdgiOS\//.test(ua)) browser = { name: 'Edge (iOS)', version: pick(/EdgiOS\/([\d.]+)/) };
  else if (/Edg\//.test(ua)) browser = { name: 'Edge', version: pick(/Edg\/([\d.]+)/) };
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = { name: 'Chrome', version: pick(/Chrome\/([\d.]+)/) };
  else if (/Firefox\//.test(ua)) browser = { name: 'Firefox', version: pick(/Firefox\/([\d.]+)/) };
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = { name: 'Safari', version: pick(/Version\/([\d.]+)/) };
  else if (/AppleWebKit/.test(ua)) browser = { name: 'WebKit browser (not identified)', version: null };
  else browser = { name: 'unknown', version: null };
  return { category, iosVersionReported: ios ? [ios[1], ios[2], ios[3]].filter(Boolean).join('.') : null, browser };
}

const errFacts = (e: unknown): ErrorFacts => ({
  name: typeof (e as { name?: unknown } | null)?.name === 'string' ? ((e as { name: string }).name).slice(0, 100) : null,
  message: e instanceof Error || typeof (e as { message?: unknown } | null)?.message === 'string' ? String((e as { message: string }).message).slice(0, 300) : e == null ? null : String(e).slice(0, 300),
});

// ---- IndexedDB: the actual test --------------------------------------------------------------------------------------------------
/** One put in its own readwrite transaction; the request and the transaction outcome are both recorded (a request alone is not proof). */
function observedPut(db: IDBDatabase, value: unknown, now: () => number): Promise<WriteResult> {
  return new Promise((resolve) => {
    const t0 = now();
    let request: WriteResult['request'] = 'not reached';
    let error: ErrorFacts | null = null;
    let done = false;
    const finish = (transaction: WriteResult['transaction']) => {
      if (done) return;
      done = true;
      resolve({ ok: transaction === 'complete', ms: Math.round(now() - t0), request, transaction, error });
    };
    let tx: IDBTransaction;
    try {
      tx = db.transaction('media', 'readwrite');
    } catch (e) {
      error = errFacts(e);
      return finish('not reached');
    }
    tx.oncomplete = () => finish('complete');
    tx.onabort = () => {
      error = error ?? (tx.error ? errFacts(tx.error) : null);
      finish('abort');
    };
    try {
      const req = tx.objectStore('media').put(value);
      req.onsuccess = () => { request = 'success'; };
      req.onerror = () => {
        request = 'error';
        error = req.error ? errFacts(req.error) : error;
      };
    } catch (e) {
      request = 'threw';
      error = errFacts(e);
      try { tx.abort(); } catch { /* already finished */ }
    }
    setTimeout(() => {
      error = error ?? { name: 'Timeout', message: 'No answer from the browser’s storage within 20 seconds' };
      finish('not reached');
    }, 20_000);
  });
}

function readRecord(db: IDBDatabase, id: string): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction('media', 'readonly').objectStore('media').get(id);
    req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function sha256(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // not available (e.g. not a secure page)
  }
}

export interface IdbCheckDeps {
  openDb: () => Promise<IDBDatabase>;
  newId: () => string;
  now: () => number;
  indexedDbAvailable: boolean;
}

export async function runIndexedDbCheck(deps: IdbCheckDeps): Promise<DeviceCheckReport['indexedDb']> {
  const notRun: WriteResult = { ok: false, ms: 0, request: 'not reached', transaction: 'not reached', error: null };
  const result: DeviceCheckReport['indexedDb'] = {
    target: 'the app’s own storage (media store), with temporary test records not linked to any report',
    open: { ok: false, ms: 0, error: null },
    plainObject: { ...notRun, readBack: false },
    blob: { ...notRun, bytes: TEST_BLOB_BYTES, readBack: false, sizeMatches: null, bytesMatch: null, hashMatches: null },
    cleanup: { ok: false, ms: 0, error: null },
  };
  if (!deps.indexedDbAvailable) {
    result.open.error = { name: 'Unsupported', message: 'IndexedDB is not available in this browser' };
    return result;
  }
  let db: IDBDatabase;
  const t0 = deps.now();
  try {
    db = await deps.openDb();
    result.open = { ok: true, ms: Math.round(deps.now() - t0), error: null };
  } catch (e) {
    result.open = { ok: false, ms: Math.round(deps.now() - t0), error: errFacts(e) };
    return result;
  }
  const run = deps.newId();
  const plainId = `device-check:${run}:plain`;
  const blobId = `device-check:${run}:blob`;
  try {
    // 1. a plain object (no file)
    const plain = await observedPut(db, { id: plainId, kind: 'device-check', text: 'ok', n: 1, flag: true }, deps.now);
    let plainBack = false;
    if (plain.ok) {
      try { plainBack = (await readRecord(db, plainId))?.text === 'ok'; } catch { plainBack = false; }
    }
    result.plainObject = { ...plain, readBack: plainBack };
    // 2. a small generated file (1 KB, not a photo or video), as a media record would hold one
    const original = new Uint8Array(TEST_BLOB_BYTES);
    for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 7) % 251;
    const write = await observedPut(db, { id: blobId, kind: 'device-check', blob: new Blob([original], { type: 'image/jpeg' }) }, deps.now);
    result.blob = { ...result.blob, ...write };
    if (write.ok) {
      try {
        const back = (await readRecord(db, blobId))?.blob;
        if (back instanceof Blob) {
          const bytes = await back.arrayBuffer();
          const got = new Uint8Array(bytes);
          result.blob.readBack = true;
          result.blob.sizeMatches = back.size === TEST_BLOB_BYTES;
          result.blob.bytesMatch = got.length === original.length && got.every((b, i) => b === original[i]);
          const [a, b] = await Promise.all([sha256(original.buffer.slice(0)), sha256(bytes)]);
          result.blob.hashMatches = a && b ? a === b : null;
        } else {
          result.blob.error = result.blob.error ?? { name: 'ReadBack', message: 'The saved test file came back missing' };
        }
      } catch (e) {
        result.blob.readBack = false;
        result.blob.error = errFacts(e);
      }
    }
  } finally {
    // Always remove the test records, whatever happened.
    const tc = deps.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('media', 'readwrite');
        tx.objectStore('media').delete(plainId);
        tx.objectStore('media').delete(blobId);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
      result.cleanup = { ok: true, ms: Math.round(deps.now() - tc), error: null };
    } catch (e) {
      result.cleanup = { ok: false, ms: Math.round(deps.now() - tc), error: errFacts(e) };
    }
  }
  return result;
}

// ---- the whole check ----------------------------------------------------------------------------------------------------------------
export interface DeviceCheckEnv {
  nav: Navigator;
  win: Window;
  supabaseUrl: string | undefined;
  now: () => Date;
}

export async function runDeviceCheck(env: DeviceCheckEnv = { nav: navigator, win: window, supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined, now: () => new Date() }): Promise<DeviceCheckReport> {
  const { nav, win } = env;
  const touchPoints = typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : null;
  const ua = String(nav.userAgent ?? '').slice(0, 500);
  const described = describeUserAgent(ua, touchPoints);
  let displayMode: DeviceCheckReport['browser']['displayMode'] = 'unknown';
  try {
    const standalone = win.matchMedia?.('(display-mode: standalone)').matches || (nav as Navigator & { standalone?: boolean }).standalone === true;
    displayMode = standalone ? 'home-screen app' : 'browser tab';
  } catch { /* unknown */ }

  const storage: DeviceCheckReport['storage'] = { indexedDbAvailable: typeof indexedDB !== 'undefined' && !!indexedDB, estimate: 'unsupported', persisted: 'unsupported' };
  if (nav.storage?.estimate) {
    try {
      const est = await nav.storage.estimate();
      storage.estimate = { usageBytes: est.usage ?? null, quotaBytes: est.quota ?? null };
    } catch { storage.estimate = 'failed'; }
  }
  if (nav.storage?.persisted) {
    try { storage.persisted = await nav.storage.persisted(); } catch { storage.persisted = 'failed'; }
  }

  const indexedDb = await runIndexedDbCheck({
    openDb: wasteDbForDeviceCheck,
    newId: () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    indexedDbAvailable: storage.indexedDbAvailable,
  });

  const platform = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? nav.platform ?? null;
  return {
    kind: DEVICE_CHECK_KIND,
    version: 1,
    appVersion: String(APP_BUILD_ID).slice(0, 64),
    environment: environmentOf(env.supabaseUrl),
    checkedAt: env.now().toISOString(),
    device: {
      userAgent: ua,
      platform: platform ? String(platform).slice(0, 100) : null,
      iosVersionReported: described.iosVersionReported,
      category: described.category,
      screen: { width: win.screen?.width ?? null, height: win.screen?.height ?? null },
      devicePixelRatio: typeof win.devicePixelRatio === 'number' ? win.devicePixelRatio : null,
      touchPoints,
      language: nav.language ? String(nav.language).slice(0, 35) : null,
    },
    browser: { ...described.browser, displayMode },
    storage,
    indexedDb,
    lastMediaSaveError: getLastMediaSaveError(),
  };
}

/** Plain-words verdict shown on the phone. */
export function verdictOf(report: DeviceCheckReport): { ok: boolean; text: string } {
  const b = report.indexedDb.blob;
  if (!report.storage.indexedDbAvailable || !report.indexedDb.open.ok) return { ok: false, text: 'This browser’s storage couldn’t be opened, so photos and videos can’t be kept on this phone for upload.' };
  if (b.ok && b.readBack && b.bytesMatch) return { ok: true, text: 'This phone can keep photos and videos for upload.' };
  return { ok: false, text: 'This phone couldn’t keep a test file for upload. If you’re using a private browsing tab, open the app in a normal tab and run the check again.' };
}
