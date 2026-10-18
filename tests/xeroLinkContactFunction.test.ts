// Tests for the REAL xero-link-contact Edge Function code, run in Node. Only its surroundings are faked: the Deno runtime, the
// database (a small fake Supabase REST + auth server) and Xero (a fake identity server and Accounting API). No real request is
// ever made; a request to any host the fakes do not know fails the test.
//
// Proved: only an active manager can use it (before any database or Xero access); every Xero-touching action first checks the
// connected organisation; search only reads, encodes the term and never picks a candidate; a link is made only for the exact
// contact the manager confirmed, with the organisation recorded; archived / missing / merged / email-less / changed / ambiguous /
// other-organisation contacts are refused, never substituted; a contact that is a building default cannot be re-linked or unlinked;
// a building default must be a linked contact of the building's client; and nothing ever creates or changes a Xero contact.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const ENV: Record<string, string | undefined> = {};
let handler: (req: Request) => Promise<Response> = async () => new Response('handler not registered', { status: 500 });
(globalThis as any).Deno = { serve: (h: typeof handler) => { handler = h; }, env: { get: (k: string) => ENV[k] } };

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const XC1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const XC2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const L1 = '10000000-0000-4000-8000-000000000001';
const L2 = '10000000-0000-4000-8000-000000000002';
const L_OTHER_CLIENT = '10000000-0000-4000-8000-000000000009';
const B1 = '20000000-0000-4000-8000-000000000001';
const SECRET = 'test-client-secret-NEVER-LEAK';
const ACCESS_TOKEN = 'xero-access-token-NEVER-LEAK';

interface Req { method: string; host: string; path: string; search: string; body: any }
const world = {
  role: 'manager' as string,
  isActive: true,
  authOk: true,
  contacts: {} as Record<string, any>,
  building: null as any,
  orgBody: null as unknown,
  searchResults: [] as any[],
  xeroContacts: {} as Record<string, any>,
  xeroLog: [] as Req[],
  dbLog: [] as Req[],
  unexpected: [] as string[],
  violations: [] as string[],
};

