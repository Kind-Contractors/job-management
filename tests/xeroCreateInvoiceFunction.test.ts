// Tests for the REAL xero-create-invoice Edge Function code (and the safeguards and Xero client it uses), run in Node.
// Only its surroundings are faked: the Deno runtime (serve / env), the database (a small fake Supabase REST + auth
// server) and Xero itself (a fake identity server and a fake Accounting API). NO real request is ever made: every
// fetch in this file is answered by the fakes below, and a request to any host the fakes do not know fails the test.
//
// What is proved, with exactly what Xero was and was NOT sent:
//   - the kill switch is default-off and a blocked request does not touch the invoice at all
//   - the connected organisation must be the expected one before ANY Xero write
//   - the function never searches for or creates a Xero contact
//   - a recipient must be linked, and that link is re-verified in the connected organisation before anything is created
//   - an invoice already in Xero must exist in the connected organisation before it is updated
//   - retries update the same Xero invoice, duplicate requests create one, and failures leave a retryable record
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- fake Deno runtime ------------------------------------------------------------------------------------------
const ENV: Record<string, string | undefined> = {};
let handler: (req: Request) => Promise<Response> = async () => new Response('handler not registered', { status: 500 });
(globalThis as any).Deno = { serve: (h: typeof handler) => { handler = h; }, env: { get: (k: string) => ENV[k] } };

// ---- ids used by the fakes (all fictional) ----------------------------------------------------------------------------
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_CONTACT = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
const XERO_INVOICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SECRET = 'test-client-secret-NEVER-LEAK';
const ACCESS_TOKEN = 'xero-access-token-NEVER-LEAK';

// ---- fake world ---------------------------------------------------------------------------------------------------------
interface XeroContactRec { ContactID: string; Name: string; EmailAddress?: string; ContactStatus: string; MergedToContactID?: string }
interface Req { method: string; host: string; path: string; search: string; body: any; headers: Headers }
const world = {
  // database
  role: 'manager' as string,
  isActive: true,
  invoice: null as any,
  contact: null as any,
  /** Every local contact by id (world.contact is contacts['ct-1']); the fake database answers a read of a contact by its id filter. */
  contacts: {} as Record<string, any>,
  building: null as any,
  failRecipientWrite: false,
  // Xero
  tokenStatus: 200,
  orgStatus: 200,
  orgBody: null as unknown,
  xeroContacts: {} as Record<string, XeroContactRec>,
  xeroInvoices: {} as Record<string, { InvoiceID: string; InvoiceNumber: string; Contact: { ContactID: string } }>,
  createStatus: 200,
  /** Xero's idempotency: a create repeated with the same Idempotency-Key gets the ORIGINAL response back, nothing is created. */
  invoicesByIdempotencyKey: {} as Record<string, { InvoiceID: string; InvoiceNumber: string; Contact: { ContactID: string } }>,
  /** When set, every invoice create is answered with this existing Xero invoice (a replayed or confused response). */
  forceCreateResponse: null as null | { InvoiceID: string; InvoiceNumber: string; Contact: { ContactID: string } },
  /** OTHER local invoices (id + their recorded Xero invoice id), for the "already recorded elsewhere?" check. */
  otherInvoices: [] as Array<{ id: string; xero_invoice_id: string | null }>,
  /** When true, that check fails with a database error. */
  otherInvoicesQueryFails: false,
  emailStatus: 200,
  accounts: [{ AccountID: 'acc-1', Code: '200', Name: 'Sales', Type: 'REVENUE', Status: 'ACTIVE' }] as unknown[],
  taxRates: [{ Name: '20% (VAT on Income)', TaxType: 'OUTPUT2', DisplayTaxRate: 20, Status: 'ACTIVE', CanApplyToRevenue: true }] as unknown[],
  // logs
  xeroLog: [] as Req[],
  dbLog: [] as Req[],
  events: [] as string[],
  unexpected: [] as string[],
  invoiceCounter: 0,
  /** Any Xero contact request other than a read BY ID, and any write to the local contacts table. Never cleared by reset(). */
  contactViolations: [] as string[],
  /** When set, every contact read by id answers with this HTTP status instead of the contact. */
  contactGetStatus: null as number | null,
  /** POST /Contacts: HTTP status to answer with, contacts created per Idempotency-Key, and how many were really created. */
  createContactStatus: 200,
  createContactLoseResponse: false,
  contactsByIdempotencyKey: {} as Record<string, XeroContactRec>,
  contactCreates: 0,
  /** Extra search results Xero returns (to simulate a full page). */
  searchPadding: [] as XeroContactRec[],
  /** Contacts that exist in Xero but are beyond the first page of a search (not returned by it). */
  hiddenFromSearch: [] as string[],
  /** Number of times the invoice row was read, and an optional action to run right after read number n (to change the data between reads). */
  invoiceReads: 0,
  afterInvoiceRead: null as null | ((n: number) => void),
  /** When true, reading the invoice fails with a database error. */
  invoiceReadFails: false,
};

/** A visit as the database would return it: its own job, and that job's building and client. */
function visitFor(id: string, jobId = 'job-1', buildingId = 'building-1', clientId = 'client-1') {
  return { id, job_id: jobId, jobs: { id: jobId, building_id: buildingId, buildings: { id: buildingId, client_id: clientId } } };
}
function freshInvoice() {
  return {
    id: 'inv-1', status: 'draft', description: 'Window cleaning', works_order_number: 'PO-7', due_date: '2026-11-15',
    xero_invoice_id: null as string | null, xero_invoice_number: null as string | null, xero_contact_id: null as string | null, xero_org_id: null as string | null, last_error: null as string | null,
    job_id: 'job-1',
    invoice_line_items: [
      { id: 'li-1', visit_id: 'visit-1', visits: visitFor('visit-1'), description: 'Window cleaning, Oak Court', quantity: 1, unit_amount: 120 },
    ] as any[],
    jobs: { id: 'job-1', building_id: 'building-1', buildings: { id: 'building-1', client_id: 'client-1', clients: { id: 'client-1', company_name: 'Oak Estates' } } } as any,
  } as any;
}
function reset() {
  ENV.SUPABASE_URL = 'https://tests.invalid';
  ENV.SUPABASE_ANON_KEY = 'anon-test-key';
  ENV.XERO_CLIENT_ID = 'test-client-id';
  ENV.XERO_CLIENT_SECRET = SECRET;
  ENV.XERO_SENDING_ENABLED = 'true';
  delete ENV.XERO_CREATION_ENABLED;
  ENV.XERO_EXPECTED_ORG_ID = ORG;
  world.role = 'manager';
  world.isActive = true;
  world.invoice = freshInvoice();
  world.contact = { id: 'ct-1', client_id: 'client-1', name: 'Sam Client', email: 'sam@client.test', xero_contact_id: CONTACT, xero_org_id: ORG };
  world.contacts = { 'ct-1': world.contact };
  world.building = { id: 'building-1', client_id: 'client-1', default_invoice_contact_id: null, default_invoice_xero_contact_id: null, default_invoice_xero_org_id: null };
  world.failRecipientWrite = false;
  world.tokenStatus = 200;
  world.orgStatus = 200;
  world.orgBody = null;
  world.xeroContacts = { [CONTACT]: { ContactID: CONTACT, Name: 'Oak Estates Ltd', EmailAddress: 'accounts@oak.test', ContactStatus: 'ACTIVE' } };
  world.xeroInvoices = {};
  world.createStatus = 200;
  world.invoicesByIdempotencyKey = {};
  world.forceCreateResponse = null;
  world.otherInvoices = [];
  world.otherInvoicesQueryFails = false;
  world.emailStatus = 200;
  world.accounts = [{ AccountID: 'acc-1', Code: '200', Name: 'Sales', Type: 'REVENUE', Status: 'ACTIVE' }];
  world.taxRates = [{ Name: '20% (VAT on Income)', TaxType: 'OUTPUT2', DisplayTaxRate: 20, Status: 'ACTIVE', CanApplyToRevenue: true }];
  world.xeroLog = [];
  world.dbLog = [];
  world.events = [];
  world.unexpected = [];
  world.invoiceCounter = 0;
  world.contactGetStatus = null;
  world.createContactStatus = 200;
  world.createContactLoseResponse = false;
  world.contactsByIdempotencyKey = {};
  world.contactCreates = 0;
  world.searchPadding = [];
  world.hiddenFromSearch = [];
  world.invoiceReads = 0;
  world.afterInvoiceRead = null;
  world.invoiceReadFails = false;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function xeroApi(r: Req): Response {
  const p = r.path.replace('/api.xro/2.0', '');
  // Allowed on contacts: a read by id, a search by searchTerm, and a create WITH an Idempotency-Key. Never an update, a
  // where= (name) lookup, a list, or a create without a key.
  if (/^\/Contacts/.test(p)) {
    const read = r.method === 'GET' && /^\/Contacts\/[^/]+$/.test(p);
    const search = r.method === 'GET' && p === '/Contacts' && new URLSearchParams(r.search).has('searchTerm') && !/where/i.test(r.search);
    const create = r.method === 'POST' && p === '/Contacts' && !!r.headers.get('idempotency-key');
    if (!read && !search && !create) world.contactViolations.push(`${r.method} ${p}${r.search}`);
  }
  if (r.method === 'GET' && p === '/Contacts') {
    const q = new URLSearchParams(r.search);
    // Exactly what the real API does with a longer term (the DEV failure this guards against).
    if ((q.get('searchTerm') ?? '').length > 50) {
      world.contactViolations.push(`overlong searchTerm (${(q.get('searchTerm') ?? '').length} characters)`);
      return json(400, { Type: 'ValidationException', Message: 'SearchTerm has a maximum length of 50 characters' });
    }
    const term = (q.get('searchTerm') ?? '').toLowerCase();
    const size = Number(q.get('pageSize') ?? '100');
    const found = Object.values(world.xeroContacts).filter((c) => !world.hiddenFromSearch.includes(c.ContactID) && (c.Name.toLowerCase().includes(term) || (c.EmailAddress ?? '').toLowerCase().includes(term)));
    return json(200, { Contacts: [...found, ...world.searchPadding].slice(0, size) });
  }
  if (r.method === 'POST' && p === '/Contacts') {
    const key = r.headers.get('idempotency-key') ?? '';
    const replay = world.contactsByIdempotencyKey[key];
    if (replay) return json(200, { Contacts: [replay] });
    if (world.createContactStatus !== 200) return json(world.createContactStatus, { Type: 'Error', Message: 'contact create failed' });
    const wanted = r.body.Contacts[0];
    if (Object.values(world.xeroContacts).some((c) => c.Name.toLowerCase() === String(wanted.Name).toLowerCase())) {
      return json(400, { Type: 'ValidationException', Message: 'The contact name is already assigned to another contact.' });
    }
    world.contactCreates += 1;
    const id = `c1000000-0000-4000-8000-${String(world.contactCreates).padStart(12, '0')}`;
    const created = { ContactID: id, Name: wanted.Name, EmailAddress: wanted.EmailAddress, ContactStatus: 'ACTIVE' };
    world.xeroContacts[id] = created;
    world.contactsByIdempotencyKey[key] = created;
    if (world.createContactLoseResponse) return json(504, { Message: 'gateway timeout' });
    return json(200, { Contacts: [created] });
  }
  if (r.method === 'GET' && p === '/Organisation') {
    if (world.orgStatus !== 200) return json(world.orgStatus, { Type: 'Error', Message: 'org lookup failed' });
    return json(200, world.orgBody ?? { Organisations: [{ OrganisationID: ORG, Name: 'Fictional Test Org' }] });
  }
  let m = p.match(/^\/Contacts\/([^/]+)$/);
  if (r.method === 'GET' && m) {
    if (world.contactGetStatus) return json(world.contactGetStatus, { Type: 'Error', Message: 'contact read refused' });
    const c = world.xeroContacts[m[1]];
    return c ? json(200, { Contacts: [c] }) : json(404, { Type: 'NotFound', Message: 'contact not found' });
  }
  m = p.match(/^\/Invoices\/([^/]+)$/);
  if (r.method === 'GET' && m) {
    const i = world.xeroInvoices[m[1]];
    return i ? json(200, { Invoices: [i] }) : json(404, { Type: 'NotFound', Message: 'invoice not found' });
  }
  if (r.method === 'GET' && p === '/Accounts') return json(200, { Accounts: world.accounts });
  if (r.method === 'GET' && p === '/TaxRates') return json(200, { TaxRates: world.taxRates });
  if (r.method === 'POST' && p === '/Invoices') {
    const key = r.headers.get('idempotency-key') ?? '';
    if (world.invoicesByIdempotencyKey[key]) return json(200, { Invoices: [world.invoicesByIdempotencyKey[key]] });
    if (world.forceCreateResponse) return json(200, { Invoices: [world.forceCreateResponse] });
    if (world.createStatus !== 200) return json(world.createStatus, { Type: 'Error', Message: 'create failed' });
    world.invoiceCounter += 1;
    const id = world.invoiceCounter === 1 ? XERO_INVOICE : `eeeeeeee-eeee-4eee-8eee-${String(world.invoiceCounter).padStart(12, '0')}`;
    const inv = { InvoiceID: id, InvoiceNumber: `INV-${String(world.invoiceCounter).padStart(3, '0')}`, Contact: { ContactID: r.body.Invoices[0].Contact.ContactID } };
    world.xeroInvoices[id] = inv;
    if (key) world.invoicesByIdempotencyKey[key] = inv;
    return json(200, { Invoices: [inv] });
  }
  m = p.match(/^\/Invoices\/([^/]+)$/);
  if (r.method === 'POST' && m) {
    const existing = world.xeroInvoices[m[1]];
    if (!existing) return json(404, { Type: 'NotFound', Message: 'invoice not found' });
    if (world.createStatus !== 200) return json(world.createStatus, { Type: 'Error', Message: 'update failed' });
    existing.Contact = { ContactID: r.body.Invoices[0].Contact.ContactID };
    return json(200, { Invoices: [existing] });
  }
  m = p.match(/^\/Invoices\/([^/]+)\/Email$/);
  if (r.method === 'POST' && m) return world.emailStatus === 200 ? new Response('', { status: 200 }) : json(world.emailStatus, { Type: 'Error', Message: 'email failed' });
  world.unexpected.push(`${r.method} ${p}${r.search}`);
  return json(500, { Message: 'unexpected Xero request' });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const rawBody = init?.body;
  const body = rawBody && typeof rawBody === 'string' && rawBody.startsWith('{') ? JSON.parse(rawBody) : rawBody;
  const r: Req = { method, host: url.host, path: decodeURIComponent(url.pathname), search: url.search, body, headers };

  if (url.host === 'identity.xero.com') {
    world.xeroLog.push(r);
    const expected = 'Basic ' + btoa(`${ENV.XERO_CLIENT_ID}:${ENV.XERO_CLIENT_SECRET}`);
    if (headers.get('authorization') !== expected || rawBody !== 'grant_type=client_credentials') world.unexpected.push('token request with wrong credentials or body');
    if (world.tokenStatus !== 200) return json(world.tokenStatus, { error: 'invalid_client' });
    return json(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 1800 });
  }
  if (url.host === 'api.xero.com') {
    world.xeroLog.push(r);
    if (headers.get('authorization') !== `Bearer ${ACCESS_TOKEN}`) world.unexpected.push('Xero call without the access token');
    world.events.push(`xero:${method} ${r.path.replace('/api.xro/2.0', '')}`);
    return xeroApi(r);
  }
  if (url.host === 'tests.invalid') {
    world.dbLog.push(r);
    const wantsObject = (headers.get('accept') ?? '').includes('vnd.pgrst.object');
    const one = (row: unknown) => json(200, wantsObject ? row : [row]);
    // The only local contact write allowed: saving a Xero link onto a contact that is still unlinked.
    if (r.path === '/rest/v1/contacts' && method !== 'GET') {
      const linkOnly = method === 'PATCH' && url.searchParams.get('xero_contact_id') === 'is.null'
        && Object.keys(body ?? {}).every((k) => ['xero_contact_id', 'xero_org_id', 'xero_contact_name', 'xero_linked_at', 'xero_linked_by'].includes(k));
      if (!linkOnly) world.contactViolations.push(`local ${method} contacts`);
      const row = world.contacts[url.searchParams.get('id')?.replace(/^eq\./, '') ?? ''];
      if (!row || row.xero_contact_id !== null) return json(200, wantsObject ? null : []);
      Object.assign(row, body);
      world.events.push(`db:LINK contact ${row.id} -> ${body.xero_contact_id}`);
      return one({ id: row.id });
    }
    if (r.path === '/auth/v1/user') return json(200, { id: 'user-1', aud: 'authenticated', email: 'luke@kindcontractors.co.uk', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    if (r.path === '/rest/v1/app_users') return one({ role: world.role, is_active: world.isActive });
    if (r.path === '/rest/v1/invoices' && method === 'PATCH') {
      const statusFilter = url.searchParams.get('status');
      if (statusFilter) {
        const allowed = statusFilter.replace(/^in\.\(/, '').replace(/\)$/, '').split(',');
        if (!allowed.includes(world.invoice.status)) return json(200, wantsObject ? null : []);
      }
      if (world.failRecipientWrite && 'xero_contact_id' in body) return json(500, { message: 'write refused' });
      Object.assign(world.invoice, body);
      world.events.push(`db:PATCH invoices ${JSON.stringify(body)}`);
      if (url.searchParams.get('select')) return one({ id: world.invoice.id });
      return new Response(null, { status: 204 });
    }
    if (r.path === '/rest/v1/invoices' && method === 'GET' && url.searchParams.has('xero_invoice_id')) {
      // "Is this Xero invoice already recorded on ANOTHER local invoice?"
      if (world.otherInvoicesQueryFails) return json(500, { message: 'database unavailable' });
      const xid = url.searchParams.get('xero_invoice_id')!.replace(/^eq\./, '');
      const notId = url.searchParams.get('id')?.replace(/^neq\./, '');
      return json(200, world.otherInvoices.filter((o) => o.xero_invoice_id === xid && o.id !== notId).map((o) => ({ id: o.id })));
    }
    if (r.path === '/rest/v1/invoices' && method === 'GET') {
      if (world.invoiceReadFails) return json(500, { message: 'database unavailable' });
      world.invoiceReads += 1;
      const response = one(world.invoice);
      world.afterInvoiceRead?.(world.invoiceReads);
      return response;
    }
    if (r.path === '/rest/v1/contacts' && method === 'GET') {
      const wanted = url.searchParams.get('id')?.replace(/^eq\./, '');
      const row = wanted ? (world.contacts[wanted] ?? null) : world.contact;
      return row ? one(row) : json(200, wantsObject ? null : []);
    }
    if (r.path === '/rest/v1/buildings' && method === 'GET') return world.building ? one(world.building) : json(200, wantsObject ? null : []);
    world.unexpected.push(`database request ${method} ${r.path}`);
    return json(404, { message: `unexpected request ${method} ${r.path}` });
  }
  world.unexpected.push(`request to unknown host ${url.host}`);
  return json(500, { message: 'unknown host' });
}) as typeof fetch;

// ---- capture console output so we can prove secrets and tokens are never logged ---------------------------------------
const consoleLines: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  (console as any)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
}

