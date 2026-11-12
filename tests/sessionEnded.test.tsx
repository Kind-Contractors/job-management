// Sign-in sessions: Log out ends only THIS browser's sign-in, and a sign-in the server has ended (signed out elsewhere, removed,
// expired) is handled clearly - one message ("Your sign-in has ended. Sign in again to continue.") instead of "Invalid or expired
// session.", and, once the sign-in service confirms it, this browser is signed out and the sign-in page says why. (DEV, 2026-11-11:
// Log out in one window ended the manager's sign-in everywhere; another window kept looking signed in while every Edge Function
// refused it.)
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, createClient } from '@supabase/supabase-js';
import { readSourceFile } from './helpers/sourceCode';
import {
  createSessionEndHandler,
  isSessionEndConfirmed,
  isSessionEndedReply,
  onSessionEndedReply,
  SESSION_ENDED_MESSAGE,
  sessionAwareFetch,
} from '../src/auth/sessionEnded';
import { verifyBuildingDefault } from '../src/repository/xeroLinksRepository';
import { getXeroInvoiceCapabilities, sendInvoice } from '../src/repository/invoicesRepository';
import { AuthContext } from '../src/auth/AuthProvider';
import LoginPage from '../src/pages/LoginPage';

// ---- a fake server -------------------------------------------------------------------------------------------------------------------
interface Call { url: string; method: string }
let calls: Call[] = [];
let reply: (url: URL) => Response = () => json(200, {});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  calls.push({ url: url.href, method: (init?.method ?? 'GET').toUpperCase() });
  return reply(url);
}) as typeof fetch;

let reports = 0;
onSessionEndedReply(() => { reports += 1; });
beforeEach(() => { calls = []; reports = 0; reply = () => json(200, {}); });
const at = (path: string) => `https://tests.invalid${path}`;

// ---- which replies mean the sign-in has ended ---------------------------------------------------------------------------------------
test('REPLY: a function\'s "Invalid or expired session." / missing sign-in, the gateway\'s 401, and a database 401 are session-ended', () => {
  assert.equal(isSessionEndedReply({ status: 403, path: '/functions/v1/xero-link-contact', error: 'Invalid or expired session.' }), true);
  assert.equal(isSessionEndedReply({ status: 403, path: '/functions/v1/admin-users', error: 'Missing Authorization header.' }), true);
  assert.equal(isSessionEndedReply({ status: 401, path: '/functions/v1/xero-create-invoice', error: 'Invalid JWT' }), true);
  assert.equal(isSessionEndedReply({ status: 401, path: '/rest/v1/jobs', error: 'JWT expired' }), true);
});

test('REPLY: refusals that are NOT about the sign-in are left alone', () => {
  assert.equal(isSessionEndedReply({ status: 403, path: '/functions/v1/xero-link-contact', error: 'Not an active manager.' }), false);
  assert.equal(isSessionEndedReply({ status: 403, path: '/functions/v1/send-client-report', error: 'This report is not approved.' }), false);
  assert.equal(isSessionEndedReply({ status: 403, path: '/rest/v1/buildings', error: 'permission denied' }), false);
  assert.equal(isSessionEndedReply({ status: 401, path: '/auth/v1/token', error: 'Invalid login credentials' }), false, 'a wrong password on the sign-in page is not this');
});

// ---- the client's fetch ------------------------------------------------------------------------------------------------------------
test('FETCH: a function refusing the sign-in comes back as the one clear message, and it is reported', async () => {
  reply = () => json(403, { error: 'Invalid or expired session.' });
  const res = await sessionAwareFetch(at('/functions/v1/xero-link-contact'), { method: 'POST' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: SESSION_ENDED_MESSAGE, code: 'SESSION_ENDED' });
  assert.equal(reports, 1);
  reply = () => json(401, { code: 401, message: 'Invalid JWT' });
  assert.equal((await (await sessionAwareFetch(at('/functions/v1/xero-create-invoice'))).json()).error, SESSION_ENDED_MESSAGE);
  reply = () => new Response('Unauthorized', { status: 401 });
  assert.equal((await (await sessionAwareFetch(at('/functions/v1/admin-users'))).json()).error, SESSION_ENDED_MESSAGE, 'even without a JSON body');
  assert.equal(reports, 3);
});