function reset() {
  ENV.SUPABASE_URL = 'https://tests.invalid';
  ENV.SUPABASE_ANON_KEY = 'anon-test-key';
  ENV.XERO_CLIENT_ID = 'test-client-id';
  ENV.XERO_CLIENT_SECRET = SECRET;
  ENV.XERO_EXPECTED_ORG_ID = ORG;
  world.role = 'manager';
  world.isActive = true;
  world.authOk = true;
  const blank = { xero_contact_id: null, xero_org_id: null, xero_contact_name: null, xero_linked_at: null };
  world.contacts = {
    [L1]: { id: L1, client_id: 'client-1', ...blank },
    [L2]: { id: L2, client_id: 'client-1', ...blank },
    [L_OTHER_CLIENT]: { id: L_OTHER_CLIENT, client_id: 'client-2', ...blank },
  };
  world.building = { id: B1, client_id: 'client-1', default_invoice_contact_id: null, default_invoice_xero_contact_id: null, default_invoice_xero_org_id: null };
  world.orgBody = null;
  world.searchResults = [];
  world.xeroContacts = {
    [XC1]: { ContactID: XC1, Name: 'Oak Estates Ltd', EmailAddress: 'accounts@oak.test', ContactStatus: 'ACTIVE' },
    [XC2]: { ContactID: XC2, Name: 'Oak Estates Ltd', EmailAddress: 'accounts@oak.test', ContactStatus: 'ACTIVE' },
  };
  world.xeroLog = [];
  world.dbLog = [];
  world.unexpected = [];
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function xeroApi(r: Req): Response {
  const p = r.path.replace('/api.xro/2.0', '');
  if (r.method !== 'GET') world.violations.push(`${r.method} ${p}`);
  if (p === '/Organisation') return json(200, world.orgBody ?? { Organisations: [{ OrganisationID: ORG }] });
  if (p === '/Contacts') {
    const term = new URLSearchParams(r.search).get('searchTerm') ?? '';
    if (term.length > 50) {
      world.violations.push(`overlong searchTerm (${term.length})`);
      return json(400, { Type: 'ValidationException', Message: 'SearchTerm has a maximum length of 50 characters' });
    }
    return json(200, { Contacts: world.searchResults });
  }
  const m = p.match(/^\/Contacts\/([^/]+)$/);
  if (m) {
    const c = world.xeroContacts[m[1]];
    return c ? json(200, { Contacts: [c] }) : json(404, { Type: 'NotFound' });
  }
  world.unexpected.push(`${r.method} ${p}`);
  return json(500, {});
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const rawBody = init?.body;
  const body = rawBody && typeof rawBody === 'string' && rawBody.startsWith('{') ? JSON.parse(rawBody) : rawBody;
  const r: Req = { method, host: url.host, path: decodeURIComponent(url.pathname), search: url.search, body };
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
    const obj = (headers.get('accept') ?? '').includes('vnd.pgrst.object');
    const one = (row: unknown) => json(200, obj ? row : [row]);
    const none = () => json(200, obj ? null : []);
    const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
    if (r.path === '/auth/v1/user') {
      return world.authOk ? json(200, { id: 'user-1', aud: 'authenticated', email: 'luke@kindcontractors.co.uk', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }) : json(401, { message: 'bad jwt' });
    }
    if (r.path === '/rest/v1/app_users') return one({ role: world.role, is_active: world.isActive });
    if (r.path === '/rest/v1/contacts') {
      if (method === 'PATCH') {
        const row = idEq ? world.contacts[idEq] : null;
        if (!row) return none();
        Object.assign(row, body);
        return one({ id: row.id });
      }
      if (method === 'GET') {
        const xid = url.searchParams.get('xero_contact_id')?.replace(/^eq\./, '');
        if (xid) {
          const neq = url.searchParams.get('id')?.replace(/^neq\./, '');
          return json(200, Object.values(world.contacts).filter((c: any) => c.xero_contact_id === xid && c.id !== neq).map((c: any) => ({ id: c.id })));
        }
        const row = idEq ? world.contacts[idEq] : null;
        return row ? one(row) : none();
      }
    }
    if (r.path === '/rest/v1/buildings') {
      if (method === 'HEAD' || (method === 'GET' && url.searchParams.get('default_invoice_contact_id'))) {
        const wanted = url.searchParams.get('default_invoice_contact_id')?.replace(/^eq\./, '');
        const n = world.building.default_invoice_contact_id === wanted ? 1 : 0;
        return new Response(null, { status: 200, headers: { 'content-range': `*/${n}`, 'content-type': 'application/json' } });
      }
      if (method === 'PATCH') {
        if (!world.building || idEq !== world.building.id) return none();
        Object.assign(world.building, body);
        return one({ id: world.building.id });
      }
      if (method === 'GET') return idEq === world.building?.id ? one(world.building) : none();
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
  assert.deepEqual(world.violations, [], 'something other than a read was sent to Xero');
  assert.deepEqual(world.unexpected, [], 'an unexpected request was made');
});

await import('../supabase/functions/xero-link-contact/index.ts');

function call(body: Record<string, unknown>, opts: { method?: string } = {}) {
  return handler(new Request('https://fn.test/xero-link-contact', {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: opts.method === 'GET' ? undefined : JSON.stringify(body),
  }));
}
const post = async (body: Record<string, unknown>) => { const res = await call(body); return { status: res.status, out: (await res.json()) as any }; };
const link = (over: Record<string, unknown> = {}) => post({ action: 'link', localContactId: L1, xeroContactId: XC1, expectedName: 'Oak Estates Ltd', ...over });
const linkedState = (id: string, xid = XC1, org = ORG) => Object.assign(world.contacts[id], { xero_contact_id: xid, xero_org_id: org, xero_contact_name: 'Oak Estates Ltd', xero_linked_at: '2026-10-01T00:00:00Z' });
const xeroGets = () => world.xeroLog.filter((r) => r.host === 'api.xero.com');
const localWrites = () => world.dbLog.filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && r.path !== '/auth/v1/user');
const noOutputLeaks = (out: unknown) => assert.doesNotMatch(JSON.stringify(out), new RegExp(`${SECRET}|${ACCESS_TOKEN}|test-client-id|accounts@oak\\.test`));

// ---- permissions: enforced on the server, before any database or Xero access -------------------------------------------------------
test('PERMISSION: a user who is not a manager is refused every action with no Xero access and no write', async () => {
  for (const role of ['technician', 'viewer']) {
    world.role = role;
    for (const action of ['search', 'verify', 'link', 'unlink', 'setBuildingDefault', 'clearBuildingDefault']) {
      const { status } = await post({ action, term: 'oak', localContactId: L1, xeroContactId: XC1, expectedName: 'x', buildingId: B1 });
      assert.equal(status, 403, `${role} ${action}`);
    }
  }
  assert.equal(xeroGets().length, 0);
  assert.equal(localWrites().length, 0);
});