beforeEach(() => {
  reset();
  world.contactViolations = [];
  consoleLines.length = 0;
});

// A safety net over EVERY test in this file, including the ones written before it existed: whatever the scenario, the
// integration never created, searched for, listed or changed a Xero contact, and never changed a local contact.
afterEach(() => {
  assert.deepEqual(world.contactViolations, [], 'a contact was searched for, created or changed');
});

await import('../supabase/functions/xero-create-invoice/index.ts'); // registers the real handler through the fake Deno.serve
const xeroClient = await import('../supabase/functions/_shared/xeroClient.ts');
const relationships = await import('../supabase/functions/_shared/invoiceRelationships.ts');

// ---- helpers ------------------------------------------------------------------------------------------------------------
function call(body: Record<string, unknown> = { invoiceId: 'inv-1', contactId: 'ct-1' }, opts: { auth?: boolean; method?: string } = {}) {
  return handler(new Request('https://fn.test/xero-create-invoice', {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.auth === false ? {} : { Authorization: 'Bearer test-token' }) },
    body: opts.method === 'GET' ? undefined : JSON.stringify(body),
  }));
}
const accounting = () => world.xeroLog.filter((r) => r.host === 'api.xero.com');
/** Every Accounting API request that is not a GET: invoice create/update, invoice email, or (never) a contact write. */
const xeroWrites = () => accounting().filter((r) => r.method !== 'GET');
const invoiceCreatesOrUpdates = () => xeroWrites().filter((r) => /\/Invoices(\/[^/]+)?$/.test(r.path));
const emailCalls = () => xeroWrites().filter((r) => r.path.endsWith('/Email'));
const contactRequests = () => accounting().filter((r) => /\/Contacts/.test(r.path));
const invoicePatches = () => world.dbLog.filter((r) => r.path === '/rest/v1/invoices' && r.method === 'PATCH');
const stringify = (v: unknown) => JSON.stringify(v);

/** Nothing may ever have been written to Xero, and no contact may ever have been searched for or created. */
function assertNoXeroWrites() {
  assert.deepEqual(xeroWrites().map((r) => `${r.method} ${r.path}`), [], 'no Xero write of any kind');
  assert.equal(accounting().filter((r) => /\/Contacts$/.test(r.path)).length, 0, 'no contact collection request (search or create)');
}

// ---- the happy path, and exactly what it does ------------------------------------------------------------------------
test('a send with every safeguard satisfied creates ONE invoice for the linked contact and emails it', async () => {
  const res = await call();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'sent', emailed: true, xeroInvoiceId: XERO_INVOICE, xeroInvoiceNumber: 'INV-001', recipientSource: 'selected' });

  const creates = invoiceCreatesOrUpdates();
  assert.equal(creates.length, 1);
  assert.equal(`${creates[0].method} ${creates[0].path}`, 'POST /api.xro/2.0/Invoices', 'a first send creates through the collection endpoint');
  assert.equal(creates[0].body.Invoices[0].Contact.ContactID, CONTACT, 'the invoice goes to the LINKED Xero contact');
  assert.equal(creates[0].body.Invoices[0].Status, 'AUTHORISED');
  assert.match(creates[0].headers.get('idempotency-key') ?? '', /^[0-9a-f]{64}$/);
  assert.equal(emailCalls().length, 1);
  assert.equal(contactRequests().every((r) => r.method === 'GET' && r.path.endsWith(`/Contacts/${CONTACT}`)), true, 'contacts are only ever read BY ID');
  assert.equal(world.invoice.status, 'sent');
  assert.equal(world.invoice.xero_invoice_id, XERO_INVOICE);
  assert.deepEqual(world.unexpected, []);
});

test('the invoice records WHO it is for, and does so BEFORE anything is created in Xero', async () => {
  await call();
  assert.equal(world.invoice.xero_contact_id, CONTACT);
  const recorded = world.events.findIndex((e) => e.startsWith('db:PATCH invoices') && e.includes('"xero_contact_id"'));
  const created = world.events.findIndex((e) => e === 'xero:POST /Invoices');
  assert.ok(recorded >= 0 && created >= 0 && recorded < created, `recipient recorded (${recorded}) before the Xero create (${created})`);
});

test('if the recipient cannot be recorded, NOTHING is created in Xero', async () => {
  world.failRecipientWrite = true;
  const res = await call();
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Could not record the invoice recipient/);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(world.invoice.status, 'failed');
});

// ---- kill switch ----------------------------------------------------------------------------------------------------
test('the kill switch is DEFAULT-OFF: unless XERO_CREATION_ENABLED or XERO_SENDING_ENABLED is exactly "true", nothing is attempted', async () => {
  for (const name of ['XERO_SENDING_ENABLED', 'XERO_CREATION_ENABLED'] as const)
  for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    reset();
    delete ENV.XERO_SENDING_ENABLED;
    delete ENV.XERO_CREATION_ENABLED;
    if (value !== undefined) ENV[name] = value;
    const res = await call();
    const out = await res.json();
    assert.equal(res.status, 503, `${name}=${JSON.stringify(value)}`);
    assert.equal(out.code, 'CREATION_DISABLED');
    assert.equal(out.status, 'blocked');
    assert.equal(world.xeroLog.length, 0, 'not even a token request: Xero is never contacted');
    assert.equal(invoicePatches().length, 0, 'the invoice is never claimed or changed');
    assert.equal(world.invoice.status, 'draft', 'still an untouched draft, not "sending" or "failed"');
    assert.equal(world.invoice.last_error, null);
  }
});

test('with the kill switch on, the same request goes through (so the block above is the switch and nothing else)', async () => {
  ENV.XERO_SENDING_ENABLED = 'true';
  assert.equal((await call()).status, 200);
});

test('a blocked request on an invoice that is already failed leaves it failed with its original error', async () => {
  world.invoice.status = 'failed';
  world.invoice.last_error = 'earlier problem';
  delete ENV.XERO_SENDING_ENABLED;
  assert.equal((await call()).status, 503);
  assert.equal(world.invoice.status, 'failed');
  assert.equal(world.invoice.last_error, 'earlier problem');
  assert.equal(invoicePatches().length, 0);
});

// ---- expected organisation ----------------------------------------------------------------------------------------------
test('with NO expected organisation configured, sending is refused before the invoice is touched and Xero is never called', async () => {
  for (const value of [undefined, '', '   ']) {
    reset();
    if (value === undefined) delete ENV.XERO_EXPECTED_ORG_ID;
    else ENV.XERO_EXPECTED_ORG_ID = value;
    const res = await call();
    const out = await res.json();
    assert.equal(res.status, 503, JSON.stringify(value));
    assert.equal(out.code, 'ORG_NOT_CONFIGURED');
    assert.equal(world.xeroLog.length, 0);
    assert.equal(invoicePatches().length, 0);
    assert.equal(world.invoice.status, 'draft');
  }
});

test('the WRONG organisation: refused BEFORE the claim with zero Xero writes, nothing looked up for contacts or invoices, and the ids are not echoed', async () => {
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 503);
  assert.equal(out.status, 'blocked');
  assert.equal(out.code, 'ORG_MISMATCH');
  assert.match(out.error, /not the one this environment is configured for/);
  assert.doesNotMatch(stringify(out), new RegExp(`${ORG}|${OTHER_ORG}`), 'neither organisation id appears in the response');
  assertNoXeroWrites();
  assert.equal(contactRequests().length, 0, 'the contact is not even looked up');
  assert.equal(invoicePatches().length, 0, 'the invoice is never claimed or changed');
  assert.equal(world.invoice.status, 'draft', 'still an untouched draft: not "sending", not "failed"');
  assert.equal(world.invoice.last_error, null);
});

test('the CORRECT organisation passes, ignoring case and surrounding whitespace in the configured value', async () => {
  ENV.XERO_EXPECTED_ORG_ID = `  ${ORG.toUpperCase()}  `;
  assert.equal((await call()).status, 200);
});

test('if the organisation lookup FAILS or returns nothing usable, the send is refused with zero Xero writes', async () => {
  const bad: Array<() => void> = [
    () => { world.orgStatus = 500; },
    () => { world.orgStatus = 401; },
    () => { world.orgStatus = 403; },
    () => { world.orgBody = {}; },
    () => { world.orgBody = { Organisations: [] }; },
    () => { world.orgBody = { Organisations: [{}] }; },
    () => { world.orgBody = { Organisations: [{ OrganisationID: '   ' }] }; },
  ];
  for (const setup of bad) {
    reset();
    setup();
    const res = await call();
    const out = await res.json();
    assert.equal(res.status, 503, setup.toString());
    assert.equal(out.code, 'ORG_LOOKUP_FAILED', setup.toString());
    assertNoXeroWrites();
    assert.equal(contactRequests().length, 0);
    assert.equal(invoicePatches().length, 0, 'the invoice is never claimed or changed');
    assert.equal(world.invoice.status, 'draft');
  }
});

test('a failed organisation lookup says which HTTP status Xero returned - and nothing else about the response', async () => {
  for (const status of [401, 403, 500]) {
    reset();
    world.orgStatus = status;
    const out = await (await call()).json();
    assert.equal(out.code, 'ORG_LOOKUP_FAILED');
    assert.match(out.error, new RegExp(`\\(Xero returned HTTP ${status}\\)\\.$`), `status ${status} is in the message`);
    assert.doesNotMatch(out.error, /org lookup failed|Type|Message/, "Xero's response body is not repeated");
    assert.doesNotMatch(stringify(out), new RegExp(`${ORG}|${OTHER_ORG}|${SECRET}|${ACCESS_TOKEN}|test-client-id`), 'no id, credential or token');
  }
  // no HTTP status exists for a malformed answer, so none is claimed
  reset();
  world.orgBody = { Organisations: [] };
  const malformed = await (await call()).json();
  assert.doesNotMatch(malformed.error, /HTTP/);
  assert.match(malformed.error, /could not confirm which Xero organisation this connection belongs to\.$/);
});

