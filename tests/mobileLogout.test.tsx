// The Manager header's Log out control on a phone. The desktop header (a 460px search box, date, email, two buttons) pushed
// the account buttons off the right edge of a 375-390px screen, so Log out could not be reached. The real components are
// server-rendered to static markup (there is no DOM library in this repo), so these tests pin the markup that makes the
// control reachable and the wiring to the one existing sign-out handler; the visual result at a narrow width is a manual check.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import TopBar from '../src/components/shell/TopBar';
import LogoutButton from '../src/components/shell/LogoutButton';
import { AuthContext, AuthProvider, useAuth, type AuthContextValue } from '../src/auth/AuthProvider';
import { supabase } from '../src/lib/supabaseClient';

const noop = () => {};
const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
const renderTopBar = () =>
  renderToStaticMarkup(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/jobs']}>
        <TopBar />
      </MemoryRouter>
    </AuthContext.Provider>,
  );

/** The opening tag of the first element whose class attribute contains `marker`. */
function tagWithClass(html: string, marker: string): string {
  const m = new RegExp(`<[a-z]+ [^>]*class="[^"]*${marker.replace(/[[\]\\^$.*+?()|{}]/g, '\\$&')}[^"]*"[^>]*>`).exec(html);
  assert.ok(m, `an element with class "${marker}" is rendered`);
  return m[0];
}
const classesOf = (tag: string) => /class="([^"]*)"/.exec(tag)![1].split(/\s+/);

test('LOGOUT: a real, labelled, keyboard-reachable button that reads "Log out"', () => {
  const html = renderToStaticMarkup(<LogoutButton onLogout={noop} />);
  assert.match(html, /^<button type="button" aria-label="Log out"/, 'a native <button> (focusable, Enter/Space activate it), not a div');
  assert.match(html, />Log out<\/button>$/);
  assert.doesNotMatch(html, /tabindex|disabled/i);
});

test('LOGOUT: touch target is at least 44x44 CSS px below lg, and the compact desktop size is restored from lg up', () => {
  const classes = classesOf(tagWithClass(renderToStaticMarkup(<LogoutButton onLogout={noop} />), 'min-h-11'));
  assert.ok(classes.includes('min-h-11') && classes.includes('min-w-11'), 'min-h-11 / min-w-11 = 2.75rem = 44px');
  assert.ok(classes.includes('lg:min-h-0') && classes.includes('lg:min-w-0') && classes.includes('lg:py-1') && classes.includes('lg:px-2'), 'desktop sizing as before');
  assert.ok(classes.includes('flex-none'), 'never shrunk by a narrow header');
});

test('LOGOUT: clicking calls the handler it was given, exactly once, with no other side effect', () => {
  let calls = 0;
  const el = LogoutButton({ onLogout: () => (calls += 1) }) as ReactElement<{ onClick: () => void }>;
  el.props.onClick();
  assert.equal(calls, 1);
});

test('TOPBAR: Log out is rendered, and the old "Sign out" duplicate is gone', () => {
  const html = renderTopBar();
  assert.equal(html.match(/aria-label="Log out"/g)?.length, 1, 'exactly one Log out control');
  assert.doesNotMatch(html, /Sign out/);
});

test('TOPBAR: the account cluster that holds Log out is never hidden at any width and cannot be pushed off the right edge', () => {
  const html = renderTopBar();
  const cluster = classesOf(tagWithClass(html, 'ml-auto'));
  assert.ok(cluster.includes('flex-none') && cluster.includes('ml-auto'), 'right-aligned, not shrinkable');
  assert.ok(!cluster.some((c) => c === 'hidden' || c.startsWith('max-') || c.endsWith(':hidden')), 'not hidden at any width');
  // Log out sits inside that cluster, after Change password (which is also still there).
  const clusterHtml = html.slice(html.indexOf('ml-auto'));
  assert.ok(clusterHtml.indexOf('Change password') !== -1 && clusterHtml.indexOf('Change password') < clusterHtml.indexOf('aria-label="Log out"'));
});

test('TOPBAR: the 460px search box, date, email and "Operations" label are desktop-only; the logo stays', () => {
  const html = renderTopBar();
  const search = classesOf(tagWithClass(html, 'justify-center'));
  assert.ok(search.includes('hidden') && search.includes('lg:flex'), 'search wrapper: hidden on phones, a flex row from lg');
  assert.ok(html.includes('w-[460px]'), 'desktop search box itself is unchanged');
  assert.ok(classesOf(tagWithClass(html, 'tracking-[0.1em]')).includes('lg:inline'), 'date');
  assert.ok(classesOf(tagWithClass(html, 'lg:block')).includes('hidden'), '"Operations" label');
  assert.match(html, /<span class="hidden lg:inline">luke@kindcontractors\.co\.uk<\/span>/, 'email text hidden on phones, avatar initials remain');
  assert.match(html, /alt="Kind Contractors"/);
});

test('TOPBAR: Change password and the signed-in identity are unchanged on desktop', () => {
  const html = renderTopBar();
  assert.match(html, />Change password<\/button>/);
  assert.match(html, />LU<\/i>/);
  assert.match(html, /Search jobs &amp; buildings/);
});

// ---- the existing sign-out behaviour (AuthProvider.signOut) is what Log out calls -------------------------------------------
// A stand-in for the offline queue: one record in a throwaway IndexedDB that sign-out must leave alone.
function openProbe(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mobile-logout-probe', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('queue');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queueWork(value: string): Promise<void> {
  const db = await openProbe();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').put(value, 'draft');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function readQueued(): Promise<unknown> {
  const db = await openProbe();
  const value = await new Promise((resolve, reject) => {
    const req = db.transaction('queue').objectStore('queue').get('draft');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

test('SIGN-OUT: Log out goes through the one existing AuthProvider.signOut -> supabase.auth.signOut, and clears no browser storage', async () => {
  let captured: AuthContextValue | undefined;
  function Capture() {
    captured = useAuth();
    return null;
  }
  renderToStaticMarkup(
    <AuthProvider>
      <Capture />
    </AuthProvider>,
  );
  assert.ok(captured);

  const store = new Map<string, string>([
    ['kind-contractors-query-cache:v2:someone-else', '{"cached":true}'],
    ['sb-test-auth-token', '{"session":true}'],
  ]);
  const fakeStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  await queueWork('unsynced-draft');
  const g = globalThis as any;
  const hadWindow = 'window' in g;
  g.window = { ...(g.window ?? {}), localStorage: fakeStorage };

  const auth = supabase.auth as any;
  const original = auth.signOut;
  let signOutCalls = 0;
  auth.signOut = async () => {
    signOutCalls += 1;
    return { error: null };
  };
  try {
    await captured!.signOut();
  } finally {
    auth.signOut = original;
    if (!hadWindow) delete g.window;
  }

  assert.equal(signOutCalls, 1, 'the Supabase sign-out is called once');
  assert.deepEqual([...store.keys()].sort(), ['kind-contractors-query-cache:v2:someone-else', 'sb-test-auth-token'], 'no localStorage entry is removed');
  assert.equal(await readQueued(), 'unsynced-draft', 'queued offline work in IndexedDB is untouched');
});