test('PERMISSION: an inactive manager, a bad session, and a non-POST are refused', async () => {
  world.isActive = false;
  assert.equal((await post({ action: 'search', term: 'oak' })).status, 403);
  reset();
  world.authOk = false;
  assert.equal((await post({ action: 'search', term: 'oak' })).status, 403);
  reset();
  assert.equal((await call({}, { method: 'GET' })).status, 405);
  assert.equal(xeroGets().length, 0);
  assert.equal(localWrites().length, 0);
});

test('PERMISSION: a bad body or unknown action is refused before Xero is asked', async () => {
  assert.equal((await post({ action: 'nope' })).status, 400);
  const res = await handler(new Request('https://fn.test/x', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: '[1]' }));
  assert.equal(res.status, 400);
  assert.equal(xeroGets().length, 0);
});

// ---- organisation gate ---------------------------------------------------------------------------------------------------------------
test('ORG: with no expected organisation configured nothing is read from Xero', async () => {
  delete ENV.XERO_EXPECTED_ORG_ID;
  for (const body of [{ action: 'search', term: 'oak' }, { action: 'link', localContactId: L1, xeroContactId: XC1, expectedName: 'Oak Estates Ltd' }]) {
    const { status, out } = await post(body);
    assert.equal(status, 503);
    assert.equal(out.code, 'ORG_NOT_CONFIGURED');
  }
  assert.equal(xeroGets().length, 0);
  assert.equal(localWrites().length, 0);
});

test('ORG: connected to a DIFFERENT organisation, search, link and default setting are all refused and write nothing', async () => {
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  linkedState(L2);
  for (const body of [
    { action: 'search', term: 'oak' },
    { action: 'link', localContactId: L1, xeroContactId: XC1, expectedName: 'Oak Estates Ltd' },
    { action: 'setBuildingDefault', buildingId: B1, localContactId: L2 },
  ]) {
    const { status, out } = await post(body);
    assert.equal(status, 503);
    assert.equal(out.code, 'ORG_MISMATCH');
    noOutputLeaks(out);
    assert.doesNotMatch(JSON.stringify(out), new RegExp(`${ORG}|${OTHER_ORG}`), 'no organisation id in the response');
  }
  assert.equal(localWrites().length, 0);
  assert.equal(xeroGets().filter((r) => r.path.startsWith('/api.xro/2.0/Contacts')).length, 0, 'no contact was read');
});

// ---- search ---------------------------------------------------------------------------------------------------------------------------
test('SEARCH: reads only, sends the term as ONE encoded parameter, archived included, and writes nothing', async () => {
  world.searchResults = [world.xeroContacts[XC1]];
  const term = `O'Brien & "Sons" =x`;
  const { status, out } = await post({ action: 'search', term });
  assert.equal(status, 200);
  const req = xeroGets().find((r) => r.path === '/api.xro/2.0/Contacts')!;
  assert.equal(req.method, 'GET');
  const q = new URLSearchParams(req.search);
  assert.equal(q.get('searchTerm'), term);
  assert.equal(q.get('includeArchived'), 'true');
  assert.equal([...q.keys()].filter((k) => /where/i.test(k)).length, 0);
  assert.equal(localWrites().length, 0);
  assert.equal(out.results.length, 1);
});

test('SEARCH: results are summarised - the email is masked, nothing is selected, look-alikes are flagged', async () => {
  world.searchResults = [world.xeroContacts[XC1], world.xeroContacts[XC2]];
  const { out } = await post({ action: 'search', term: 'oak' });
  noOutputLeaks(out);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].emailHint, 'a***@oak.test');
  assert.equal(out.results[0].sameNameAsOthers, 1);
  assert.equal(out.results[0].sameEmailAsOthers, 1);
  assert.equal('selected' in out, false);
  assert.equal(JSON.stringify(out).includes('"link'), false, 'nothing is linked by searching');
  assert.equal(localWrites().length, 0);
});

