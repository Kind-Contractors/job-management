// Tests for the building invoice recipient actions of the REAL xero-link-contact Edge Function (searchRecipients, getRecipient,
// setBuildingRecipient, clearBuildingRecipient, and verify / the legacy default actions on such a building), run in Node. Only the
// surroundings are faked: the Deno runtime, the database (a fake Supabase REST + auth server, including the two server-only
// database functions with the same "is it still the recipient you saw?" check as the real ones) and Xero (identity + Accounting
// API). A request to any host the fakes do not know fails the test.
//
// Proved: only an active manager can use them; every Xero-touching action checks the connected organisation; the recipient is the
// exact Xero contact the manager confirmed, re-read in the connected organisation (missing, other-organisation, archived, not active,
// merged, email-less and renamed contacts are refused, never substituted); nothing is ever chosen from an email, a name or a
// person's Xero link; a stale page (contact id OR organisation changed) is refused before anything is written, and again by the
// database; the save goes only through the server-only database functions, with the service role, which is used for nothing else;
// changing one building touches no other building, no contact and no invoice; Xero only ever receives reads.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const ENV: Record<string, string | undefined> = {};
let handler: (req: Request) => Promise<Response> = async () => new Response('handler not registered', { status: 500 });
(globalThis as any).Deno = { serve: (h: typeof handler) => { handler = h; }, env: { get: (k: string) => ENV[k] } };

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const XC1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const XC2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const X_ARCHIVED = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const X_DRAFT = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const X_MERGED = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const X_NOEMAIL = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const X_OTHER_ORG = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const BA = '20000000-0000-4000-8000-00000000000a';
const BB = '20000000-0000-4000-8000-00000000000b';
const B_LEGACY = '20000000-0000-4000-8000-00000000000c';
const B_MISSING = '20000000-0000-4000-8000-0000000000ff';
const PERSON = '10000000-0000-4000-8000-000000000001';
const SECRET = 'test-client-secret-NEVER-LEAK';
const ACCESS_TOKEN = 'xero-access-token-NEVER-LEAK';
const SERVICE_KEY = 'service-role-key-NEVER-LEAK';
const MANAGER_TOKEN = 'manager-session-token';

interface Req { method: string; host: string; path: string; search: string; body: any; auth: string | null; apikey: string | null }
const none = () => ({
  default_invoice_contact_id: null, default_invoice_xero_contact_id: null, default_invoice_xero_org_id: null,
  default_invoice_xero_contact_name: null, default_invoice_xero_contact_email: null,
});
const world = {
  role: 'manager' as string,
  isActive: true,
  authOk: true,
  userEmail: 'luke@kindcontractors.co.uk' as string | null,
  buildings: {} as Record<string, any>,
  contacts: {} as Record<string, any>,
  orgBody: null as unknown,
  searchResults: [] as any[],
  xeroContacts: {} as Record<string, any>,
  /** Simulates another manager changing the recipient between this function's read and its save. */
  changeBeforeSave: null as null | ((b: Record<string, any>) => void),
  xeroLog: [] as Req[],
  dbLog: [] as Req[],
  rpcLog: [] as Req[],
  unexpected: [] as string[],
  violations: [] as string[],
};

