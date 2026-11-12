// Tests for the local, read-only Xero contact export (tools/xero-contact-export).
//
// Xero is a fake: the tool is handed a fake `fetch` that answers the identity server and the Accounting API, so NO
// real request is possible. Every request is recorded, and any request the fake does not recognise (or any method
// other than the one token POST) is a failure. What is proved:
//   - an organisation mismatch stops everything BEFORE any contact is requested
//   - paging is complete (including archived records, short pages and exact multiples), and any inconsistency aborts
//   - no mutation endpoint is ever called, and the tool's source has no way to make one
//   - rate limits are respected, unexpected responses abort safely, and no partial file is ever left behind
//   - the output stays outside git repositories, is never overwritten, and nothing sensitive is logged
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs, readCredentials } from '../tools/xero-contact-export/cliArgs';
import { runCli } from '../tools/xero-contact-export/cliMain';
import {
  DEFAULT_TUNING,
  ExportError,
  exportContacts,
  findSyncOrNetworkWarning,
  inspectOrganisation,
  makeSafeLog,
  mapContact,
  realFs,
  summariseDetail,
  writeNewFile,
  type FsOps,
  type Credentials,
  type Deps,
  type Tuning,
} from '../tools/xero-contact-export/exportContacts';

// ---- fictional ids and secrets ---------------------------------------------------------------------------------------------
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CREDS: Credentials = { clientId: 'fictional-client-id-123', clientSecret: 'fictional-client-secret-NEVER-LEAK' };
const ACCESS_TOKEN = 'fictional-access-token-NEVER-LEAK';
const cid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

function rawContact(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ContactID: cid(i),
    ContactStatus: 'ACTIVE',
    Name: `Fictional Contact ${i} Ltd`,
    FirstName: 'Fiona',
    LastName: 'Fictional',
    EmailAddress: `fictional.${i}@example.test`,
    AccountNumber: `AC${i}`,
    IsCustomer: true,
    IsSupplier: false,
    UpdatedDateUTC: '/Date(1700000000000+0000)/',
    Addresses: [
      { AddressType: 'POBOX', AddressLine1: `${i} Test Street`, AddressLine2: 'Floor 2', City: 'Testville', Region: 'Testshire', PostalCode: 'TS1 1AA', Country: 'GB', AttentionTo: 'Accounts' },
      { AddressType: 'STREET', AddressLine1: `${i} Other Road`, City: 'Elsewhere', PostalCode: 'EL2 2BB' },
    ],
    ContactPersons: [{ FirstName: 'Pat', LastName: 'Person', EmailAddress: `pat.${i}@example.test`, IncludeInEmails: true }],
    BankAccountDetails: 'SHOULD-NOT-BE-EXPORTED-BANK',
    TaxNumber: 'SHOULD-NOT-BE-EXPORTED-TAX',
    ...over,
  };
}
const contacts = (n: number, from = 1) => Array.from({ length: n }, (_, k) => rawContact(from + k));

// ---- the fake Xero --------------------------------------------------------------------------------------------------------------
interface Rec { method: string; host: string; path: string; query: URLSearchParams; headers: Headers; body: unknown }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fake = {
  orgBody: null as unknown,
  orgStatus: 200,
  tokenStatus: 200,
  scope: 'accounting.settings.read accounting.contacts.read',
  all: [] as Array<Record<string, unknown>>,
  /** The most contacts the fake returns on one page, whatever pageSize asked for. */
  pageCap: null as number | null,
  hook: null as null | ((rec: Rec, apiCall: number) => Response | undefined),
  log: [] as Rec[],
  unexpected: [] as string[],
  apiCalls: 0,
};
function resetFake() {
  fake.orgBody = null;
  fake.orgStatus = 200;
  fake.tokenStatus = 200;
  fake.scope = 'accounting.settings.read accounting.contacts.read';
  fake.all = [];
  fake.pageCap = null;
  fake.hook = null;
  fake.log = [];
  fake.unexpected = [];
  fake.apiCalls = 0;
}

const fakeFetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const rec: Rec = { method: (init?.method ?? 'GET').toUpperCase(), host: url.host, path: url.pathname, query: url.searchParams, headers: new Headers(init?.headers), body: init?.body };
  fake.log.push(rec);

  if (rec.host === 'identity.xero.com') {
    if (rec.method !== 'POST' || rec.path !== '/connect/token') fake.unexpected.push(`${rec.method} ${rec.host}${rec.path}`);
    if (fake.tokenStatus !== 200) return json(fake.tokenStatus, { error: 'invalid_client' });
    return json(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 1800, scope: fake.scope });
  }
  if (rec.host !== 'api.xero.com') {
    fake.unexpected.push(`unknown host ${rec.host}`);
    return json(500, {});
  }

  fake.apiCalls += 1;
  if (rec.method !== 'GET') fake.unexpected.push(`${rec.method} ${rec.path}`);
  if (rec.headers.get('authorization') !== `Bearer ${ACCESS_TOKEN}`) fake.unexpected.push('request without the access token');
  const hooked = fake.hook?.(rec, fake.apiCalls);
  if (hooked) return hooked;

  if (rec.path === '/api.xro/2.0/Organisation') {
    if (fake.orgStatus !== 200) return json(fake.orgStatus, { Message: 'org failed' });
    return json(200, fake.orgBody ?? { Organisations: [{ OrganisationID: ORG, Name: 'Fictional Test Org', IsDemoCompany: false, OrganisationType: 'COMPANY', CountryCode: 'GB', OrganisationStatus: 'ACTIVE' }] });
  }
  if (rec.path === '/api.xro/2.0/Contacts') {
    const page = Number(rec.query.get('page') ?? '1');
    const size = Math.min(Number(rec.query.get('pageSize') ?? '100'), fake.pageCap ?? 1000);
    // Xero leaves archived contacts out unless asked for them.
    const visible = fake.all.filter((c) => rec.query.get('includeArchived') === 'true' || c.ContactStatus !== 'ARCHIVED');
    return json(200, { Contacts: visible.slice((page - 1) * size, page * size) });
  }
  fake.unexpected.push(`${rec.method} ${rec.path}`);
  return json(500, { Message: 'unexpected Xero request' });
}) as typeof fetch;

// ---- harness ------------------------------------------------------------------------------------------------------------------------
let dir = '';
let sleeps: number[] = [];
let logs: string[] = [];

