// Deleting a contact (Building File → Contacts & Defaults). A fresh check covers all the client's buildings; the main contact, a
// building's invoice default and a contact with job-report send history are blocked with how to resolve it; otherwise the delete
// goes ahead only for the version checked (id + updated_at), the database's foreign keys still refuse anything unsafe, and the
// deletion is recorded in each building's history by name only. The repository runs against a fake database (fetch); the dialog
// is rendered to static markup with the check seeded (no DOM library in this repo).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CONTACT_DELETE_REFUSED, checkContactDeletion, deleteContact, type ContactDeletionCheck } from '../src/repository/contactsRepository';
import { contactDeletionPlan } from '../src/lib/contactDeletion';
import { HISTORY_EVENT_LABEL } from '../src/lib/historyEventLabels';
import DeleteContactDialog from '../src/components/contacts/DeleteContactDialog';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const CHECK: ContactDeletionCheck = {
  contactId: 'ct-1', name: 'Jane Smith', updatedAt: '2026-10-29T10:00:00.123456+00:00', isPrimary: false,
  defaultForBuildings: [], reportSends: 0, xeroContactName: null, linkedToXero: false, buildingCount: 3,
};

// ---- the rules ---------------------------------------------------------------------------------------------------------------
test('PLAN: nothing depends on it -> a confirmation naming the shared buildings; past invoices and reports unchanged', () => {
  const plan = contactDeletionPlan(CHECK, 'Atlas Property');
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.confirm, [
    'Contacts belong to Atlas Property and are shared by all 3 of its buildings: Jane Smith will be removed from all 3.',
    'Past invoices and job reports are not changed.',
  ]);
  assert.match(contactDeletionPlan({ ...CHECK, buildingCount: 1 }, 'Atlas').confirm[0], /shared by its building: Jane Smith will be removed from it\./);
});

test('PLAN: a Xero-linked contact can be deleted - with a warning that only the app\'s link goes and the Xero contact is untouched', () => {
  const plan = contactDeletionPlan({ ...CHECK, linkedToXero: true, xeroContactName: 'Atlas Ltd' }, 'Atlas');
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.confirm[2], 'Jane Smith is linked to the Xero contact "Atlas Ltd". Only the link in this app is removed; the Xero contact itself is not changed.');
});

test('PLAN: the main contact is blocked, with how to resolve it', () => {
  const [b] = contactDeletionPlan({ ...CHECK, isPrimary: true }, 'Atlas').blockers;
  assert.equal(b.kind, 'main_contact');
  assert.match(b.text, /Jane Smith is the main contact .*Choose another main contact first under "Job reports · default recipient", or untick "Main contact" in Edit\./);
});

test('PLAN: an invoice default on ANY of the client\'s buildings is blocked, naming those buildings and how to resolve it', () => {
  const [b] = contactDeletionPlan({ ...CHECK, defaultForBuildings: [{ id: 'b2', name: 'Flair' }, { id: 'b3', name: '1 Rec Way' }] }, 'Atlas').blockers;
  assert.equal(b.kind, 'invoice_default');
  assert.match(b.text, /^Jane Smith is the default invoice recipient for 2 buildings: Flair, 1 Rec Way\. Change or clear that default first, under "Invoices · default recipient"/);
});

test('PLAN: a contact that has been sent job reports is blocked - kept for the record (cannot be resolved); all blockers are listed', () => {
  const plan = contactDeletionPlan({ ...CHECK, reportSends: 1, isPrimary: true, defaultForBuildings: [{ id: 'b', name: 'Flair' }] }, 'Atlas');
  assert.deepEqual(plan.blockers.map((b) => b.kind), ['main_contact', 'invoice_default', 'report_history']);
  assert.equal(plan.blockers[2].text, 'Jane Smith has been sent 1 job report. The contact is kept so the record of who those reports went to stays complete, so it cannot be deleted.');
  assert.match(contactDeletionPlan({ ...CHECK, reportSends: 4 }, 'Atlas').blockers[0].text, /has been sent 4 job reports\./);
});