function reset() {
  ENV.SUPABASE_URL = 'https://tests.invalid';
  ENV.SUPABASE_ANON_KEY = 'anon-test-key';
  ENV.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  ENV.XERO_CLIENT_ID = 'test-client-id';
  ENV.XERO_CLIENT_SECRET = SECRET;
  ENV.XERO_EXPECTED_ORG_ID = ORG;
  world.role = 'manager';
  world.isActive = true;
  world.authOk = true;
  world.userEmail = 'luke@kindcontractors.co.uk';
  world.buildings = {
    [BA]: { id: BA, client_id: 'client-1', ...none() },
    [BB]: { id: BB, client_id: 'client-1', ...none(), default_invoice_xero_contact_id: XC1, default_invoice_xero_org_id: ORG, default_invoice_xero_contact_name: 'Oak Estates Ltd', default_invoice_xero_contact_email: 'accounts@oak.test' },
    [B_LEGACY]: { id: B_LEGACY, client_id: 'client-1', ...none(), default_invoice_contact_id: PERSON, default_invoice_xero_contact_id: XC1, default_invoice_xero_org_id: ORG, default_invoice_xero_contact_name: 'Oak Estates Ltd' },
  };
  // A PERSON linked to a Xero contact - must never be used to choose a building's recipient.
  world.contacts = { [PERSON]: { id: PERSON, client_id: 'client-1', xero_contact_id: XC2, xero_org_id: ORG, xero_contact_name: 'Oak Estates Ltd', xero_linked_at: '2026-10-01T00:00:00Z' } };
  world.orgBody = null;
  world.searchResults = [];
  const addr = { AddressType: 'POBOX', AddressLine1: 'Flat 2', AddressLine2: '16-17 Marylebone High St', City: 'London', PostalCode: 'W1U 4QA', Country: 'United Kingdom' };
  world.xeroContacts = {
    [XC1]: { ContactID: XC1, Name: 'Oak Estates Ltd', EmailAddress: 'accounts@oak.test', ContactStatus: 'ACTIVE', AccountNumber: 'OAK1', Addresses: [addr] },
    // Same name AND same email as XC1, a different contact (scenarios B / E).
    [XC2]: { ContactID: XC2, Name: 'Oak Estates Ltd', EmailAddress: 'accounts@oak.test', ContactStatus: 'ACTIVE', AccountNumber: 'OAK2', Addresses: [{ AddressType: 'STREET', AddressLine1: '1 Oak Road', City: 'Leeds', PostalCode: 'LS1 1AA' }] },
    [X_ARCHIVED]: { ContactID: X_ARCHIVED, Name: 'Old Estates', EmailAddress: 'old@x.test', ContactStatus: 'ARCHIVED' },
    [X_DRAFT]: { ContactID: X_DRAFT, Name: 'Odd Status', EmailAddress: 'odd@x.test', ContactStatus: 'GDPRREQUEST' },
    [X_MERGED]: { ContactID: X_MERGED, Name: 'Merged Estates', EmailAddress: 'm@x.test', ContactStatus: 'ACTIVE', MergedToContactID: XC1 },
    [X_NOEMAIL]: { ContactID: X_NOEMAIL, Name: 'No Mail Ltd', ContactStatus: 'ACTIVE' },
  };
  world.changeBeforeSave = null;
  world.xeroLog = [];
  world.dbLog = [];
  world.rpcLog = [];
  world.unexpected = [];
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function xeroApi(r: Req): Response {
  const p = r.path.replace('/api.xro/2.0', '');
  if (r.method !== 'GET') world.violations.push(`${r.method} ${p}`);
  if (p === '/Organisation') return json(200, world.orgBody ?? { Organisations: [{ OrganisationID: ORG }] });
  if (p === '/Contacts') return json(200, { Contacts: world.searchResults });
  const m = p.match(/^\/Contacts\/([^/]+)$/);
  if (m) {
    const c = world.xeroContacts[m[1]];
    return c ? json(200, { Contacts: [c] }) : json(404, { Type: 'NotFound' });
  }
  world.unexpected.push(`${r.method} ${p}`);
  return json(500, {});
}

/** The database functions, with the same refusals as supabase/migrations/20261110100000_building_invoice_recipient.sql. */
function rpc(name: string, a: Record<string, any>): Response {
  const fail = (message: string) => json(400, { code: 'P0001', message, details: null, hint: null });
  const b = world.buildings[a.p_building_id];
  if (!b) return fail('building_not_found: that building could not be found. Nothing was changed.');
  world.changeBeforeSave?.(b);
  const expId = a.p_expected_current_xero_contact_id?.trim() || null;
  const expOrg = a.p_expected_current_xero_org_id?.trim() || null;
  if ((b.default_invoice_xero_contact_id ?? null) !== expId || (b.default_invoice_xero_org_id ?? null) !== expOrg) {
    return fail("building_invoice_recipient_changed: this building's invoice recipient is not the one you saw. Reload and try again. Nothing was changed.");
  }
  if (name === 'set_building_invoice_recipient') {
    if (!a.p_xero_contact_id?.trim() || !a.p_xero_org_id?.trim() || !a.p_xero_contact_name?.trim()) return fail('building_invoice_recipient_incomplete: ...');
    if (!a.p_actor?.trim()) return fail('building_invoice_recipient_actor_required: ...');
    Object.assign(b, {
      default_invoice_contact_id: null, default_invoice_xero_contact_id: a.p_xero_contact_id, default_invoice_xero_org_id: a.p_xero_org_id,
      default_invoice_xero_contact_name: a.p_xero_contact_name, default_invoice_xero_contact_email: a.p_xero_contact_email, set_by: a.p_actor,
    });
  } else {
    Object.assign(b, none(), { set_by: null });
  }
  return new Response(null, { status: 204 });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const rawBody = init?.body;
  const body = rawBody && typeof rawBody === 'string' && rawBody.startsWith('{') ? JSON.parse(rawBody) : rawBody;
  const r: Req = { method, host: url.host, path: decodeURIComponent(url.pathname), search: url.search, body, auth: headers.get('authorization'), apikey: headers.get('apikey') };
  if (url.host === 'identity.xero.com') {
    world.xeroLog.push(r);
    return json(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 1800 });
  }
  if (url.host === 'api.xero.com') {
    world.xeroLog.push(r);
    return xeroApi(r);
  }
  if (url.host === 'tests.invalid') {
    world.dbLog.push(r);
    const usesService = r.auth === `Bearer ${SERVICE_KEY}` || r.apikey === SERVICE_KEY;
    if (r.path.startsWith('/rest/v1/rpc/')) {
      world.rpcLog.push(r);
      if (r.auth !== `Bearer ${SERVICE_KEY}`) world.violations.push(`database function called without the service role: ${r.path}`);
      return rpc(r.path.slice('/rest/v1/rpc/'.length), body ?? {});
    }
    if (usesService) world.violations.push(`service role used for something other than the recipient functions: ${method} ${r.path}`);
    const obj = (headers.get('accept') ?? '').includes('vnd.pgrst.object');
    const one = (row: unknown) => json(200, obj ? row : [row]);
    const nothing = () => json(200, obj ? null : []);
    const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
    if (r.path === '/auth/v1/user') {
      return world.authOk
        ? json(200, { id: 'user-1', aud: 'authenticated', email: world.userEmail ?? undefined, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' })
        : json(401, { message: 'bad jwt' });
    }
    if (r.path === '/rest/v1/app_users') return one({ role: world.role, is_active: world.isActive });
    if (r.path === '/rest/v1/contacts' && method === 'GET') {
      const row = idEq ? world.contacts[idEq] : null;
      return row ? one(row) : nothing();
    }
    if (r.path === '/rest/v1/buildings') {
      const b = idEq ? world.buildings[idEq] : null;
      if (method === 'GET') return b ? one(b) : nothing();
      if (method === 'PATCH') {
        if (!b) return nothing();
        // The real trigger refuses any direct write to a recipient chosen without a contact.
        if (!b.default_invoice_contact_id && b.default_invoice_xero_contact_id) {
          return json(403, { code: '42501', message: "building_invoice_recipient_server_only: this building's invoice recipient can only be set, changed or cleared through the invoice recipient panel. Nothing was changed." });
        }
        Object.assign(b, body);
        return one({ id: b.id });
      }
    }
    world.unexpected.push(`database request ${method} ${r.path}`);
    return json(404, { message: 'unexpected' });
  }
  world.unexpected.push(`request to unknown host ${url.host}`);
  return json(500, {});
}) as typeof fetch;

const consoleLines: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  (console as any)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
}