function deps(): Deps {
  return { fetch: fakeFetch, sleep: async (ms) => { sleeps.push(ms); }, log: (line) => { logs.push(line); } };
}
beforeEach(() => {
  resetFake();
  dir = mkdtempSync(join(tmpdir(), 'kc-xero-export-test-'));
  sleeps = [];
  logs = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const outFile = () => join(dir, 'contacts.json');
function run(over: { confirm?: string; out?: string; tuning?: Partial<Tuning>; creds?: Credentials } = {}) {
  return exportContacts(
    { creds: over.creds ?? CREDS, confirmOrgId: over.confirm ?? ORG, outPath: over.out ?? outFile(), tuning: { ...DEFAULT_TUNING, ...(over.tuning ?? {}) } },
    deps(),
  );
}
const read = (p = outFile()) => JSON.parse(readFileSync(p, 'utf8'));
const contactCalls = () => fake.log.filter((r) => r.path === '/api.xro/2.0/Contacts');
const nothingWritten = () => assert.deepEqual(readdirSync(dir), [], 'no export, checksum or temporary file was left behind');
const failsWith = (code: string) => (e: any) => e instanceof ExportError && e.code === code;

// ---- organisation verification ------------------------------------------------------------------------------------------------------
test('an organisation MISMATCH stops everything: no contact is requested and nothing is written', async () => {
  fake.all = contacts(5);
  await assert.rejects(() => run({ confirm: OTHER_ORG }), failsWith('ORG_MISMATCH'));
  assert.equal(contactCalls().length, 0, 'not one contact request');
  assert.deepEqual(fake.log.map((r) => `${r.method} ${r.host}${r.path}`), ['POST identity.xero.com/connect/token', 'GET api.xero.com/api.xro/2.0/Organisation']);
  nothingWritten();
});

test('the mismatch message does not repeat either organisation id', async () => {
  fake.all = contacts(1);
  try {
    await run({ confirm: OTHER_ORG });
    assert.ok(false, 'should have refused');
  } catch (e: any) {
    assert.doesNotMatch(String(e.message), new RegExp(`${ORG}|${OTHER_ORG}`));
    assert.match(String(e.message), /No contacts were requested/);
  }
});

test('the confirmed id is compared ignoring case and surrounding spaces', async () => {
  fake.all = contacts(2);
  const summary = await run({ confirm: `  ${ORG.toUpperCase()}  ` });
  assert.equal(summary.contactCount, 2);
});

test('a malformed confirmed id is refused before ANY request', async () => {
  for (const bad of ['', 'not-an-id', ORG.slice(0, -1), `${ORG} ${ORG}`]) {
    await assert.rejects(() => run({ confirm: bad }), failsWith('BAD_ARGUMENT'));
  }
  assert.equal(fake.log.length, 0);
});

test('INSPECT mode reports the connected organisation and granted scopes, and requests no contacts', async () => {
  fake.all = contacts(3);
  const org = await inspectOrganisation(CREDS, deps());
  assert.equal(org.organisationId, ORG);
  assert.equal(org.name, 'Fictional Test Org');
  assert.equal(org.isDemoCompany, false);
  assert.equal(org.organisationStatus, 'ACTIVE');
  assert.equal(org.grantedScopes, 'accounting.settings.read accounting.contacts.read');
  assert.equal(contactCalls().length, 0);
  nothingWritten();
});

// ---- paging ------------------------------------------------------------------------------------------------------------------------------
test('PAGING is complete: 250 contacts at 100 per page are four requests (the last is empty) and all 250 are kept, in order', async () => {
  fake.all = contacts(250);
  const summary = await run();
  assert.deepEqual(contactCalls().map((r) => r.query.get('page')), ['1', '2', '3', '4']);
  assert.equal(summary.contactCount, 250);
  assert.equal(summary.pages, 3);
  const doc = read();
  assert.equal(doc.contacts.length, 250);
  assert.deepEqual(doc.contacts.map((c: any) => c.contactId), fake.all.map((c) => c.ContactID));
  assert.equal(doc.meta.contactCount, 250);
});

test('an EXACT multiple of the page size does not lose or invent anything (the empty page ends it)', async () => {
  fake.all = contacts(200);
  assert.equal((await run()).contactCount, 200);
  assert.deepEqual(contactCalls().map((r) => r.query.get('page')), ['1', '2', '3']);
});

test('zero contacts is a valid, complete export of nothing', async () => {
  const summary = await run();
  assert.equal(summary.contactCount, 0);
  assert.equal(contactCalls().length, 1);
  assert.deepEqual(read().contacts, []);
});

test('a server that returns FEWER rows than asked for cannot truncate the export (paging stops only on an empty page)', async () => {
  fake.all = contacts(130);
  fake.pageCap = 40; // asked for 100, gets 40
  const summary = await run();
  assert.equal(summary.contactCount, 130);
  assert.deepEqual(contactCalls().map((r) => r.query.get('page')), ['1', '2', '3', '4', '5']);
});

test('every contact request asks for ARCHIVED contacts too, with the chosen page size', async () => {
  fake.all = contacts(3);
  await run({ tuning: { pageSize: 250 } });
  for (const r of contactCalls()) {
    assert.equal(r.query.get('includeArchived'), 'true');
    assert.equal(r.query.get('pageSize'), '250');
  }
});

test('ARCHIVED (and erased) records are RETAINED, with their status', async () => {
  fake.all = [rawContact(1), rawContact(2, { ContactStatus: 'ARCHIVED' }), rawContact(3, { ContactStatus: 'GDPRREQUEST' }), rawContact(4, { ContactStatus: 'ARCHIVED' })];
  const summary = await run();
  assert.equal(summary.contactCount, 4);
  assert.equal(summary.archivedCount, 2);
  assert.deepEqual(read().contacts.map((c: any) => c.status), ['ACTIVE', 'ARCHIVED', 'GDPRREQUEST', 'ARCHIVED']);
  assert.equal(read().meta.archivedCount, 2);
});

test('a ContactID seen on two pages (contacts changed mid-export) aborts the whole export', async () => {
  fake.all = contacts(5);
  fake.hook = (rec) => (rec.path.endsWith('/Contacts') && rec.query.get('page') === '2' ? json(200, { Contacts: [rawContact(1)] }) : undefined);
  await assert.rejects(() => run({ tuning: { pageSize: 2 } }), failsWith('DATA_CHANGED_DURING_EXPORT'));
  nothingWritten();
});

test('more pages than the limit aborts instead of looping', async () => {
  fake.all = contacts(10);
  await assert.rejects(() => run({ tuning: { pageSize: 1, maxPages: 3 } }), failsWith('TOO_MANY_PAGES'));
  nothingWritten();
});

// ---- what is kept ------------------------------------------------------------------------------------------------------------------------
test('ContactIDs, status, names, emails, addresses and contact-person email flags are preserved', async () => {
  fake.all = [rawContact(7, { ContactPersons: [
    { FirstName: 'A', LastName: 'Yes', EmailAddress: 'a@example.test', IncludeInEmails: true },
    { FirstName: 'B', LastName: 'No', EmailAddress: 'b@example.test', IncludeInEmails: false },
    { FirstName: 'C', LastName: 'Unset', EmailAddress: 'c@example.test' },
  ] })];
  await run();
  const c = read().contacts[0];
  assert.equal(c.contactId, cid(7));
  assert.equal(c.status, 'ACTIVE');
  assert.equal(c.name, 'Fictional Contact 7 Ltd');
  assert.equal(c.emailAddress, 'fictional.7@example.test');
  assert.equal(c.accountNumber, 'AC7');
  assert.equal(c.addresses.length, 2);
  assert.deepEqual(c.addresses[0], { type: 'POBOX', attentionTo: 'Accounts', line1: '7 Test Street', line2: 'Floor 2', line3: null, line4: null, city: 'Testville', region: 'Testshire', postalCode: 'TS1 1AA', country: 'GB' });
  assert.deepEqual(c.contactPersons.map((p: any) => p.includeInEmails), [true, false, null]);
});

test('only an allow-list of fields is exported: bank and tax details Xero returns are dropped', async () => {
  fake.all = contacts(2);
  await run();
  const text = readFileSync(outFile(), 'utf8');
  assert.doesNotMatch(text, /SHOULD-NOT-BE-EXPORTED/);
  assert.doesNotMatch(text, /BankAccountDetails|TaxNumber/);
});

test('DUPLICATE names and SHARED emails are kept as separate records - nothing is merged or de-duplicated', async () => {
  fake.all = [
    rawContact(1, { Name: 'Twin Court Ltd', EmailAddress: 'accounts@shared.example.test' }),
    rawContact(2, { Name: 'Twin Court Ltd', EmailAddress: 'accounts@shared.example.test' }),
    rawContact(3, { Name: 'twin court ltd', EmailAddress: 'ACCOUNTS@shared.example.test', ContactStatus: 'ARCHIVED' }),
  ];
  await run();
  const out = read().contacts;
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c: any) => c.contactId), [cid(1), cid(2), cid(3)]);
  assert.equal(new Set(out.map((c: any) => c.contactId)).size, 3);
});

test('a contact with missing optional fields is exported with nulls, not invented values', () => {
  const c = mapContact({ ContactID: cid(9) });
  assert.deepEqual(c, { contactId: cid(9), name: null, status: null, firstName: null, lastName: null, emailAddress: null, accountNumber: null, isCustomer: null, isSupplier: null, updatedDateUtc: null, mergedToContactId: null, addresses: [], contactPersons: [] });
});

// ---- read-only ----------------------------------------------------------------------------------------------------------------------------
test('NO mutation endpoint is ever called: the only non-GET request is the single token POST', async () => {
  fake.all = [...contacts(120), rawContact(500, { ContactStatus: 'ARCHIVED' })];
  await run();
  const nonGet = fake.log.filter((r) => r.method !== 'GET');
  assert.deepEqual(nonGet.map((r) => `${r.method} ${r.host}${r.path}`), ['POST identity.xero.com/connect/token']);
  assert.deepEqual(fake.log.filter((r) => r.host === 'api.xero.com').map((r) => r.method), fake.log.filter((r) => r.host === 'api.xero.com').map(() => 'GET'));
  assert.deepEqual(fake.unexpected, []);
  assert.ok(fake.log.every((r) => !/Invoices|Payments|Email|Attachments/.test(r.path)), 'nothing but Organisation and Contacts');
});

