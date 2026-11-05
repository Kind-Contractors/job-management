// New app versions after a deploy (src/lib/appUpdate.ts, public/sw-update.js): an open page running an OLD version is updated only
// when nothing can be lost - never during a waste upload, never over unsaved edits, never in a loop - and the access screen no longer
// tells a valid account it is "not set up" just because an old version is running.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { autoReloadAllowed, decideReload, recordAutoReload, type ReloadContext } from '../src/lib/appUpdate';
import { UpdateBarView } from '../src/components/shell/UpdateBar';
import UnauthorizedPage from '../src/pages/UnauthorizedPage';
import { AuthContext } from '../src/auth/AuthProvider';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const ctx = (over: Partial<ReloadContext> & { status?: ReloadContext['auth']['status']; role?: string | null }): ReloadContext => ({
  auth: { status: over.status ?? 'authorized', role: over.role === undefined ? 'manager' : over.role },
  hidden: over.hidden ?? false,
  wasteUploadBusy: over.wasteUploadBusy ?? false,
  unsavedEdits: over.unsavedEdits ?? false,
});

// ---- the reload rule ---------------------------------------------------------------------------------------------------------
test('RULE: the sign-in and access screens reload at once (no work can exist there) - this is the "Not set up" fix', () => {
  for (const status of ['signed_out', 'unauthorized', 'check_failed', 'loading'] as const) assert.equal(decideReload(ctx({ status, role: null })), 'now', status);
});

test('RULE: a waste reporter is NEVER reloaded while an upload runs - on screen or not; otherwise only once the app is off screen', () => {
  assert.equal(decideReload(ctx({ role: 'waste_reporter', wasteUploadBusy: true })), 'when-uploads-stop');
  assert.equal(decideReload(ctx({ role: 'waste_reporter', wasteUploadBusy: true, hidden: true })), 'when-uploads-stop');
  assert.equal(decideReload(ctx({ role: 'waste_reporter' })), 'when-hidden');
  assert.equal(decideReload(ctx({ role: 'waste_reporter', hidden: true })), 'now');
});

test('RULE: a manager is reloaded only off screen and never over unsaved edits; a technician never automatically', () => {
  assert.equal(decideReload(ctx({ role: 'manager' })), 'when-hidden');
  assert.equal(decideReload(ctx({ role: 'manager', hidden: true })), 'now');
  assert.equal(decideReload(ctx({ role: 'manager', hidden: true, unsavedEdits: true })), 'ask');
  assert.equal(decideReload(ctx({ role: 'technician', hidden: true })), 'ask');
  assert.equal(decideReload(ctx({ role: 'technician' })), 'ask');
});

// ---- loop guard --------------------------------------------------------------------------------------------------------------
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

test('LOOPS: one automatic reload per build; a reload that did not bring a new build is never repeated; never twice within a minute', () => {
  const s = fakeStorage();
  assert.equal(autoReloadAllowed(s, 'build-A', 1_000), true, 'first time');
  recordAutoReload(s, 'build-A', 1_000);
  assert.equal(autoReloadAllowed(s, 'build-A', 999_999), false, 'still build A after reloading: stop (show the bar instead)');
  assert.equal(autoReloadAllowed(s, 'build-B', 30_000), false, 'new build, but less than a minute later');
  assert.equal(autoReloadAllowed(s, 'build-B', 61_001), true, 'a later deploy may update this tab again');
  const broken = { getItem: () => '{not json' };
  assert.equal(autoReloadAllowed(broken, 'x', 0), true);
});

// ---- screens -----------------------------------------------------------------------------------------------------------------
test('BAR: says a new version is ready and why it is waiting; Reload is always offered', () => {
  const upload = renderToStaticMarkup(<UpdateBarView waitingFor="upload" onReload={() => {}} />);
  assert.match(upload, /A new version of the app is ready\./);
  assert.match(upload, /when the photos and videos have finished uploading/);
  assert.match(upload, />Reload</);
  assert.match(renderToStaticMarkup(<UpdateBarView waitingFor="unsaved" onReload={() => {}} />), /Save your changes first/);
});