// ---- the repository, against a fake database ---------------------------------------------------------------------------------
type Req = { method: string; path: string; search: string; body: any; headers: Headers };
interface Fake {
  contact?: Record<string, unknown> | null;
  defaults?: { id: string; name: string | null; address: string }[];
  sends?: number;
  buildingCount?: number;
  deleted?: { id: string }[];
  deleteError?: { code: string; message: string; details?: string };
  clientBuildings?: string[];
}
async function withFakeDb(fake: Fake, run: () => Promise<void>): Promise<Req[]> {
  const seen: Req[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null;
    const search = decodeURIComponent(url.search);
    seen.push({ method, path: url.pathname, search, body, headers });
    const json = (v: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...extra } });
    const wantsObject = String(headers.get('accept') ?? '').includes('vnd.pgrst.object');
    if (url.pathname === '/rest/v1/contacts' && method === 'GET') return json(wantsObject ? (fake.contact ?? null) : fake.contact ? [fake.contact] : []);
    if (url.pathname === '/rest/v1/report_client_sends' && method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${fake.sends ?? 0}` } });
    if (url.pathname === '/rest/v1/buildings' && method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${fake.buildingCount ?? 0}` } });
    if (url.pathname === '/rest/v1/buildings' && method === 'GET' && search.includes('default_invoice_contact_id')) return json(fake.defaults ?? []);
    if (url.pathname === '/rest/v1/buildings' && method === 'GET') return json((fake.clientBuildings ?? ['b1']).map((id) => ({ id })));
    if (url.pathname === '/rest/v1/contacts' && method === 'DELETE') {
      if (fake.deleteError) return json(fake.deleteError, 409);
      return json(fake.deleted ?? []);
    }
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
const CONTACT_ROW = { id: 'ct-1', client_id: 'cl-1', name: 'Jane Smith', is_primary: false, xero_contact_id: 'XC-1', xero_contact_name: 'Atlas Ltd', updated_at: '2026-10-29T10:00:00.123456+00:00' };

test('CHECK: reads the contact (fresh version), its invoice defaults on ANY building, its report sends and the client\'s building count', async () => {
  let check: ContactDeletionCheck | null = null;
  const reqs = await withFakeDb({ contact: CONTACT_ROW, defaults: [{ id: 'b9', name: null, address: '9 Other St' }], sends: 2, buildingCount: 4 }, async () => {
    check = await checkContactDeletion('ct-1', 'cl-1');
  });
  assert.deepEqual(check, {
    contactId: 'ct-1', name: 'Jane Smith', updatedAt: '2026-10-29T10:00:00.123456+00:00', isPrimary: false,
    defaultForBuildings: [{ id: 'b9', name: '9 Other St' }], reportSends: 2, xeroContactName: 'Atlas Ltd', linkedToXero: true, buildingCount: 4,
  });
  const defaults = reqs.find((r) => r.path === '/rest/v1/buildings' && r.search.includes('default_invoice_contact_id'))!;
  assert.match(defaults.search, /default_invoice_contact_id=eq\.ct-1/);
  assert.doesNotMatch(defaults.search, /client_id/, 'every building that uses it, not only this client\'s current list');
  assert.match(reqs.find((r) => r.path === '/rest/v1/report_client_sends')!.search, /recipient_contact_id=eq\.ct-1/);
  assert.match(reqs.find((r) => r.path === '/rest/v1/buildings' && r.method === 'HEAD')!.search, /client_id=eq\.cl-1/);
  assert.equal(reqs.filter((r) => r.method !== 'GET' && r.method !== 'HEAD').length, 0, 'the check writes nothing');
});

test('CHECK: a contact that is gone, or belongs to another client, comes back as null (nothing to delete)', async () => {
  let a: unknown = 'x';
  let b: unknown = 'x';
  await withFakeDb({ contact: null }, async () => { a = await checkContactDeletion('ct-1', 'cl-1'); });
  await withFakeDb({ contact: { ...CONTACT_ROW, client_id: 'other' } }, async () => { b = await checkContactDeletion('ct-1', 'cl-1'); });
  assert.equal(a, null);
  assert.equal(b, null);
});