test('if Xero will not even issue a token, nothing is written to Xero and the invoice is left exactly as it was', async () => {
  world.tokenStatus = 400;
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 502);
  assert.equal(out.code, 'XERO_AUTH_FAILED');
  assert.equal(accounting().length, 0, 'no Accounting API call at all');
  assert.equal(invoicePatches().length, 0);
  assert.equal(world.invoice.status, 'draft');
  assert.doesNotMatch(stringify(out), new RegExp(SECRET));
});

test('a linked contact is used by its ID: no search, no create, and the stored link is not rewritten', async () => {
  await call();
  assert.equal(contactRequests().length, 1);
  assert.match(contactRequests()[0].path, new RegExp(`/Contacts/${CONTACT}$`));
  assert.equal(world.dbLog.filter((r) => r.path === '/rest/v1/contacts' && r.method !== 'GET').length, 0, 'the local contact record is never modified');
});

// ---- cross-organisation and unusable links -----------------------------------------------------------------------------
test('a contact id from ANOTHER organisation (not found in the connected one) is refused before anything is created', async () => {
  world.contact.xero_contact_id = OTHER_CONTACT; // e.g. stored while connected to a test organisation
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 502);
  assert.equal(out.code, 'LINK_NOT_IN_ORGANISATION');
  assert.match(out.error, /may belong to a different organisation/);
  assertNoXeroWrites();
  assert.equal(world.invoice.status, 'failed');
});

test('a stored id that is not a well-formed Xero id never reaches Xero (and cannot alter the request path)', async () => {
  for (const bad of ['not-a-guid', '../Invoices', `${CONTACT}/../Organisation`, "x' OR '1'='1", `${CONTACT}?x=1`]) {
    reset();
    world.contact.xero_contact_id = bad;
    const res = await call();
    assert.equal((await res.json()).code, 'LINK_NOT_IN_ORGANISATION', bad);
    assert.equal(contactRequests().length, 0, `no request was made for ${JSON.stringify(bad)}`);
    assertNoXeroWrites();
    assert.deepEqual(world.unexpected, []);
  }
});

test('an ARCHIVED (or erased) Xero contact is refused: it is never un-archived or replaced', async () => {
  for (const status of ['ARCHIVED', 'GDPRREQUEST']) {
    reset();
    world.xeroContacts[CONTACT].ContactStatus = status;
    const out = await (await call()).json();
    assert.equal(out.code, 'CONTACT_NOT_ACTIVE', status);
    assertNoXeroWrites();
    assert.equal(emailCalls().length, 0);
  }
});

test('a linked contact with no email address is refused BEFORE the invoice is created (previously this was only noticed after authorising it)', async () => {
  for (const email of [undefined, '', '   ']) {
    reset();
    world.xeroContacts[CONTACT].EmailAddress = email;
    const out = await (await call()).json();
    assert.equal(out.code, 'CONTACT_NO_EMAIL', JSON.stringify(email));
    assertNoXeroWrites();
  }
});

test('a recipient from a DIFFERENT client is refused before Xero is asked about it', async () => {
  world.contact.client_id = 'someone-else';
  const res = await call();
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /does not belong to this invoice's client/);
  assertNoXeroWrites();
  assert.equal(contactRequests().length, 0);
});

test('a missing recipient on a first send is refused (nothing to link or verify)', async () => {
  const res = await call({ invoiceId: 'inv-1' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /no default recipient/);
  assertNoXeroWrites();
});

// ---- stored invoice references ----------------------------------------------------------------------------------------------
test('an invoice whose stored Xero invoice id does not exist in the connected organisation is NOT updated or re-sent', async () => {
  world.invoice.status = 'failed';
  world.invoice.xero_invoice_id = XERO_INVOICE; // belongs to some other organisation: absent from this one's invoices
  world.invoice.xero_invoice_number = 'INV-OLD';
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 502);
  assert.equal(out.code, 'INVOICE_NOT_IN_ORGANISATION');
  assertNoXeroWrites();
  assert.equal(world.invoice.xero_invoice_id, XERO_INVOICE, 'the stored reference is left as it was (history is not rewritten)');
  assert.equal(world.invoice.xero_invoice_number, 'INV-OLD');
});

test('a malformed stored Xero invoice id never reaches Xero', async () => {
  world.invoice.status = 'failed';
  world.invoice.xero_invoice_id = '../Contacts';
  const out = await (await call()).json();
  assert.equal(out.code, 'INVOICE_NOT_IN_ORGANISATION');
  assert.equal(accounting().filter((r) => r.path !== '/api.xro/2.0/Organisation').length, 0);
});

// ---- retries, duplicates, failures ---------------------------------------------------------------------------------------------
test('RETRY after the email step failed: the SAME Xero invoice is updated (never a second), with the same recipient and idempotency key', async () => {
  world.emailStatus = 500;
  const first = await call();
  assert.equal(first.status, 502);
  assert.equal(world.invoice.status, 'failed');
  assert.equal(world.invoice.xero_invoice_id, XERO_INVOICE, 'the created invoice was saved before the email step');
  const firstCreate = invoiceCreatesOrUpdates()[0];

  world.emailStatus = 200;
  const second = await call();
  assert.equal(second.status, 200);
  assert.equal(world.invoiceCounter, 1, 'Xero only ever created ONE invoice');
  const all = invoiceCreatesOrUpdates();
  assert.equal(all.length, 2);
  assert.equal(all[1].path, `/api.xro/2.0/Invoices/${XERO_INVOICE}`, 'the retry updates through the ID-scoped path, not the collection endpoint');
  assert.equal(all[1].body.Invoices[0].Contact.ContactID, CONTACT);
  assert.equal(all[1].headers.get('idempotency-key'), firstCreate.headers.get('idempotency-key'), 'unchanged payload => identical key');
  assert.equal(world.invoice.status, 'sent');
});

test('RETRY with no recipient given uses the invoice\'s own Xero contact, verified exactly like a chosen one', async () => {
  world.invoice.status = 'failed';
  world.invoice.xero_invoice_id = XERO_INVOICE;
  world.xeroInvoices[XERO_INVOICE] = { InvoiceID: XERO_INVOICE, InvoiceNumber: 'INV-001', Contact: { ContactID: CONTACT } };
  const res = await call({ invoiceId: 'inv-1' });
  assert.equal(res.status, 200);
  assert.equal(invoiceCreatesOrUpdates()[0].path, `/api.xro/2.0/Invoices/${XERO_INVOICE}`);
  assert.ok(contactRequests().some((r) => r.path.endsWith(`/Contacts/${CONTACT}`)), 'the contact was re-read by id');

  reset();
  world.invoice.status = 'failed';
  world.invoice.xero_invoice_id = XERO_INVOICE;
  world.xeroInvoices[XERO_INVOICE] = { InvoiceID: XERO_INVOICE, InvoiceNumber: 'INV-001', Contact: { ContactID: CONTACT } };
  world.xeroContacts[CONTACT].ContactStatus = 'ARCHIVED';
  const refused = await call({ invoiceId: 'inv-1' });
  assert.equal((await refused.json()).code, 'CONTACT_NOT_ACTIVE');
  assertNoXeroWrites();
});

test('DUPLICATE requests (a double click): exactly one proceeds, one Xero invoice is created, the other is told it is already being sent', async () => {
  const [a, b] = await Promise.all([call(), call()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(invoiceCreatesOrUpdates().length, 1);
  assert.equal(emailCalls().length, 1);
  assert.equal(world.invoiceCounter, 1);
});

test('an invoice that is already SENT cannot be sent again: only the read-only token and organisation check happen, never a write', async () => {
  world.invoice.status = 'sent';
  const res = await call();
  assert.equal(res.status, 409);
  assert.deepEqual(world.xeroLog.map((r) => `${r.method} ${r.host}${r.path.replace('/api.xro/2.0', '')}`), ['POST identity.xero.com/connect/token', 'GET api.xero.com/Organisation']);
  assert.deepEqual(world.events.filter((e) => e.startsWith('db:')), [], 'no database change took effect (the claim matched nothing)');
  assert.equal(world.invoice.status, 'sent');
});

test('a Xero failure while creating leaves a retryable, explained record and never reaches the email step', async () => {
  world.createStatus = 500;
  const res = await call();
  assert.equal(res.status, 502);
  assert.equal(world.invoice.status, 'failed');
  assert.match(world.invoice.last_error, /HTTP 500/);
  assert.equal(emailCalls().length, 0);
  assert.equal(world.invoice.xero_invoice_id, null, 'nothing was created, so nothing is recorded as created');
  // fixed on Xero's side: the same invoice can simply be sent again
  world.createStatus = 200;
  assert.equal((await call()).status, 200);
});

test('a missing Sales account (or VAT rate) is refused before anything is created', async () => {
  world.accounts = [];
  const res = await call();
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /No active account named "Sales"/);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

// ---- fix 3: the organisation is verified BEFORE the invoice is claimed ----------------------------------------------------
test('the organisation is read BEFORE the invoice is claimed (so a wrong one can never touch the row)', async () => {
  await call();
  const org = world.events.findIndex((e) => e === 'xero:GET /Organisation');
  const claim = world.events.findIndex((e) => e.startsWith('db:PATCH invoices') && e.includes('"status":"sending"'));
  assert.ok(org >= 0 && claim >= 0 && org < claim, `organisation read (${org}) before the claim (${claim})`);
});

test('a previously FAILED invoice keeps its status and error when the organisation check blocks a retry', async () => {
  world.invoice.status = 'failed';
  world.invoice.last_error = 'earlier problem';
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  assert.equal((await call()).status, 503);
  assert.equal(world.invoice.status, 'failed');
  assert.equal(world.invoice.last_error, 'earlier problem');
  assert.equal(invoicePatches().length, 0);
});

test('the manager check, kill switch and configuration check still come before ANY Xero request, token included', async () => {
  world.role = 'technician';
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  assert.equal((await call()).status, 403);
  assert.equal(world.xeroLog.length, 0);
  reset();
  delete ENV.XERO_SENDING_ENABLED;
  assert.equal((await call()).status, 503);
  assert.equal(world.xeroLog.length, 0);
  reset();
  delete ENV.XERO_EXPECTED_ORG_ID;
  assert.equal((await call()).status, 503);
  assert.equal(world.xeroLog.length, 0);
});

test('CONCURRENT requests: each verifies the organisation, but the atomic claim lets only one create the invoice', async () => {
  const responses = await Promise.all([call(), call(), call()]);
  const bodies = await Promise.all(responses.map((r) => r.clone().text()));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409, 409], bodies.join(' | '));
  assert.equal(accounting().filter((r) => r.path.endsWith('/Organisation')).length, 3, 'verified for every request');
  assert.equal(invoiceCreatesOrUpdates().length, 1);
  assert.equal(emailCalls().length, 1);
  assert.equal(world.invoiceCounter, 1);
});

test('concurrent requests against the WRONG organisation: none claims the invoice, none writes', async () => {
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  const results = await Promise.all([call(), call()]);
  assert.deepEqual(results.map((r) => r.status), [503, 503]);
  assert.equal(invoicePatches().length, 0);
  assertNoXeroWrites();
});

// ---- recipient persistence ------------------------------------------------------------------------------------------------------------
const NEW_CONTACT = '99999999-9999-4999-8999-999999999999';

test('FIRST creation is unchanged: the recipient is recorded BEFORE the create, and stays recorded if the create fails', async () => {
  world.createStatus = 500;
  const res = await call();
  assert.equal(res.status, 502);
  assert.equal(world.invoice.xero_contact_id, CONTACT);
  assert.equal(world.invoice.xero_invoice_id, null);
  const recorded = world.events.findIndex((e) => e.startsWith('db:PATCH invoices') && e.includes('"xero_contact_id"'));
  const created = world.events.findIndex((e) => e === 'xero:POST /Invoices');
  assert.ok(recorded >= 0 && recorded < created, 'recorded before the Xero create attempt');
});

test('a retry with an UNCHANGED recipient keeps the same idempotency key as before the failed update', async () => {
  world.emailStatus = 500;
  await call();
  const firstKey = invoiceCreatesOrUpdates()[0].headers.get('idempotency-key');
  world.createStatus = 500; // the update attempt fails...
  await call();
  world.createStatus = 200;
  world.emailStatus = 200;
  await call();
  const keys = invoiceCreatesOrUpdates().map((r) => r.headers.get('idempotency-key'));
  assert.ok(keys.every((k) => k === firstKey), 'recipient handling never alters the payload hash');
  assert.equal(world.invoiceCounter, 1);
  assert.equal(world.invoice.status, 'sent');
});

// ---- who may call it, and how ---------------------------------------------------------------------------------------------------
test('only an active MANAGER can send, and is checked before the kill switch or anything else', async () => {
  world.role = 'technician';
  delete ENV.XERO_SENDING_ENABLED;
  const res = await call();
  assert.equal(res.status, 403, 'a non-manager learns nothing about the switch');
  assert.equal(world.xeroLog.length, 0);
  assert.equal(invoicePatches().length, 0);
  reset();
  world.isActive = false;
  assert.equal((await call()).status, 403);
  reset();
  assert.equal((await call({ invoiceId: 'inv-1', contactId: 'ct-1' }, { auth: false })).status, 403);
});

test('only POST is accepted', async () => {
  assert.equal((await call({}, { method: 'GET' })).status, 405);
  assert.equal(world.xeroLog.length, 0);
});

// ---- secrets and tokens ------------------------------------------------------------------------------------------------------------
test('the Xero secret and access token never appear in a response, a stored error or a log line - on success or on any failure', async () => {
  const outputs: string[] = [];
  const run = async (setup?: () => void) => {
    reset();
    setup?.();
    const res = await call();
    outputs.push(await res.text(), stringify(world.invoice));
  };
  await run();
  await run(() => { world.tokenStatus = 401; });
  await run(() => { world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] }; });
  await run(() => { world.createStatus = 500; });
  await run(() => { world.emailStatus = 500; });
  await run(() => { world.contact.xero_contact_id = null; });
  const everything = [...outputs, ...consoleLines].join('\n');
  assert.doesNotMatch(everything, new RegExp(SECRET));
  assert.doesNotMatch(everything, new RegExp(ACCESS_TOKEN));
  assert.doesNotMatch(everything, /test-client-id/);
});

