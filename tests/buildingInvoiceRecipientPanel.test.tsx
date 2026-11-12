// Step 4: the Building File's invoice recipient panel (src/components/buildings/BuildingInvoiceRecipientPanel.tsx).
//
// WORKFLOW tests run the panel's own rules (src/lib/buildingInvoiceRecipient.ts) and the REAL repository calls
// (src/repository/xeroLinksRepository.ts) end to end through the REAL xero-link-contact Edge Function, with only its surroundings
// faked: the database (including the two server-only functions, with the same "still the recipient you saw?" check as the real
// migration) and Xero. Each scenario starts from what the panel shows, does what the manager does, and ends by reloading the
// building the way the page does (mapBuildingRow over the stored row).
//
// RENDER tests show each step of the panel (current recipient, search, confirmation, clear confirmation, error) with its
// starting-state props, as other panels in this repository are tested.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readSourceFile } from './helpers/sourceCode';
import type { BuildingRow, Contact } from '../src/domain/types';
import {
  canSaveChosenRecipient,
  currentBuildingRecipient,
  expectedRecipientOf,
  recipientSearchStartTerm,
  replacesAnotherRecipient,
} from '../src/lib/buildingInvoiceRecipient';
import {
  clearBuildingRecipient,
  getXeroRecipient,
  searchXeroRecipients,
  setBuildingRecipient,
  verifyBuildingDefault,
  type XeroRecipientCandidate,
} from '../src/repository/xeroLinksRepository';
import { mapBuildingRow } from '../src/repository/mapBuildingRow';

// ---- the Edge Function, its database and Xero (faked) --------------------------------------------------------------------------------
const ENV: Record<string, string | undefined> = {};
let handler: (req: Request) => Promise<Response> = async () => new Response('handler not registered', { status: 500 });
(globalThis as any).Deno = { serve: (h: typeof handler) => { handler = h; }, env: { get: (k: string) => ENV[k] } };

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADRIAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EML = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const DCI = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const ARCHIVED = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const B_NONE = '20000000-0000-4000-8000-00000000000a';
const B_OWN = '20000000-0000-4000-8000-00000000000b';
const B_SHARE = '20000000-0000-4000-8000-00000000000c';
const B_PERSON = '20000000-0000-4000-8000-00000000000d';
const LAURA = '10000000-0000-4000-8000-000000000001';
const SERVICE_KEY = 'service-role-key-NEVER-LEAK';