beforeEach(() => { reset(); world.violations = []; consoleLines.length = 0; });
afterEach(() => {
  assert.deepEqual(world.violations, [], 'a rule was broken (Xero write, or service role misuse)');
  assert.deepEqual(world.unexpected, [], 'an unexpected request was made');
});

await import('../supabase/functions/xero-link-contact/index.ts');

const post = async (body: Record<string, unknown>) => {
  const res = await handler(new Request('https://fn.test/xero-link-contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MANAGER_TOKEN}` },
    body: JSON.stringify(body),
  }));
  return { status: res.status, out: (await res.json()) as any };
};
const setR = (over: Record<string, unknown> = {}) =>
  post({ action: 'setBuildingRecipient', buildingId: BA, xeroContactId: XC1, expectedName: 'Oak Estates Ltd', expectedCurrentXeroContactId: null, expectedCurrentXeroOrgId: null, ...over });
const clearR = (over: Record<string, unknown> = {}) =>
  post({ action: 'clearBuildingRecipient', buildingId: BB, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG, ...over });
const xeroGets = () => world.xeroLog.filter((r) => r.host === 'api.xero.com');
const contactReadsFromXero = () => xeroGets().filter((r) => r.path.includes('/Contacts'));
const writes = () => world.dbLog.filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && r.path !== '/auth/v1/user');
const snapshot = () => JSON.parse(JSON.stringify(world.buildings));
const NEW_ACTIONS = ['searchRecipients', 'getRecipient', 'setBuildingRecipient', 'clearBuildingRecipient'];