test('every Xero request is a read of a known endpoint, a token request, or a send of the invoice - nothing unexpected is ever called', async () => {
  await call();
  world.invoice.status = 'failed';
  world.contact.xero_contact_id = OTHER_CONTACT;
  await call();
  assert.deepEqual(world.unexpected, []);
  for (const r of accounting()) {
    const allowed = r.method === 'GET'
      ? /\/(Organisation|Accounts|TaxRates|Contacts\/[0-9a-f-]{36}|Invoices\/[0-9a-f-]{36})$/.test(r.path)
      : /\/Invoices(\/[0-9a-f-]{36}(\/Email)?)?$/.test(r.path) && r.method === 'POST';
    assert.ok(allowed, `unexpected Xero request: ${r.method} ${r.path}`);
  }
});

// ---- the Xero client itself --------------------------------------------------------------------------------------------------------
test('the Xero client can read a contact or invoice only by a well-formed id, and treats 404 (and only 404) as "not found"', async () => {
  assert.deepEqual(await xeroClient.getContactById(ACCESS_TOKEN, 'nope'), { outcome: 'not_found' });
  assert.equal(accounting().length, 0, 'a malformed id makes no request');

  const missing = await xeroClient.getContactById(ACCESS_TOKEN, OTHER_CONTACT);
  assert.deepEqual(missing, { outcome: 'not_found' });

  const found = await xeroClient.getContactById(ACCESS_TOKEN, CONTACT);
  assert.equal(found.outcome, 'found');

  // anything other than 404 is an error, never a silent "not found"
  const original = globalThis.fetch;
  globalThis.fetch = (async () => json(500, { Message: 'boom' })) as typeof fetch;
  await assert.rejects(() => xeroClient.getContactById(ACCESS_TOKEN, CONTACT), (e: any) => e instanceof xeroClient.XeroHttpError && e.status === 500);
  globalThis.fetch = original;
});

// ---- duplicate-contact prevention -------------------------------------------------------------------------------------------------
// A LINKED contact is always used by its id and never searched for, changed or replaced. Automatic linking/creation applies
// only to a contact with NO link at all (see the AUTO-CONTACT tests).
const contactReads = () => contactRequests().filter((r) => r.method === 'GET');
const snapshotXeroContacts = () => JSON.stringify(world.xeroContacts);

test('NO-DUPLICATES 1: a valid linked ContactID is REUSED - one read by id, the invoice goes to that exact contact, nothing about it changes', async () => {
  const before = snapshotXeroContacts();
  const res = await call();
  assert.equal(res.status, 200);
  assert.deepEqual(contactRequests().map((r) => `${r.method} ${r.path.replace('/api.xro/2.0', '')}`), [`GET /Contacts/${CONTACT}`], 'exactly one contact request: a read by id');
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, CONTACT);
  assert.equal(snapshotXeroContacts(), before, 'the Xero contact is exactly as it was');
  assert.equal(world.contact.xero_contact_id, CONTACT, 'the local link is exactly as it was');
  assert.deepEqual(world.contactViolations, []);
});

test('NO-DUPLICATES 2: the invoice names its contact by id ONLY (a Name or email in that object could make Xero create or update a contact)', async () => {
  world.emailStatus = 500;
  await call(); // creates
  world.emailStatus = 200;
  await call(); // updates the same invoice
  const writes = invoiceCreatesOrUpdates();
  assert.equal(writes.length, 2);
  for (const w of writes) {
    assert.deepEqual(Object.keys(w.body.Invoices[0].Contact), ['ContactID'], `${w.method} ${w.path}`);
    assert.equal(w.body.Invoices[0].Contact.ContactID, CONTACT);
  }
});

test('NO-DUPLICATES 5: an INVALID ContactID fails safely, whatever it looks like, and nothing is created in its place', async () => {
  for (const bad of ['', '   ', 'not-a-guid', '{' + CONTACT + '}', CONTACT.slice(1), CONTACT + 'x', CONTACT.replace(/-/g, ''), '../Contacts', 'Name=="X"', '%00']) {
    reset();
    world.contact.xero_contact_id = bad;
    const res = await call();
    const out = await res.json();
    assert.ok(out.code === 'NOT_LINKED' || out.code === 'LINK_NOT_IN_ORGANISATION', `${JSON.stringify(bad)} -> ${out.code}`);
    assert.equal(contactReads().length, 0, `no request was even made for ${JSON.stringify(bad)}`);
    assert.equal(invoiceCreatesOrUpdates().length, 0);
  }
});

test('NO-DUPLICATES 6: an ARCHIVED (or erased) contact fails safely - it is not un-archived, replaced or recreated', async () => {
  for (const status of ['ARCHIVED', 'GDPRREQUEST']) {
    reset();
    world.xeroContacts[CONTACT].ContactStatus = status;
    const before = snapshotXeroContacts();
    const out = await (await call()).json();
    assert.equal(out.code, 'CONTACT_NOT_ACTIVE');
    assert.equal(snapshotXeroContacts(), before);
    assert.equal(invoiceCreatesOrUpdates().length, 0);
    assert.equal(world.contact.xero_contact_id, CONTACT, 'the link is left for a person to decide about');
  }
});

test('NO-DUPLICATES 7: a ContactID from ANOTHER organisation (not found in the connected one) fails safely instead of being replaced', async () => {
  const foreign = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'; // exists in some other Xero organisation, not in this one
  world.contact.xero_contact_id = foreign;
  const out = await (await call()).json();
  assert.equal(out.code, 'LINK_NOT_IN_ORGANISATION');
  assert.deepEqual(contactRequests().map((r) => r.method), ['GET'], 'one read by id, nothing else');
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(world.contact.xero_contact_id, foreign, 'not silently re-pointed at something else');
});

test('NO-DUPLICATES 8: and when the CONNECTED organisation is the wrong one, the contact is not even looked up', async () => {
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  const out = await (await call()).json();
  assert.equal(out.code, 'ORG_MISMATCH');
  assert.equal(contactRequests().length, 0);
});

test('NO-DUPLICATES 9: if Xero cannot answer the contact read (400, 403, 429, 500), the send fails safely - it never falls back to creating a contact', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    reset();
    world.contactGetStatus = status;
    const res = await call();
    assert.equal(res.status, 502, `HTTP ${status}`);
    assert.equal(invoiceCreatesOrUpdates().length, 0);
    assert.equal(contactReads().length, 1, 'exactly one read, no retry loop, no alternative path');
    assert.equal(world.invoice.status, 'failed', 'left retryable');
  }
});

test('NO-DUPLICATES 10: a NAME or EMAIL MISMATCH between the local and the Xero contact does not trigger anything - the linked id is still the one used', async () => {
  // The local contact is "Sam Client" / sam@client.test; the linked Xero contact has a completely different name and email.
  // A different Xero contact exists whose name AND email exactly equal the local contact's. It must be ignored.
  world.xeroContacts[OTHER_CONTACT] = { ContactID: OTHER_CONTACT, Name: 'Sam Client', EmailAddress: 'sam@client.test', ContactStatus: 'ACTIVE' };
  const before = snapshotXeroContacts();
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, CONTACT, 'the LINKED contact, not the look-alike');
  assert.deepEqual(contactReads().map((r) => r.path.split('/').pop()), [CONTACT], 'the look-alike was never even read');
  assert.equal(snapshotXeroContacts(), before);
});

test('NO-DUPLICATES 14: REPEATED retries of a linked contact whose email step keeps failing create ONE invoice and read the same contact, never a new one', async () => {
  world.emailStatus = 500;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await call();
    assert.equal(res.status, 502, `attempt ${attempt}`);
  }
  world.emailStatus = 200;
  assert.equal((await call()).status, 200);
  assert.equal(world.invoiceCounter, 1, 'Xero holds exactly one invoice');
  assert.ok(invoiceCreatesOrUpdates().slice(1).every((w) => w.path === `/api.xro/2.0/Invoices/${XERO_INVOICE}`), 'every retry updated the same invoice');
  assert.ok(contactReads().every((r) => r.path.endsWith(`/Contacts/${CONTACT}`)), 'only ever the linked contact');
  assert.equal(world.invoice.xero_contact_id, CONTACT);
});

test('NO-DUPLICATES 15: the only Xero writes are invoice calls and ONE contact create, made only by the automatic-contact module', () => {
  const roots = ['supabase/functions', 'tools', 'src'];
  const files: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    // tools/ is a local, untracked folder: absent in a clean checkout.
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push({ file: full, text: readFileSync(full, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '') });
    }
  };
  for (const r of roots) walk(join(process.cwd(), r));
  assert.ok(files.length > 20, 'the scan really covered the code');
  for (const { file, text } of files) {
    assert.doesNotMatch(text, /findContactByName|updateContact\(.*xero/i, file);
    if (/createContact\b/.test(text)) assert.match(file, /_shared[\\/](xeroClient|autoXeroContact)\.ts$/, `${file} must not create Xero contacts`);
    if (/searchContacts/.test(text)) assert.match(file, /(_shared[\\/](xeroClient|autoXeroContact)\.ts|xero-link-contact[\\/]index\.ts)$/, `${file} must not use the contact search`);
  }
  // Every call to xeroPost anywhere targets an invoice path.
  const callSites: string[] = [];
  for (const { file, text } of files) {
    for (const m of text.matchAll(/xeroPost\s*(?:<[^>]*>)?\s*\(\s*[A-Za-z]+\s*,\s*([^,]+),/g)) {
      let target = m[1].trim();
      // A path held in a variable: judge the expression it was assigned from, in the same file.
      if (/^[A-Za-z_]+$/.test(target)) target = text.match(new RegExp(`const ${target}\\s*=\\s*([^;]+);`))?.[1] ?? target;
      callSites.push(`${file}: ${target}`);
    }
  }
  assert.ok(callSites.length >= 2, 'the invoice and email calls were found');
  for (const site of callSites) assert.match(site, /Invoices|xeroClient\.ts: '\/Contacts'$/, `a Xero POST that is not an invoice call or the one contact create: ${site}`);
  assert.equal(callSites.filter((site) => /Contacts/.test(site)).length, 1, 'exactly one contact write: the create in xeroClient.ts (never an update /Contacts/{id})');
});

// ---- combined invoices: server-side validation of every line's visit against the invoice's job ----------------------------------------
// The screen only lets a manager tick visits of one job, but a checkbox is not a safeguard. The function validates the data
// itself, BEFORE any Xero call and before the claim; an invalid invoice is never claimed, so it cannot be left 'sending'.
const lineFor = (n: number, over: Record<string, unknown> = {}) => ({ id: `li-${n}`, visit_id: `visit-${n}`, visits: visitFor(`visit-${n}`), description: `Communal cleaning visit ${n}`, quantity: 1, unit_amount: 100 * n, ...over });
const setLines = (...lines: any[]) => {
  world.invoice.invoice_line_items = lines;
};

/** A refused invoice: a clear 422 with its code, no Xero request at all (not even a token), never claimed, never changed. */
async function assertRefusedUntouched(code: string, messagePattern: RegExp, status = 422) {
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, status, JSON.stringify(out));
  assert.equal(out.code, code);
  assert.match(out.error, messagePattern);
  assert.match(out.error, /Nothing was sent|Invoice not found/);
  assert.equal(world.xeroLog.length, 0, 'no request of any kind reached Xero, not even a token');
  assert.equal(invoicePatches().length, 0, 'the invoice was never claimed or changed');
  assert.notEqual(world.invoice?.status, 'sending');
  return out;
}

test('COMBINED 1: a valid invoice with SEVERAL visits of the same job is sent as ONE Xero invoice with every line', async () => {
  setLines(lineFor(1), lineFor(2), lineFor(3));
  const res = await call();
  assert.equal(res.status, 200);
  const creates = invoiceCreatesOrUpdates();
  assert.equal(creates.length, 1, 'one Xero invoice');
  const items = creates[0].body.Invoices[0].LineItems;
  assert.deepEqual(items.map((l: any) => l.UnitAmount), [100, 200, 300]);
  assert.deepEqual(items.map((l: any) => l.Description), ['Communal cleaning visit 1', 'Communal cleaning visit 2', 'Communal cleaning visit 3']);
  assert.ok(items.every((l: any) => l.AccountCode === '200' && l.TaxType === 'OUTPUT2'), 'Sales account and 20% VAT on every line');
  assert.equal(creates[0].body.Invoices[0].Contact.ContactID, CONTACT);
  assert.equal(world.invoice.status, 'sent');
  assert.equal(emailCalls().length, 1);
});

test('COMBINED 2: a multi-line invoice retried after a failed email updates the SAME Xero invoice with the same lines and idempotency key', async () => {
  setLines(lineFor(1), lineFor(2));
  world.emailStatus = 500;
  assert.equal((await call()).status, 502);
  world.emailStatus = 200;
  assert.equal((await call()).status, 200);
  const writes = invoiceCreatesOrUpdates();
  assert.equal(world.invoiceCounter, 1);
  assert.equal(writes[1].path, `/api.xro/2.0/Invoices/${XERO_INVOICE}`);
  assert.equal(writes[0].body.Invoices[0].LineItems.length, 2);
  assert.equal(writes[1].body.Invoices[0].LineItems.length, 2);
  assert.equal(writes[0].headers.get('idempotency-key'), writes[1].headers.get('idempotency-key'));
});

test('COMBINED 3: relationships returned as ARRAYS (as the database may shape them) are accepted exactly like objects', async () => {
  const v = (n: number) => ({ ...visitFor(`visit-${n}`), jobs: [{ id: 'job-1', building_id: 'building-1', buildings: [{ id: 'building-1', client_id: 'client-1' }] }] });
  setLines({ ...lineFor(1), visits: [v(1)] }, { ...lineFor(2), visits: [v(2)] });
  world.invoice.jobs = [{ ...world.invoice.jobs, buildings: [world.invoice.jobs.buildings] }];
  assert.equal((await call()).status, 200);
});