const blank = { default_invoice_contact_id: null, default_invoice_xero_contact_id: null, default_invoice_xero_org_id: null, default_invoice_xero_contact_name: null, default_invoice_xero_contact_email: null };
const db = {
  role: 'manager',
  buildings: {} as Record<string, any>,
  contacts: {} as Record<string, any>,
  xero: {} as Record<string, any>,
  orgId: ORG,
  rpcCalls: [] as { name: string; body: any; auth: string | null }[],
  xeroWrites: [] as string[],
  /** Another manager's change, applied just before the next save reaches the database. */
  beforeSave: null as null | ((b: any) => void),
};
function building(id: string, name: string, invoiceDetails: string, over: Record<string, unknown> = {}) {
  return { id, client_id: 'client-eml', address: name, name: null, postcode: 'W1', invoice_details: invoiceDetails, extra_requirements: null, ...blank, clients: { id: 'client-eml', company_name: 'Estate Management London' }, building_access: null, ...over };
}
function reset() {
  ENV.SUPABASE_URL = 'https://tests.invalid';
  ENV.SUPABASE_ANON_KEY = 'test-key';
  ENV.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  ENV.XERO_CLIENT_ID = 'test-client-id';
  ENV.XERO_CLIENT_SECRET = 'test-secret';
  ENV.XERO_EXPECTED_ORG_ID = ORG;
  db.role = 'manager';
  db.orgId = ORG;
  db.beforeSave = null;
  db.rpcCalls = [];
  db.xeroWrites = [];
  const adrianRow = { default_invoice_xero_contact_id: ADRIAN, default_invoice_xero_org_id: ORG, default_invoice_xero_contact_name: '16-17 Marylebone Adrian Levy', default_invoice_xero_contact_email: 'accounts@eml.test' };
  db.buildings = {
    [B_NONE]: building(B_NONE, '137 Randolph Avenue', '137 Randolph DCI Finance Limited'),
    [B_OWN]: building(B_OWN, '16-17 Marylebone', '16-17 Marylebone Adrian Levy', adrianRow),
    [B_SHARE]: building(B_SHARE, '18 Marylebone', '16-17 Marylebone Adrian Levy', adrianRow),
    [B_PERSON]: building(B_PERSON, '47 Litchfield', '47 Litchfield FGC Freehold Limited', { default_invoice_contact_id: LAURA, default_invoice_xero_contact_id: ADRIAN, default_invoice_xero_org_id: ORG, default_invoice_xero_contact_name: '16-17 Marylebone Adrian Levy' }),
  };
  db.contacts = { [LAURA]: { id: LAURA, client_id: 'client-eml', name: 'Laura Newton', xero_contact_id: ADRIAN, xero_org_id: ORG, xero_contact_name: '16-17 Marylebone Adrian Levy', xero_linked_at: '2026-10-01' } };
  const po = (line: string, city: string, pc: string) => [{ AddressType: 'POBOX', AddressLine1: line, City: city, PostalCode: pc, Country: 'United Kingdom' }];
  db.xero = {
    [ADRIAN]: { ContactID: ADRIAN, Name: '16-17 Marylebone Adrian Levy', EmailAddress: 'accounts@eml.test', ContactStatus: 'ACTIVE', Addresses: po('16-17 Marylebone High St', 'London', 'W1U 4QA') },
    [EML]: { ContactID: EML, Name: 'ESTATE MANAGEMENT LONDON LIMITED', EmailAddress: 'accounts@eml.test', ContactStatus: 'ACTIVE', AccountNumber: 'EML01', Addresses: po('1 Baker St', 'London', 'NW1 6XE') },
    [DCI]: { ContactID: DCI, Name: '137 Randolph DCI Finance Limited', EmailAddress: 'ap@dci.test', ContactStatus: 'ACTIVE', Addresses: po('137 Randolph Ave', 'London', 'W9 1DN') },
    [ARCHIVED]: { ContactID: ARCHIVED, Name: '137 Randolph DCI Finance Limited', EmailAddress: 'old@dci.test', ContactStatus: 'ARCHIVED' },
  };
}