test('the tool\'s source has no way to make a write: one POST (the token), and no PUT, PATCH or DELETE', () => {
  for (const file of ['exportContacts.ts', 'cliArgs.ts', 'cliMain.ts', 'cli.ts']) {
    const code = readFileSync(join(process.cwd(), 'tools', 'xero-contact-export', file), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /['"`](PUT|PATCH|DELETE)['"`]/, file);
    assert.doesNotMatch(code, /\/Invoices|\/Payments|\/Email|ContactGroups|\/Accounts|\/TaxRates/, `${file} reaches only Organisation and Contacts`);
    const posts = code.match(/method:\s*['"`]POST['"`]/g) ?? [];
    assert.equal(posts.length, file === 'exportContacts.ts' ? 1 : 0, `${file} POST count`);
  }
});

test('the token request is exactly the app\'s pattern: Basic auth, client_credentials, NO scope parameter', async () => {
  await run();
  const token = fake.log.find((r) => r.host === 'identity.xero.com')!;
  assert.equal(token.headers.get('authorization'), `Basic ${btoa(`${CREDS.clientId}:${CREDS.clientSecret}`)}`);
  assert.equal(token.body, 'grant_type=client_credentials');
  assert.equal(token.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(read().meta.grantedScopes, 'accounting.settings.read accounting.contacts.read', 'what Xero says was granted is recorded');
});

// ---- rate limits ------------------------------------------------------------------------------------------------------------------------
test('requests are SPACED: a pause before every Accounting API request after the first', async () => {
  fake.all = contacts(250);
  await run();
  const apiRequests = fake.log.filter((r) => r.host === 'api.xero.com').length; // organisation + 4 pages
  assert.equal(apiRequests, 5);
  assert.deepEqual(sleeps, Array(apiRequests - 1).fill(DEFAULT_TUNING.minIntervalMs));
});

test('a 429 waits for Retry-After, then carries on and still produces a complete export', async () => {
  fake.all = contacts(150);
  let limited = false;
  fake.hook = (rec) => {
    if (rec.path.endsWith('/Contacts') && rec.query.get('page') === '2' && !limited) {
      limited = true;
      return json(429, { Message: 'slow down' }, { 'retry-after': '7' });
    }
    return undefined;
  };
  const summary = await run();
  assert.equal(summary.contactCount, 150);
  assert.ok(sleeps.includes(7000), `slept for Retry-After: ${sleeps.join(',')}`);
});

test('a 429 that never clears aborts after the retry limit, writing nothing', async () => {
  fake.all = contacts(150);
  fake.hook = (rec) => (rec.path.endsWith('/Contacts') && rec.query.get('page') === '2' ? json(429, {}, { 'retry-after': '1' }) : undefined);
  await assert.rejects(() => run({ tuning: { maxRetries: 3 } }), failsWith('RATE_LIMITED'));
  assert.equal(contactCalls().filter((r) => r.query.get('page') === '2').length, 4, 'one try plus three retries, then stop');
  nothingWritten();
});

test('a daily-limit 429, or a wait of hours, aborts at once instead of sleeping', async () => {
  fake.all = contacts(5);
  fake.hook = (rec) => (rec.path.endsWith('/Contacts') ? json(429, {}, { 'retry-after': '40000', 'x-rate-limit-problem': 'day' }) : undefined);
  await assert.rejects(() => run(), failsWith('RATE_LIMITED'));
  assert.ok(sleeps.every((ms) => ms < 10_000), 'never slept for hours');
  nothingWritten();
});

test('it stops, writing nothing, when the DAILY allowance is nearly used (invoicing shares it)', async () => {
  fake.all = contacts(5);
  fake.hook = (_rec, n) => (n === 1 ? json(200, { Organisations: [{ OrganisationID: ORG }] }, { 'x-daylimit-remaining': '50' }) : undefined);
  await assert.rejects(() => run(), failsWith('RATE_LIMITED'));
  assert.equal(contactCalls().length, 0);
  nothingWritten();
});

test('when the per-minute allowance is nearly used it waits a minute before the next request', async () => {
  fake.all = contacts(150);
  let first = true;
  fake.hook = (rec) => {
    if (rec.path.endsWith('/Contacts') && rec.query.get('page') === '1' && first) {
      first = false;
      return json(200, { Contacts: fake.all.slice(0, 100) }, { 'x-minlimit-remaining': '1' });
    }
    return undefined;
  };
  await run();
  assert.ok(sleeps.some((ms) => ms >= 60_000), `waited: ${sleeps.join(',')}`);
});

// ---- unexpected responses -----------------------------------------------------------------------------------------------------------------
test('a refused organisation lookup (401/403) aborts with the status, requests no contacts and writes nothing', async () => {
  for (const status of [401, 403]) {
    resetFake();
    fake.orgStatus = status;
    await assert.rejects(() => run(), (e: any) => e.code === 'ORG_LOOKUP_FAILED' && e.message.includes(`HTTP ${status}`));
    assert.equal(contactCalls().length, 0);
    nothingWritten();
  }
});

test('an organisation answer with no id cannot be verified: aborts before any contact request', async () => {
  for (const body of [{}, { Organisations: [] }, { Organisations: [{}] }, { Organisations: [{ OrganisationID: '  ' }] }]) {
    resetFake();
    fake.orgBody = body;
    await assert.rejects(() => run(), failsWith('ORG_LOOKUP_FAILED'));
    assert.equal(contactCalls().length, 0);
  }
  nothingWritten();
});

test('a token failure aborts before any Accounting API request', async () => {
  fake.tokenStatus = 401;
  await assert.rejects(() => run(), failsWith('AUTH_FAILED'));
  assert.equal(fake.log.filter((r) => r.host === 'api.xero.com').length, 0);
  nothingWritten();
});

test('a persistent 5xx is retried a bounded number of times, then aborts', async () => {
  fake.all = contacts(150);
  fake.hook = (rec) => (rec.path.endsWith('/Contacts') && rec.query.get('page') === '2' ? json(503, {}) : undefined);
  await assert.rejects(() => run(), failsWith('XERO_ERROR'));
  assert.equal(contactCalls().filter((r) => r.query.get('page') === '2').length, 4, 'one try plus three retries');
  nothingWritten();
});

test('a transient network failure is retried and the export still completes', async () => {
  fake.all = contacts(150);
  let failed = false;
  const flaky = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/Contacts') && url.searchParams.get('page') === '2' && !failed) {
      failed = true;
      throw new TypeError('network down');
    }
    return fakeFetch(input, init);
  }) as typeof fetch;
  const summary = await exportContacts({ creds: CREDS, confirmOrgId: ORG, outPath: outFile(), tuning: DEFAULT_TUNING }, { ...deps(), fetch: flaky });
  assert.equal(summary.contactCount, 150);
});

test('malformed answers abort, writing nothing: no contact list, a non-list, invalid JSON, a contact with no ContactID', async () => {
  const cases: Array<() => Response> = [
    () => json(200, {}),
    () => json(200, { Contacts: 'nope' }),
    () => new Response('<html>gateway</html>', { status: 200 }),
    () => json(200, { Contacts: [{ Name: 'No id' }] }),
  ];
  for (const make of cases) {
    resetFake();
    fake.all = contacts(5);
    fake.hook = (rec) => (rec.path.endsWith('/Contacts') ? make() : undefined);
    await assert.rejects(() => run(), failsWith('BAD_RESPONSE'));
    nothingWritten();
  }
});

test('an unexpected non-2xx on a contact page (for example 404 or 400) aborts', async () => {
  for (const status of [400, 404]) {
    resetFake();
    fake.hook = (rec) => (rec.path.endsWith('/Contacts') ? json(status, {}) : undefined);
    await assert.rejects(() => run(), failsWith('XERO_ERROR'));
    nothingWritten();
  }
});

test('a failure on a LATER page leaves no partial export even though earlier pages succeeded', async () => {
  fake.all = contacts(300);
  fake.hook = (rec) => (rec.path.endsWith('/Contacts') && rec.query.get('page') === '3' ? json(400, {}) : undefined);
  await assert.rejects(() => run(), failsWith('XERO_ERROR'));
  assert.ok(contactCalls().length >= 3);
  nothingWritten();
});

// ---- output safety --------------------------------------------------------------------------------------------------------------------------
test('an unsafe output path is refused BEFORE any request: relative, wrong extension, missing folder', async () => {
  for (const out of ['contacts.json', join(dir, 'contacts.txt'), join(dir, 'no-such-folder', 'contacts.json'), '']) {
    await assert.rejects(() => run({ out }), failsWith('UNSAFE_OUTPUT_PATH'));
  }
  assert.equal(fake.log.length, 0, 'not even a token request');
});

test('a path inside ANY git work tree is refused (before any request) - including this repository', async () => {
  const repo = join(dir, 'some-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'nested', 'deeper'), { recursive: true });
  for (const out of [join(repo, 'contacts.json'), join(repo, 'nested', 'deeper', 'contacts.json'), join(process.cwd(), 'xero-export-must-not-exist.json')]) {
    await assert.rejects(() => run({ out }), failsWith('UNSAFE_OUTPUT_PATH'));
  }
  assert.equal(fake.log.length, 0);
  assert.equal(existsSync(join(process.cwd(), 'xero-export-must-not-exist.json')), false);
});

test('an existing file is NEVER overwritten (and an existing checksum file blocks too), before any request', async () => {
  writeFileSync(outFile(), 'PRECIOUS');
  await assert.rejects(() => run(), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(readFileSync(outFile(), 'utf8'), 'PRECIOUS');
  assert.equal(fake.log.length, 0);

  const other = join(dir, 'other.json');
  writeFileSync(`${other}.sha256`, 'x');
  await assert.rejects(() => run({ out: other }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(existsSync(other), false);
});

test('a successful export writes the file plus a matching SHA-256 file, and leaves no temporary file', async () => {
  fake.all = contacts(30);
  const summary = await run();
  assert.deepEqual(readdirSync(dir).sort(), ['contacts.json', 'contacts.json.sha256']);
  const text = readFileSync(outFile(), 'utf8');
  const digest = createHash('sha256').update(text).digest('hex');
  assert.equal(summary.sha256, digest);
  assert.match(readFileSync(`${outFile()}.sha256`, 'utf8'), new RegExp(`^${digest}  contacts\\.json\\n$`));
  if (process.platform !== 'win32') assert.equal(statSync(outFile()).mode & 0o777, 0o600, 'readable by the owner only');
});

test('the export file never contains the credentials or the access token', async () => {
  fake.all = contacts(5);
  await run();
  const text = readFileSync(outFile(), 'utf8');
  assert.doesNotMatch(text, new RegExp(`${CREDS.clientSecret}|${CREDS.clientId}|${ACCESS_TOKEN}`));
});

// ---- nothing sensitive is logged -----------------------------------------------------------------------------------------------------------
test('NOTHING sensitive is logged: no token, credential, contact name or email address - on success or failure', async () => {
  fake.all = [...contacts(120), rawContact(900, { ContactStatus: 'ARCHIVED' })];
  await run();
  fake.orgStatus = 403;
  await assert.rejects(() => run({ out: join(dir, 'second.json') }));
  resetFake();
  fake.tokenStatus = 401;
  await assert.rejects(() => run({ out: join(dir, 'third.json') }));

  assert.ok(logs.length > 0, 'something was logged');
  const everything = logs.join('\n');
  assert.doesNotMatch(everything, /Fictional Contact|example\.test|@/, 'no contact name or email');
  assert.doesNotMatch(everything, new RegExp(`${CREDS.clientSecret}|${CREDS.clientId}|${ACCESS_TOKEN}`), 'no credential or token');
});

test('error messages carry no credential, token, contact name or email', async () => {
  fake.all = contacts(3);
  const messages: string[] = [];
  for (const setup of [() => { fake.tokenStatus = 400; }, () => { fake.orgStatus = 500; }, () => { fake.hook = () => json(200, { Contacts: [{ Name: 'Fictional Contact X', EmailAddress: 'x@example.test' }] }); }]) {
    resetFake();
    fake.all = contacts(3);
    setup();
    try {
      await run({ out: join(dir, `e${messages.length}.json`) });
    } catch (e: any) {
      messages.push(String(e.message));
    }
  }
  assert.equal(messages.length, 3);
  assert.doesNotMatch(messages.join('\n'), new RegExp(`${CREDS.clientSecret}|${CREDS.clientId}|${ACCESS_TOKEN}|Fictional Contact|example\\.test`));
});

// ---- MergedToContactID ------------------------------------------------------------------------------------------------------------------
test('MergedToContactID is preserved, so a merged-away contact can be traced to the one that survived', async () => {
  fake.all = [rawContact(1), rawContact(2, { ContactStatus: 'ARCHIVED', MergedToContactID: cid(1) }), rawContact(3, { MergedToContactID: '' })];
  await run();
  const out = read().contacts;
  assert.deepEqual(out.map((c: any) => c.mergedToContactId), [null, cid(1), '']);
  assert.equal(read().meta.detail.mergedAway, 1, 'an empty value is not counted as merged');
});

// ---- error wording ------------------------------------------------------------------------------------------------------------------------
test('a refused token request mentions that scope requirements may need verifying - without claiming that is the cause', async () => {
  fake.tokenStatus = 400;
  try {
    await run();
    assert.ok(false, 'should have failed');
  } catch (e: any) {
    assert.equal(e.code, 'AUTH_FAILED');
    assert.match(e.message, /HTTP 400/);
    assert.match(e.message, /scope requirements may also need verifying/);
    assert.match(e.message, /not necessarily the cause/);
    assert.doesNotMatch(e.message, /missing scope|is missing|definitely|usual cause/);
  }
});

test('a 401/403 on a request says the scopes may need verifying, not that one is definitely missing', async () => {
  fake.orgStatus = 403;
  try {
    await run();
    assert.ok(false, 'should have failed');
  } catch (e: any) {
    assert.match(e.message, /HTTP 403/);
    assert.match(e.message, /may lack authorisation/);
    assert.match(e.message, /scopes may need verifying/);
    assert.doesNotMatch(e.message, /missing|usual cause|definitely/);
  }
});

test('the token request itself is unchanged by the wording fix: still no scope parameter', async () => {
  await run();
  const token = fake.log.find((r) => r.host === 'identity.xero.com')!;
  assert.equal(token.body, 'grant_type=client_credentials');
});

// ---- unknown arguments are never echoed ---------------------------------------------------------------------------------------
test('an unknown argument is rejected WITHOUT repeating it (it could be a secret typed by mistake)', () => {
  for (const arg of [['TOPSECRETVALUE'], ['name=TOPSECRETVALUE'], ['--unknown=TOPSECRETVALUE'], ['--TOPSECRETVALUE'], ['-xTOPSECRETVALUE'], ['--inspect-organisation', 'TOPSECRETVALUE']]) {
    try {
      parseArgs(arg);
      assert.ok(false, `should have been rejected: ${arg.length}`);
    } catch (e: any) {
      assert.equal(e.code, 'BAD_ARGUMENT');
      assert.match(e.message, /Unknown or unexpected argument/);
      assert.doesNotMatch(e.message, /TOPSECRETVALUE/);
    }
  }
});

// ---- output path: symlinks, junctions, repositories -------------------------------------------------------------------------------
function canLink(type: 'junction' | 'file'): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'kc-link-probe-'));
  try {
    if (type === 'junction') {
      mkdirSync(join(probe, 'a'));
      symlinkSync(join(probe, 'a'), join(probe, 'b'), 'junction');
    } else {
      writeFileSync(join(probe, 'a'), 'x');
      symlinkSync(join(probe, 'a'), join(probe, 'b'), 'file');
    }
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const junctionsWork = canLink('junction');
const fileLinksWork = canLink('file');

test('a symlink or junction that RESOLVES into a git repository is refused, before any request', { skip: junctionsWork ? false : 'cannot create symlinks or junctions on this machine' }, async () => {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'private'));
  const link = join(dir, 'looks-innocent');
  symlinkSync(join(repo, 'private'), link, 'junction');
  await assert.rejects(() => run({ out: join(link, 'contacts.json') }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(fake.log.length, 0);
  assert.deepEqual(readdirSync(join(repo, 'private')), [], 'nothing was written into the repository');
});

test('a symlinked or junctioned folder that resolves to a SAFE place is allowed, and the file lands in the real folder', { skip: junctionsWork ? false : 'cannot create symlinks or junctions on this machine' }, async () => {
  const real = join(dir, 'real-private-folder');
  mkdirSync(real);
  const link = join(dir, 'shortcut');
  symlinkSync(real, link, 'junction');
  fake.all = contacts(2);
  await run({ out: join(link, 'contacts.json') });
  assert.deepEqual(readdirSync(real).sort(), ['contacts.json', 'contacts.json.sha256']);
});

test('a DANGLING symlink sitting at the output name counts as an existing file and is refused', { skip: fileLinksWork ? false : 'cannot create file symlinks on this machine' }, async () => {
  symlinkSync(join(dir, 'does-not-exist.json'), join(dir, 'dangling.json'), 'file');
  await assert.rejects(() => run({ out: join(dir, 'dangling.json') }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(fake.log.length, 0);
});

test('a BARE repository folder and a `.git` FILE (worktree or submodule) are recognised as repositories', async () => {
  const bare = join(dir, 'bare.git');
  mkdirSync(join(bare, 'objects'), { recursive: true });
  mkdirSync(join(bare, 'refs'));
  writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
  await assert.rejects(() => run({ out: join(bare, 'contacts.json') }), failsWith('UNSAFE_OUTPUT_PATH'));

  const worktree = join(dir, 'worktree');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), 'gitdir: ../elsewhere\n');
  await assert.rejects(() => run({ out: join(worktree, 'contacts.json') }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(fake.log.length, 0);
});

// ---- cloud-synced and shared folders ---------------------------------------------------------------------------------------------------
test('cloud-synced and network locations are recognised from the path (best effort)', () => {
  for (const flagged of [
    'C:\\Users\\x\\OneDrive\\Exports\\a.json',
    'C:\\Users\\x\\OneDrive - Fictional Ltd\\Documents\\a.json',
    '/home/x/Dropbox/a.json',
    'D:\\Google Drive\\a.json',
    '/Users/x/iCloud Drive/a.json',
    '\\\\fileserver\\share\\a.json',
    '//fileserver/share/a.json',
  ]) {
    assert.ok(findSyncOrNetworkWarning(flagged), flagged);
  }
  for (const fine of ['C:\\private\\kc\\a.json', '/home/x/private/a.json', '/home/x/boxing/a.json', 'C:\\Users\\x\\Synchronised\\a.json']) {
    assert.equal(findSyncOrNetworkWarning(fine), null, fine);
  }
});

test('exporting into a folder that looks cloud-synced WARNS (and still works: it is a warning, not a refusal)', async () => {
  const synced = join(dir, 'OneDrive');
  mkdirSync(synced);
  fake.all = contacts(3);
  const summary = await run({ out: join(synced, 'contacts.json') });
  assert.equal(summary.contactCount, 3);
  assert.ok(logs.some((l) => /^WARNING: .*cloud-synced folder.*Do not keep an export of real client contacts/.test(l)), logs.join('\n'));
});

test('a plain private folder gets no warning', async () => {
  fake.all = contacts(3);
  await run();
  assert.ok(logs.every((l) => !l.startsWith('WARNING')));
});

// ---- aggregate counts ----------------------------------------------------------------------------------------------------------------------
test('aggregate counts: contacts with a REAL address, email, contact persons, persons flagged for invoice emails, merged away', () => {
  const blank = { type: 'POBOX', attentionTo: null, line1: null, line2: null, line3: null, line4: null, city: null, region: null, postalCode: null, country: null };
  const withLine = { ...blank, line1: '1 Test Street' };
  const base = mapContact({ ContactID: cid(1) });
  const counts = summariseDetail([
    { ...base, contactId: cid(1), addresses: [blank, blank] },
    { ...base, contactId: cid(2), addresses: [blank, withLine], emailAddress: 'a@example.test' },
    { ...base, contactId: cid(3), emailAddress: '   ', contactPersons: [{ firstName: null, lastName: null, emailAddress: null, includeInEmails: true }, { firstName: null, lastName: null, emailAddress: null, includeInEmails: false }] },
    { ...base, contactId: cid(4), mergedToContactId: cid(2), contactPersons: [{ firstName: null, lastName: null, emailAddress: null, includeInEmails: null }] },
  ]);
  assert.deepEqual(counts, { withAddress: 1, withEmail: 1, withContactPersons: 2, contactPersonsIncludedInEmails: 1, mergedAway: 1 });
});

test('the export reports the aggregate counts (summary, file and log) without logging any individual contact', async () => {
  fake.all = [rawContact(1), rawContact(2, { Addresses: [{ AddressType: 'POBOX' }], ContactPersons: [] }), rawContact(3, { EmailAddress: undefined })];
  const summary = await run();
  assert.deepEqual(summary.detail, { withAddress: 2, withEmail: 2, withContactPersons: 2, contactPersonsIncludedInEmails: 2, mergedAway: 0 });
  assert.deepEqual(read().meta.detail, summary.detail);
  assert.ok(logs.some((l) => l.startsWith('detail: 2 with an address, 2 with an email, 2 with contact persons (2 flagged for invoice emails), 0 merged away')), logs.join('\n'));
  assert.doesNotMatch(logs.join('\n'), /Fictional Contact|example\.test|@/);
});

test('if a sizeable export comes back with no address at all, the operator is told to check the response had full detail', async () => {
  fake.all = Array.from({ length: 25 }, (_, k) => rawContact(k + 1, { Addresses: [{ AddressType: 'POBOX' }, { AddressType: 'STREET' }] }));
  await run();
  assert.ok(logs.some((l) => l.startsWith('NOTE: no contact has any address or no contact has any contact person')), logs.join('\n'));
  logs = [];
  resetFake();
  fake.all = contacts(25);
  await run({ out: join(dir, 'second.json') });
  assert.ok(logs.every((l) => !l.startsWith('NOTE:')), 'no note when the detail is there');
});

// ---- organisation status ---------------------------------------------------------------------------------------------------------------------
test('an organisation that is NOT ACTIVE is refused before any contact request, and nothing is written', async () => {
  for (const status of ['INACTIVE', 'SUSPENDED', 'DELETED']) {
    resetFake();
    fake.all = contacts(3);
    fake.orgBody = { Organisations: [{ OrganisationID: ORG, Name: 'Fictional Test Org', OrganisationStatus: status }] };
    await assert.rejects(() => run(), failsWith('ORG_NOT_ACTIVE'));
    assert.equal(contactCalls().length, 0, status);
    nothingWritten();
  }
});

test('ACTIVE is accepted (any case); a status Xero does not report is noted and does not block the export', async () => {
  fake.all = contacts(2);
  fake.orgBody = { Organisations: [{ OrganisationID: ORG, OrganisationStatus: 'active' }] };
  assert.equal((await run()).contactCount, 2);

  resetFake();
  fake.all = contacts(2);
  fake.orgBody = { Organisations: [{ OrganisationID: ORG }] };
  logs = [];
  assert.equal((await run({ out: join(dir, 'second.json') })).contactCount, 2);
  assert.ok(logs.includes('note: Xero did not report an organisation status'));
});

test('the status check comes AFTER the organisation match (a mismatch is still reported as a mismatch)', async () => {
  fake.orgBody = { Organisations: [{ OrganisationID: ORG, OrganisationStatus: 'INACTIVE' }] };
  await assert.rejects(() => run({ confirm: OTHER_ORG }), failsWith('ORG_MISMATCH'));
});

// ---- README ----------------------------------------------------------------------------------------------------------------------------------
// Whitespace is collapsed so a phrase still matches if the README is re-wrapped.
const readme = readFileSync(join(process.cwd(), 'tools', 'xero-contact-export', 'README.md'), 'utf8').replace(/\s+/g, ' ');

test('README: no instruction types a secret into a command; prompts are used for every supported shell', () => {
  assert.doesNotMatch(readme, /set XERO_CLIENT_(ID|SECRET)=[^\s`]/i);
  assert.doesNotMatch(readme, /\$env:XERO_CLIENT_SECRET\s*=\s*'/);
  assert.doesNotMatch(readme, /export XERO_CLIENT_SECRET=\S/);
  assert.match(readme, /Read-Host 'Xero client secret' -AsSecureString/);
  assert.match(readme, /read -r -s -p 'Xero client secret: '/);
  assert.match(readme, /set \/p XERO_CLIENT_SECRET=/);
  assert.match(readme, /visible on screen/);
  assert.match(readme, /believed correct for each shell but were not tested here/);
});

test('README: warns against cloud-synced and shared folders, and states what cannot be detected', () => {
  assert.match(readme, /\*\*Do not\*\* use a \*\*cloud-synced\*\* folder \(OneDrive, Dropbox, Google Drive/);
  assert.match(readme, /shared or network folder/);
  assert.match(readme, /What it cannot detect/);
  assert.match(readme, /mapped\s+network drive/);
});

test('README: has retention and deletion guidance, including its honest limit', () => {
  assert.match(readme, /Delete it when the review is finished/);
  assert.match(readme, /Delete \*\*both\*\* files/);
  assert.match(readme, /Remove-Item -LiteralPath/);
  assert.match(readme, /Deleting does not guarantee the data cannot be recovered/);
  assert.match(readme, /Recycle Bin/);
});

test('README: states the Node version that was ACTUALLY verified, and does not claim more', () => {
  assert.match(readme, /Verified on \*\*Node v25\.6\.0 \(Windows\)\*\*/);
  assert.match(readme, /have \*\*not\*\* been tested\s+here/);
  assert.doesNotMatch(readme, /Needs Node 23\.6 or newer/);
});

test('README: says the token request is unchanged and the scope question is open', () => {
  assert.match(readme, /no `scope`\s+parameter/);
  assert.match(readme, /\*\*unverified\*\*/);
});

// ---- C1: write-time failures --------------------------------------------------------------------------------------------------------
function makeOutFolder(): string {
  const out = join(dir, 'out');
  mkdirSync(out);
  return out;
}
/** Runs `action` once, on the second contact-page request: i.e. in the middle of the export, after the first check of the path. */
function duringExport(action: () => void) {
  let done = false;
  fake.hook = (rec) => {
    if (!done && rec.path.endsWith('/Contacts') && rec.query.get('page') === '2') {
      done = true;
      action();
    }
    return undefined;
  };
}

test('a TARGET file that appears DURING the export is never overwritten, and nothing else is written', async () => {
  fake.all = contacts(150);
  const out = makeOutFolder();
  const target = join(out, 'contacts.json');
  duringExport(() => writeFileSync(target, 'PRECIOUS'));
  await assert.rejects(() => run({ out: target }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(readFileSync(target, 'utf8'), 'PRECIOUS');
  assert.deepEqual(readdirSync(out), ['contacts.json'], 'no temporary or checksum file was created');
  assert.ok(logs.every((l) => !l.startsWith('wrote ')), 'never reported as written');
});

test('a CHECKSUM file that appears DURING the export is not overwritten either, and no export is written', async () => {
  fake.all = contacts(150);
  const out = makeOutFolder();
  const target = join(out, 'contacts.json');
  duringExport(() => writeFileSync(`${target}.sha256`, 'PRECIOUS-SUM'));
  await assert.rejects(() => run({ out: target }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(readFileSync(`${target}.sha256`, 'utf8'), 'PRECIOUS-SUM');
  assert.deepEqual(readdirSync(out), ['contacts.json.sha256']);
});

test('C3: a git repository that appears in the output folder DURING the export stops it before anything is written', async () => {
  fake.all = contacts(150);
  const out = makeOutFolder();
  duringExport(() => mkdirSync(join(out, '.git')));
  await assert.rejects(() => run({ out: join(out, 'contacts.json') }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.deepEqual(readdirSync(out), ['.git'], 'nothing was written next to the new repository');
});

test('C3: an output folder that is REMOVED during the export stops it with nothing written', async () => {
  fake.all = contacts(150);
  const out = makeOutFolder();
  duringExport(() => rmSync(out, { recursive: true, force: true }));
  await assert.rejects(() => run({ out: join(out, 'contacts.json') }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('C3: an output folder swapped for a JUNCTION into a git repository DURING the export is refused, and nothing reaches the repository', { skip: junctionsWork ? false : 'cannot create symlinks or junctions on this machine' }, async () => {
  fake.all = contacts(150);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'private'));
  const out = makeOutFolder();
  duringExport(() => {
    rmSync(out, { recursive: true, force: true });
    symlinkSync(join(repo, 'private'), out, 'junction');
  });
  await assert.rejects(() => run({ out: join(out, 'contacts.json') }), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.deepEqual(readdirSync(join(repo, 'private')), []);
});

test('writeNewFile: if the target appears at the last moment, the files it created are removed and the existing file is untouched', () => {
  const target = outFile();
  writeFileSync(target, 'PRECIOUS');
  assert.throws(() => writeNewFile(target, 'DATA', 'abc'), failsWith('UNSAFE_OUTPUT_PATH'));
  assert.equal(readFileSync(target, 'utf8'), 'PRECIOUS');
  assert.deepEqual(readdirSync(dir), ['contacts.json'], 'no temporary file and no checksum file left behind');
});

test('writeNewFile: a failed RENAME removes the temporary and checksum files and leaves no export - and does not leak the cause', () => {
  const target = outFile();
  const ops: FsOps = { ...realFs, renameSync: () => { throw new Error('disk says no: SOME-INTERNAL-DETAIL'); } };
  try {
    writeNewFile(target, 'DATA', 'abc', ops);
    assert.ok(false, 'should have failed');
  } catch (e: any) {
    assert.equal(e.code, 'WRITE_FAILED');
    assert.doesNotMatch(e.message, /SOME-INTERNAL-DETAIL/);
    assert.match(e.message, /Nothing usable was left behind/);
  }
  assert.deepEqual(readdirSync(dir), [], 'no .json, no .sha256, no .tmp');
});

test('writeNewFile: a failed WRITE (disk full) closes the file, removes the temporary file, and leaves no export', () => {
  const target = outFile();
  const closed: number[] = [];
  const ops: FsOps = {
    ...realFs,
    writeSync: () => { throw new Error('ENOSPC'); },
    closeSync: (fd) => { closed.push(fd); realFs.closeSync(fd); },
  };
  assert.throws(() => writeNewFile(target, 'DATA', 'abc', ops), failsWith('WRITE_FAILED'));
  assert.equal(closed.length, 1, 'the open file was closed');
  assert.deepEqual(readdirSync(dir), []);
});

test('writeNewFile: a checksum file that already exists is NOT deleted by the cleanup (only files this call created are removed)', () => {
  const target = outFile();
  writeFileSync(`${target}.sha256`, 'KEEP');
  assert.throws(() => writeNewFile(target, 'DATA', 'abc'), failsWith('WRITE_FAILED'));
  assert.equal(readFileSync(`${target}.sha256`, 'utf8'), 'KEEP');
  assert.deepEqual(readdirSync(dir), ['contacts.json.sha256'], 'the temporary file was removed, the pre-existing file kept');
});

test('end to end: a failed rename after a full download reports failure, writes no .json, and is never logged as written', async () => {
  fake.all = contacts(30);
  await assert.rejects(
    () => exportContacts({ creds: CREDS, confirmOrgId: ORG, outPath: outFile(), tuning: DEFAULT_TUNING }, { ...deps(), fsOps: { renameSync: () => { throw new Error('nope'); } } }),
    failsWith('WRITE_FAILED'),
  );
  nothingWritten();
  assert.ok(logs.every((l) => !l.startsWith('wrote ') && !l.startsWith('detail:')), 'no success line was printed');
});

test('a .json export only ever comes into existence through the final rename, after the data was written and flushed', async () => {
  fake.all = contacts(30);
  const calls: string[] = [];
  const target = outFile();
  const fsOps: Partial<FsOps> = {
    openSync: (path, flags, mode) => { calls.push(`open ${path === target ? 'TARGET' : path.endsWith('.tmp') ? 'temp' : path.endsWith('.sha256') ? 'sidecar' : 'other'} ${flags}`); return realFs.openSync(path, flags, mode); },
    writeSync: (fd, data) => { calls.push('write'); return realFs.writeSync(fd, data); },
    fsyncSync: (fd) => { calls.push('fsync'); realFs.fsyncSync(fd); },
    renameSync: (from, to) => {
      calls.push(`rename ${from.endsWith('.tmp') ? 'temp' : 'other'} -> ${to === target ? 'TARGET' : 'other'} (target existed before: ${existsSync(target)})`);
      realFs.renameSync(from, to);
    },
  };
  await exportContacts({ creds: CREDS, confirmOrgId: ORG, outPath: target, tuning: DEFAULT_TUNING }, { ...deps(), fsOps });
  assert.deepEqual(calls, ['open temp wx', 'write', 'fsync', 'open sidecar wx', 'write', 'rename temp -> TARGET (target existed before: false)']);
  assert.ok(!calls.some((c) => c.startsWith('open TARGET')), 'the final name is never opened for writing directly');
});

test('README: explains leftovers after a kill or power loss, and the remaining window of the last check', () => {
  assert.match(readme, /killed, or the machine loses power, while writing/);
  assert.match(readme, /\.tmp/);
  assert.match(readme, /Look for them and \*\*delete them\*\*/);
  assert.match(readme, /checked \*\*again immediately before the file is written\*\*/);
  assert.match(readme, /\*\*A very small window remains\*\*/);
  assert.match(readme, /cannot be removed without operating-system support/);
});

test('the Node version comments in the source agree with the README: verified only on v25.6.0', () => {
  for (const file of ['exportContacts.ts', 'cli.ts']) {
    const text = readFileSync(join(process.cwd(), 'tools', 'xero-contact-export', file), 'utf8');
    assert.doesNotMatch(text, /23\.6/, `${file} must not claim a version that was not verified`);
    assert.match(text, /v25\.6\.0/, `${file} states the verified version`);
  }
});

// ---- C2: the log scrubber -----------------------------------------------------------------------------------------------------------------
test('log scrubber: every occurrence of a known secret is redacted (even one full of regex characters); an empty secret is ignored', () => {
  const lines: string[] = [];
  const log = makeSafeLog((l) => lines.push(l), ['s3cr.t+(x)*', 'TOKEN123', '']);
  log('a s3cr.t+(x)* b s3cr.t+(x)* c');
  log('Bearer TOKEN123 and again TOKEN123');
  log('plain line stays plain');
  assert.deepEqual(lines, ['a [redacted] b [redacted] c', 'Bearer [redacted] and again [redacted]', 'plain line stays plain']);
});

test('log scrubber: anything shaped like an email address is redacted, whatever surrounds it', () => {
  const lines: string[] = [];
  const log = makeSafeLog((l) => lines.push(l), []);
  for (const text of [
    'contact a@b.c here',
    'first.last+tag@sub.example.co.uk',
    '<user@host>',
    '("quoted@example.test")',
    'mailto:someone@example.test?subject=x',
    'two@example.test and three@example.test',
  ]) log(text);
  assert.equal(lines.length, 6);
  for (const line of lines) assert.doesNotMatch(line, /@/, line);
  assert.equal(lines[0], 'contact [redacted] here');
  assert.equal(lines[5], '[redacted] and [redacted]');
});

test('log scrubber: ordinary lines (counts, paths, statuses) pass through untouched', () => {
  const lines: string[] = [];
  const log = makeSafeLog((l) => lines.push(l), [CREDS.clientSecret]);
  const same = ['page 3: 100 contacts (300 so far)', 'organisation verified against the confirmed id', 'wrote 5 contacts (1 archived) to C:\\private\\export.json', 'contacts page 2: rate limited, waiting 7s (retry 1 of 5)'];
  for (const l of same) log(l);
  assert.deepEqual(lines, same);
});

test('log scrubber: it is a backstop for secrets and emails ONLY - contact names are protected by never being logged, not by this', () => {
  const lines: string[] = [];
  makeSafeLog((l) => lines.push(l), [])('Fictional Contact 1 Ltd');
  assert.deepEqual(lines, ['Fictional Contact 1 Ltd']);
});

test('log scrubber: it is really wired into the export - a secret or email-shaped text in a logged path never reaches the log', async () => {
  fake.all = contacts(3);
  const emailFolder = join(dir, 'kc@example.test');
  mkdirSync(emailFolder);
  await run({ out: join(emailFolder, 'contacts.json') });
  const secretFolder = join(dir, CREDS.clientSecret);
  mkdirSync(secretFolder);
  await run({ out: join(secretFolder, 'contacts.json') });
  const wrote = logs.filter((l) => l.startsWith('wrote '));
  assert.equal(wrote.length, 2);
  for (const line of wrote) {
    assert.match(line, /\[redacted\]/);
    assert.doesNotMatch(line, new RegExp(`@|${CREDS.clientSecret}`));
  }
});

// ---- C2: the command's own output -----------------------------------------------------------------------------------------------------------
const ENV_OK = { XERO_CLIENT_ID: CREDS.clientId, XERO_CLIENT_SECRET: CREDS.clientSecret };
async function cli(argv: string[], env: Record<string, string | undefined> = ENV_OK, over: Partial<Deps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, env, { ...deps(), log: (l) => { out.push(l); }, ...over }, { out: (l) => { out.push(l); }, err: (l) => { err.push(l); } });
  return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n') };
}
const SENSITIVE = () => new RegExp(`${CREDS.clientSecret}|${CREDS.clientId}|${ACCESS_TOKEN}|Fictional Contact|example\\.test|@`);

test('CLI: --help prints the usage and nothing else, with no network', async () => {
  const r = await cli(['--help'], {});
  assert.equal(r.code, 0);
  assert.match(r.out, /Read-only Xero contact export/);
  assert.equal(r.err, '');
  assert.equal(fake.log.length, 0);
});

test('CLI: inspect prints the organisation, status and scopes, requests no contacts, and shows no contact data or secret', async () => {
  fake.all = contacts(5);
  const r = await cli(['--inspect-organisation']);
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`organisation id : ${ORG}`));
  assert.match(r.out, /name            : Fictional Test Org/);
  assert.match(r.out, /demo company    : no/);
  assert.match(r.out, /status          : ACTIVE\n/);
  assert.match(r.out, /granted scopes  : accounting\.settings\.read accounting\.contacts\.read/);
  assert.doesNotMatch(r.out, /NOT ACTIVE/);
  assert.equal(r.err, '');
  assert.equal(contactCalls().length, 0);
  assert.doesNotMatch(r.all, SENSITIVE());
});

test('CLI: inspect says plainly when the organisation is NOT ACTIVE and an export will be refused', async () => {
  fake.orgBody = { Organisations: [{ OrganisationID: ORG, Name: 'Fictional Test Org', OrganisationStatus: 'SUSPENDED' }] };
  const r = await cli(['--inspect-organisation']);
  assert.equal(r.code, 0);
  assert.match(r.out, /status          : SUSPENDED  <-- NOT ACTIVE: an export will be refused/);
});

test('CLI: a successful export prints the summary, the reminders and the checksum - and no contact data, credential or token', async () => {
  fake.all = contacts(5);
  const r = await cli(['--confirm-org', ORG, '--out', outFile()]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Reminder: the export must go in a private LOCAL folder/);
  assert.match(r.out, /Done: 5 contacts \(0 archived\) in 1 pages\./);
  assert.match(r.out, /Detail: 5 with an address, 5 with an email, 5 with contact persons \(5 flagged for invoice emails\), 0 merged away\./);
  assert.match(r.out, /SHA-256: [0-9a-f]{64}/);
  assert.match(r.out, /Delete it \(and its \.sha256 file\) when the review is finished/);
  assert.equal(r.err, '');
  assert.doesNotMatch(r.all, SENSITIVE());
  assert.equal(statSync(outFile()).isFile(), true);
});

test('CLI: every kind of failure exits 1 with only a fixed message - no credential, token, contact data or organisation id', async () => {
  const cases: Array<{ code: string; argv: string[]; setup: () => void }> = [
    { code: 'AUTH_FAILED', argv: ['--confirm-org', ORG, '--out', outFile()], setup: () => { fake.tokenStatus = 401; } },
    { code: 'ORG_LOOKUP_FAILED', argv: ['--confirm-org', ORG, '--out', outFile()], setup: () => { fake.orgStatus = 403; } },
    { code: 'ORG_MISMATCH', argv: ['--confirm-org', OTHER_ORG, '--out', outFile()], setup: () => undefined },
    { code: 'ORG_NOT_ACTIVE', argv: ['--confirm-org', ORG, '--out', outFile()], setup: () => { fake.orgBody = { Organisations: [{ OrganisationID: ORG, OrganisationStatus: 'INACTIVE' }] }; } },
    { code: 'UNSAFE_OUTPUT_PATH', argv: ['--confirm-org', ORG, '--out', 'relative.json'], setup: () => undefined },
    { code: 'BAD_RESPONSE', argv: ['--confirm-org', ORG, '--out', outFile()], setup: () => { fake.hook = (rec) => (rec.path.endsWith('/Contacts') ? json(200, { Contacts: [{ Name: 'Fictional Contact X', EmailAddress: 'x@example.test' }] }) : undefined); } },
  ];
  for (const c of cases) {
    resetFake();
    fake.all = contacts(3);
    c.setup();
    const r = await cli(c.argv);
    assert.equal(r.code, 1, c.code);
    assert.match(r.err, new RegExp(`^Error \\(${c.code}\\): `), r.err);
    assert.doesNotMatch(r.all, SENSITIVE(), c.code);
    assert.doesNotMatch(r.all, new RegExp(`${ORG}|${OTHER_ORG}`), `${c.code} does not echo an organisation id`);
    nothingWritten();
  }
});

test('CLI: an UNEXPECTED error prints one generic line - not its message, which could hold a secret or an email', async () => {
  fake.all = contacts(150);
  const r = await cli(['--confirm-org', ORG, '--out', outFile()], ENV_OK, { sleep: async () => { throw new Error(`boom ${CREDS.clientSecret} someone@example.test`); } });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'Error: the export failed unexpectedly. Nothing was written.');
  assert.doesNotMatch(r.all, SENSITIVE());
  nothingWritten();
});

test('CLI: bad arguments and missing credentials stop before any network use, without echoing what was typed', async () => {
  for (const argv of [['TOPSECRETVALUE'], ['--unknown=TOPSECRETVALUE'], ['--client-secret', 'TOPSECRETVALUE'], ['--client-secret=TOPSECRETVALUE']]) {
    const r = await cli(argv);
    assert.equal(r.code, 1);
    assert.match(r.err, /^Error \(BAD_ARGUMENT\): /);
    assert.doesNotMatch(r.all, /TOPSECRETVALUE/);
  }
  const noCreds = await cli(['--inspect-organisation'], {});
  assert.equal(noCreds.code, 1);
  assert.match(noCreds.err, /XERO_CLIENT_ID and XERO_CLIENT_SECRET/);
  const half = await cli(['--inspect-organisation'], { XERO_CLIENT_ID: CREDS.clientId });
  assert.equal(half.code, 1);
  assert.doesNotMatch(half.all, new RegExp(CREDS.clientId), 'a supplied credential is not echoed back');
  assert.equal(fake.log.length, 0, 'nothing reached the fake Xero');
});

test('CLI: all output goes through the supplied writers (no direct console or process use in the logic), and cli.ts holds none of it', () => {
  const dirPath = join(process.cwd(), 'tools', 'xero-contact-export');
  const logic = readFileSync(join(dirPath, 'cliMain.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(logic, /console\.|process\./);
  const entry = readFileSync(join(dirPath, 'cli.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(entry, /parseArgs|readCredentials|inspectOrganisation|exportContacts\(/);
  assert.match(entry, /runCli\(process\.argv\.slice\(2\), process\.env/);
});

// ---- command line -------------------------------------------------------------------------------------------------------------------------
test('arguments: help, inspect, and export need exactly what they should', () => {
  assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['--inspect-organisation']), { kind: 'inspect' });
  assert.deepEqual(parseArgs(['--confirm-org', ORG, '--out', '/private/x.json']), { kind: 'export', confirmOrgId: ORG, outPath: '/private/x.json', pageSize: 100 });
  assert.deepEqual(parseArgs([`--confirm-org=${ORG}`, '--out=/private/x.json', '--page-size=250']), { kind: 'export', confirmOrgId: ORG, outPath: '/private/x.json', pageSize: 250 });
  assert.throws(() => parseArgs([]), failsWith('BAD_ARGUMENT'));
  assert.throws(() => parseArgs(['--confirm-org', ORG]), /--out/);
  assert.throws(() => parseArgs(['--out', '/p.json']), /--confirm-org/);
  assert.throws(() => parseArgs(['--inspect-organisation', '--out', '/p.json']), failsWith('BAD_ARGUMENT'));
  assert.throws(() => parseArgs(['--bogus']), /Unknown or unexpected argument/);
  assert.throws(() => parseArgs(['--confirm-org']), /needs a value/);
  for (const n of ['0', '1001', 'x', '1.5']) assert.throws(() => parseArgs(['--confirm-org', ORG, '--out', '/p.json', '--page-size', n]), /page-size/);
});

test('credentials are NEVER accepted as command-line arguments', () => {
  for (const args of [['--client-secret', 'abc'], ['--client-secret=abc'], ['--client-id', 'abc'], ['--token', 'abc'], ['--access-token=abc'], ['--password', 'abc'], ['--secret', 'abc']]) {
    assert.throws(() => parseArgs(args), /never from command-line arguments/, args.join(' '));
  }
});

test('credentials come from the environment, trimmed, and a missing one is named without echoing values', () => {
  assert.deepEqual(readCredentials({ XERO_CLIENT_ID: ' id ', XERO_CLIENT_SECRET: ' secret ' }), { clientId: 'id', clientSecret: 'secret' });
  for (const env of [{}, { XERO_CLIENT_ID: 'id' }, { XERO_CLIENT_SECRET: 'secret' }, { XERO_CLIENT_ID: ' ', XERO_CLIENT_SECRET: 'secret' }]) {
    assert.throws(() => readCredentials(env), (e: any) => e.code === 'BAD_ARGUMENT' && /XERO_CLIENT_ID and XERO_CLIENT_SECRET/.test(e.message) && !/secret'/.test(e.message));
  }
});

const nodeRunsTypeScript = !!process.features.typescript;
test('the command runs as plain TypeScript with no build step (help), and without credentials it stops before any network access', { skip: nodeRunsTypeScript ? false : 'this Node cannot run .ts directly' }, () => {
  const cli = join(process.cwd(), 'tools', 'xero-contact-export', 'cli.ts');
  // The environment is rebuilt WITHOUT any XERO_* variable, so these runs cannot reach Xero even by accident.
  const cleanEnv: Record<string, string | undefined> = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env: cleanEnv });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Read-only Xero contact export/);
  assert.match(help.stdout, /never from arguments/);

  const noCreds = spawnSync(process.execPath, [cli, '--inspect-organisation'], { encoding: 'utf8', env: cleanEnv });
  assert.equal(noCreds.status, 1);
  assert.match(noCreds.stderr, /XERO_CLIENT_ID and XERO_CLIENT_SECRET/);

  const badArgs = spawnSync(process.execPath, [cli, '--client-secret', 'TOPSECRETVALUE'], { encoding: 'utf8', env: cleanEnv });
  assert.equal(badArgs.status, 1);
  assert.match(badArgs.stderr, /never from command-line arguments/);
  assert.doesNotMatch(badArgs.stderr + badArgs.stdout, /TOPSECRETVALUE/, 'a secret typed on the command line is not echoed back');
});