test('COMBINED 4: a visit from ANOTHER JOB is refused with a clear message, before any Xero call, and the invoice is left a draft', async () => {
  setLines(lineFor(1), lineFor(2), lineFor(3, { visits: visitFor('visit-3', 'job-2', 'building-1') }));
  const out = await assertRefusedUntouched('MIXED_JOBS', /Line 3.*different job.*same job/);
  assert.equal(out.status, 'blocked');
  assert.equal(world.invoice.status, 'draft');
  assert.equal(world.invoice.last_error, null);
});

test('COMBINED 5: a visit from another BUILDING (or another CLIENT) is refused the same way', async () => {
  setLines(lineFor(1), lineFor(2, { visits: visitFor('visit-2', 'job-2', 'building-2', 'client-1') }));
  await assertRefusedUntouched('MIXED_JOBS', /Line 2/);
  reset();
  setLines(lineFor(1, { visits: visitFor('visit-1', 'job-3', 'building-3', 'client-2') }));
  await assertRefusedUntouched('MIXED_JOBS', /Line 1/);
});

test('COMBINED 6: missing, inconsistent or unresolvable relationships are each refused clearly, with nothing sent and nothing claimed', async () => {
  const cases: Array<{ name: string; code: string; pattern: RegExp; setup: () => void }> = [
    { name: 'a line with no visit', code: 'LINE_WITHOUT_VISIT', pattern: /Line 2 is not linked to a visit/, setup: () => setLines(lineFor(1), lineFor(2, { visit_id: null, visits: null })) },
    { name: 'a line whose visit does not exist', code: 'VISIT_NOT_FOUND', pattern: /Line 2's visit could not be found/, setup: () => setLines(lineFor(1), lineFor(2, { visits: null })) },
    { name: 'a visit record that is not the line\'s visit', code: 'VISIT_NOT_FOUND', pattern: /Line 1's visit could not be found/, setup: () => setLines(lineFor(1, { visits: visitFor('some-other-visit') })) },
    { name: 'an invoice whose job cannot be found', code: 'JOB_UNRESOLVED', pattern: /job could not be found/, setup: () => { world.invoice.jobs = null; } },
    { name: 'an invoice with no job id', code: 'JOB_UNRESOLVED', pattern: /job could not be found/, setup: () => { world.invoice.job_id = null; } },
    { name: 'a job with no building', code: 'JOB_UNRESOLVED', pattern: /no building/, setup: () => { world.invoice.jobs.buildings = null; } },
    { name: 'a building with no client', code: 'JOB_UNRESOLVED', pattern: /no client/, setup: () => { world.invoice.jobs.buildings.client_id = null; } },
    { name: 'a job record that does not match the invoice', code: 'RELATIONSHIP_INCONSISTENT', pattern: /does not match the invoice/, setup: () => { world.invoice.jobs.id = 'job-other'; } },
    { name: 'a visit of the right job that resolves to a different building', code: 'RELATIONSHIP_INCONSISTENT', pattern: /Line 1's visit does not resolve to the same building and client/, setup: () => setLines(lineFor(1, { visits: visitFor('visit-1', 'job-1', 'building-9') })) },
    { name: 'a visit of the right job that resolves to a different client', code: 'RELATIONSHIP_INCONSISTENT', pattern: /same building and client/, setup: () => setLines(lineFor(1, { visits: visitFor('visit-1', 'job-1', 'building-1', 'client-9') })) },
    { name: 'a visit whose own job record is missing', code: 'RELATIONSHIP_INCONSISTENT', pattern: /same building and client/, setup: () => setLines(lineFor(1, { visits: { id: 'visit-1', job_id: 'job-1', jobs: null } })) },
    { name: 'an invoice with no lines', code: 'INVOICE_NO_LINES', pattern: /no line items/, setup: () => setLines() },
  ];
  for (const c of cases) {
    reset();
    c.setup();
    await assertRefusedUntouched(c.code, c.pattern);
    assert.equal(world.invoice.status, 'draft', c.name);
  }
});

test('COMBINED 7: an invoice that does not exist is refused as not found, with no Xero call', async () => {
  world.invoice = null;
  const res = await call();
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'INVOICE_NOT_FOUND');
  assert.equal(world.xeroLog.length, 0);
});

test('COMBINED 8: if the invoice data cannot be LOADED, the send is blocked (a failed check is never a pass)', async () => {
  world.invoiceReadFails = true;
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 500);
  assert.equal(out.status, 'blocked');
  assert.match(out.error, /Could not check the invoice before sending/);
  assert.equal(world.xeroLog.length, 0);
  assert.equal(invoicePatches().length, 0);
  assert.equal(world.invoice.status, 'draft');
});

test('COMBINED 9: lines changed AFTER the first check but before the Xero writes are caught by the second check: invoice left FAILED (not sending), nothing written to Xero', async () => {
  setLines(lineFor(1), lineFor(2));
  world.afterInvoiceRead = (n) => {
    if (n === 1) setLines(lineFor(1), lineFor(2, { visits: visitFor('visit-2', 'job-9', 'building-9') }));
  };
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 422);
  assert.equal(out.status, 'failed');
  assert.equal(out.code, 'MIXED_JOBS');
  assertNoXeroWrites();
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(emailCalls().length, 0);
  assert.equal(world.invoice.status, 'failed', 'recorded as failed with the reason, never stuck in sending');
  assert.match(world.invoice.last_error, /different job/);
  assert.equal(world.invoice.xero_invoice_id, null);
});

test('COMBINED 10: if the invoice\'s CLIENT changes between the checks, the send is refused - the recipient is only ever checked against the client the invoice was validated for', async () => {
  world.afterInvoiceRead = (n) => {
    if (n === 1) {
      world.invoice.jobs.buildings.client_id = 'client-2';
      setLines(lineFor(1, { visits: visitFor('visit-1', 'job-1', 'building-1', 'client-2') }));
    }
  };
  const res = await call();
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /job or client changed while it was being sent/);
  assertNoXeroWrites();
  assert.equal(world.invoice.status, 'failed');
});

test('COMBINED 11: the recipient is validated against the SAME client the lines were validated against (a contact of another client is still refused on a valid multi-line invoice)', async () => {
  setLines(lineFor(1), lineFor(2));
  world.contact.client_id = 'client-2';
  const res = await call();
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /does not belong to this invoice's client/);
  assertNoXeroWrites();
});

test('COMBINED 12: an invoice that is already SENT is still answered "already sent", and the new check does not disturb it', async () => {
  setLines(lineFor(1), lineFor(2));
  world.invoice.status = 'sent';
  assert.equal((await call()).status, 409);
  assert.equal(world.invoice.status, 'sent');
});

test('COMBINED 13: no refusal path leaves an invoice in the sending state', async () => {
  const setups: Array<() => void> = [
    () => setLines(lineFor(1), lineFor(2, { visits: visitFor('visit-2', 'job-2') })),
    () => setLines(lineFor(1, { visit_id: null, visits: null })),
    () => { world.invoice.jobs = null; },
    () => setLines(),
    () => { world.invoiceReadFails = true; },
  ];
  for (const setup of setups) {
    reset();
    setup();
    await call();
    assert.notEqual(world.invoice.status, 'sending');
    assert.equal(world.xeroLog.length, 0);
  }
});

test('COMBINED 14 (the check itself): returns the one job, building, client and the visits, in line order', () => {
  const validated = relationships.validateInvoiceRelationships({
    id: 'inv-1',
    job_id: 'job-1',
    jobs: { id: 'job-1', building_id: 'building-1', buildings: { id: 'building-1', client_id: 'client-1' } },
    invoice_line_items: [lineFor(1), lineFor(2), lineFor(3)] as any,
  });
  assert.deepEqual(validated, { jobId: 'job-1', buildingId: 'building-1', clientId: 'client-1', visitIds: ['visit-1', 'visit-2', 'visit-3'] });
  assert.throws(() => relationships.validateInvoiceRelationships(null), (e: any) => e.code === 'INVOICE_NOT_FOUND' && e.status === 404);
});

// ---- recipient lock: once Xero holds the invoice, its recipient cannot change --------------------------------------------------------
const OTHER_LOCAL = 'ct-2';
function addSecondLinkedContact() {
  world.xeroContacts[NEW_CONTACT] = { ContactID: NEW_CONTACT, Name: 'Other Recipient Ltd', EmailAddress: 'other@oak.test', ContactStatus: 'ACTIVE' };
  world.contacts[OTHER_LOCAL] = { id: OTHER_LOCAL, client_id: 'client-1', name: 'Other Person', email: 'other@client.test', xero_contact_id: NEW_CONTACT, xero_org_id: ORG };
}
/** An invoice that already exists in Xero (created for CONTACT in organisation ORG), failed at the email step, now being retried. */
function xeroHoldsInvoice(over: { recordedRecipient?: string | null; recordedOrg?: string | null; xeroSideContact?: string } = {}) {
  world.invoice.status = 'failed';
  world.invoice.xero_invoice_id = XERO_INVOICE;
  world.invoice.xero_invoice_number = 'INV-001';
  world.invoice.xero_contact_id = over.recordedRecipient === undefined ? CONTACT : over.recordedRecipient;
  world.invoice.xero_org_id = over.recordedOrg === undefined ? ORG : over.recordedOrg;
  world.xeroInvoices[XERO_INVOICE] = { InvoiceID: XERO_INVOICE, InvoiceNumber: 'INV-001', Contact: { ContactID: over.xeroSideContact ?? CONTACT } };
}
const recipientWrites = () => invoicePatches().filter((r) => 'xero_contact_id' in r.body);

test('LOCK 1: a retry naming a DIFFERENT linked contact is refused - nothing is sent, Xero is unchanged, the recorded recipient is unchanged', async () => {
  addSecondLinkedContact();
  xeroHoldsInvoice();
  const res = await call({ invoiceId: 'inv-1', contactId: OTHER_LOCAL });
  const out = await res.json();
  assert.equal(res.status, 502);
  assert.equal(out.code, 'RECIPIENT_LOCKED');
  assert.match(out.error, /already exists in Xero, so its recipient cannot be changed/);
  assert.equal(invoiceCreatesOrUpdates().length, 0, 'no update was sent to Xero');
  assert.equal(emailCalls().length, 0);
  assert.equal(world.xeroInvoices[XERO_INVOICE].Contact.ContactID, CONTACT, 'Xero still has the original recipient');
  assert.equal(world.invoice.xero_contact_id, CONTACT);
  assert.equal(recipientWrites().length, 0, 'the recipient was never written');
  assert.equal(world.invoice.status, 'failed', 'left retryable, not sending');
});

test('LOCK 2: a retry with the SAME contact succeeds and UPDATES the existing Xero invoice (no duplicate, same idempotency key)', async () => {
  xeroHoldsInvoice();
  const res = await call();
  assert.equal(res.status, 200);
  const writes = invoiceCreatesOrUpdates();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `/api.xro/2.0/Invoices/${XERO_INVOICE}`);
  assert.equal(writes[0].body.Invoices[0].Contact.ContactID, CONTACT);
  assert.equal(world.invoiceCounter, 0, 'no new invoice');
  assert.equal(world.invoice.xero_contact_id, CONTACT);
  assert.equal(world.invoice.xero_org_id, ORG);
  assert.equal(world.invoice.status, 'sent');
});

test('LOCK 3: a retry that names NO contact uses the locked one', async () => {
  xeroHoldsInvoice();
  const res = await call({ invoiceId: 'inv-1' });
  assert.equal(res.status, 200);
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, CONTACT);
  assert.equal(((await res.json()) as any).recipientSource, 'locked');
});