const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function rpc(name: string, a: any, auth: string | null): Response {
  db.rpcCalls.push({ name, body: a, auth });
  if (auth !== `Bearer ${SERVICE_KEY}`) return json(403, { code: '42501', message: `permission denied for function ${name}` });
  const fail = (message: string) => json(400, { code: 'P0001', message });
  const b = db.buildings[a.p_building_id];
  if (!b) return fail('building_not_found: ...');
  db.beforeSave?.(b);
  db.beforeSave = null;
  if ((b.default_invoice_xero_contact_id ?? null) !== (a.p_expected_current_xero_contact_id ?? null) || (b.default_invoice_xero_org_id ?? null) !== (a.p_expected_current_xero_org_id ?? null)) {
    return fail("building_invoice_recipient_changed: this building's invoice recipient is not the one you saw. Reload and try again. Nothing was changed.");
  }
  if (name === 'set_building_invoice_recipient') {
    Object.assign(b, { default_invoice_contact_id: null, default_invoice_xero_contact_id: a.p_xero_contact_id, default_invoice_xero_org_id: a.p_xero_org_id, default_invoice_xero_contact_name: a.p_xero_contact_name, default_invoice_xero_contact_email: a.p_xero_contact_email });
  } else {
    Object.assign(b, blank);
  }
  return new Response(null, { status: 204 });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? (typeof input === 'object' && input.method) ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined));
  const raw = init?.body ?? (typeof input === 'object' && input.body ? await input.text() : undefined);
  const body = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw;
  if (url.host === 'tests.invalid' && url.pathname === '/functions/v1/xero-link-contact') {
    // The browser's call reaches the REAL Edge Function.
    return handler(new Request('https://fn.test/xero-link-contact', { method: 'POST', headers, body: typeof raw === 'string' ? raw : JSON.stringify(body) }));
  }
  if (url.host === 'identity.xero.com') return json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 1800 });
  if (url.host === 'api.xero.com') {
    const p = url.pathname.replace('/api.xro/2.0', '');
    if (method !== 'GET') db.xeroWrites.push(`${method} ${p}`);
    if (p === '/Organisation') return json(200, { Organisations: [{ OrganisationID: db.orgId }] });
    if (p === '/Contacts') {
      const t = (url.searchParams.get('searchTerm') ?? '').toLowerCase();
      return json(200, { Contacts: Object.values(db.xero).filter((c: any) => c.Name.toLowerCase().includes(t)) });
    }
    const m = p.match(/^\/Contacts\/([^/]+)$/);
    if (m) return db.xero[m[1]] ? json(200, { Contacts: [db.xero[m[1]]] }) : json(404, { Type: 'NotFound' });
    return json(500, {});
  }
  if (url.host === 'tests.invalid') {
    if (url.pathname.startsWith('/rest/v1/rpc/')) return rpc(url.pathname.slice('/rest/v1/rpc/'.length), body ?? {}, headers.get('authorization'));
    const obj = (headers.get('accept') ?? '').includes('vnd.pgrst.object');
    const one = (row: unknown) => json(200, obj ? row : [row]);
    const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
    if (url.pathname === '/auth/v1/user') return json(200, { id: 'user-1', aud: 'authenticated', email: 'luke@kindcontractors.co.uk', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    if (url.pathname === '/rest/v1/app_users') return one({ role: db.role, is_active: true });
    if (url.pathname === '/rest/v1/buildings' && method === 'GET') return idEq && db.buildings[idEq] ? one(db.buildings[idEq]) : json(200, obj ? null : []);
    if (url.pathname === '/rest/v1/contacts' && method === 'GET') return idEq && db.contacts[idEq] ? one(db.contacts[idEq]) : json(200, obj ? null : []);
  }
  throw new Error(`unexpected request ${method} ${url.href}`);
}) as typeof fetch;

for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) (console as any)[level] = () => {};
beforeEach(reset);
reset();
await import('../supabase/functions/xero-link-contact/index.ts');

/** The building as the page has it after a reload. */
const reload = (id: string): BuildingRow => mapBuildingRow(db.buildings[id]);
const lauraContact = { id: LAURA, name: 'Laura Newton', xeroContactName: '16-17 Marylebone Adrian Levy' } as Contact;
const saveAs = (b: BuildingRow, chosen: XeroRecipientCandidate) =>
  setBuildingRecipient({ buildingId: b.id, xeroContactId: chosen.contactId, expectedName: chosen.name, ...expectedRecipientOf(currentBuildingRecipient(b, [lauraContact])) });
async function find(term: string, contactId: string): Promise<XeroRecipientCandidate> {
  const { results } = await searchXeroRecipients(term);
  const hit = results.find((r) => r.contactId === contactId);
  assert.ok(hit, `${contactId} found by "${term}"`);
  return hit!;
}