test('SEARCH: archived, merged and email-less candidates are marked as unlinkable; a one-result search is not auto-linked', async () => {
  world.searchResults = [
    { ContactID: XC1, Name: 'A', ContactStatus: 'ARCHIVED', EmailAddress: 'a@x.test' },
    { ContactID: XC2, Name: 'B', ContactStatus: 'ACTIVE', EmailAddress: 'b@x.test', MergedToContactID: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    { ContactID: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', Name: 'C', ContactStatus: 'ACTIVE' },
  ];
  const { out } = await post({ action: 'search', term: 'abc' });
  assert.deepEqual(out.results.map((r: any) => r.blockedReason), ['ARCHIVED', 'MERGED', 'NO_EMAIL']);
  assert.equal(localWrites().length, 0);
});

test('SEARCH: a too-short, too-long or control-character term is refused without asking Xero', async () => {
  for (const term of ['a', ' ', 'x'.repeat(51), 'ab\u0000cd', 7 as unknown as string]) {
    const { status } = await post({ action: 'search', term });
    assert.equal(status, 400, JSON.stringify(term));
  }
  assert.equal(xeroGets().length, 0);
});

test('SEARCH: a full page of results says it may be incomplete', async () => {
  world.searchResults = Array.from({ length: 25 }, (_, i) => ({ ContactID: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, Name: `N${i}`, ContactStatus: 'ACTIVE', EmailAddress: `e${i}@x.test` }));
  assert.equal((await post({ action: 'search', term: 'oak' })).out.mayBeIncomplete, true);
});

// ---- link -----------------------------------------------------------------------------------------------------------------------------
test('LINK: links the exact confirmed contact, records the organisation, the name seen and who linked it', async () => {
  const { status, out } = await link();
  assert.equal(status, 200);
  const c = world.contacts[L1];
  assert.equal(c.xero_contact_id, XC1);
  assert.equal(c.xero_org_id, ORG);
  assert.equal(c.xero_contact_name, 'Oak Estates Ltd');
  assert.ok(c.xero_linked_at);
  assert.equal(c.xero_linked_by, 'luke@kindcontractors.co.uk');
  assert.equal(out.alsoLinkedToOtherContacts, 0);
  noOutputLeaks(out);
  assert.ok(xeroGets().every((r) => r.method === 'GET'));
});

test('LINK: reports when the same Xero contact is already linked to other people (allowed, but visible)', async () => {
  linkedState(L2);
  assert.equal((await link()).out.alsoLinkedToOtherContacts, 1);
});

test('LINK: a Xero contact that does not exist in the connected organisation is refused, nothing is linked', async () => {
  const { status, out } = await link({ xeroContactId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  assert.equal(status, 422);
  assert.equal(out.code, 'LINK_NOT_IN_ORGANISATION');
  assert.equal(localWrites().length, 0);
});

test('LINK: archived, not-active, merged and email-less contacts are refused - never replaced by another', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ContactStatus: 'ARCHIVED' }, 'CONTACT_NOT_ACTIVE'],
    [{ ContactStatus: 'GDPRREQUEST' }, 'CONTACT_NOT_ACTIVE'],
    [{ MergedToContactID: XC2 }, 'CONTACT_MERGED'],
    [{ EmailAddress: '' }, 'CONTACT_NO_EMAIL'],
  ];
  for (const [patch, code] of cases) {
    reset();
    Object.assign(world.xeroContacts[XC1], patch);
    const { status, out } = await link();
    assert.equal(status, 422, code);
    assert.equal(out.code, code);
    assert.equal(localWrites().length, 0, code);
  }
});

test('LINK: if the contact was renamed since the manager looked, it is refused (409) and nothing is linked', async () => {
  world.xeroContacts[XC1].Name = 'Somebody Else Ltd';
  const { status, out } = await link();
  assert.equal(status, 409);
  assert.equal(out.code, 'CONTACT_CHANGED');
  assert.equal(localWrites().length, 0);
});

test('LINK: the confirmed name is required, ids are validated, and a missing local contact is a 404', async () => {
  assert.equal((await link({ expectedName: '' })).status, 400);
  assert.equal((await link({ expectedName: undefined })).status, 400);
  assert.equal((await link({ xeroContactId: 'not an id' })).status, 400);
  assert.equal((await link({ localContactId: '../../x' })).status, 400);
  assert.equal((await link({ localContactId: '10000000-0000-4000-8000-0000000000ff' })).status, 404);
  assert.equal(localWrites().length, 0);
});

test('LINK: replacing an existing link to a DIFFERENT contact needs an explicit replace; the old link is kept otherwise', async () => {
  linkedState(L1, XC2);
  const refused = await link();
  assert.equal(refused.status, 409);
  assert.equal(refused.out.code, 'ALREADY_LINKED');
  assert.equal(world.contacts[L1].xero_contact_id, XC2);
  const done = await link({ replace: true });
  assert.equal(done.status, 200);
  assert.equal(world.contacts[L1].xero_contact_id, XC1);
});