// ---- authorization --------------------------------------------------------------------------------------------------------------
test('AUTH: technicians, viewers, waste reporters, an inactive manager and a bad session are refused every new action - no Xero, no write', async () => {
  const before = snapshot();
  for (const setup of [() => { world.role = 'technician'; }, () => { world.role = 'viewer'; }, () => { world.role = 'waste_reporter'; }, () => { world.isActive = false; }, () => { world.authOk = false; }]) {
    reset();
    setup();
    for (const action of NEW_ACTIONS) {
      const { status } = await post({ action, term: 'oak', buildingId: BB, xeroContactId: XC1, expectedName: 'Oak Estates Ltd', expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG });
      assert.equal(status, 403, action);
    }
    assert.equal(xeroGets().length, 0);
    assert.equal(world.rpcLog.length, 0);
    assert.equal(writes().length, 0);
  }
  assert.deepEqual(world.buildings, before);
});

test('AUTH: a manager whose account has no email cannot set a recipient (who chose it must be recorded) - nothing saved', async () => {
  world.userEmail = null;
  const { status, out } = await setR();
  assert.equal(status, 422);
  assert.equal(out.code, 'ACTOR_UNKNOWN');
  assert.equal(world.rpcLog.length, 0);
});

test('REQUEST: missing or malformed fields are refused before Xero is asked', async () => {
  const bad = [
    { expectedName: '' },
    { expectedName: undefined },
    { xeroContactId: 'accounts@oak.test' }, // an email is never a recipient
    { xeroContactId: 'Oak Estates Ltd' }, // nor a name
    { buildingId: 'not-an-id' },
    { expectedCurrentXeroContactId: undefined },
    { expectedCurrentXeroOrgId: undefined },
    { expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: null }, // only half of the recipient
    { expectedCurrentXeroContactId: null, expectedCurrentXeroOrgId: ORG },
    { expectedCurrentXeroContactId: 'x', expectedCurrentXeroOrgId: ORG },
  ];
  for (const over of bad) {
    const body: Record<string, unknown> = { action: 'setBuildingRecipient', buildingId: BA, xeroContactId: XC1, expectedName: 'Oak Estates Ltd', expectedCurrentXeroContactId: null, expectedCurrentXeroOrgId: null, ...over };
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete body[k];
    const { status } = await post(body);
    assert.equal(status, 400, JSON.stringify(over));
  }
  assert.equal((await post({ action: 'clearBuildingRecipient', buildingId: BB })).status, 400);
  assert.equal((await post({ action: 'getRecipient', xeroContactId: 'nope' })).status, 400);
  assert.equal((await post({ action: 'searchRecipients', term: 'o' })).status, 400);
  assert.equal(xeroGets().length, 0);
  assert.equal(world.rpcLog.length, 0);
});

// ---- organisation ---------------------------------------------------------------------------------------------------------------
test('ORG: connected to a different organisation, or none configured - search, get and set are refused (503) and nothing is saved', async () => {
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  for (const body of [{ action: 'searchRecipients', term: 'oak' }, { action: 'getRecipient', xeroContactId: XC1 }]) {
    const { status, out } = await post(body);
    assert.equal(status, 503);
    assert.equal(out.code, 'ORG_MISMATCH');
  }
  const { status, out } = await setR();
  assert.equal(status, 503);
  assert.equal(out.code, 'ORG_MISMATCH');
  assert.equal(contactReadsFromXero().length, 0, 'no contact is read from the wrong organisation');
  reset();
  delete ENV.XERO_EXPECTED_ORG_ID;
  assert.equal((await setR()).out.code, 'ORG_NOT_CONFIGURED');
  assert.equal(xeroGets().length, 0);
  assert.equal(world.rpcLog.length, 0);
  assert.equal(world.buildings[BA].default_invoice_xero_contact_id, null);
});