// ---- SELECTION -----------------------------------------------------------------------------------------------------------------------
test('SELECT: a building with no recipient - search from its invoice details, choose, confirm, save; the page then shows it, with its address from Xero', async () => {
  const b = reload(B_NONE);
  const current = currentBuildingRecipient(b, []);
  assert.equal(current.kind, 'none');
  const term = recipientSearchStartTerm(b.invoiceDetails);
  assert.equal(term, '137 Randolph DCI Finance Limited');

  const { results } = await searchXeroRecipients(term);
  assert.deepEqual(results.map((r) => r.contactId).sort(), [ARCHIVED, DCI].sort(), 'both look-alikes are listed; none is chosen');
  const dci = results.find((r) => r.contactId === DCI)!;
  const archived = results.find((r) => r.contactId === ARCHIVED)!;
  assert.equal(dci.email, 'ap@dci.test');
  assert.equal(dci.address, '137 Randolph Ave, London, W9 1DN, United Kingdom');
  assert.equal(dci.sameNameAsOthers, 1);
  assert.equal(canSaveChosenRecipient({ current, chosen: archived, replaceConfirmed: true }), false, 'an archived contact can never be saved');
  assert.equal(canSaveChosenRecipient({ current, chosen: dci, replaceConfirmed: false }), true, 'nothing to replace: no tick needed');

  const saved = await saveAs(b, dci);
  assert.equal(saved.unchanged, false);
  assert.equal(saved.previous, null);
  assert.deepEqual(db.rpcCalls.map((c) => [c.name, c.body.p_expected_current_xero_contact_id, c.body.p_expected_current_xero_org_id]), [['set_building_invoice_recipient', null, null]]);

  const after = reload(B_NONE);
  assert.deepEqual(after.invoiceRecipient, { xeroContactId: DCI, xeroOrgId: ORG, name: '137 Randolph DCI Finance Limited', email: 'ap@dci.test' });
  const live = await verifyBuildingDefault(B_NONE);
  assert.equal(live.state, 'ok');
  assert.equal(live.current?.address, '137 Randolph Ave, London, W9 1DN, United Kingdom');
  assert.deepEqual(db.xeroWrites, []);
});

test('SELECT: getRecipient re-reads one contact with its full details (read-only)', async () => {
  const r = await getXeroRecipient(EML);
  assert.equal(r.state, 'ok');
  assert.equal(r.contact?.name, 'ESTATE MANAGEMENT LONDON LIMITED');
  assert.equal(r.contact?.accountNumber, 'EML01');
  assert.equal((await getXeroRecipient(ARCHIVED)).state, 'not_active');
  assert.equal(db.rpcCalls.length, 0);
});

// ---- REPLACEMENT ---------------------------------------------------------------------------------------------------------------------
test('REPLACE: a different contact needs the tick; saved against the recipient the manager saw; the building sharing the old one keeps it', async () => {
  const b = reload(B_OWN);
  const current = currentBuildingRecipient(b, []);
  assert.equal(current.kind, 'own');
  const eml = await find('estate management', EML);
  assert.equal(replacesAnotherRecipient(current, eml), true);
  assert.equal(canSaveChosenRecipient({ current, chosen: eml, replaceConfirmed: false }), false, 'not without the tick');
  assert.equal(canSaveChosenRecipient({ current, chosen: eml, replaceConfirmed: true }), true);

  const shareBefore = JSON.stringify(db.buildings[B_SHARE]);
  const saved = await saveAs(b, eml);
  assert.deepEqual(saved.previous, { xeroContactId: ADRIAN, xeroOrgId: ORG });
  assert.equal(db.rpcCalls[0].body.p_expected_current_xero_contact_id, ADRIAN);
  assert.equal(db.rpcCalls[0].body.p_expected_current_xero_org_id, ORG);
  assert.equal(reload(B_OWN).invoiceRecipient?.xeroContactId, EML);
  assert.equal(JSON.stringify(db.buildings[B_SHARE]), shareBefore, 'the other building with the same Xero contact is unchanged');
});

test('REPLACE: choosing the same contact again needs no tick and only refreshes its details', async () => {
  db.xero[ADRIAN].EmailAddress = 'new-accounts@eml.test';
  const b = reload(B_OWN);
  const current = currentBuildingRecipient(b, []);
  const same = await find('16-17 Marylebone', ADRIAN);
  assert.equal(replacesAnotherRecipient(current, same), false);
  const saved = await saveAs(b, same);
  assert.equal(saved.unchanged, true);
  assert.equal(reload(B_OWN).invoiceRecipient?.email, 'new-accounts@eml.test');
});

test('REPLACE a contact-based default: the panel shows it as such, the switch carries its Xero id + organisation, and Laura\'s Xero link is kept', async () => {
  const b = reload(B_PERSON);
  assert.equal(b.invoiceRecipient, null, 'a person-based default is never shown as the building\'s own recipient');
  const current = currentBuildingRecipient(b, [lauraContact]);
  assert.equal(current.kind, 'contact');
  const fgc = await find('estate management', EML);
  assert.equal(canSaveChosenRecipient({ current, chosen: fgc, replaceConfirmed: false }), false, 'replacing the old default needs the tick too');
  const lauraBefore = JSON.stringify(db.contacts[LAURA]);
  await saveAs(b, fgc);
  const after = reload(B_PERSON);
  assert.equal(after.defaultRecipient, null);
  assert.equal(after.invoiceRecipient?.xeroContactId, EML);
  assert.equal(JSON.stringify(db.contacts[LAURA]), lauraBefore, 'the person and their Xero link are untouched');
});