test('LINK: re-confirming the SAME contact (for example to tag an old link with its organisation) needs no replace', async () => {
  Object.assign(world.contacts[L1], { xero_contact_id: XC1, xero_org_id: null });
  assert.equal((await link()).status, 200);
  assert.equal(world.contacts[L1].xero_org_id, ORG);
});

test('LINK: a contact that is a building default cannot be pointed elsewhere or re-tagged', async () => {
  linkedState(L1, XC2);
  Object.assign(world.building, { default_invoice_contact_id: L1, default_invoice_xero_contact_id: XC2, default_invoice_xero_org_id: ORG });
  const { status, out } = await link({ replace: true });
  assert.equal(status, 409);
  assert.equal(out.code, 'DEFAULT_IN_USE');
  assert.equal(world.contacts[L1].xero_contact_id, XC2);
});

// ---- unlink ---------------------------------------------------------------------------------------------------------------------------
test('UNLINK: removes the link and everything recorded with it, and never contacts Xero', async () => {
  linkedState(L1);
  const { status, out } = await post({ action: 'unlink', localContactId: L1 });
  assert.equal(status, 200);
  assert.equal(out.unlinked, true);
  assert.deepEqual(
    [world.contacts[L1].xero_contact_id, world.contacts[L1].xero_org_id, world.contacts[L1].xero_contact_name, world.contacts[L1].xero_linked_at],
    [null, null, null, null],
  );
  assert.equal(xeroGets().length, 0);
});