test('ORG: a contact id from another organisation does not exist in the connected one - refused, never substituted', async () => {
  const { status, out } = await setR({ xeroContactId: X_OTHER_ORG, expectedName: 'Oak Estates Ltd' });
  assert.equal(status, 422);
  assert.equal(out.code, 'CONTACT_NOT_IN_ORGANISATION');
  assert.equal(world.rpcLog.length, 0);
  assert.deepEqual(contactReadsFromXero().map((r) => r.path.split('/').pop()), [X_OTHER_ORG], 'only that id was looked up - no search for a look-alike');
});

// ---- search and get -------------------------------------------------------------------------------------------------------------
test('SEARCH: full name, email and address for the manager; look-alikes flagged; blocked ones marked; nothing chosen or saved', async () => {
  world.searchResults = [world.xeroContacts[XC1], world.xeroContacts[XC2], world.xeroContacts[X_ARCHIVED], world.xeroContacts[X_MERGED]];
  const { status, out } = await post({ action: 'searchRecipients', term: '16-17 Marylebone' });
  assert.equal(status, 200);
  const [a, b, c, d] = out.results;
  assert.equal(a.email, 'accounts@oak.test');
  assert.equal(a.address, 'Flat 2, 16-17 Marylebone High St, London, W1U 4QA, United Kingdom');
  assert.equal(a.accountNumber, 'OAK1');
  assert.equal(b.address, '1 Oak Road, Leeds, LS1 1AA');
  assert.equal(a.sameNameAsOthers, 1);
  assert.equal(a.sameEmailAsOthers, 1);
  assert.equal(c.blockedReason, 'ARCHIVED');
  assert.equal(d.blockedReason, 'MERGED');
  assert.equal(out.results.length, 4);
  assert.ok(!('selected' in out) && !('chosen' in out));
  const q = contactReadsFromXero()[0];
  assert.equal(new URLSearchParams(q.search).get('searchTerm'), '16-17 Marylebone');
  assert.equal(world.rpcLog.length, 0);
  assert.equal(writes().length, 0);
});

test('SEARCH: a single result is listed, not chosen', async () => {
  world.searchResults = [world.xeroContacts[XC1]];
  const { out } = await post({ action: 'searchRecipients', term: 'oak' });
  assert.equal(out.results.length, 1);
  assert.equal(world.rpcLog.length, 0);
  assert.equal(world.buildings[BA].default_invoice_xero_contact_id, null);
});

test('GET: a contact\'s current details by id; missing, archived, not active, merged and email-less are reported, read-only', async () => {
  const ok = await post({ action: 'getRecipient', xeroContactId: XC1 });
  assert.equal(ok.out.state, 'ok');
  assert.equal(ok.out.contact.email, 'accounts@oak.test');
  assert.equal(ok.out.contact.address, 'Flat 2, 16-17 Marylebone High St, London, W1U 4QA, United Kingdom');
  const states: Record<string, string> = { [X_OTHER_ORG]: 'not_found', [X_ARCHIVED]: 'not_active', [X_DRAFT]: 'not_active', [X_MERGED]: 'merged', [X_NOEMAIL]: 'no_email' };
  for (const [id, state] of Object.entries(states)) assert.equal((await post({ action: 'getRecipient', xeroContactId: id })).out.state, state, id);
  assert.equal(world.rpcLog.length, 0);
  assert.equal(writes().length, 0);
});

// ---- set / replace / update / clear ---------------------------------------------------------------------------------------------
test('SET: the confirmed contact, re-read in Xero, is saved through the server-only function with the service role', async () => {
  const { status, out } = await setR();
  assert.equal(status, 200);
  assert.equal(world.rpcLog.length, 1);
  const call = world.rpcLog[0];
  assert.equal(call.path, '/rest/v1/rpc/set_building_invoice_recipient');
  assert.equal(call.auth, `Bearer ${SERVICE_KEY}`);
  assert.deepEqual(call.body, {
    p_building_id: BA,
    p_xero_contact_id: XC1,
    p_xero_org_id: ORG, // the CONNECTED organisation, confirmed with Xero
    p_xero_contact_name: 'Oak Estates Ltd', // from Xero, not from the request
    p_xero_contact_email: 'accounts@oak.test', // from Xero
    p_actor: 'luke@kindcontractors.co.uk', // the signed-in manager
    p_expected_current_xero_contact_id: null,
    p_expected_current_xero_org_id: null,
  });
  assert.equal(world.buildings[BA].default_invoice_xero_contact_id, XC1);
  assert.equal(out.recipient.contactId, XC1);
  assert.equal(out.recipient.xeroOrgId, ORG);
  assert.equal(out.previous, null);
  assert.equal(out.unchanged, false);
  // The manager's own session did every read; the service role did only the save.
  assert.ok(world.dbLog.filter((r) => !r.path.startsWith('/rest/v1/rpc/')).every((r) => r.auth === `Bearer ${MANAGER_TOKEN}`));
});