// ---- CLEARING ------------------------------------------------------------------------------------------------------------------------
test('CLEAR: only this building, only if it is still the recipient the manager saw; no Xero call needed', async () => {
  const b = reload(B_OWN);
  const shareBefore = JSON.stringify(db.buildings[B_SHARE]);
  const out = await clearBuildingRecipient({ buildingId: b.id, ...expectedRecipientOf(currentBuildingRecipient(b, [])) });
  assert.equal(out.cleared, true);
  assert.equal(reload(B_OWN).invoiceRecipient, null);
  assert.equal(currentBuildingRecipient(reload(B_OWN), []).kind, 'none');
  assert.equal(JSON.stringify(db.buildings[B_SHARE]), shareBefore);
  assert.deepEqual(db.rpcCalls.map((c) => c.name), ['clear_building_invoice_recipient']);
});

// ---- ERRORS --------------------------------------------------------------------------------------------------------------------------
test('ERROR: another manager changed the recipient after this page loaded - save and clear are refused with "reload", nothing overwritten', async () => {
  const b = reload(B_OWN); // the page as loaded
  const eml = await find('estate management', EML);
  db.buildings[B_OWN].default_invoice_xero_contact_id = DCI; // someone else, meanwhile
  await assert.rejects(() => saveAs(b, eml), /changed since you loaded the page\. Reload it and try again/);
  await assert.rejects(() => clearBuildingRecipient({ buildingId: b.id, ...expectedRecipientOf(currentBuildingRecipient(b, [])) }), /Reload/);
  assert.equal(db.buildings[B_OWN].default_invoice_xero_contact_id, DCI, 'their change stands');
  assert.equal(db.rpcCalls.length, 0, 'refused before Xero or the database function');
});

test('ERROR: the same contact moved to another organisation meanwhile (same id) - refused too: the organisation is part of what the manager saw', async () => {
  const b = reload(B_OWN);
  const eml = await find('estate management', EML);
  db.beforeSave = (row) => { row.default_invoice_xero_org_id = OTHER_ORG; }; // the race: after the function's own check
  await assert.rejects(() => saveAs(b, eml), /Reload/);
  assert.equal(db.buildings[B_OWN].default_invoice_xero_contact_id, ADRIAN);
});

test('ERROR: a contact archived or renamed after it was found is refused with the reason, and nothing is saved', async () => {
  const b = reload(B_NONE);
  const dci = await find('137 Randolph', DCI);
  db.xero[DCI].ContactStatus = 'ARCHIVED';
  await assert.rejects(() => saveAs(b, dci), /archived/);
  db.xero[DCI].ContactStatus = 'ACTIVE';
  db.xero[DCI].Name = 'DCI Finance Ltd';
  await assert.rejects(() => saveAs(b, dci), /changed since you looked at it/);
  assert.equal(reload(B_NONE).invoiceRecipient, null);
  assert.equal(db.rpcCalls.length, 0);
});

test('ERROR: wrong Xero organisation connected, or not a manager - the reason reaches the panel, nothing is saved', async () => {
  const b = reload(B_NONE);
  const dci = await find('137 Randolph', DCI);
  db.orgId = OTHER_ORG;
  await assert.rejects(() => saveAs(b, dci), /not the one this environment is configured for/);
  db.orgId = ORG;
  db.role = 'technician';
  await assert.rejects(() => saveAs(b, dci), /Not an active manager/);
  await assert.rejects(() => searchXeroRecipients('137'), /Not an active manager/);
  assert.equal(reload(B_NONE).invoiceRecipient, null);
  assert.equal(db.rpcCalls.length, 0);
});