test('DELETE: one contact, by id AND client AND the version checked; then "Contact deleted: {name}" in each building\'s history', async () => {
  const reqs = await withFakeDb({ deleted: [{ id: 'ct-1' }], clientBuildings: ['b1', 'b2'] }, () => deleteContact('ct-1', 'cl-1', '2026-10-29T10:00:00.123456+00:00', 'Jane Smith'));
  const del = reqs.filter((r) => r.path === '/rest/v1/contacts' && r.method === 'DELETE');
  assert.equal(del.length, 1);
  assert.match(del[0].search, /id=eq\.ct-1/);
  assert.match(del[0].search, /client_id=eq\.cl-1/);
  assert.match(del[0].search, /updated_at=eq\.2026-10-29T10:00:00\.123456\+00:00/);
  assert.match(del[0].search, /select=id/, 'reads back the row it deleted');
  const h = history(reqs);
  assert.deepEqual(h.map((e) => [e.entity_type, e.entity_id, e.event_type, e.detail]), [
    ['building', 'b1', 'contact_deleted', 'Contact deleted: Jane Smith'],
    ['building', 'b2', 'contact_deleted', 'Contact deleted: Jane Smith'],
  ]);
  assert.equal(HISTORY_EVENT_LABEL.contact_deleted, 'Contact deleted');
  assert.equal(reqs.filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && !['/rest/v1/contacts', '/rest/v1/activity_events'].includes(r.path)).length, 0, 'nothing else is written (no invoice, building or Xero call)');
});

test('CONCURRENT CHANGE: if the contact changed (or went) after it was checked, nothing is deleted or recorded', async () => {
  let err: unknown;
  const reqs = await withFakeDb({ deleted: [] }, async () => {
    try { await deleteContact('ct-1', 'cl-1', 'old-version', 'Jane Smith'); } catch (e) { err = e; }
  });
  assert.equal((err as Error).message, CONTACT_DELETE_REFUSED.changed);
  assert.deepEqual(history(reqs), []);
});

test('DATABASE REFUSALS: a building default or report send history added meanwhile -> a plain message; nothing recorded', async () => {
  const cases = [
    [{ code: '23503', message: 'update or delete on table "contacts" violates foreign key constraint "buildings_default_invoice_contact_id_fkey" on table "buildings"' }, CONTACT_DELETE_REFUSED.invoiceDefault],
    [{ code: '23503', message: 'update or delete on table "contacts" violates foreign key constraint "report_client_sends_recipient_contact_id_fkey" on table "report_client_sends"' }, CONTACT_DELETE_REFUSED.reportHistory],
    [{ code: '42501', message: 'permission denied' }, 'The contact could not be deleted: permission denied'],
  ] as const;
  for (const [deleteError, message] of cases) {
    let err: unknown;
    const reqs = await withFakeDb({ deleteError: { ...deleteError } }, async () => {
      try { await deleteContact('ct-1', 'cl-1', 'v', 'Jane Smith'); } catch (e) { err = e; }
    });
    assert.equal((err as Error).message, message);
    assert.deepEqual(history(reqs), [], message);
  }
});

test('HISTORY: the name only - never the email address or phone number', () => {
  const repo = src('src', 'repository', 'contactsRepository.ts');
  const fn = repo.slice(repo.indexOf('export async function deleteContact('));
  assert.match(fn, /await logContactActivity\(clientId, 'contact_deleted', `Contact deleted: \$\{name\}`\);/);
  assert.doesNotMatch(fn, /email|phone/i);
});

// ---- the dialog ----------------------------------------------------------------------------------------------------------------
const renderDialog = (check: ContactDeletionCheck | null | undefined) => {
  const qc = new QueryClient();
  if (check !== undefined) qc.setQueryData(['contactDeletionCheck', 'ct-1'], check);
  return decode(renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <DeleteContactDialog contactId="ct-1" contactName="Jane Smith" clientId="cl-1" clientName="Atlas Property" onClose={() => {}} onDeleted={() => {}} />
    </QueryClientProvider>,
  ));
};

test('DIALOG: while checking it says so, and offers no Delete', () => {
  const html = renderDialog(undefined);
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Delete contact: Jane Smith"/);
  assert.match(html, /Checking what depends on this contact…/);
  assert.doesNotMatch(html, />Delete contact<\/button>/);
});