test('LOCK 4: a local contact whose link has since been re-pointed at ANOTHER Xero contact cannot be used to retry the invoice', async () => {
  addSecondLinkedContact();
  xeroHoldsInvoice();
  world.contacts['ct-1'].xero_contact_id = NEW_CONTACT; // ct-1 now points somewhere else
  const out = await (await call({ invoiceId: 'inv-1', contactId: 'ct-1' })).json();
  assert.equal(out.code, 'RECIPIENT_LOCKED');
  assertNoXeroWrites();
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('LOCK 5: if the recorded recipient and the recipient on the invoice in Xero disagree, the invoice is not touched', async () => {
  addSecondLinkedContact();
  xeroHoldsInvoice({ xeroSideContact: NEW_CONTACT });
  const out = await (await call()).json();
  assert.equal(out.code, 'RECIPIENT_LOCKED');
  assert.match(out.error, /does not match the recipient on the invoice in Xero/);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('LOCK 6: an invoice created in a DIFFERENT Xero organisation is never updated through the connected one', async () => {
  xeroHoldsInvoice({ recordedOrg: OTHER_ORG });
  const out = await (await call()).json();
  assert.equal(out.code, 'INVOICE_ORG_MISMATCH');
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(world.invoice.xero_org_id, OTHER_ORG, 'the recorded organisation is left as it was');
});

test('LOCK 7: an invoice sent before the recipient and organisation were recorded can be retried with its own Xero contact, and gets them recorded once', async () => {
  xeroHoldsInvoice({ recordedRecipient: null, recordedOrg: null });
  const res = await call({ invoiceId: 'inv-1' });
  assert.equal(res.status, 200);
  assert.equal(world.invoice.xero_contact_id, CONTACT);
  assert.equal(world.invoice.xero_org_id, ORG);
  assert.equal(world.invoiceCounter, 0);
});

test('LOCK 8: ...and such a legacy invoice is locked to the contact Xero holds: a different contact is refused', async () => {
  addSecondLinkedContact();
  xeroHoldsInvoice({ recordedRecipient: null, recordedOrg: null });
  const out = await (await call({ invoiceId: 'inv-1', contactId: OTHER_LOCAL })).json();
  assert.equal(out.code, 'RECIPIENT_LOCKED');
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(world.invoice.xero_contact_id, null, 'nothing was recorded either');
});

test('LOCK 9: if the locked Xero contact has since been ARCHIVED, the retry is refused - not switched to another contact', async () => {
  addSecondLinkedContact();
  xeroHoldsInvoice();
  world.xeroContacts[CONTACT].ContactStatus = 'ARCHIVED';
  const out = await (await call({ invoiceId: 'inv-1', contactId: OTHER_LOCAL })).json();
  assert.ok(out.code === 'RECIPIENT_LOCKED' || out.code === 'CONTACT_NOT_ACTIVE', out.code);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('LOCK 10: CONCURRENT retries, one with the locked contact and one with another, can never change the recipient', async () => {
  addSecondLinkedContact();
  xeroHoldsInvoice();
  const results = await Promise.all([call({ invoiceId: 'inv-1', contactId: 'ct-1' }), call({ invoiceId: 'inv-1', contactId: OTHER_LOCAL }), call({ invoiceId: 'inv-1', contactId: OTHER_LOCAL })]);
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.every((st) => [200, 409, 502].includes(st)), statuses.join(','));
  for (const w of invoiceCreatesOrUpdates()) assert.equal(w.body.Invoices[0].Contact.ContactID, CONTACT, 'every write to Xero names the locked contact');
  assert.equal(world.invoice.xero_contact_id, CONTACT);
  assert.equal(world.xeroInvoices[XERO_INVOICE].Contact.ContactID, CONTACT);
  assert.equal(world.invoiceCounter, 0, 'no new invoice');
  assert.ok(recipientWrites().every((w) => w.body.xero_contact_id === CONTACT), 'no write to the row ever carried another recipient');
});

test('LOCK 11: CONCURRENT FIRST sends naming different contacts create exactly ONE Xero invoice, for exactly one of them', async () => {
  addSecondLinkedContact();
  const results = await Promise.all([call({ invoiceId: 'inv-1', contactId: 'ct-1' }), call({ invoiceId: 'inv-1', contactId: OTHER_LOCAL })]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(world.invoiceCounter, 1);
  assert.equal(invoiceCreatesOrUpdates().length, 1);
  assert.equal(world.invoice.xero_contact_id, invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID);
});

// ---- organisation tags on links and invoices ----------------------------------------------------------------------------------------
test('ORG 1: a link with NO organisation recorded is refused before Xero is asked (re-link it to verify it)', async () => {
  world.contact.xero_org_id = null;
  const out = await (await call()).json();
  assert.equal(out.code, 'LINK_UNTAGGED');
  assert.equal(contactReads().length, 0);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('ORG 2: a link recorded for ANOTHER Xero organisation (for example the Test one) is refused before Xero is asked', async () => {
  world.contact.xero_org_id = OTHER_ORG;
  const out = await (await call()).json();
  assert.equal(out.code, 'LINK_WRONG_ORGANISATION');
  assert.equal(contactReads().length, 0);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('ORG 3: the invoice records the Xero ORGANISATION with its recipient, before the create and again after Xero accepts it', async () => {
  await call();
  assert.equal(world.invoice.xero_org_id, ORG);
  const firstWrite = invoicePatches().find((r) => 'xero_org_id' in r.body)!;
  assert.deepEqual({ c: firstWrite.body.xero_contact_id, o: firstWrite.body.xero_org_id }, { c: CONTACT, o: ORG });
  const recorded = world.events.findIndex((e) => e.startsWith('db:PATCH invoices') && e.includes('"xero_org_id"'));
  const created = world.events.findIndex((e) => e === 'xero:POST /Invoices');
  assert.ok(recorded >= 0 && recorded < created);
});

// ---- the building's saved default recipient --------------------------------------------------------------------------------------------
function setBuildingDefault(localId = 'ct-1', xeroId = CONTACT, org = ORG) {
  world.building.default_invoice_contact_id = localId;
  world.building.default_invoice_xero_contact_id = xeroId;
  world.building.default_invoice_xero_org_id = org;
}

test('DEFAULT 1: with no contact chosen, the building\'s saved default recipient is used - and the response says so', async () => {
  setBuildingDefault();
  const res = await call({ invoiceId: 'inv-1' });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.recipientSource, 'building_default');
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, CONTACT);
  assert.equal(world.invoice.xero_contact_id, CONTACT);
  assert.equal(world.invoice.xero_org_id, ORG);
});

test('DEFAULT 2: with NO default and no contact chosen, the send is refused with an explanation - a default is never guessed', async () => {
  // ct-1 is the client's only, linked, primary contact: it must still NOT be picked.
  world.contact.is_primary = true;
  const res = await call({ invoiceId: 'inv-1' });
  const out = await res.json();
  assert.equal(res.status, 502);
  assert.equal(out.code, 'NO_RECIPIENT');
  assert.match(out.error, /no default recipient/);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(contactReads().length, 0, 'no contact was even looked at');
  assert.equal(world.invoice.xero_contact_id, null);
});

test('DEFAULT 3: a contact chosen for THIS invoice overrides the default (when it is itself valid)', async () => {
  addSecondLinkedContact();
  setBuildingDefault('ct-1', CONTACT, ORG);
  const res = await call({ invoiceId: 'inv-1', contactId: OTHER_LOCAL });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.recipientSource, 'selected');
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, NEW_CONTACT);
});

test('DEFAULT 4: a default whose contact has been RE-LINKED since it was chosen is stale - refused, not silently followed', async () => {
  addSecondLinkedContact();
  setBuildingDefault('ct-1', CONTACT, ORG);
  world.contacts['ct-1'].xero_contact_id = NEW_CONTACT;
  const out = await (await call({ invoiceId: 'inv-1' })).json();
  assert.equal(out.code, 'DEFAULT_STALE');
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('DEFAULT 5: a default chosen in ANOTHER Xero organisation is refused', async () => {
  setBuildingDefault('ct-1', CONTACT, OTHER_ORG);
  const out = await (await call({ invoiceId: 'inv-1' })).json();
  assert.equal(out.code, 'DEFAULT_WRONG_ORGANISATION');
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('DEFAULT 6: a default that is no longer a contact of the building\'s client is refused', async () => {
  world.contacts['ct-9'] = { id: 'ct-9', client_id: 'client-2', name: 'Elsewhere', email: 'e@x.test', xero_contact_id: CONTACT, xero_org_id: ORG };
  setBuildingDefault('ct-9', CONTACT, ORG);
  const out = await (await call({ invoiceId: 'inv-1' })).json();
  assert.equal(out.code, 'DEFAULT_STALE');
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('DEFAULT 7: a default whose Xero contact is ARCHIVED, or has no email, or whose link has no organisation, is refused - never replaced', async () => {
  for (const [setup, code] of [
    [() => { world.xeroContacts[CONTACT].ContactStatus = 'ARCHIVED'; }, 'CONTACT_NOT_ACTIVE'],
    [() => { world.xeroContacts[CONTACT].EmailAddress = ''; }, 'CONTACT_NO_EMAIL'],
    [() => { world.contact.xero_org_id = null; world.building.default_invoice_xero_org_id = ORG; }, 'DEFAULT_STALE'],
  ] as Array<[() => void, string]>) {
    reset();
    setBuildingDefault();
    setup();
    const out = await (await call({ invoiceId: 'inv-1' })).json();
    assert.equal(out.code, code);
    assert.equal(invoiceCreatesOrUpdates().length, 0);
  }
});

test('DEFAULT 8: a building that does not belong to the invoice\'s client is not used', async () => {
  setBuildingDefault();
  world.building.client_id = 'client-2';
  const res = await call({ invoiceId: 'inv-1' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /building could not be matched to its client/);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('DEFAULT 9: the default is used only for a FIRST send - an invoice Xero already holds keeps its own recipient whatever the default now says', async () => {
  addSecondLinkedContact();
  setBuildingDefault(OTHER_LOCAL, NEW_CONTACT, ORG);
  xeroHoldsInvoice();
  const res = await call({ invoiceId: 'inv-1' });
  assert.equal(res.status, 200);
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, CONTACT);
  assert.equal(((await res.json()) as any).recipientSource, 'locked');
});

// ---- automatic Xero contact for an UNLINKED recipient (first send only) -------------------------------------------------------------
const contactCreatesSent = () => accounting().filter((r) => r.method === 'POST' && r.path === '/api.xro/2.0/Contacts');
const contactSearches = () => accounting().filter((r) => r.method === 'GET' && r.path === '/api.xro/2.0/Contacts');
function unlinked(over: Record<string, unknown> = {}) {
  Object.assign(world.contact, { xero_contact_id: null, xero_org_id: null, ...over });
}

test('AUTO-CONTACT 1: an already LINKED contact is reused by id: no search, no create, the link is not rewritten', async () => {
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(contactSearches().length + contactCreatesSent().length, 0);
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, CONTACT);
  assert.equal(world.events.filter((e) => e.startsWith('db:LINK')).length, 0);
  assert.equal(((await res.json()) as any).recipientSource, 'selected');
});

test('AUTO-CONTACT 2: an UNLINKED contact whose email matches exactly ONE active Xero contact is linked to it and reused - nothing created', async () => {
  unlinked();
  world.xeroContacts[OTHER_CONTACT] = { ContactID: OTHER_CONTACT, Name: 'Sam at Oak', EmailAddress: 'SAM@client.test', ContactStatus: 'ACTIVE' };
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.recipientSource, 'auto_linked');
  assert.equal(contactCreatesSent().length, 0, 'no contact created');
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, OTHER_CONTACT);
  assert.deepEqual(
    [world.contact.xero_contact_id, world.contact.xero_org_id, world.contact.xero_contact_name],
    [OTHER_CONTACT, ORG, 'Sam at Oak'],
    'the link and the organisation are saved on the local contact',
  );
  assert.match(world.contact.xero_linked_by, /^auto \(invoice send\): /);
});

test('AUTO-CONTACT 3: an UNLINKED contact with no match is CREATED in Xero as "<person> (<client>)" with its email, idempotently, then linked and invoiced', async () => {
  unlinked();
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.recipientSource, 'auto_created');
  const creates = contactCreatesSent();
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].body, { Contacts: [{ Name: 'Sam Client (Oak Estates)', EmailAddress: 'sam@client.test' }] }, 'only a name and an email');
  assert.match(creates[0].headers.get('idempotency-key') ?? '', /^[0-9a-f]{64}$/);
  const newId = world.contact.xero_contact_id;
  assert.match(newId, /^c1000000-/);
  assert.equal(world.contact.xero_org_id, ORG);
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, newId);
  assert.equal(world.invoice.xero_contact_id, newId);
  // Order: organisation verified -> claim -> contact created -> linked -> invoice created -> invoice emailed.
  const at = (pred: (e: string) => boolean) => world.events.findIndex(pred);
  const org = at((e) => e === 'xero:GET /Organisation');
  const created = at((e) => e === 'xero:POST /Contacts');
  const linked = at((e) => e.startsWith('db:LINK'));
  const invoice = at((e) => e === 'xero:POST /Invoices');
  const email = at((e) => e.endsWith('/Email'));
  assert.ok(org < created && created < linked && linked < invoice && invoice < email, world.events.join('\n'));
});

test('AUTO-CONTACT 4: creating a contact never emails anything - no email call happens unless and until the invoice is created', async () => {
  unlinked();
  world.createStatus = 500; // the invoice create fails after the contact is created
  await call();
  assert.equal(contactCreatesSent().length, 1);
  assert.equal(emailCalls().length, 0, 'no email at all');
  assert.ok(contactCreatesSent().every((r) => !/Email/i.test(r.path)), 'the contact create is not an email request');
});

test('AUTO-CONTACT 5: SEVERAL Xero contacts with the same email are ambiguous - refused, nothing created, nothing linked, nothing invoiced', async () => {
  unlinked();
  world.xeroContacts['11111111-1111-4111-8111-111111111111'] = { ContactID: '11111111-1111-4111-8111-111111111111', Name: 'A', EmailAddress: 'sam@client.test', ContactStatus: 'ACTIVE' };
  world.xeroContacts['22222222-2222-4222-8222-222222222222'] = { ContactID: '22222222-2222-4222-8222-222222222222', Name: 'B', EmailAddress: 'sam@client.test', ContactStatus: 'ACTIVE' };
  const out = await (await call()).json();
  assert.equal(out.code, 'CONTACT_AMBIGUOUS');
  assert.match(out.error, /cannot tell which one to use/);
  assert.equal(contactCreatesSent().length, 0);
  assert.equal(world.contact.xero_contact_id, null);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(world.invoice.status, 'failed', 'retryable once the manager links the right one');
});

test('AUTO-CONTACT 6: an archived or merged email match, a name already taken by another email, or an incomplete search are refused - never guessed', async () => {
  const cases: Array<[() => void, string]> = [
    [() => { world.xeroContacts[OTHER_CONTACT] = { ContactID: OTHER_CONTACT, Name: 'Old', EmailAddress: 'sam@client.test', ContactStatus: 'ARCHIVED' }; }, 'CONTACT_MATCH_NOT_ACTIVE'],
    [() => { world.xeroContacts[OTHER_CONTACT] = { ContactID: OTHER_CONTACT, Name: 'Old', EmailAddress: 'sam@client.test', ContactStatus: 'ACTIVE', MergedToContactID: CONTACT }; }, 'CONTACT_MATCH_NOT_ACTIVE'],
    [() => { world.xeroContacts[OTHER_CONTACT] = { ContactID: OTHER_CONTACT, Name: 'Sam Client (Oak Estates)', EmailAddress: 'someone@else.test', ContactStatus: 'ACTIVE' }; }, 'CONTACT_NAME_TAKEN'],
    [() => { world.searchPadding = Array.from({ length: 25 }, (_, i) => ({ ContactID: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, Name: `X${i}`, EmailAddress: `x${i}@y.test`, ContactStatus: 'ACTIVE' })); }, 'CONTACT_SEARCH_INCOMPLETE'],
  ];
  for (const [setup, code] of cases) {
    reset();
    unlinked();
    setup();
    const out = await (await call()).json();
    assert.equal(out.code, code);
    assert.equal(contactCreatesSent().length, 0, code);
    assert.equal(world.contact.xero_contact_id, null, code);
    assert.equal(invoiceCreatesOrUpdates().length, 0, code);
  }
});

test('AUTO-CONTACT 7: missing details (no email, an invalid email, no name, no client name) are refused with what to fix - before Xero is searched', async () => {
  const cases: Array<[() => void, RegExp]> = [
    [() => unlinked({ email: null }), /a valid email address/],
    [() => unlinked({ email: 'not-an-email' }), /a valid email address/],
    [() => unlinked({ name: '  ' }), /a name/],
    [() => { unlinked(); world.invoice.jobs.buildings.clients.company_name = ' '; }, /the client's name/],
  ];
  for (const [setup, message] of cases) {
    reset();
    setup();
    const out = await (await call()).json();
    assert.equal(out.code, 'CONTACT_DETAILS_MISSING');
    assert.match(out.error, message);
    assert.equal(contactSearches().length + contactCreatesSent().length, 0);
    assert.equal(invoiceCreatesOrUpdates().length, 0);
  }
});

test('AUTO-CONTACT 8: in the WRONG organisation nothing is searched, created or linked (the organisation check comes first)', async () => {
  unlinked();
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  const out = await (await call()).json();
  assert.equal(out.code, 'ORG_MISMATCH');
  assert.equal(contactRequests().length, 0);
  assert.equal(world.contact.xero_contact_id, null);
});

test('AUTO-CONTACT 9: an EXISTING link is never replaced automatically - untagged, other-organisation or missing-in-Xero links are refused, not re-created', async () => {
  for (const [setup, code] of [
    [() => { world.contact.xero_org_id = null; }, 'LINK_UNTAGGED'],
    [() => { world.contact.xero_org_id = OTHER_ORG; }, 'LINK_WRONG_ORGANISATION'],
    [() => { world.contact.xero_contact_id = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'; }, 'LINK_NOT_IN_ORGANISATION'],
    [() => { world.contact.xero_contact_id = '   '; }, 'NOT_LINKED'],
  ] as Array<[() => void, string]>) {
    reset();
    setup();
    const out = await (await call()).json();
    assert.equal(out.code, code);
    assert.equal(contactSearches().length + contactCreatesSent().length, 0, code);
  }
});

test('AUTO-CONTACT 10: if the contact CREATE fails, no invoice is created, nothing is linked, and the invoice is left retryable', async () => {
  unlinked();
  world.createContactStatus = 500;
  const res = await call();
  assert.equal(res.status, 502);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(world.contact.xero_contact_id, null);
  assert.equal(world.invoice.status, 'failed');
  assert.equal(emailCalls().length, 0);
});

test('AUTO-CONTACT 11: RETRY after the contact was created but the invoice failed: the link is reused, no second contact', async () => {
  unlinked();
  world.createStatus = 500;
  await call();
  assert.equal(world.contactCreates, 1);
  const linkedTo = world.contact.xero_contact_id;
  world.createStatus = 200;
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(world.contactCreates, 1, 'still exactly one contact in Xero');
  assert.equal(contactCreatesSent().length, 1, 'the retry did not even try to create');
  assert.equal(invoiceCreatesOrUpdates().at(-1)!.body.Invoices[0].Contact.ContactID, linkedTo);
});

test('AUTO-CONTACT 12: TIMEOUT after Xero created the contact (response lost): the retry finds it by email and links it - no duplicate', async () => {
  unlinked();
  world.createContactLoseResponse = true;
  const first = await call();
  assert.equal(first.status, 502);
  assert.equal(world.contactCreates, 1);
  assert.equal(world.contact.xero_contact_id, null, 'nothing linked from a lost response');
  world.createContactLoseResponse = false;
  const out = await (await call()).json();
  assert.equal(out.status, 'sent');
  assert.equal(out.recipientSource, 'auto_linked');
  assert.equal(world.contactCreates, 1, 'still one contact');
  assert.match(world.contact.xero_contact_id, /^c1000000-/);
});

test('AUTO-CONTACT 13: the create request is IDEMPOTENT: the same organisation, contact and details always send the same key, which Xero answers with the same contact', async () => {
  unlinked();
  world.createStatus = 500;
  await call();
  const key1 = contactCreatesSent()[0].headers.get('idempotency-key');
  // Simulate the link being lost locally, then a retry: the same key comes back to the same contact.
  world.contact.xero_contact_id = null;
  world.contact.xero_org_id = null;
  delete world.xeroContacts[Object.keys(world.xeroContacts).find((k) => k.startsWith('c1000000-'))!]; // the search no longer sees it
  world.createStatus = 200;
  await call();
  const key2 = contactCreatesSent()[1].headers.get('idempotency-key');
  assert.equal(key1, key2);
  assert.equal(world.contactCreates, 1, 'Xero replayed the original create');
});

test('AUTO-CONTACT 14: CONCURRENT first sends of the same invoice create at most ONE contact and ONE invoice', async () => {
  unlinked();
  const results = await Promise.all([call(), call(), call()]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(world.contactCreates, 1);
  assert.equal(world.invoiceCounter, 1);
});

test('AUTO-CONTACT 15: CONCURRENT link attempts for the same local contact (two invoices at once) end with ONE Xero contact and one link', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { linkOrCreateXeroContact } = await import('../supabase/functions/_shared/autoXeroContact.ts');
  unlinked();
  const db = createClient('https://tests.invalid', 'anon-test-key', { auth: { persistSession: false } }) as any;
  const input = { db, accessToken: ACCESS_TOKEN, connectedOrgId: ORG, clientName: 'Oak Estates', contact: world.contact, linkedBy: 'test' };
  const [a, b] = await Promise.all([linkOrCreateXeroContact(input), linkOrCreateXeroContact(input)]);
  assert.equal(a.xeroContactId, b.xeroContactId);
  assert.equal(world.contactCreates, 1, 'the second create was answered with the first contact');
  assert.equal(world.contact.xero_contact_id, a.xeroContactId);
});

test('AUTO-CONTACT 16: if another request linked the contact to a DIFFERENT Xero contact meanwhile, the send is refused rather than overwriting it', async () => {
  unlinked();
  // At the moment Xero creates the contact, another request links the local contact elsewhere: the conditional save then
  // matches no row, and the link it finds is not the one just created.
  world.contactsByIdempotencyKey = new Proxy({} as Record<string, XeroContactRec>, {
    set(target, prop, value) {
      Object.assign(world.contact, { xero_contact_id: 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0', xero_org_id: ORG });
      return Reflect.set(target, prop, value);
    },
  });
  const out = await (await call()).json();
  assert.equal(out.code, 'CONTACT_LINK_CONFLICT');
  assert.equal(world.contact.xero_contact_id, 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0', 'the other link was not overwritten');
  assert.equal(invoiceCreatesOrUpdates().length, 0);
});

test('AUTO-CONTACT 19 (DEV regression): a long client and contact name - "Finity - not in xero yet (New Client - Not in xero)" - is created, with no search over 50 characters', async () => {
  Object.assign(world.contact, { name: 'Finity - not in xero yet', email: 'finity@newclient.test', xero_contact_id: null, xero_org_id: null });
  world.invoice.jobs.buildings.clients.company_name = 'New Client - Not in xero';
  const fullName = 'Finity - not in xero yet (New Client - Not in xero)';
  assert.ok(fullName.length > 50, `the generated name is ${fullName.length} characters`);
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.recipientSource, 'auto_created');
  const terms = contactSearches().map((r) => new URLSearchParams(r.search).get('searchTerm') ?? '');
  assert.ok(terms.length >= 2, 'searched by email, then checked the name');
  assert.ok(terms.every((t) => t.length <= 50), `every searchTerm is at most 50 characters: ${JSON.stringify(terms)}`);
  assert.equal(terms[0], 'finity@newclient.test', 'the first search is the email, not the display name');
  assert.deepEqual(contactCreatesSent()[0].body, { Contacts: [{ Name: fullName, EmailAddress: 'finity@newclient.test' }] }, 'created with the FULL name');
  assert.equal(world.contact.xero_contact_name, fullName);
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, world.contact.xero_contact_id);
});

test('AUTO-CONTACT 20: a long name that IS taken (exact full name) is still refused, found through the shortened search', async () => {
  Object.assign(world.contact, { name: 'Finity - not in xero yet', email: 'finity@newclient.test', xero_contact_id: null, xero_org_id: null });
  world.invoice.jobs.buildings.clients.company_name = 'New Client - Not in xero';
  world.xeroContacts[OTHER_CONTACT] = { ContactID: OTHER_CONTACT, Name: 'Finity - not in xero yet (New Client - Not in xero)', EmailAddress: 'someone@else.test', ContactStatus: 'ACTIVE' };
  const out = await (await call()).json();
  assert.equal(out.code, 'CONTACT_NAME_TAKEN');
  assert.equal(contactCreatesSent().length, 0);
  assert.equal(world.contact.xero_contact_id, null);
});

test('AUTO-CONTACT 21: a DIFFERENT contact that only shares the first 50 characters is never treated as a match - the new contact is created', async () => {
  Object.assign(world.contact, { name: 'Finity - not in xero yet', email: 'finity@newclient.test', xero_contact_id: null, xero_org_id: null });
  world.invoice.jobs.buildings.clients.company_name = 'New Client - Not in xero';
  // Same first 50 characters, different full name and email.
  world.xeroContacts[OTHER_CONTACT] = { ContactID: OTHER_CONTACT, Name: 'Finity - not in xero yet (New Client - Not in xero) Ltd', EmailAddress: 'other@else.test', ContactStatus: 'ACTIVE' };
  const out = await (await call()).json();
  assert.equal(out.recipientSource, 'auto_created');
  assert.notEqual(world.contact.xero_contact_id, OTHER_CONTACT, 'never linked by a shortened name');
  assert.equal(contactCreatesSent().length, 1);
});

test('AUTO-CONTACT 22: if the name search cannot see a clash (it is past the first page), the unique-name refusal from Xero is reported as name taken - nothing linked, no invoice', async () => {
  Object.assign(world.contact, { xero_contact_id: null, xero_org_id: null });
  // The exact name exists in Xero (different email) but the search does not return it.
  world.xeroContacts['abababab-abab-4bab-8bab-abababababab'] = { ContactID: 'abababab-abab-4bab-8bab-abababababab', Name: 'Sam Client (Oak Estates)', EmailAddress: 'x@y.test', ContactStatus: 'ACTIVE' };
  world.hiddenFromSearch = ['abababab-abab-4bab-8bab-abababababab'];
  const out = await (await call()).json();
  assert.equal(out.code, 'CONTACT_NAME_TAKEN');
  assert.equal(contactCreatesSent().length, 1, 'the create was attempted and refused by Xero');
  assert.equal(world.contactCreates, 0, 'nothing was created');
  assert.equal(world.contact.xero_contact_id, null);
  assert.equal(invoiceCreatesOrUpdates().length, 0);
  assert.equal(world.invoice.status, 'failed', 'retryable once the name clash is resolved');
});

test('AUTO-CONTACT 23: an email longer than 50 characters is searched with its first 50, and only an EXACT full email counts as a match', async () => {
  const longEmail = 'accounts.payable.department.for.new.client@newclient-property-management.test';
  assert.ok(longEmail.length > 50);
  Object.assign(world.contact, { email: longEmail, xero_contact_id: null, xero_org_id: null });
  world.xeroContacts[OTHER_CONTACT] = { ContactID: OTHER_CONTACT, Name: 'NewClient AP', EmailAddress: longEmail.toUpperCase(), ContactStatus: 'ACTIVE' };
  world.xeroContacts['abababab-abab-4bab-8bab-abababababab'] = { ContactID: 'abababab-abab-4bab-8bab-abababababab', Name: 'Prefix twin', EmailAddress: longEmail.slice(0, 50) + '.other', ContactStatus: 'ACTIVE' };
  const out = await (await call()).json();
  assert.equal(out.recipientSource, 'auto_linked');
  assert.equal(world.contact.xero_contact_id, OTHER_CONTACT, 'the exact email match, not the prefix twin');
  assert.ok(contactSearches().every((r) => (new URLSearchParams(r.search).get('searchTerm') ?? '').length <= 50));
  assert.equal(contactCreatesSent().length, 0);
});

test('AUTO-CONTACT 24: the Xero client itself refuses to send a search term over 50 characters (no request is made)', async () => {
  await assert.rejects(xeroClient.searchContacts(ACCESS_TOKEN, 'x'.repeat(51)), /at most 50 characters/);
  assert.equal(contactSearches().length, 0);
  assert.equal(xeroClient.boundedSearchTerm('  a   b  '), 'a b');
  assert.equal(xeroClient.boundedSearchTerm('y'.repeat(60)).length, 50);
});

test('AUTO-CONTACT 17: the building DEFAULT path is unchanged - no default and no chosen contact is still refused, never auto-created', async () => {
  unlinked();
  const out = await (await call({ invoiceId: 'inv-1' })).json();
  assert.equal(out.code, 'NO_RECIPIENT');
  assert.equal(contactSearches().length + contactCreatesSent().length, 0);
});

test('AUTO-CONTACT 18: a retry of an invoice Xero already holds never creates or links a contact (the recipient is locked)', async () => {
  unlinked();
  world.invoice.status = 'failed';
  world.invoice.xero_invoice_id = XERO_INVOICE;
  world.invoice.xero_contact_id = CONTACT;
  world.invoice.xero_org_id = ORG;
  world.xeroInvoices[XERO_INVOICE] = { InvoiceID: XERO_INVOICE, InvoiceNumber: 'INV-001', Contact: { ContactID: CONTACT } };
  const out = await (await call({ invoiceId: 'inv-1', contactId: 'ct-1' })).json();
  assert.ok(['RECIPIENT_LOCKED', 'LINK_UNTAGGED'].includes(out.code), out.code);
  assert.equal(contactSearches().length + contactCreatesSent().length, 0);
});

// ---- creation allowed, emailing NOT allowed (XERO_CREATION_ENABLED on, XERO_SENDING_ENABLED absent) ---------------------------------
function creationOnly() {
  delete ENV.XERO_SENDING_ENABLED;
  ENV.XERO_CREATION_ENABLED = 'true';
}

test('EMAIL-OFF 1: with creation on and emailing absent, the invoice is CREATED in Xero, NOT emailed, and recorded as in_xero_not_emailed', async () => {
  creationOnly();
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(out, { status: 'in_xero_not_emailed', emailed: false, code: 'EMAIL_DISABLED', xeroInvoiceId: XERO_INVOICE, xeroInvoiceNumber: 'INV-001', recipientSource: 'selected' });
  assert.equal(world.invoiceCounter, 1, 'created');
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Status, 'AUTHORISED');
  assert.equal(emailCalls().length, 0, 'no email request of any kind');
  assert.equal(world.invoice.status, 'in_xero_not_emailed');
  assert.equal(world.invoice.sent_at ?? null, null, 'never stamped as sent');
  assert.equal(world.invoice.xero_invoice_id, XERO_INVOICE);
  assert.equal(world.invoice.xero_contact_id, CONTACT);
  assert.equal(world.invoice.xero_org_id, ORG);
});

test('EMAIL-OFF 2: an UNLINKED recipient is linked or created automatically with emailing off - and nothing is emailed', async () => {
  creationOnly();
  Object.assign(world.contact, { xero_contact_id: null, xero_org_id: null });
  const out = await (await call()).json();
  assert.equal(out.status, 'in_xero_not_emailed');
  assert.equal(out.recipientSource, 'auto_created');
  assert.equal(world.contactCreates, 1);
  assert.match(world.contact.xero_contact_id, /^c1000000-/);
  assert.equal(invoiceCreatesOrUpdates()[0].body.Invoices[0].Contact.ContactID, world.contact.xero_contact_id);
  assert.equal(emailCalls().length, 0);
});

test('EMAIL-OFF 3: XERO_SENDING_ENABLED alone still creates AND emails (environments that already send keep working)', async () => {
  delete ENV.XERO_CREATION_ENABLED;
  ENV.XERO_SENDING_ENABLED = 'true';
  const out = await (await call()).json();
  assert.equal(out.status, 'sent');
  assert.equal(emailCalls().length, 1);
});

test('EMAIL-OFF 4: every other safeguard still applies with emailing off: organisation, recipient links, relationships, building defaults', async () => {
  creationOnly();
  world.orgBody = { Organisations: [{ OrganisationID: OTHER_ORG }] };
  assert.equal((await (await call()).json()).code, 'ORG_MISMATCH');
  reset(); creationOnly();
  delete ENV.XERO_EXPECTED_ORG_ID;
  assert.equal((await (await call()).json()).code, 'ORG_NOT_CONFIGURED');
  reset(); creationOnly();
  world.contact.xero_org_id = null;
  assert.equal((await (await call()).json()).code, 'LINK_UNTAGGED');
  reset(); creationOnly();
  world.xeroContacts[CONTACT].ContactStatus = 'ARCHIVED';
  assert.equal((await (await call()).json()).code, 'CONTACT_NOT_ACTIVE');
  reset(); creationOnly();
  setLines(lineFor(1), lineFor(2, { visits: visitFor('visit-2', 'job-2') }));
  assert.equal((await call()).status, 422);
  reset(); creationOnly();
  assert.equal((await (await call({ invoiceId: 'inv-1' })).json()).code, 'NO_RECIPIENT');
  assert.equal(world.invoiceCounter, 0, 'none of them created anything');
  assert.equal(world.contactCreates, 0);
  assert.equal(emailCalls().length, 0);
});

test('EMAIL-OFF 5: the building DEFAULT recipient works with emailing off', async () => {
  creationOnly();
  Object.assign(world.building, { default_invoice_contact_id: 'ct-1', default_invoice_xero_contact_id: CONTACT, default_invoice_xero_org_id: ORG });
  const out = await (await call({ invoiceId: 'inv-1' })).json();
  assert.equal(out.status, 'in_xero_not_emailed');
  assert.equal(out.recipientSource, 'building_default');
  assert.equal(emailCalls().length, 0);
});

test('EMAIL-OFF 6: a RETRY of an invoice whose email failed earlier updates the SAME Xero invoice and, with emailing now off, does not email', async () => {
  world.emailStatus = 500; // emailing was on, and the email failed
  await call();
  assert.equal(world.invoice.status, 'failed');
  const emailsBefore = emailCalls().length;
  creationOnly();
  const out = await (await call()).json();
  assert.equal(out.status, 'in_xero_not_emailed');
  assert.equal(world.invoiceCounter, 1, 'no duplicate invoice');
  assert.equal(invoiceCreatesOrUpdates().at(-1)!.path, `/api.xro/2.0/Invoices/${XERO_INVOICE}`);
  assert.equal(emailCalls().length, emailsBefore, 'no further email attempt');
});

test('EMAIL-OFF 7: turning emailing ON later never emails an invoice created while it was off (it is not claimable again)', async () => {
  creationOnly();
  await call();
  assert.equal(world.invoice.status, 'in_xero_not_emailed');
  ENV.XERO_SENDING_ENABLED = 'true';
  const res = await call();
  assert.equal(res.status, 409);
  assert.equal(emailCalls().length, 0);
  assert.equal(world.invoice.status, 'in_xero_not_emailed');
  assert.equal(world.invoiceCounter, 1);
});

test('EMAIL-OFF 8: CONCURRENT sends with emailing off create ONE invoice and email nothing', async () => {
  creationOnly();
  const results = await Promise.all([call(), call(), call()]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(world.invoiceCounter, 1);
  assert.equal(emailCalls().length, 0);
});

test('EMAIL-OFF 9: with BOTH switches absent (production today) nothing at all happens: no token, no contact, no invoice, no email', async () => {
  delete ENV.XERO_SENDING_ENABLED;
  delete ENV.XERO_CREATION_ENABLED;
  Object.assign(world.contact, { xero_contact_id: null, xero_org_id: null });
  const out = await (await call()).json();
  assert.equal(out.code, 'CREATION_DISABLED');
  assert.equal(world.xeroLog.length, 0);
  assert.equal(world.invoice.status, 'draft');
  assert.equal(world.contact.xero_contact_id, null);
});

test('EMAIL-OFF 10: the email permission is read right before the email step - the only email call is guarded by it', () => {
  const code = readFileSync(join(process.cwd(), 'supabase', 'functions', 'xero-create-invoice', 'index.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const guard = code.indexOf('if (!isSendingEnabled()) {');
  const email = code.indexOf('await emailInvoiceOrExplain(');
  const created = code.indexOf('await createOrUpdateAuthorisedInvoice(');
  assert.ok(created > 0 && created < guard && guard < email, 'create -> email permission check -> email');
  assert.equal(code.split('emailInvoiceOrExplain(').length - 1, 2, 'one definition and exactly one call');
});

// ---- one Xero invoice per local invoice (the DEV INV-0015 incident) --------------------------------------------------------------------
/** A second, different local invoice with exactly the same content as the first (same recipient, no reference, same due date, same lines). */
function secondIdenticalInvoice(id = 'inv-2') {
  world.otherInvoices.push({ id: world.invoice.id, xero_invoice_id: world.invoice.xero_invoice_id });
  world.invoice = { ...freshInvoice(), id };
}

test('IDEMPOTENCY 1 (DEV regression): two DIFFERENT invoices with identical recipient, reference, due date and lines create TWO Xero invoices', async () => {
  creationOnly();
  const first = await (await call()).json();
  assert.equal(first.xeroInvoiceNumber, 'INV-001');
  secondIdenticalInvoice();
  const second = await (await call({ invoiceId: 'inv-2', contactId: 'ct-1' })).json();
  assert.equal(second.status, 'in_xero_not_emailed');
  assert.equal(second.xeroInvoiceNumber, 'INV-002', 'a NEW Xero invoice, not the first one replayed');
  assert.notEqual(second.xeroInvoiceId, first.xeroInvoiceId);
  assert.equal(world.invoiceCounter, 2);
  const keys = invoiceCreatesOrUpdates().map((r) => r.headers.get('idempotency-key'));
  assert.equal(new Set(keys).size, 2, 'different local invoices never share a key');
});

test('IDEMPOTENCY 2: retries of the SAME local invoice still reuse the same key (a lost response is answered with the same invoice)', async () => {
  world.emailStatus = 500;
  await call();
  const key1 = invoiceCreatesOrUpdates()[0].headers.get('idempotency-key');
  // The local record of the create is lost (as after a timeout), so the retry posts the create again.
  Object.assign(world.invoice, { status: 'failed', xero_invoice_id: null, xero_invoice_number: null });
  world.emailStatus = 200;
  const out = await (await call()).json();
  const key2 = invoiceCreatesOrUpdates()[1].headers.get('idempotency-key');
  assert.equal(key2, key1, 'same local invoice and content: same key');
  assert.equal(out.xeroInvoiceNumber, 'INV-001', 'Xero replayed the original: no duplicate');
  assert.equal(world.invoiceCounter, 1);
});

test('IDEMPOTENCY 3: a Xero invoice already recorded on ANOTHER local invoice is refused - nothing saved, nothing emailed, the other invoice untouched', async () => {
  world.otherInvoices = [{ id: 'inv-other', xero_invoice_id: XERO_INVOICE }];
  world.forceCreateResponse = { InvoiceID: XERO_INVOICE, InvoiceNumber: 'INV-0015', Contact: { ContactID: CONTACT } };
  const res = await call();
  const out = await res.json();
  assert.equal(res.status, 502);
  assert.equal(out.code, 'XERO_INVOICE_ALREADY_RECORDED');
  assert.match(out.error, /Xero answered with invoice INV-0015, which is already recorded on another invoice in the app\. Nothing was saved or emailed\./);
  assert.equal(emailCalls().length, 0, 'not emailed');
  assert.equal(world.invoice.xero_invoice_id, null, 'the other invoice\'s Xero id was not saved here');
  assert.equal(world.invoice.xero_invoice_number, null);
  assert.equal(world.invoice.status, 'failed', 'left retryable, with the reason');
  assert.match(world.invoice.last_error, /already recorded on another invoice/);
  assert.deepEqual(world.otherInvoices, [{ id: 'inv-other', xero_invoice_id: XERO_INVOICE }]);
});

test('IDEMPOTENCY 4: if that check cannot be made (database error) the response is refused too - fail safe, nothing emailed', async () => {
  world.otherInvoicesQueryFails = true;
  const out = await (await call()).json();
  assert.equal(out.code, 'XERO_INVOICE_ALREADY_RECORDED');
  assert.match(out.error, /could not check whether another invoice already has it/);
  assert.equal(emailCalls().length, 0);
  assert.equal(world.invoice.xero_invoice_id, null);
});

test('IDEMPOTENCY 5: an UPDATE that comes back with a DIFFERENT Xero invoice than the one this invoice has is refused', async () => {
  world.invoice.status = 'failed';
  world.invoice.xero_invoice_id = XERO_INVOICE;
  world.invoice.xero_invoice_number = 'INV-001';
  world.invoice.xero_contact_id = CONTACT;
  world.invoice.xero_org_id = ORG;
  world.xeroInvoices[XERO_INVOICE] = { InvoiceID: XERO_INVOICE, InvoiceNumber: 'INV-001', Contact: { ContactID: CONTACT } };
  // Xero answers the update with a different invoice.
  const other = 'eeeeeeee-0000-4000-8000-000000000099';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'api.xero.com' && (init?.method ?? 'GET') === 'POST' && url.pathname.endsWith(`/Invoices/${XERO_INVOICE}`)) {
      world.xeroLog.push({ method: 'POST', host: url.host, path: decodeURIComponent(url.pathname), search: url.search, body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return json(200, { Invoices: [{ InvoiceID: other, InvoiceNumber: 'INV-099', Contact: { ContactID: CONTACT } }] });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const out = await (await call()).json();
    assert.equal(out.code, 'XERO_INVOICE_ALREADY_RECORDED');
    assert.match(out.error, /not the Xero invoice this invoice already has/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(world.invoice.xero_invoice_id, XERO_INVOICE, 'its own Xero invoice is kept');
  assert.equal(emailCalls().length, 0);
});

test('IDEMPOTENCY 6: the key is scoped to the local invoice id in the Xero client itself', async () => {
  const base = { contactId: CONTACT, reference: null, dueDate: '2026-11-17', lineItems: [{ Description: 'Clean', Quantity: 1, UnitAmount: 700, AccountCode: '200', TaxType: 'OUTPUT2' }] };
  const a1 = await xeroClient.computeInvoiceIdempotencyKey({ ...base, localInvoiceId: 'inv-a' });
  const a2 = await xeroClient.computeInvoiceIdempotencyKey({ ...base, localInvoiceId: 'inv-a' });
  const b = await xeroClient.computeInvoiceIdempotencyKey({ ...base, localInvoiceId: 'inv-b' });
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

// ---- source guards: DEV stays on its own organisation, and contact creation cannot creep back in -------------------------------
function functionSources(): Array<{ file: string; text: string }> {
  const root = join(process.cwd(), 'supabase', 'functions');
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push({ file: full.replace(root, ''), text: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out;
}

test('Edge Function sources: contacts are created only by the automatic-contact module, never updated, never looked up by name', () => {
  for (const { file, text } of functionSources()) {
    const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /findContactByName/, file);
    if (/createContact\b/.test(code)) assert.match(file, /_shared[\\/](xeroClient|autoXeroContact)\.ts$/, `${file} must not create Xero contacts`);
    // The read-only search: the manager-only link function, and the automatic-contact module (by email, then exact name).
    if (/searchContacts/.test(code)) assert.match(file, /(_shared[\\/](xeroClient|autoXeroContact)\.ts|xero-link-contact[\\/]index\.ts)$/, `${file} must not use the contact search`);
    // The one POST to /Contacts is the create in xeroClient.ts; nothing ever posts to /Contacts/{id} (an update).
    if (/xeroPost\s*(<[^>]*>)?\s*\([^)]*\/Contacts/.test(code)) assert.match(file, /_shared[\\/]xeroClient\.ts$/, `${file} must not POST to /Contacts`);
    assert.doesNotMatch(code, /\/Contacts\/\$\{[^}]*\}['"`]\s*,\s*\{/, `${file} must not update a contact`);
    assert.doesNotMatch(code, /where=Name|where\s*=\s*`?Name==/, `${file} must not search contacts by name`);
    // The only read of the whole /Contacts collection is xero-test's diagnostic count (it returns a number, never contact data).
    if (/['"`]\/Contacts['"`?]/.test(code)) assert.match(file, /(xero-test[\\/]index\.ts|_shared[\\/]xeroClient\.ts)$/, `${file} uses the /Contacts collection directly`);
  }
});

test('no credential or organisation id is hardcoded: the Xero secret, client id and organisation id come only from the environment', () => {
  for (const { file, text } of functionSources()) {
    const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${file} contains a GUID literal`);
  }
  const client = functionSources().find((s) => s.file.endsWith('xeroClient.ts'))!.text;
  assert.match(client, /Deno\.env\.get\('XERO_CLIENT_ID'\)/);
  assert.match(client, /Deno\.env\.get\('XERO_CLIENT_SECRET'\)/);
  const safeguards = functionSources().find((s) => s.file.endsWith('xeroSafeguards.ts'))!.text;
  assert.match(safeguards, /Deno\.env\.get\('XERO_EXPECTED_ORG_ID'\)/);
  assert.match(safeguards, /Deno\.env\.get\('XERO_SENDING_ENABLED'\) === 'true'/);
});

test('the token request only ever goes to Xero\'s identity server with the environment\'s own credentials', async () => {
  await call();
  const tokenRequests = world.xeroLog.filter((r) => r.host === 'identity.xero.com');
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].path, '/connect/token');
  assert.equal(world.unexpected.filter((u) => /token/.test(u)).length, 0, 'the credentials presented were exactly the configured ones');
});