test('ERROR: the old person-based actions cannot overwrite a building\'s own recipient', async () => {
  const before = JSON.stringify(db.buildings[B_OWN]);
  const { supabase } = await import('../src/lib/supabaseClient');
  const res = await supabase.functions.invoke('xero-link-contact', { body: { action: 'setBuildingDefault', buildingId: B_OWN, localContactId: LAURA } });
  assert.ok(res.error, 'refused');
  assert.equal(JSON.stringify(db.buildings[B_OWN]), before);
});

// ---- the panel, step by step (rendered) ----------------------------------------------------------------------------------------------
const { default: BuildingInvoiceRecipientPanel, buildingRecipientCheckKey } = await import('../src/components/buildings/BuildingInvoiceRecipientPanel');
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function panel(b: BuildingRow, props: Record<string, unknown> = {}, check?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // The live check is seeded under the same key the panel uses: its own recipient's Xero id, or the contact-based default's.
  const checkedId = b.invoiceRecipient?.xeroContactId ?? b.defaultRecipient?.xeroContactId;
  if (check && checkedId) qc.setQueryData(buildingRecipientCheckKey(b.id, checkedId), check);
  return decode(renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <BuildingInvoiceRecipientPanel building={b} contacts={[lauraContact]} {...props} />
    </QueryClientProvider>,
  ));
}
const candidate = (over: Partial<XeroRecipientCandidate> = {}): XeroRecipientCandidate => ({
  contactId: EML, name: 'ESTATE MANAGEMENT LONDON LIMITED', status: 'ACTIVE', accountNumber: 'EML01', emailHint: null, hasEmail: true, location: null,
  personsIncludedInEmails: 0, mergedToContactId: null, blockedReason: null, sameNameAsOthers: 0, sameEmailAsOthers: 0,
  email: 'accounts@eml.test', address: '1 Baker St, London, NW1 6XE, United Kingdom', ...over,
});

test('RENDER: the current recipient is clearly marked, with its full name, email and billing address read from Xero', () => {
  const html = panel(reload(B_OWN), {}, { state: 'ok', recipientSource: 'building', current: { ...candidate({ contactId: ADRIAN, name: '16-17 Marylebone Adrian Levy', address: '16-17 Marylebone High St, London, W1U 4QA' }) } });
  assert.match(html, /Current recipient/);
  assert.match(html, /16-17 Marylebone Adrian Levy/);
  assert.match(html, /accounts@eml\.test/);
  assert.match(html, /data-testid="current-recipient-address"[^>]*>16-17 Marylebone High St, London, W1U 4QA</);
  assert.match(html, /Checked in Xero: the contact exists/);
  assert.match(html, />Replace recipient</);
  assert.match(html, />Clear recipient</);
});

test('RENDER: a problem found in Xero (archived, renamed) is shown on the current recipient', () => {
  const html = panel(reload(B_OWN), {}, { state: 'not_active', recipientSource: 'building', current: candidate({ name: '16-17 Marylebone Adrian Levy (old)' }), nameChanged: true });
  assert.match(html, /archived or inactive in Xero/);
  assert.match(html, /Its name in Xero has changed since it was chosen/);
});