test('UNLINK: refused while the contact is a building default; unlinking an unlinked contact changes nothing', async () => {
  linkedState(L1);
  Object.assign(world.building, { default_invoice_contact_id: L1, default_invoice_xero_contact_id: XC1, default_invoice_xero_org_id: ORG });
  const refused = await post({ action: 'unlink', localContactId: L1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.out.code, 'DEFAULT_IN_USE');
  assert.equal(world.contacts[L1].xero_contact_id, XC1);
  const nothing = await post({ action: 'unlink', localContactId: L2 });
  assert.equal(nothing.out.unlinked, false);
});

// ---- building default -----------------------------------------------------------------------------------------------------------------
test('DEFAULT: a linked, verified contact of the building\'s client can become the default, recording its Xero id and organisation', async () => {
  linkedState(L1);
  const { status } = await post({ action: 'setBuildingDefault', buildingId: B1, localContactId: L1 });
  assert.equal(status, 200);
  assert.deepEqual(
    [world.building.default_invoice_contact_id, world.building.default_invoice_xero_contact_id, world.building.default_invoice_xero_org_id],
    [L1, XC1, ORG],
  );
});

test('DEFAULT: a contact of ANOTHER client, an unlinked contact and a contact with no organisation tag are all refused', async () => {
  linkedState(L_OTHER_CLIENT);
  Object.assign(world.contacts[L2], { xero_contact_id: XC2, xero_org_id: null });
  const expected: Array<[string, string]> = [[L_OTHER_CLIENT, 'WRONG_CLIENT'], [L1, 'NOT_LINKED'], [L2, 'LINK_UNTAGGED']];
  for (const [id, code] of expected) {
    const { status, out } = await post({ action: 'setBuildingDefault', buildingId: B1, localContactId: id });
    assert.equal(status, 422, code);
    assert.equal(out.code, code);
  }
  assert.equal(world.building.default_invoice_contact_id, null);
});

test('DEFAULT: a contact tagged for another organisation, or archived or email-less in Xero, is refused', async () => {
  linkedState(L1, XC1, OTHER_ORG);
  assert.equal((await post({ action: 'setBuildingDefault', buildingId: B1, localContactId: L1 })).out.code, 'LINK_WRONG_ORGANISATION');
  linkedState(L1);
  world.xeroContacts[XC1].ContactStatus = 'ARCHIVED';
  assert.equal((await post({ action: 'setBuildingDefault', buildingId: B1, localContactId: L1 })).out.code, 'CONTACT_NOT_ACTIVE');
  world.xeroContacts[XC1].ContactStatus = 'ACTIVE';
  world.xeroContacts[XC1].EmailAddress = '';
  assert.equal((await post({ action: 'setBuildingDefault', buildingId: B1, localContactId: L1 })).out.code, 'CONTACT_NO_EMAIL');
  linkedState(L1, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal((await post({ action: 'setBuildingDefault', buildingId: B1, localContactId: L1 })).out.code, 'LINK_NOT_IN_ORGANISATION');
  assert.equal(world.building.default_invoice_contact_id, null);
});

test('DEFAULT: an unknown building is a 404; clearing resets all three fields and needs no Xero', async () => {
  linkedState(L1);
  assert.equal((await post({ action: 'setBuildingDefault', buildingId: '20000000-0000-4000-8000-0000000000ff', localContactId: L1 })).status, 404);
  await post({ action: 'setBuildingDefault', buildingId: B1, localContactId: L1 });
  world.xeroLog = [];
  const { status } = await post({ action: 'clearBuildingDefault', buildingId: B1 });
  assert.equal(status, 200);
  assert.deepEqual([world.building.default_invoice_contact_id, world.building.default_invoice_xero_contact_id, world.building.default_invoice_xero_org_id], [null, null, null]);
  assert.equal(xeroGets().length, 0);
});

// ---- verify ---------------------------------------------------------------------------------------------------------------------------
test('VERIFY: reports not-linked, untagged, wrong organisation, missing, archived, merged, email-less and ok - read only', async () => {
  const v = async (id = L1) => (await post({ action: 'verify', localContactId: id })).out.state;
  assert.equal(await v(), 'not_linked');
  Object.assign(world.contacts[L1], { xero_contact_id: XC1, xero_org_id: null });
  assert.equal(await v(), 'untagged');
  linkedState(L1, XC1, OTHER_ORG);
  assert.equal(await v(), 'wrong_organisation');
  linkedState(L1, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(await v(), 'not_found');
  linkedState(L1);
  assert.equal(await v(), 'ok');
  world.xeroContacts[XC1].ContactStatus = 'ARCHIVED';
  assert.equal(await v(), 'not_active');
  world.xeroContacts[XC1].ContactStatus = 'ACTIVE';
  world.xeroContacts[XC1].MergedToContactID = XC2;
  assert.equal(await v(), 'merged');
  delete world.xeroContacts[XC1].MergedToContactID;
  world.xeroContacts[XC1].EmailAddress = '';
  assert.equal(await v(), 'no_email');
  assert.equal(localWrites().length, 0);
});

test('VERIFY: a building default is reported as none, ok, stale (link changed since) or wrong organisation', async () => {
  const v = async () => (await post({ action: 'verify', buildingId: B1 })).out.state;
  assert.equal(await v(), 'no_default');
  linkedState(L1);
  Object.assign(world.building, { default_invoice_contact_id: L1, default_invoice_xero_contact_id: XC1, default_invoice_xero_org_id: ORG });
  assert.equal(await v(), 'ok');
  world.contacts[L1].xero_contact_id = XC2;
  assert.equal(await v(), 'stale');
  world.building.default_invoice_xero_org_id = OTHER_ORG;
  assert.equal(await v(), 'wrong_organisation');
  assert.equal(localWrites().length, 0);
});

// ---- no contact is ever created or changed in Xero ------------------------------------------------------------------------------------
test('EVERYTHING: across every action, Xero only ever received GETs (plus the token request), and no secret or token was logged or returned', async () => {
  linkedState(L2, XC2);
  world.searchResults = [world.xeroContacts[XC1]];
  await post({ action: 'search', term: 'oak' });
  await link();
  await post({ action: 'verify', localContactId: L1 });
  await post({ action: 'setBuildingDefault', buildingId: B1, localContactId: L1 });
  await post({ action: 'clearBuildingDefault', buildingId: B1 });
  await post({ action: 'unlink', localContactId: L1 });
  assert.ok(xeroGets().every((r) => r.method === 'GET' || r.host === 'identity.xero.com'));
  assert.equal(xeroGets().filter((r) => r.method === 'POST' && r.host === 'api.xero.com').length, 0);
  for (const line of consoleLines) assert.doesNotMatch(line, new RegExp(`${SECRET}|${ACCESS_TOKEN}`));
});

test('SEARCH: a 50-character term is sent; a 51-character one is refused with Xero\'s limit explained, before Xero is asked', async () => {
  const fifty = 'f'.repeat(50);
  assert.equal((await post({ action: 'search', term: fifty })).status, 200);
  const req = xeroGets().find((r) => r.path === '/api.xro/2.0/Contacts')!;
  assert.equal(new URLSearchParams(req.search).get('searchTerm'), fifty);
  world.xeroLog = [];
  const { status, out } = await post({ action: 'search', term: 'f'.repeat(51) });
  assert.equal(status, 400);
  assert.equal(out.code, 'TERM_TOO_LONG');
  assert.match(out.error, /Xero accepts 50 characters at most/);
  assert.equal(xeroGets().length, 0);
});