test('REPLACE: a DIFFERENT contact with the same name and email (B / E) replaces the confirmed current one', async () => {
  const { status, out } = await setR({ buildingId: BB, xeroContactId: XC2, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG });
  assert.equal(status, 200);
  assert.equal(world.buildings[BB].default_invoice_xero_contact_id, XC2);
  assert.deepEqual(out.previous, { xeroContactId: XC1, xeroOrgId: ORG });
  assert.equal(out.unchanged, false);
});

test('REPLACE a recipient saved in ANOTHER organisation: the new one is saved with the CONNECTED organisation, never the old one', async () => {
  world.buildings[BB].default_invoice_xero_org_id = OTHER_ORG;
  const { status, out } = await setR({ buildingId: BB, xeroContactId: XC2, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: OTHER_ORG });
  assert.equal(status, 200);
  assert.equal(world.rpcLog[0].body.p_xero_org_id, ORG);
  assert.equal(world.rpcLog[0].body.p_expected_current_xero_org_id, OTHER_ORG);
  assert.equal(world.buildings[BB].default_invoice_xero_org_id, ORG);
  assert.deepEqual(out.previous, { xeroContactId: XC1, xeroOrgId: OTHER_ORG });
  assert.equal(out.unchanged, false);
});

test('UPDATE SAME: re-confirming the current contact refreshes its details and says it is unchanged', async () => {
  world.xeroContacts[XC1].Name = 'Oak Estates Limited';
  world.xeroContacts[XC1].EmailAddress = 'ap@oak.test';
  const { status, out } = await setR({ buildingId: BB, expectedName: 'Oak Estates Limited', expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG });
  assert.equal(status, 200);
  assert.equal(out.unchanged, true);
  assert.equal(world.buildings[BB].default_invoice_xero_contact_name, 'Oak Estates Limited');
  assert.equal(world.buildings[BB].default_invoice_xero_contact_email, 'ap@oak.test');
});

test('REPLACE a legacy (person-based) default: allowed only with that default confirmed; the person link is never consulted', async () => {
  const { status } = await setR({ buildingId: B_LEGACY, xeroContactId: XC2, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG });
  assert.equal(status, 200);
  assert.equal(world.buildings[B_LEGACY].default_invoice_contact_id, null);
  assert.equal(world.buildings[B_LEGACY].default_invoice_xero_contact_id, XC2);
  assert.equal(world.dbLog.filter((r) => r.path === '/rest/v1/contacts').length, 0, 'contacts are never read to choose a recipient');
});

test('CLEAR: through the server-only function with the confirmed recipient; Xero is not needed', async () => {
  const { status, out } = await clearR();
  assert.equal(status, 200);
  assert.equal(out.cleared, true);
  assert.equal(world.rpcLog.length, 1);
  assert.equal(world.rpcLog[0].path, '/rest/v1/rpc/clear_building_invoice_recipient');
  assert.deepEqual(world.rpcLog[0].body, { p_building_id: BB, p_expected_current_xero_contact_id: XC1, p_expected_current_xero_org_id: ORG });
  assert.equal(world.buildings[BB].default_invoice_xero_contact_id, null);
  assert.equal(xeroGets().length, 0);
});

test('CLEAR: clearing a building that has none (and was seen as none) changes nothing and calls nothing', async () => {
  const { status, out } = await clearR({ buildingId: BA, expectedCurrentXeroContactId: null, expectedCurrentXeroOrgId: null });
  assert.equal(status, 200);
  assert.equal(out.cleared, false);
  assert.equal(world.rpcLog.length, 0);
});