test('RENDER: no recipient, and a contact-based default, say so - the latter can be replaced or cleared here', () => {
  const none = panel(reload(B_NONE));
  assert.match(none, /Invoices · default recipient in Xero/);
  assert.match(none, /No invoice recipient yet/);
  assert.match(none, />Find the invoice contact in Xero</);
  assert.doesNotMatch(none, /Clear recipient|Clear contact-based default/);
  const person = panel(reload(B_PERSON));
  assert.match(person, /Current: contact-based default/);
  assert.match(person, /The older way, through Laura Newton's Xero link\./);
  assert.match(person, />Choose the building's Xero contact</);
  assert.match(person, />Clear contact-based default</);
});

test('RENDER: clearing a contact-based default asks first, and says the person and their Xero link are kept', () => {
  const html = panel(reload(B_PERSON), { initialConfirmingClear: true });
  assert.match(html, /data-testid="confirm-clear-recipient"/);
  assert.match(html, /Clear <span class="font-semibold">16-17 Marylebone Adrian Levy<\/span> as this building's invoice recipient\?/);
  assert.match(html, /Laura Newton and their Xero link are kept\./);
  assert.match(html, />Keep it</);
});

test('RENDER: the search opens from the building\'s invoice details (the invoice contact name)', () => {
  const html = panel(reload(B_NONE), { initialSearching: true });
  assert.match(html, /data-testid="xero-recipient-search"/);
  assert.match(html, /value="137 Randolph DCI Finance Limited"/);
  assert.match(html, /For this building only/);
});

test('RENDER: the confirmation shows exactly what will be saved; replacing needs the tick (Save disabled until then)', () => {
  const unticked = panel(reload(B_OWN), { initialChosen: candidate() });
  assert.match(unticked, /Save as this building's recipient\?/);
  assert.match(unticked, /ESTATE MANAGEMENT LONDON LIMITED/);
  assert.match(unticked, /accounts@eml\.test/);
  assert.match(unticked, /1 Baker St, London, NW1 6XE, United Kingdom/);
  assert.match(unticked, /Account EML01/);
  assert.match(unticked, /Replace <span class="font-semibold">16-17 Marylebone Adrian Levy<\/span> as this building's invoice recipient/);
  assert.match(unticked, /<button type="button"[^>]*disabled=""[^>]*>Save recipient<\/button>/);
  const ticked = panel(reload(B_OWN), { initialChosen: candidate(), initialReplaceConfirmed: true });
  assert.doesNotMatch(ticked, /disabled=""[^>]*>Save recipient</);
  const first = panel(reload(B_NONE), { initialChosen: candidate() });
  assert.doesNotMatch(first, /type="checkbox"/, 'nothing to replace: no tick');
  assert.doesNotMatch(first, /disabled=""[^>]*>Save recipient</);
});

test('RENDER: a blocked contact can never be saved, even if it reached the confirmation', () => {
  const html = panel(reload(B_NONE), { initialChosen: candidate({ blockedReason: 'ARCHIVED' }) });
  assert.match(html, /disabled=""[^>]*>Save recipient</);
});

test('RENDER: clearing asks first, and says other buildings keep the same Xero contact', () => {
  const html = panel(reload(B_OWN), { initialConfirmingClear: true });
  assert.match(html, /data-testid="confirm-clear-recipient"/);
  assert.match(html, /Clear <span class="font-semibold">16-17 Marylebone Adrian Levy<\/span> as this building's invoice recipient\?/);
  assert.match(html, /Other buildings that use the same Xero contact keep it/);
  assert.match(html, />Keep it</);
});

test('RENDER: an error shows the server\'s reason with a way to reload the building\'s recipient', () => {
  const html = panel(reload(B_OWN), { initialError: "This building's invoice recipient has changed since you loaded the page. Reload it and try again. Nothing was changed." });
  assert.match(html, /role="alert"/);
  assert.match(html, /changed since you loaded the page/);
  assert.match(html, />Reload this building's recipient</);
});

// ---- wiring --------------------------------------------------------------------------------------------------------------------------
test('TAB: the panel is the only invoice panel on Contacts & Defaults (the contact-based panel was removed 2026-11-11)', () => {
  const tab = readSourceFile('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx');
  assert.match(tab, /<BuildingInvoiceRecipientPanel building=\{building\} contacts=\{contacts\} \/>/);
  assert.doesNotMatch(tab, /<BuildingDefaultRecipientPanel|person-links-not-used/);
});

test('CLEAR A CONTACT-BASED DEFAULT: through the panel\'s clear, with that default as what the manager saw - the building has no recipient after; Laura and her link untouched', async () => {
  const b = reload(B_PERSON);
  const current = currentBuildingRecipient(b, [lauraContact]);
  assert.equal(current.kind, 'contact');
  const lauraBefore = JSON.stringify(db.contacts[LAURA]);
  const out = await clearBuildingRecipient({ buildingId: b.id, ...expectedRecipientOf(current) });
  assert.equal(out.cleared, true);
  assert.deepEqual(db.rpcCalls.map((c) => [c.name, c.body.p_expected_current_xero_contact_id, c.body.p_expected_current_xero_org_id]), [['clear_building_invoice_recipient', ADRIAN, ORG]]);
  const after = reload(B_PERSON);
  assert.equal(after.defaultRecipient, null);
  assert.equal(after.invoiceRecipient, null);
  assert.equal(currentBuildingRecipient(after, [lauraContact]).kind, 'none');
  assert.equal(JSON.stringify(db.contacts[LAURA]), lauraBefore, 'the person and their Xero link are kept');
});

test('PANEL: saves and clears always carry the recipient the manager saw, and refresh this building\'s data', () => {
  const code = readSourceFile('src', 'components', 'buildings', 'BuildingInvoiceRecipientPanel.tsx');
  assert.match(code, /setBuildingRecipient\(\{ buildingId: building\.id, xeroContactId: c\.contactId, expectedName: c\.name, \.\.\.expectedRecipientOf\(current\) \}\)/);
  assert.match(code, /clearBuildingRecipient\(\{ buildingId: building\.id, \.\.\.expectedRecipientOf\(current\) \}\)/);
  assert.match(code, /\['buildingRows'\], \['jobRows'\], \['buildingRecipientCheck', building\.id\]/);
  assert.doesNotMatch(code, /linkContact|setBuildingDefaultRecipient|from\('contacts'\)/, 'never touches people or their Xero links');
});

// ---- the live Xero check of an older contact-based default (added 2026-11-11) -----------------------------------------------------
test('LIVE CHECK (contact-based default): the same read-only check runs, through the real function - ok while the person still has that link', async () => {
  const v = await verifyBuildingDefault(B_PERSON);
  assert.equal(v.state, 'ok');
  assert.equal(v.currentName, '16-17 Marylebone Adrian Levy');
  assert.equal(db.rpcCalls.length, 0, 'read-only');
});

test('LIVE CHECK (contact-based default): stale once the person is linked elsewhere, and archived / missing in Xero are reported', async () => {
  db.contacts[LAURA].xero_contact_id = EML; // the person's link changed after the default was chosen
  assert.equal((await verifyBuildingDefault(B_PERSON)).state, 'stale');
  db.contacts[LAURA].xero_contact_id = ADRIAN;
  db.xero[ADRIAN].ContactStatus = 'ARCHIVED';
  assert.equal((await verifyBuildingDefault(B_PERSON)).state, 'not_active');
  delete db.xero[ADRIAN];
  assert.equal((await verifyBuildingDefault(B_PERSON)).state, 'not_found');
  assert.equal(db.rpcCalls.length, 0);
});

test('LIVE CHECK (contact-based default): the panel shows the result - ok, stale, a renamed contact, or that Xero could not be reached', () => {
  const ok = panel(reload(B_PERSON), {}, { state: 'ok', currentName: '16-17 Marylebone Adrian Levy' });
  assert.match(ok, /data-testid="contact-default-check"[^>]*>Checked in Xero: the contact exists, is active and has an email address\.</);
  assert.doesNotMatch(ok, /Its name in Xero is now/);
  const stale = panel(reload(B_PERSON), {}, { state: 'stale' });
  assert.match(stale, /data-testid="contact-default-check"[^>]*>This default's person has been linked to a different Xero contact since it was chosen, so it cannot be used\. Choose the building's Xero contact, or clear it\.</);
  assert.match(stale, />Clear contact-based default</, 'and it can be fixed right there');
  const renamed = panel(reload(B_PERSON), {}, { state: 'ok', currentName: 'Adrian Levy Estates' });
  assert.match(renamed, /Its name in Xero is now “Adrian Levy Estates”\./);
  assert.match(panel(reload(B_PERSON), {}, { state: 'not_active', currentName: '16-17 Marylebone Adrian Levy' }), /archived or inactive in Xero/);
  const code = readSourceFile('src', 'components', 'buildings', 'BuildingInvoiceRecipientPanel.tsx');
  assert.match(code, /enabled: current\.kind !== 'none',/, 'checked for its own recipient and for a contact-based default; never with nothing to check');
  assert.match(code, /queryKey: buildingRecipientCheckKey\(building\.id, current\.kind === 'none' \? '' : current\.xeroContactId\),/);
});
