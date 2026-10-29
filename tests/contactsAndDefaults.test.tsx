// Building File → Contacts & Defaults: contacts (client-wide) are added, edited, classified and linked to Xero in one place;
// the job-report default is the client's main (primary) contact - the existing, client-wide contacts.is_primary, never an
// accounts-only contact; the invoice default stays per building (server-validated). The Site file only summarises, and the
// invoice editor shows its recipient with "Change for this invoice" (never changing a saved default). Components are rendered
// to static markup (there is no DOM library in this repo); wiring and safeguards are checked from source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSourceFile } from './helpers/sourceCode';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import ContactsAndDefaultsTab from '../src/components/buildings/ContactsAndDefaultsTab';
import ReportDefaultPanel from '../src/components/buildings/ReportDefaultPanel';
import EditContactForm, { changedFields, editFormFrom } from '../src/components/contacts/EditContactForm';
import { REPORT_DEFAULT_PROBLEM, reportDefaultSummary, resolveDisplayContact } from '../src/lib/contactDisplay';

const src = (...p: string[]) => readSourceFile(...p);
const noComments = (code: string) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const wrap = (el: React.ReactElement) => decode(renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>));

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contact = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, clientId: 'cl1', name, role: null, email: `${id}@client.test`, phoneNumber: null, isPrimary: false, isAccountsContact: false, notes: null, xeroContactId: null, xeroOrgId: null, xeroContactName: null, xeroLinkedAt: null, ...extra }) as any;
const OPS = contact('ops', 'Olly Ops');
const MAIN = contact('main', 'Mia Main', { isPrimary: true });
const ACC = contact('acc', 'Accounts Team', { isAccountsContact: true });
const ACC_MAIN = contact('accmain', 'Accounts Main', { isAccountsContact: true, isPrimary: true });
const LINKED = contact('lnk', 'Lee Linked', { xeroContactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', xeroOrgId: ORG, xeroContactName: 'Lee Ltd' });
const building = (over: Record<string, unknown> = {}) =>
  ({ id: 'b1', clientId: 'cl1', clientName: 'Atlas Property', name: 'Flair', buildingName: 'Flair', invoiceDetails: '', defaultRecipient: null, ...over }) as any;

// ---- the job-report default -----------------------------------------------------------------------------------------------------
test('REPORT DEFAULT: the only ordinary contact, else the ordinary main contact - exactly what Ready for client preselects', () => {
  assert.deepEqual(reportDefaultSummary([OPS]), { kind: 'contact', contact: OPS, via: 'only_contact' });
  assert.deepEqual(reportDefaultSummary([OPS, MAIN]), { kind: 'contact', contact: MAIN, via: 'main_contact' });
  assert.deepEqual(reportDefaultSummary([OPS, ACC]), { kind: 'contact', contact: OPS, via: 'only_contact' }, 'accounts-only contacts are not counted');
});

test('REPORT DEFAULT: never an accounts-only contact, and each "none" says why', () => {
  assert.deepEqual(reportDefaultSummary([]), { kind: 'none', why: 'no_contacts' });
  assert.deepEqual(reportDefaultSummary([ACC]), { kind: 'none', why: 'all_accounts_only' });
  assert.deepEqual(reportDefaultSummary([OPS, MAIN.isPrimary ? contact('o2', 'Other') : OPS, ACC_MAIN]), { kind: 'none', why: 'main_is_accounts_only' });
  assert.deepEqual(reportDefaultSummary([OPS, contact('o2', 'Other')]), { kind: 'none', why: 'no_main' });
  for (const why of ['no_contacts', 'all_accounts_only', 'main_is_accounts_only', 'no_main'] as const) assert.ok(REPORT_DEFAULT_PROBLEM[why].length > 20, why);
  assert.deepEqual(resolveDisplayContact([OPS, ACC_MAIN]), { kind: 'primary', contact: ACC_MAIN }, 'the grid rule is unchanged (it still shows the main contact)');
});

// ---- editing a contact --------------------------------------------------------------------------------------------------------
test('EDIT: the form starts from the saved values (main contact and accounts-only included)', () => {
  assert.deepEqual(editFormFrom(contact('x', 'X', { email: null, phoneNumber: '0207', isPrimary: true, isAccountsContact: true })), {
    name: 'X', email: '', phoneNumber: '0207', isPrimary: true, isAccountsContact: true,
  });
  assert.equal(editFormFrom(contact('y', 'Y', { isAccountsContact: undefined })).isAccountsContact, false);
});

test('EDIT: only fields that really changed are written (an unrelated edit never touches main contact or accounts-only)', () => {
  const saved = editFormFrom(contact('x', 'X', { isPrimary: true, isAccountsContact: true }));
  assert.deepEqual(changedFields(saved, { name: 'X', email: 'x@client.test', phoneNumber: '0207', isPrimary: true, isAccountsContact: true }), { phoneNumber: '0207' });
  assert.deepEqual(changedFields(saved, { name: 'X', email: 'x@client.test', phoneNumber: null, isPrimary: true, isAccountsContact: true }), {}, 'nothing changed');
  assert.deepEqual(changedFields(saved, { name: 'X', email: null, phoneNumber: null, isPrimary: false, isAccountsContact: false }), { email: null, isPrimary: false, isAccountsContact: false });
});

test('EDIT: the rendered form - fields seeded, main contact explained as client-wide, accounts-only explained', () => {
  const html = wrap(
    <EditContactForm clientId="cl1" clientName="Atlas Property" contact={MAIN} contacts={[MAIN, OPS]} buildingCount={3} refreshKeys={[['contacts', 'cl1']]} onCancel={() => {}} onSaved={() => {}} />,
  );
  assert.match(html, /value="Mia Main"/);
  assert.match(html, /value="main@client\.test"/);
  assert.match(html, /<input type="checkbox" class="mt-0\.5" checked=""\/><span>Main contact/);
  assert.match(html, /The default recipient of job reports and the contact shown in the jobs grid, for all 3 of Atlas Property's buildings\./);
  assert.match(html, /Accounts only<span[^>]*>For invoices\. Never chosen automatically as the recipient of a job report\.<\/span>/);
  assert.match(html, />Save changes<\/button>/);
});

test('EDIT: saving is the existing updateContact by id, with the shared checks and the same duplicate-email confirmation', () => {
  const form = noComments(src('src', 'components', 'contacts', 'EditContactForm.tsx'));
  assert.match(form, /await updateContact\(contact\.id, clientId, patch\);/);
  assert.match(form, /checkContactForm\(form, contacts, contact\.id, \{ allowDuplicateEmail \}\)/);
  assert.match(form, /duplicateEmailWarning\(duplicate\.name\)/);
  assert.match(form, /onClick=\{\(\) => submit\(true\)\}/, 'a duplicate email needs its own explicit confirmation');
  assert.doesNotMatch(form, /xero|linkContact|createContactForClient|sendInvoice/i, 'editing never links, creates or sends anything');
  assert.match(src('src', 'repository', 'contactsRepository.ts'), /if \(patch\.isPrimary\) await unsetOtherPrimaryContacts\(clientId, contactId\);/, 'one main contact per client');
});

// ---- the report-default panel ---------------------------------------------------------------------------------------------------
test('REPORT PANEL: shows the main contact; accounts-only contacts are never offered; applies to every building of the client', () => {
  const html = wrap(<ReportDefaultPanel clientId="cl1" clientName="Atlas Property" contacts={[MAIN, OPS, ACC]} buildingCount={2} refreshKeys={[]} />);
  assert.match(html, /Job reports · default recipient/);
  assert.match(html, /it applies to all 2 of Atlas Property's buildings/);
  assert.match(html, />Mia Main<\/div>/);
  assert.match(html, /· main contact/);
  assert.match(html, />Change main contact<\/button>/);
  assert.doesNotMatch(html, /<select/, 'the picker opens from "Change main contact"');
});

test('REPORT PANEL: with no default it says why and offers only operational contacts', () => {
  const html = wrap(<ReportDefaultPanel clientId="cl1" clientName="Atlas" contacts={[OPS, contact('o2', 'Other'), ACC]} buildingCount={1} refreshKeys={[]} />);
  assert.match(html, new RegExp(REPORT_DEFAULT_PROBLEM.no_main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /<option value="ops"(?: class="[^"]*")?>Olly Ops — ops@client\.test<\/option>/);
  assert.match(html, /<option value="o2"(?: class="[^"]*")?>Other — o2@client\.test<\/option>/);
  assert.doesNotMatch(html, /<option value="acc"/, 'accounts-only is never offered as the report default');
  const onlyAcc = wrap(<ReportDefaultPanel clientId="cl1" clientName="Atlas" contacts={[ACC]} buildingCount={1} refreshKeys={[]} />);
  assert.match(onlyAcc, /Add an operational \(not accounts-only\) contact, above, to set a default\./);
  assert.doesNotMatch(onlyAcc, /<select/);
});

test('REPORT PANEL: saving sets ONLY the main-contact flag, through updateContact (history logged, old main cleared)', () => {
  const panel = noComments(src('src', 'components', 'buildings', 'ReportDefaultPanel.tsx'));
  assert.match(panel, /await updateContact\(contactId, clientId, \{ isPrimary: true \}\);/);
  assert.match(panel, /const eligible = contacts\.filter\(\(c\) => c\.isAccountsContact !== true\);/);
  assert.doesNotMatch(panel, /from\('contacts'\)|supabase|migration/, 'no new field and no direct write');
});

// ---- the tab -----------------------------------------------------------------------------------------------------------------------
const renderTab = (contacts: any[], buildingCount = 2, over: Record<string, unknown> = {}) =>
  wrap(<ContactsAndDefaultsTab building={building(over)} contacts={contacts} contactsLoading={false} contactsError={false} buildingCount={buildingCount} />);

test('TAB: says contacts are client-wide (shared by every building) and the invoice default is this building only', () => {
  const html = renderTab([MAIN, OPS, LINKED], 3);
  assert.match(html, /Contacts belong to <span class="font-semibold">Atlas Property<\/span> and are shared by all 3 of its buildings: a change here applies to every one of them\.\s+The invoice default below is for this building only\./);
  assert.match(html, /data-testid="manage-contacts"/);
  assert.match(html, /data-testid="find-xero-contact"/);
  assert.match(html, /data-testid="report-default"/);
  assert.match(html, /data-testid="invoice-default"/);
});

test('TAB: each contact shows badges and Xero state, with Edit, Link to Xero / Change Xero link, and Verify for linked ones', () => {
  const html = renderTab([MAIN, ACC, LINKED]);
  assert.equal((html.match(/data-testid="contact-row"/g) ?? []).length, 3);
  assert.match(html, />Main contact<\/span>/);
  assert.match(html, />Accounts only<\/span>/);
  assert.match(html, /✓ Linked to Xero: Lee Ltd/);
  assert.match(html, /aria-label="Edit Mia Main"[^>]*>Edit<\/button>/);
  assert.match(html, /aria-label="Link Mia Main"[^>]*>Link to Xero<\/button>/);
  assert.match(html, /aria-label="Change the Xero link of Lee Linked"[^>]*>Change Xero link<\/button>/);
  assert.match(html, /aria-label="Verify the Xero link of Lee Linked"[^>]*>Verify<\/button>/);
  assert.doesNotMatch(html, /aria-label="Verify the Xero link of Mia Main"/, 'nothing to verify on an unlinked contact');
});

test('TAB: a filter appears for longer lists; the empty client says so; loading and errors are explained', () => {
  assert.doesNotMatch(renderTab([MAIN, OPS]), /aria-label="Filter contacts"/);
  assert.match(renderTab([MAIN, OPS, ACC, LINKED]), /aria-label="Filter contacts"/);
  assert.match(renderTab([]), /No contacts recorded for Atlas Property yet\./);
  const loading = wrap(<ContactsAndDefaultsTab building={building()} contacts={[]} contactsLoading contactsError={false} buildingCount={1} />);
  assert.match(loading, /Loading contacts…/);
  const failed = wrap(<ContactsAndDefaultsTab building={building()} contacts={[]} contactsLoading={false} contactsError buildingCount={1} />);
  assert.match(failed, /Couldn't load contacts\./);
});

test('TAB: every write is an existing, guarded path; nothing creates a Xero contact or touches an invoice', () => {
  const tab = noComments(src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx'));
  assert.doesNotMatch(tab, /supabase|from\('contacts'\)|sendInvoice|xero-create-invoice|invoicesRepository|createXeroContact/);
  assert.match(tab, /verifyContactLink\(id\)/, 'verify is the read-only check');
  assert.match(tab, /<BuildingDefaultRecipientPanel building=\{building\} contacts=\{contacts\} \/>/, 'the invoice default keeps its server-validated panel');
});

// ---- the page -----------------------------------------------------------------------------------------------------------------------
test('PAGE: the tab is in the URL (?tab=contacts / ?tab=history; anything else is the Site file), replacing history entries', () => {
  const page = noComments(src('src', 'pages', 'BuildingFilePage.tsx'));
  assert.match(page, /return value === 'contacts' \|\| value === 'history' \? value : 'site';/);
  assert.match(page, /const tab = tabFromParam\(searchParams\.get\('tab'\)\);/);
  assert.match(page, /if \(next === 'site'\) updated\.delete\('tab'\);\s+else updated\.set\('tab', next\);/);
  assert.match(page, /\{ replace: true \}/);
  assert.match(page, /contacts: 'Contacts & Defaults'/);
  assert.match(page, /tab === 'contacts' \? \(\s+<ContactsAndDefaultsTab/);
  assert.match(page, /buildingCount=\{buildings\.filter\(\(b\) => b\.clientId === building\.clientId\)\.length\}/);
});

// ---- the invoice editor -----------------------------------------------------------------------------------------------------------
test('INVOICE: "Change for this invoice" only opens the picker for this invoice - it never changes a saved default or a contact', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  assert.match(editor, /onClick=\{\(\) => setChooseOtherContact\(true\)\}[\s\S]{0,700}Change for this invoice/);
  assert.doesNotMatch(editor, /setBuildingDefaultRecipient|clearBuildingDefaultRecipient|updateContact|createContactForClient|contactsRepository/);
  assert.match(editor, /For this invoice only: the building&apos;s default is not changed\./);
});

test('INVOICE: no usable default -> why, plus "Set up contacts & defaults" in a NEW tab (unsaved invoice edits kept) and a reload', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  assert.match(editor, /\{defaultProblem \?\? 'This building has no default invoice recipient, so one is chosen for each invoice\.'\}/);
  assert.match(editor, /href=\{`\/buildings\/\$\{buildingId\}\?tab=contacts`\}\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(editor, /void queryClient\.invalidateQueries\(\{ queryKey: \['jobRows'\] \}\)/);
});

test('UNCHANGED: no schema or Edge Function change - report sending and invoice sending read the same fields as before', () => {
  const report = noComments(src('supabase', 'functions', 'send-client-report', 'index.ts'));
  assert.doesNotMatch(report, /is_primary|is_accounts_contact/, 'the report server still takes the chosen contact only');
  const recipients = noComments(src('supabase', 'functions', '_shared', 'invoiceRecipients.ts'));
  assert.match(recipients, /default_invoice_contact_id/, 'the invoice default is still the building fields');
  assert.doesNotMatch(recipients, /is_primary/, 'the main contact never decides an invoice recipient');
});