// ---- stale selections -----------------------------------------------------------------------------------------------------------
test('STALE: a different contact id OR a different organisation than the manager saw is refused (409) before Xero is asked', async () => {
  const before = snapshot();
  const cases = [
    { buildingId: BB, expectedCurrentXeroContactId: XC2, expectedCurrentXeroOrgId: ORG }, // wrong contact
    { buildingId: BB, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: OTHER_ORG }, // same contact, wrong organisation
    { buildingId: BB, expectedCurrentXeroContactId: null, expectedCurrentXeroOrgId: null }, // saw none, there is one
    { buildingId: BA, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG }, // saw one, there is none
  ];
  for (const c of cases) {
    const s = await setR({ xeroContactId: XC2, ...c });
    assert.equal(s.status, 409, `set ${JSON.stringify(c)}`);
    assert.equal(s.out.code, 'RECIPIENT_CHANGED');
    assert.match(s.out.error, /Reload/);
    const cl = await clearR(c);
    assert.equal(cl.status, 409, `clear ${JSON.stringify(c)}`);
    assert.equal(cl.out.code, 'RECIPIENT_CHANGED');
  }
  assert.equal(xeroGets().length, 0);
  assert.equal(world.rpcLog.length, 0);
  assert.deepEqual(world.buildings, before);
});

test('STALE (race): changed by someone else between the read and the save - the database refuses, reported as reload, nothing overwritten', async () => {
  // Another manager moves the recipient to another organisation (same contact id) just before the save.
  world.changeBeforeSave = (b) => { b.default_invoice_xero_org_id = OTHER_ORG; };
  const s = await setR({ buildingId: BB, xeroContactId: XC2, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG });
  assert.equal(s.status, 409);
  assert.equal(s.out.code, 'RECIPIENT_CHANGED');
  assert.equal(world.buildings[BB].default_invoice_xero_contact_id, XC1);
  const cl = await clearR();
  assert.equal(cl.status, 409);
  assert.equal(cl.out.code, 'RECIPIENT_CHANGED');
  assert.equal(world.buildings[BB].default_invoice_xero_contact_id, XC1);
});

// ---- invalid or inactive contacts -----------------------------------------------------------------------------------------------
test('INVALID: archived, not active, merged and email-less contacts are refused with the reason - never replaced by another', async () => {
  const expectations: [string, string, string][] = [
    [X_ARCHIVED, 'Old Estates', 'CONTACT_NOT_ACTIVE'],
    [X_DRAFT, 'Odd Status', 'CONTACT_NOT_ACTIVE'],
    [X_MERGED, 'Merged Estates', 'CONTACT_MERGED'],
    [X_NOEMAIL, 'No Mail Ltd', 'CONTACT_NO_EMAIL'],
  ];
  for (const [id, name, code] of expectations) {
    const { status, out } = await setR({ xeroContactId: id, expectedName: name });
    assert.equal(status, 422, id);
    assert.equal(out.code, code);
    assert.match(out.error, /Nothing was changed/);
  }
  assert.equal(world.rpcLog.length, 0);
  assert.equal(world.buildings[BA].default_invoice_xero_contact_id, null, 'the merged contact\'s survivor is NOT chosen instead');
});

test('INVALID: a contact renamed since the manager looked is refused (409) - the name sent is never trusted over Xero', async () => {
  const { status, out } = await setR({ expectedName: 'Oak Estates' });
  assert.equal(status, 409);
  assert.equal(out.code, 'CONTACT_CHANGED');
  assert.equal(world.rpcLog.length, 0);
});

test('INVALID: an unknown building is a 404 before Xero is asked', async () => {
  assert.equal((await setR({ buildingId: B_MISSING })).status, 404);
  assert.equal((await clearR({ buildingId: B_MISSING })).status, 404);
  assert.equal(xeroGets().length, 0);
  assert.equal(world.rpcLog.length, 0);
});

// ---- never automatic, never anything else ----------------------------------------------------------------------------------------
test('NEVER AUTOMATIC: no action picks a recipient - a person linked to a Xero contact, or a building sharing the name, changes nothing', async () => {
  world.searchResults = [world.xeroContacts[XC2]];
  await post({ action: 'searchRecipients', term: 'Oak Estates Ltd' });
  await post({ action: 'getRecipient', xeroContactId: XC2 });
  await post({ action: 'verify', buildingId: BA });
  assert.equal(world.buildings[BA].default_invoice_xero_contact_id, null, 'BA stays without a recipient though a person and BB point at Oak Estates');
  assert.equal(world.rpcLog.length, 0);
  assert.equal(writes().length, 0);
});