test('FETCH: a database 401 is reported but its reply is unchanged; every other reply passes through untouched', async () => {
  reply = () => json(401, { message: 'JWT expired', code: 'PGRST301' });
  assert.equal((await (await sessionAwareFetch(at('/rest/v1/jobs'))).json()).message, 'JWT expired');
  assert.equal(reports, 1);
  for (const [path, status, body] of [
    ['/functions/v1/xero-link-contact', 403, { error: 'Not an active manager.' }],
    ['/functions/v1/xero-link-contact', 409, { error: 'Reload' }],
    ['/rest/v1/buildings', 403, { message: 'permission denied' }],
    ['/auth/v1/token', 400, { error: 'invalid_grant' }],
    ['/auth/v1/user', 401, { message: 'bad jwt' }],
    ['/functions/v1/xero-link-contact', 200, { ok: true }],
  ] as const) {
    const original = json(status, body);
    reply = () => original;
    const res = await sessionAwareFetch(at(path));
    assert.equal(res, original, `${path} ${status} untouched`);
  }
  assert.equal(reports, 1, 'nothing else was reported');
});

test('FETCH: a network failure is passed on as it is (and is not a sign-in problem)', async () => {
  reply = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => sessionAwareFetch(at('/functions/v1/xero-link-contact')), /Failed to fetch/);
  assert.equal(reports, 0);
});

// ---- what the screens show (real repository calls through the app's Supabase client) -------------------------------------------------
test('SCREENS: the Xero check, the invoice capabilities and a send all show the clear message instead of "Invalid or expired session."', async () => {
  reply = (url) => (url.pathname.startsWith('/functions/v1/') ? json(403, { error: 'Invalid or expired session.' }) : json(200, {}));
  for (const callIt of [() => verifyBuildingDefault('b1'), () => getXeroInvoiceCapabilities(), () => sendInvoice('inv-1')]) {
    await assert.rejects(callIt, (e: Error) => e.message === SESSION_ENDED_MESSAGE);
  }
  assert.equal(reports, 3);
  assert.ok(calls.every((c) => c.url.includes('/functions/v1/')), 'the requests went to the server as before');
});

test('SCREENS: a refusal that is not about the sign-in still shows the server\'s own reason', async () => {
  reply = () => json(403, { error: 'Not an active manager.' });
  await assert.rejects(() => verifyBuildingDefault('b1'), /Not an active manager\./);
  assert.equal(reports, 0);
});

// ---- confirming before signing out ---------------------------------------------------------------------------------------------------
test('CONFIRM: only the sign-in service saying the session is gone counts - not reaching it (offline) never does', () => {
  assert.equal(isSessionEndConfirmed(new AuthApiError('Session not found', 403, 'session_not_found')), true);
  assert.equal(isSessionEndConfirmed(new AuthApiError('invalid JWT', 401, 'bad_jwt')), true);
  assert.equal(isSessionEndConfirmed(new AuthSessionMissingError()), true);
  assert.equal(isSessionEndConfirmed(new AuthRetryableFetchError('Failed to fetch', 0)), false, 'offline: stay signed in');
  assert.equal(isSessionEndConfirmed(new AuthApiError('Internal error', 500, 'unexpected_failure')), false);
  assert.equal(isSessionEndConfirmed(null), false);
  assert.equal(isSessionEndConfirmed(new Error('anything else')), false);
});

function handlerWith(getUserError: unknown, opts: { throws?: boolean } = {}) {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const handle = createSessionEndHandler({
    getUser: async () => { log.push('getUser'); await gate; if (opts.throws) throw new Error('boom'); return { error: getUserError }; },
    signOutHere: async () => { log.push('signOutHere'); },
    onEnded: () => log.push('onEnded'),
  });
  return { log, handle, release };
}

test('CONFIRMED: this browser is signed out once (however many replies arrive together), and the sign-in page will say why', async () => {
  const { log, handle, release } = handlerWith(new AuthApiError('Session not found', 403, 'session_not_found'));
  const all = Promise.all([handle(), handle(), handle()]);
  release();
  await all;
  assert.deepEqual(log, ['getUser', 'onEnded', 'signOutHere']);
});