test('ACCESS SCREEN: no longer claims the account is "not set up"; offers Reload and shows the app version', () => {
  const auth: any = { status: 'unauthorized', role: null, session: { user: { email: 'new@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: () => {} };
  const html = renderToStaticMarkup(
    <AuthContext.Provider value={auth}>
      <UnauthorizedPage />
    </AuthContext.Provider>,
  );
  assert.match(html, /We couldn’t confirm access/);
  assert.match(html, /just updated, reload the page/);
  assert.match(html, />Reload</);
  assert.match(html, /App version /);
  assert.doesNotMatch(html, /isn't set up for access yet/);
  assert.match(src('src', 'pages', 'UnauthorizedPage.tsx'), /checkForAppUpdate\(\)/, 'it looks for a newer version first');
});

// ---- wiring ------------------------------------------------------------------------------------------------------------------
test('WIRING: the app registers the same service worker itself (no injected script), and the worker loads sw-update.js', () => {
  const cfg = src('vite.config.ts');
  assert.match(cfg, /injectRegister: false/);
  assert.match(cfg, /importScripts: \['sw-update\.js'\]/);
  assert.match(cfg, /registerType: 'autoUpdate'/);
  assert.match(cfg, /skipWaiting: true,\s*clientsClaim: true,/, 'the new worker still takes over at once - the plugin no longer sets these when it does not inject the script');
  assert.match(cfg, /handler: 'NetworkOnly'/, 'Supabase traffic still never cached');
  const upd = src('src', 'lib', 'appUpdate.ts');
  assert.match(upd, /'\/sw\.js'/);
  assert.match(upd, /\{ scope: '\/' \}/);
  const main = src('src', 'main.tsx');
  assert.match(main, /setReloadSafetyChecks\(\{ wasteUploadBusy: isWasteWorkerBusy, unsavedEdits: hasUnsavedEdits \}\)/);
  assert.match(main, /startAppUpdates\(\)/);
});

// ---- the service-worker part (public/sw-update.js) -------------------------------------------------------------------------
function loadSw() {
  const sandbox: any = { self: { indexedDB }, URL, MessageChannel, setTimeout, Promise, Date, Map, Set, Object, console };
  vm.createContext(sandbox);
  vm.runInContext(src('public', 'sw-update.js'), sandbox);
  const api = sandbox.KC_UPDATE;
  api.configureForTests({ ask: 50, recheck: 0, minGap: 0 });
  return api;
}

test('SW: which OLD pages it may reload - the sign-in address and the waste screens only; never manager or technician pages', () => {
  const sw = loadSw();
  assert.equal(sw.legacyPolicy('https://app.example/'), 'now');
  assert.equal(sw.legacyPolicy('https://app.example/waste'), 'if-idle');
  assert.equal(sw.legacyPolicy('https://app.example/waste/sent/abc'), 'if-idle');
  for (const p of ['/jobs', '/ready-for-client', '/technician', '/technician/visits/x/report', '/wastex', '/waste-reports']) {
    assert.equal(sw.legacyPolicy(`https://app.example${p}`), 'never', p);
  }
});

async function seedWasteDb(statuses: string[]) {
  await new Promise<void>((resolve, reject) => {
    const del = indexedDB.deleteDatabase('kind-contractors-waste-reports');
    del.onsuccess = () => resolve();
    del.onerror = () => reject(del.error);
  });
  if (statuses.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('kind-contractors-waste-reports', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('media', { keyPath: 'id' });
    req.onsuccess = () => {
      const tx = req.result.transaction('media', 'readwrite');
      statuses.forEach((status, i) => tx.objectStore('media').put({ id: `m${i}`, status }));
      tx.oncomplete = () => {
        req.result.close();
        resolve();
      };
    };
    req.onerror = () => reject(req.error);
  });
}

test('SW: an upload is "running" while a file is uploading or being checked; waiting/ready files are not; no database means none', async () => {
  const sw = loadSw();
  await seedWasteDb([]);
  assert.equal(await sw.wasteUploadBusy(), false);
  const dbs = await indexedDB.databases();
  assert.ok(!dbs.some((d) => d.name === 'kind-contractors-waste-reports'), 'looking never creates the database');
  await seedWasteDb(['ready', 'pending', 'failed']);
  assert.equal(await sw.wasteUploadBusy(), false);
  await seedWasteDb(['ready', 'uploading']);
  assert.equal(await sw.wasteUploadBusy(), true);
  await seedWasteDb(['checking']);
  assert.equal(await sw.wasteUploadBusy(), true);
});

function client(id: string, url: string, aware: boolean) {
  const c = {
    type: 'window',
    id,
    url,
    navigations: 0,
    postMessage: (msg: any, ports: MessagePort[]) => {
      if (aware && msg.type === "KC_WHO_HANDLES_UPDATES") ports[0].postMessage({ type: "KC_UPDATE_AWARE" });
      ports[0].close();
    },
    navigate: async () => {
      c.navigations += 1;
    },
  };
  return c;
}

test('SW: an OLD page on the sign-in address is reloaded once; a page of this version (it answers) is never touched', async () => {
  const sw = loadSw();
  const old = client('a', 'https://app.example/', false);
  const fresh = client('b', 'https://app.example/', true);
  await sw.look(old);
  await sw.look(fresh);
  assert.equal(old.navigations, 1);
  assert.equal(fresh.navigations, 0);
  await sw.look(old);
  assert.equal(old.navigations, 1, 'never twice');
});

test('SW: an OLD waste page is NOT reloaded while an upload runs; it is reloaded once the upload has finished (on its next request)', async () => {
  const sw = loadSw();
  await seedWasteDb(['ready', 'uploading', 'pending']);
  const page = client('w', 'https://app.example/waste/sent/r1', false);
  await sw.look(page);
  assert.equal(page.navigations, 0, 'upload running: left alone');
  await seedWasteDb(['ready', 'ready', 'pending']);
  await sw.look(page);
  assert.equal(page.navigations, 1, 'upload finished: updated');
});

test('SW: a busy OLD waste page is looked at once more shortly after - so it updates even if its last upload was its last request', async () => {
  const sw = loadSw();
  sw.configureForTests({ ask: 50, recheck: 60_000, minGap: 0, followUp: 30 });
  await seedWasteDb(['uploading']);
  const page = client('w2', 'https://app.example/waste', false);
  assert.equal(await sw.look(page), 'busy');
  await seedWasteDb(['ready']); // the upload finished and the page made no further request
  await sw.lookAgainLater(page);
  assert.equal(page.navigations, 1);
});

test('SW: a page seen busy keeps getting follow-up looks even when its next request comes soon after (no throttle gap), one at a time', async () => {
  const sw = loadSw();
  sw.configureForTests({ ask: 50, recheck: 60_000, minGap: 0, followUp: 30 });
  await seedWasteDb(['uploading']);
  const page = client('w3', 'https://app.example/waste', false);
  assert.equal(await sw.look(page), 'busy');
  assert.equal(await sw.look(page), undefined, 'a second look straight away is throttled...');
  assert.equal(sw.wasBusy(page), true, '...but the page is remembered as busy, so its request still starts a follow-up');
  await seedWasteDb(['ready']);
  await Promise.all([sw.lookAgainLater(page), sw.lookAgainLater(page)]);
  assert.equal(page.navigations, 1, 'two follow-ups at once collapse into one');
  assert.equal(sw.wasBusy(page), false);
});

test('SW: OLD manager and technician pages are never reloaded from the worker', async () => {
  const sw = loadSw();
  for (const url of ['https://app.example/jobs', 'https://app.example/technician/visits/x/report']) {
    const page = client(url, url, false);
    await sw.look(page);
    assert.equal(page.navigations, 0, url);
  }
});

test('SW: never two reloads within the minimum gap (no reload storms across tabs)', async () => {
  const sw = loadSw();
  sw.configureForTests({ ask: 50, recheck: 0, minGap: 60_000 });
  await seedWasteDb([]);
  const a = client('a', 'https://app.example/', false);
  const b = client('b', 'https://app.example/', false);
  await sw.look(a);
  await sw.look(b);
  assert.equal(a.navigations + b.navigations, 1);
});