test('DIALOG: blocked -> why and how to resolve, only a Close button (no Delete)', () => {
  const html = renderDialog({ ...CHECK, isPrimary: true, reportSends: 2 });
  assert.match(html, /data-testid="delete-contact-blocked"/);
  assert.match(html, /data-blocker="main_contact"[^>]*>Jane Smith is the main contact/);
  assert.match(html, /data-blocker="report_history"[^>]*>Jane Smith has been sent 2 job reports\./);
  assert.doesNotMatch(html, />Delete contact<\/button>/);
  assert.match(html, />Close<\/button>/);
});

test('DIALOG: deletable -> the confirmation (shared buildings, Xero line when linked) with Delete contact and Cancel', () => {
  const html = renderDialog({ ...CHECK, linkedToXero: true, xeroContactName: 'Atlas Ltd' });
  assert.match(html, /data-testid="delete-contact-confirm"/);
  assert.match(html, /shared by all 3 of its buildings: Jane Smith will be removed from all 3\./);
  assert.match(html, /Only the link in this app is removed; the Xero contact itself is not changed\./);
  assert.match(html, />Delete contact<\/button>/);
  assert.match(html, />Cancel<\/button>/);
  assert.doesNotMatch(renderDialog(CHECK), /Xero contact/, 'no Xero line when not linked');
});

test('DIALOG: a contact that no longer exists for this client says so; nothing can be deleted', () => {
  const html = renderDialog(null);
  assert.match(html, /This contact no longer exists for this client\. Nothing was deleted\./);
  assert.doesNotMatch(html, />Delete contact<\/button>/);
});

test('DIALOG: deletes exactly the version checked; Escape / close / Cancel close it, never while deleting', () => {
  const d = src('src', 'components', 'contacts', 'DeleteContactDialog.tsx');
  assert.match(d, /return deleteContact\(c\.contactId, clientId, c\.updatedAt, c\.name\);/);
  assert.match(d, /const close = \(\) => \{\s+if \(!remove\.isPending\) onClose\(\);/);
  assert.match(d, /if \(e\.key === 'Escape'\) close\(\);/);
  assert.match(d, /aria-label="Close"[\s\S]{0,260}autoFocus/, 'focus starts on Close: inside the dialog (Escape works) and on the safe choice');
  assert.match(d, /backdropDismiss\(remove\.isPending \? undefined : onClose\)/);
  assert.doesNotMatch(d, /xeroLinks|xero-link|sendInvoice|invoicesRepository|from\('invoices'\)/, 'no Xero or invoice calls');
});

// ---- the tab -------------------------------------------------------------------------------------------------------------------
test('TAB: Delete beside Edit on every contact; after a delete the lists, buildings and history refresh and a notice says so', () => {
  const tab = src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx');
  assert.match(tab, /aria-label=\{`Delete \$\{c\.name\}`\}[^>]*>\s*Delete\s*<\/button>/);
  assert.ok(tab.indexOf('aria-label={`Edit ${c.name}`}') < tab.indexOf('aria-label={`Delete ${c.name}`}'), 'beside Edit');
  assert.match(tab, /for \(const queryKey of \[\.\.\.refreshKeys, \['buildingRows'\]\]\) void queryClient\.invalidateQueries\(\{ queryKey \}\);/);
  assert.match(tab, /setNotice\(`\$\{name\} was deleted\.`\);/);
  assert.match(tab, /const refreshKeys = \[\['contacts', building\.clientId\], \['jobRows'\], \['historicalJobRows'\], \['buildingHistory', building\.id\]\];/);
});

test('SCOPE: no Edge Function, invoice or Xero code changed for this; the database rules are the existing foreign keys', () => {
  const repo = src('src', 'repository', 'contactsRepository.ts');
  const fns = repo.slice(repo.indexOf('export interface ContactDeletionCheck'));
  assert.doesNotMatch(fns, /functions\.invoke|from\('invoices'\)|xero-link-contact|\.update\(/);
  const sql = src('supabase', 'migrations', '20261017120000_xero_recipient_links.sql');
  assert.match(sql, /default_invoice_contact_id uuid references public\.contacts \(id\) on delete restrict/);
  assert.match(src('supabase', 'migrations', '20260911151021_report_client_sends.sql'), /recipient_contact_id uuid references public\.contacts\(id\),/);
});
