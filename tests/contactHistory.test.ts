// Contact history (activity_events, one entry per building of the client): an update names the fields that changed (never their
// values), nothing is recorded when nothing changed, and a main-contact change records BOTH sides - the contact that became main
// and the one that is no longer main (only when one was actually replaced). Exercised through the real repository functions
// against a fake database (fetch), as in accountsOnlyContacts.test.tsx.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contactChangeSummary, createContactForClient, updateContact } from '../src/repository/contactsRepository';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

type Req = { method: string; path: string; search: string; body: any };
/** `before`: the saved contact updateContact reads first. `mains`: the client's other main contacts the demotion update would change. */
async function withFakeDb(opts: { before?: Record<string, unknown> | null; mains?: { id: string; name: string }[]; buildings?: string[] }, run: () => Promise<void>): Promise<Req[]> {
  const seen: Req[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null;
    seen.push({ method, path: url.pathname, search: decodeURIComponent(url.search), body });
    const wantsObject = String(new Headers(init?.headers).get('accept') ?? '').includes('vnd.pgrst.object');
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/rest/v1/contacts' && method === 'POST') {
      const row = Array.isArray(body) ? body[0] : body;
      const created = { id: 'new-1', role: null, notes: null, xero_contact_id: null, xero_org_id: null, xero_contact_name: null, xero_linked_at: null, is_accounts_contact: false, ...row };
      return json(wantsObject ? created : [created]);
    }
    // The demotion: an update of the client's current main contact(s), returning the rows it changed.
    if (url.pathname === '/rest/v1/contacts' && method === 'PATCH' && url.search.includes('is_primary=eq.true')) return json(opts.mains ?? []);
    if (url.pathname === '/rest/v1/contacts' && method === 'GET') return opts.before ? json(wantsObject ? opts.before : [opts.before]) : json(wantsObject ? null : []);
    if (url.pathname === '/rest/v1/buildings' && method === 'GET') return json((opts.buildings ?? ['b1']).map((id) => ({ id })));
    return new Response(null, { status: method === 'POST' ? 201 : 204 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}
const history = (r: Req[]) => r.filter((x) => x.path === '/rest/v1/activity_events' && x.method === 'POST').map((x) => (Array.isArray(x.body) ? x.body[0] : x.body));
const details = (r: Req[]) => history(r).map((h) => h.detail);
const SAVED = { name: 'Jane Smith', email: 'jane@client.test', phone_number: null, is_primary: false, is_accounts_contact: false };

// ---- which fields changed ------------------------------------------------------------------------------------------------------
test('FIELDS: each changed field is named; values (email, phone) are never written to the history', async () => {
  assert.deepEqual(details(await withFakeDb({ before: SAVED }, () => updateContact('ct-1', 'c1', { phoneNumber: '0207 111 2222' }))), ['Contact updated: Jane Smith (phone)']);
  assert.deepEqual(details(await withFakeDb({ before: SAVED }, () => updateContact('ct-1', 'c1', { email: 'j.smith@client.test', phoneNumber: '0207' }))), ['Contact updated: Jane Smith (email, phone)']);
  assert.deepEqual(details(await withFakeDb({ before: SAVED }, () => updateContact('ct-1', 'c1', { name: 'Jane Smyth' }))), ['Contact updated: Jane Smyth (name)'], 'under the new name');
  assert.deepEqual(details(await withFakeDb({ before: SAVED }, () => updateContact('ct-1', 'c1', { isAccountsContact: true }))), ['Contact updated: Jane Smith (marked accounts only)'], 'the existing wording is kept');
  assert.deepEqual(details(await withFakeDb({ before: { ...SAVED, is_accounts_contact: true } }, () => updateContact('ct-1', 'c1', { isAccountsContact: false }))), ['Contact updated: Jane Smith (no longer accounts only)']);
  const all = details(await withFakeDb({ before: SAVED }, () => updateContact('ct-1', 'c1', { email: 'x@y.test', phoneNumber: '0207 999', isAccountsContact: true })));
  assert.deepEqual(all, ['Contact updated: Jane Smith (email, phone, marked accounts only)']);
  assert.doesNotMatch(all.join(' '), /x@y\.test|0207/, 'no email address or phone number in the history');
});

test('NO CHANGE: saving the same values (or an emptied field that was already empty) records nothing', async () => {
  assert.deepEqual(details(await withFakeDb({ before: SAVED }, () => updateContact('ct-1', 'c1', { name: 'Jane Smith', email: 'jane@client.test', phoneNumber: null, isPrimary: false, isAccountsContact: false }))), []);
  assert.deepEqual(details(await withFakeDb({ before: SAVED }, () => updateContact('ct-1', 'c1', {}))), []);
  assert.deepEqual(contactChangeSummary(SAVED, { phoneNumber: null, email: 'jane@client.test' }), []);
});

test('ONE ENTRY PER BUILDING of the client, as before (contacts are shared by all its buildings)', async () => {
  const h = history(await withFakeDb({ before: SAVED, buildings: ['b1', 'b2'] }, () => updateContact('ct-1', 'c1', { phoneNumber: '0207' })));
  assert.deepEqual(h.map((e) => [e.entity_type, e.entity_id, e.event_type, e.detail]), [
    ['building', 'b1', 'contact_updated', 'Contact updated: Jane Smith (phone)'],
    ['building', 'b2', 'contact_updated', 'Contact updated: Jane Smith (phone)'],
  ]);
});

// ---- main contact: both sides --------------------------------------------------------------------------------------------------
test('MAIN: making a contact main records the new main contact AND the one it replaced (once each)', async () => {
  const reqs = await withFakeDb({ before: SAVED, mains: [{ id: 'ct-old', name: 'Old Main' }] }, () => updateContact('ct-1', 'c1', { isPrimary: true }));
  assert.deepEqual(details(reqs), ['Contact updated: Old Main (no longer main contact)', 'Contact updated: Jane Smith (now main contact)']);
  const demote = reqs.find((r) => r.method === 'PATCH' && r.search.includes('is_primary=eq.true'))!;
  assert.match(demote.search, /client_id=eq\.c1/);
  assert.match(demote.search, /id=neq\.ct-1/, 'never the contact being made main');
  assert.match(demote.search, /select=id,name/, 'reads back exactly the rows it changed');
  assert.deepEqual(demote.body, { is_primary: false });
});

test('MAIN: no demotion entry when the client had no other main contact', async () => {
  const reqs = await withFakeDb({ before: SAVED, mains: [] }, () => updateContact('ct-1', 'c1', { isPrimary: true }));
  assert.deepEqual(details(reqs), ['Contact updated: Jane Smith (now main contact)']);
});

test('MAIN: re-saving a contact that is already main records nothing (no false promotion or demotion)', async () => {
  const reqs = await withFakeDb({ before: { ...SAVED, is_primary: true }, mains: [] }, () => updateContact('ct-1', 'c1', { isPrimary: true }));
  assert.deepEqual(details(reqs), []);
});

test('MAIN: un-ticking main contact records only that (nobody else is touched)', async () => {
  const reqs = await withFakeDb({ before: { ...SAVED, is_primary: true } }, () => updateContact('ct-1', 'c1', { isPrimary: false }));
  assert.deepEqual(details(reqs), ['Contact updated: Jane Smith (no longer main contact)']);
  assert.equal(reqs.filter((r) => r.method === 'PATCH' && r.search.includes('is_primary=eq.true')).length, 0, 'no demotion query');
});

test('MAIN with other fields: one entry for the contact listing every change, plus the demotion', async () => {
  const reqs = await withFakeDb({ before: SAVED, mains: [{ id: 'ct-old', name: 'Old Main' }] }, () => updateContact('ct-1', 'c1', { phoneNumber: '0207', isPrimary: true }));
  assert.deepEqual(details(reqs), ['Contact updated: Old Main (no longer main contact)', 'Contact updated: Jane Smith (phone, now main contact)']);
});

// ---- creation ------------------------------------------------------------------------------------------------------------------
test('CREATE: a new contact marked main that replaces one records both: "Contact added: … (main contact)" and the demotion', async () => {
  const reqs = await withFakeDb({ mains: [{ id: 'ct-old', name: 'Old Main' }] }, async () => {
    await createContactForClient('c1', { name: 'New Main', email: null, phoneNumber: null, isPrimary: true });
  });
  assert.deepEqual(details(reqs), ['Contact updated: Old Main (no longer main contact)', 'Contact added: New Main (main contact)']);
  const demote = reqs.find((r) => r.method === 'PATCH' && r.search.includes('is_primary=eq.true'))!;
  assert.doesNotMatch(demote.search, /id=neq/, 'a new contact has no id yet: every current main contact of the client is replaced');
});

test('CREATE: the first contact (main, nobody replaced) has no demotion entry; accounts-only wording kept; ordinary add unchanged', async () => {
  assert.deepEqual(details(await withFakeDb({ mains: [] }, async () => { await createContactForClient('c1', { name: 'First', email: null, phoneNumber: null, isPrimary: true }); })), ['Contact added: First (main contact)']);
  assert.deepEqual(details(await withFakeDb({}, async () => { await createContactForClient('c1', { name: 'Pat', email: null, phoneNumber: null, isPrimary: false }); })), ['Contact added: Pat']);
  assert.deepEqual(details(await withFakeDb({}, async () => { await createContactForClient('c1', { name: 'Acc', email: null, phoneNumber: null, isPrimary: false, isAccountsContact: true }); })), ['Contact added: Acc (accounts only)']);
  assert.deepEqual(details(await withFakeDb({ mains: [] }, async () => { await createContactForClient('c1', { name: 'Both', email: null, phoneNumber: null, isPrimary: true, isAccountsContact: true }); })), ['Contact added: Both (main contact, accounts only)']);
});

test('UNCHANGED: what is written to the contact row is exactly as before (only the history text changed)', async () => {
  const reqs = await withFakeDb({ before: SAVED, mains: [{ id: 'ct-old', name: 'Old Main' }] }, () => updateContact('ct-1', 'c1', { phoneNumber: '0207', isPrimary: true }));
  const own = reqs.find((r) => r.method === 'PATCH' && r.search.includes('id=eq.ct-1'))!;
  assert.deepEqual(own.body, { phone_number: '0207', is_primary: true });
  const order = reqs.filter((r) => r.path === '/rest/v1/contacts' && r.method === 'PATCH').map((r) => (r.search.includes('is_primary=eq.true') ? 'demote' : 'save'));
  assert.deepEqual(order, ['demote', 'save'], 'the old main contact is cleared first (one main contact per client)');
});

// ---- the stale notice ----------------------------------------------------------------------------------------------------------
test('NOTICE: starting another edit, or opening "+ Add contact" (either button), clears the last save\'s notice', () => {
  const tab = readFileSync(join(process.cwd(), 'src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(tab, /if \(editingId !== c\.id\) \{\s+setNotice\(null\);\s+setJustAddedId\(null\);\s+\}\s+setEditingId\(editingId === c\.id \? null : c\.id\);/);
  assert.match(tab, /setAddingContact\(true\);\s+setAddingForXero\(false\);\s+setNotice\(null\);\s+setJustAddedId\(null\);/, '+ Add contact');
  assert.match(tab, /setAddingForXero\(true\);\s+setAddingContact\(true\);\s+setNotice\(null\);\s+setJustAddedId\(null\);/, '+ Add a new contact (Find in Xero)');
  assert.match(tab, /setNotice\(changed \? `\$\{saved\.name\} was updated\.` : `No changes to \$\{saved\.name\}\.`\);/, 'the notice is set only when that save has finished (onSaved)');
});