test('INDEPENDENT: setting, replacing and clearing building A touches no other building, no contact and no invoice', async () => {
  const others = JSON.stringify([world.buildings[BB], world.buildings[B_LEGACY], world.contacts]);
  await setR();
  await setR({ xeroContactId: XC2, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG });
  await clearR({ buildingId: BA, expectedCurrentXeroContactId: XC2, expectedCurrentXeroOrgId: ORG });
  assert.equal(JSON.stringify([world.buildings[BB], world.buildings[B_LEGACY], world.contacts]), others);
  assert.ok(world.rpcLog.every((r) => r.body.p_building_id === BA));
  assert.equal(world.dbLog.filter((r) => /invoices|contacts/.test(r.path)).length, 0);
});

// ---- verify and the legacy actions on such a building -----------------------------------------------------------------------------
test('VERIFY: a building\'s own recipient is checked live - ok (with current details), renamed, wrong organisation, missing, blocked', async () => {
  let v = (await post({ action: 'verify', buildingId: BB })).out;
  assert.equal(v.state, 'ok');
  assert.equal(v.recipientSource, 'building');
  assert.equal(v.current.email, 'accounts@oak.test');
  assert.equal(v.nameChanged, false);
  world.xeroContacts[XC1].Name = 'Oak Estates (Renamed)';
  v = (await post({ action: 'verify', buildingId: BB })).out;
  assert.equal(v.nameChanged, true);
  world.xeroContacts[XC1].ContactStatus = 'ARCHIVED';
  assert.equal((await post({ action: 'verify', buildingId: BB })).out.state, 'not_active');
  delete world.xeroContacts[XC1];
  assert.equal((await post({ action: 'verify', buildingId: BB })).out.state, 'not_found');
  world.buildings[BB].default_invoice_xero_org_id = OTHER_ORG;
  assert.equal((await post({ action: 'verify', buildingId: BB })).out.state, 'wrong_organisation');
  assert.equal((await post({ action: 'verify', buildingId: BA })).out.state, 'no_default');
  assert.equal(world.rpcLog.length, 0);
  assert.equal(writes().length, 0);
});

test('LEGACY ACTIONS: the person-based set/clear default refuse a building whose recipient was chosen in the panel (409) - nothing written', async () => {
  const before = snapshot();
  const set = await post({ action: 'setBuildingDefault', buildingId: BB, localContactId: PERSON });
  assert.equal(set.status, 409);
  assert.equal(set.out.code, 'RECIPIENT_SET_IN_PANEL');
  const clear = await post({ action: 'clearBuildingDefault', buildingId: BB });
  assert.equal(clear.status, 409);
  assert.equal(clear.out.code, 'RECIPIENT_SET_IN_PANEL');
  assert.deepEqual(world.buildings, before);
  assert.equal(writes().length, 0);
});

test('LEGACY ACTIONS: a person-based default is still cleared as before (unchanged workflow)', async () => {
  const { status } = await post({ action: 'clearBuildingDefault', buildingId: B_LEGACY });
  assert.equal(status, 200);
  assert.equal(world.buildings[B_LEGACY].default_invoice_contact_id, null);
  assert.equal(world.rpcLog.length, 0, 'the old action still writes directly, as before');
});

// ---- across everything -----------------------------------------------------------------------------------------------------------
test('EVERYTHING: Xero only received reads; the service key, client secret and token never appear in a response or a log', async () => {
  world.searchResults = [world.xeroContacts[XC1]];
  const outs = [
    await post({ action: 'searchRecipients', term: 'oak' }),
    await post({ action: 'getRecipient', xeroContactId: XC1 }),
    await setR(),
    await setR({ xeroContactId: X_ARCHIVED, expectedName: 'Old Estates', expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG }),
    await clearR({ buildingId: BA, expectedCurrentXeroContactId: XC1, expectedCurrentXeroOrgId: ORG }),
    await post({ action: 'verify', buildingId: BB }),
  ];
  for (const r of world.xeroLog.filter((x) => x.host === 'api.xero.com')) assert.equal(r.method, 'GET');
  const leak = new RegExp(`${SECRET}|${ACCESS_TOKEN}|${SERVICE_KEY}|test-client-id`);
  assert.doesNotMatch(JSON.stringify(outs), leak);
  assert.doesNotMatch(consoleLines.join('\n'), leak);
});