test('NOT CONFIRMED: still signed in (a false alarm, offline, or the check itself failing) - nothing happens', async () => {
  for (const [label, err, throws] of [['session fine', null, false], ['offline', new AuthRetryableFetchError('Failed to fetch', 0), false], ['check threw', null, true]] as const) {
    const { log, handle, release } = handlerWith(err, { throws });
    const p = handle();
    release();
    await p;
    assert.deepEqual(log, ['getUser'], label);
  }
});

test('AGAIN: after a check has finished, a later rejection is checked again', async () => {
  const { log, handle, release } = handlerWith(null);
  release();
  await handle();
  await handle();
  assert.deepEqual(log, ['getUser', 'getUser']);
});

// ---- Log out: this browser only -----------------------------------------------------------------------------------------------------
function signedInClient() {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const client = createClient('https://tests.invalid', 'anon', { auth: { storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: sessionAwareFetch } });
  const session = { access_token: 'access', refresh_token: 'refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
  store.set('sb-tests-auth-token', JSON.stringify(session));
  return { client, store };
}

test('LOG OUT: { scope: "local" } asks the server to end only this browser\'s session, and clears it here', async () => {
  reply = () => new Response(null, { status: 204 });
  const { client, store } = signedInClient();
  const { error } = await client.auth.signOut({ scope: 'local' });
  assert.equal(error, null);
  const logout = calls.find((c) => c.url.includes('/auth/v1/logout'))!;
  assert.equal(new URL(logout.url).searchParams.get('scope'), 'local');
  assert.equal(store.size, 0, 'signed out here');
});

test('LOG OUT: the app uses it - and nowhere signs out every session', () => {
  const code = readSourceFile('src', 'auth', 'AuthProvider.tsx');
  const calls = code.match(/supabase\.auth\.signOut\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.equal(c, "supabase.auth.signOut({ scope: 'local' })");
  assert.doesNotMatch(code, /scope: 'global'|scope: 'others'/);
});

test('LOG OUT: a session the server already ended is still cleared here (the server\'s "not found" does not block it)', async () => {
  reply = () => json(403, { code: 'session_not_found', message: 'Session not found' });
  const { client, store } = signedInClient();
  await client.auth.signOut({ scope: 'local' });
  assert.equal(store.size, 0);
});

// ---- wiring --------------------------------------------------------------------------------------------------------------------------
test('WIRING: every request uses the session-aware fetch; AuthProvider listens, confirms, signs out here, and clears the flag on the next sign-in', () => {
  assert.match(readSourceFile('src', 'lib', 'supabaseClient.ts'), /createClient\(supabaseUrl, supabaseAnonKey, \{ global: \{ fetch: sessionAwareFetch \} \}\)/);
  const auth = readSourceFile('src', 'auth', 'AuthProvider.tsx');
  assert.match(auth, /getUser: \(\) => supabase\.auth\.getUser\(\)/);
  assert.match(auth, /onEnded: \(\) => setSessionEnded\(true\)/);
  assert.match(auth, /return onSessionEndedReply\(\(\) => void handle\(\)\);/);
  assert.match(auth, /if \(cancelled\) return;\s+\/\/ A new sign-in[^\n]*\n\s+setSessionEnded\(false\);/);
});

// ---- the sign-in page ----------------------------------------------------------------------------------------------------------------
const loginWith = (sessionEnded: boolean | undefined) =>
  renderToStaticMarkup(
    <AuthContext.Provider value={{ status: 'signed_out', role: null, session: null, signOut: async () => {}, recheck: () => {}, sessionEnded }}>
      <LoginPage />
    </AuthContext.Provider>,
  );

test('SIGN-IN PAGE: says the sign-in has ended when that is why it is shown, and nothing extra otherwise', () => {
  assert.match(loginWith(true), /data-testid="session-ended"[^>]*>Your sign-in has ended\. Sign in again to continue\.</);
  assert.doesNotMatch(loginWith(false), /session-ended/);
  assert.doesNotMatch(loginWith(undefined), /session-ended/);
  assert.doesNotMatch(renderToStaticMarkup(<LoginPage />), /session-ended/, 'works outside the provider too');
});
