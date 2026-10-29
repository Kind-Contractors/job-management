// Accounts-only contacts: Luke can mark a contact as accounts-only (invoices; never chosen automatically for job reports) in All
// Live Jobs' contact popover and the shared new-contact form (Building File, invoice screen). The flag is never inferred and is
// written only when explicitly given, so saving other fields never changes it. The job-report picker labels accounts-only
// contacts and never preselects one, but a deliberate choice is allowed (with a warning). Invoicing and Xero linking are unchanged.
// Real code under a fake fetch (no network: the app's Supabase URL is tests.invalid) and static page renders.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { ACCOUNTS_ONLY_HINT, ACCOUNTS_ONLY_LABEL, BLANK_CONTACT_FORM, checkContactForm } from '../src/lib/contactForm';
import { resolveDisplayContact, resolveReportRecipientDefault } from '../src/lib/contactDisplay';
import { createContactForClient, updateContact } from '../src/repository/contactsRepository';
import NewContactForm from '../src/components/contacts/NewContactForm';
import InvoiceEditor from '../src/components/jobs/InvoiceEditor';
import ReadyForClientPage from '../src/pages/ReadyForClientPage';
import { AuthContext } from '../src/auth/AuthProvider';
import type { InvoiceDetail, JobContactSummary } from '../src/domain/types';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (code: string) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function contact(id: string, name: string, over: Partial<JobContactSummary> = {}): JobContactSummary {
  return {
    id, name, email: `${id}@client.test`, phoneNumber: null, isPrimary: false, isAccountsContact: false,
    xeroContactId: null, xeroOrgId: null, xeroContactName: null, xeroLinkedAt: null, ...over,
  };
}
const OPS = contact('ops', 'Sam Ops');
const ACC = contact('acc', 'Accounts Team', { isAccountsContact: true });

// ---- the form: unchecked by default, passed through, never inferred ---------------------------------------------------------
test('FORM 1: a new contact starts NOT accounts-only; the checkbox value is passed through exactly as chosen', () => {
  assert.equal(BLANK_CONTACT_FORM.isAccountsContact, false);
  const marked = checkContactForm({ ...BLANK_CONTACT_FORM, name: 'Accounts Team', email: 'acc@client.test', isAccountsContact: true }, []);
  assert.deepEqual(marked.ok && marked.input.isAccountsContact, true);
  const plain = checkContactForm({ ...BLANK_CONTACT_FORM, name: 'Sam', email: 'sam@client.test' }, []);
  assert.deepEqual(plain.ok && plain.input.isAccountsContact, false);
});

test('FORM 2: the classification is never inferred from the name or the email address', () => {
  const r = checkContactForm({ ...BLANK_CONTACT_FORM, name: 'Accounts Payable', email: 'accounts@client.test' }, []);
  assert.equal(r.ok && r.input.isAccountsContact, false, 'an "accounts" name or mailbox does not mark the contact');
});

test('FORM 3: the shared new-contact form (Building File, invoice screen) shows the checkbox, unchecked, with its explanation', () => {
  const html = decode(renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NewContactForm clientId="c1" title="New contact" contacts={[]} refreshKeys={[['contacts', 'c1']]} onCancel={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  ));
  assert.match(html, new RegExp(`<input type="checkbox" class="mt-0.5"/><span>${ACCOUNTS_ONLY_LABEL}<span class="[^"]*">${ACCOUNTS_ONLY_HINT}</span></span>`));
  assert.doesNotMatch(html, /Xero/, 'nothing about Xero on the form: linking stays a separate step');
});

test('FORM 4: the popover offers the same checkbox for new AND existing contacts, seeded from the SAVED value, and labels marked contacts', () => {
  const popover = noComments(src('src', 'components', 'jobs', 'ContactPopover.tsx'));
  assert.match(popover, /isAccountsContact: c\.isAccountsContact === true \}/, 'the edit form starts from the saved classification');
  assert.match(popover, /const BLANK_FORM: ContactFormState = \{ name: '', email: '', phoneNumber: '', isPrimary: false, isAccountsContact: false \};/);
  assert.match(popover, /checked=\{form\.isAccountsContact\}\s+onChange=\{\(e\) => setForm\(\{ \.\.\.form, isAccountsContact: e\.target\.checked \}\)\}/);
  assert.match(popover, /\{c\.isAccountsContact && \([\s\S]*?Accounts only\s*<\/span>/);
  assert.match(popover, /const checked = checkContactForm\(form, contacts, adding \? null : selectedId\);/, 'the same checks and save as before');
});

// ---- persistence: written only when given; history records genuine changes --------------------------------------------------
type Req = { method: string; path: string; search: string; body: any };
async function withFakeDb(before: Record<string, unknown> | null, run: () => Promise<void>): Promise<Req[]> {
  const seen: Req[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null;
    seen.push({ method, path: url.pathname, search: url.search, body });
    const wantsObject = String(new Headers(init?.headers).get('accept') ?? '').includes('vnd.pgrst.object');
    const reply = (row: unknown) => new Response(JSON.stringify(wantsObject ? row : [row]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/rest/v1/contacts' && method === 'POST') {
      const row = Array.isArray(body) ? body[0] : body;
      return reply({ id: 'new-1', role: null, notes: null, xero_contact_id: null, xero_org_id: null, xero_contact_name: null, xero_linked_at: null, is_accounts_contact: false, ...row });
    }
    if (url.pathname === '/rest/v1/contacts' && method === 'GET') return before ? reply(before) : new Response('[]', { status: 200 });
    if (url.pathname === '/rest/v1/buildings' && method === 'GET') return new Response(JSON.stringify([{ id: 'b1' }]), { status: 200 });
    return new Response(null, { status: method === 'POST' ? 201 : 204 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}
const contactWrites = (r: Req[]) => r.filter((x) => x.path === '/rest/v1/contacts' && x.method !== 'GET');
const history = (r: Req[]) => r.filter((x) => x.path === '/rest/v1/activity_events' && x.method === 'POST').map((x) => (Array.isArray(x.body) ? x.body[0] : x.body).detail);
const SAVED = { name: 'Accounts Team', email: 'acc@client.test', phone_number: null, is_primary: false, is_accounts_contact: true };

test('SAVE 1: creating WITHOUT the flag (other creation paths) writes nothing for it, so the database default (false) applies', async () => {
  const reqs = await withFakeDb(null, async () => {
    const c = await createContactForClient('c1', { name: 'Pat', email: null, phoneNumber: null, isPrimary: false });
    assert.equal(c.isAccountsContact, false);
  });
  const insert = contactWrites(reqs).find((r) => r.method === 'POST')!;
  assert.equal('is_accounts_contact' in (Array.isArray(insert.body) ? insert.body[0] : insert.body), false);
  assert.deepEqual(history(reqs), ['Contact added: Pat']);
});

test('SAVE 2: creating a contact marked accounts-only writes the flag and says so in the history', async () => {
  const reqs = await withFakeDb(null, async () => {
    const c = await createContactForClient('c1', { name: 'Accounts Team', email: 'acc@client.test', phoneNumber: null, isPrimary: false, isAccountsContact: true });
    assert.equal(c.isAccountsContact, true);
  });
  const insert = contactWrites(reqs).find((r) => r.method === 'POST')!;
  assert.equal((Array.isArray(insert.body) ? insert.body[0] : insert.body).is_accounts_contact, true);
  assert.deepEqual(history(reqs), ['Contact added: Accounts Team (accounts only)']);
});

test('SAVE 3: an edit that does not supply the flag never writes it (the saved classification is kept)', async () => {
  const reqs = await withFakeDb(SAVED, () => updateContact('ct-1', 'c1', { phoneNumber: '0207' }));
  const patch = contactWrites(reqs).find((r) => r.method === 'PATCH')!;
  assert.deepEqual(patch.body, { phone_number: '0207' });
});

test('SAVE 4: the popover saves the whole form, seeded from the saved value - editing another field leaves the flag as it was', async () => {
  const reqs = await withFakeDb(SAVED, () => updateContact('ct-1', 'c1', { name: 'Accounts Team', email: 'acc@client.test', phoneNumber: '0207', isPrimary: false, isAccountsContact: true }));
  const patch = contactWrites(reqs).find((r) => r.method === 'PATCH')!;
  assert.equal(patch.body.is_accounts_contact, true, 'the same value as saved');
  assert.deepEqual(history(reqs), ['Contact updated: Accounts Team (phone)'], 'only the phone changed: no classification change recorded');
});

test('SAVE 5: marking and un-marking are explicit writes, each recorded in the contact history', async () => {
  const unmark = await withFakeDb(SAVED, () => updateContact('ct-1', 'c1', { isAccountsContact: false }));
  assert.deepEqual(contactWrites(unmark).find((r) => r.method === 'PATCH')!.body, { is_accounts_contact: false });
  assert.deepEqual(history(unmark), ['Contact updated: Accounts Team (no longer accounts only)']);
  const mark = await withFakeDb({ ...SAVED, is_accounts_contact: false }, () => updateContact('ct-1', 'c1', { isAccountsContact: true }));
  assert.deepEqual(contactWrites(mark).find((r) => r.method === 'PATCH')!.body, { is_accounts_contact: true });
  assert.deepEqual(history(mark), ['Contact updated: Accounts Team (marked accounts only)']);
});

test('SAVE 6: contacts created with a new building or a new client stay unmarked (they do not pass the flag)', () => {
  for (const f of [['src', 'components', 'jobs', 'BuildingCreator.tsx'], ['src', 'components', 'buildings', 'ChangeBuildingClientPanel.tsx']]) {
    assert.doesNotMatch(src(...f), /isAccountsContact|is_accounts_contact/, f.join('/'));
  }
});

// ---- the job-report default -------------------------------------------------------------------------------------------------
test('REPORT 1: ordinary contacts keep the existing default - the only contact, else the primary, else nobody', () => {
  assert.deepEqual(resolveReportRecipientDefault([OPS]), { kind: 'single', contact: OPS });
  const primary = contact('p', 'Pat Primary', { isPrimary: true });
  assert.deepEqual(resolveReportRecipientDefault([OPS, primary]), { kind: 'primary', contact: primary });
  assert.deepEqual(resolveReportRecipientDefault([OPS, contact('o2', 'Other')]), { kind: 'ambiguous' });
  assert.deepEqual(resolveReportRecipientDefault([]), { kind: 'none' });
});

test('REPORT 2: an accounts-only contact is NEVER chosen automatically - not as the only contact, not as the primary', () => {
  assert.deepEqual(resolveReportRecipientDefault([ACC]), { kind: 'none_eligible' }, 'the only contact');
  const accPrimary = { ...ACC, isPrimary: true };
  assert.deepEqual(resolveReportRecipientDefault([accPrimary]), { kind: 'none_eligible' }, 'the only contact and primary');
  assert.deepEqual(resolveReportRecipientDefault([accPrimary, OPS]), { kind: 'single', contact: OPS }, 'the primary is skipped');
  assert.deepEqual(resolveReportRecipientDefault([accPrimary, OPS, contact('o2', 'Other')]), { kind: 'ambiguous' });
});

test('REPORT 3: with an ordinary and an accounts-only contact, the rules apply to the ordinary ones only', () => {
  assert.deepEqual(resolveReportRecipientDefault([ACC, OPS]), { kind: 'single', contact: OPS });
  const opsPrimary = { ...OPS, isPrimary: true };
  assert.deepEqual(resolveReportRecipientDefault([ACC, opsPrimary, contact('o2', 'Other')]), { kind: 'primary', contact: opsPrimary });
});

test('REPORT 4: the shared resolveDisplayContact is unchanged - the jobs grid and the popover still use it as before', () => {
  assert.deepEqual(resolveDisplayContact([ACC]), { kind: 'single', contact: ACC }, 'the grid still shows the only contact');
  for (const f of [['src', 'components', 'jobs', 'JobsGrid.tsx'], ['src', 'components', 'jobs', 'ContactPopover.tsx']]) {
    assert.match(src(...f), /resolveDisplayContact\(/, f.join('/'));
    assert.doesNotMatch(src(...f), /resolveReportRecipientDefault/, f.join('/'));
  }
});

// ---- the Ready for client page ---------------------------------------------------------------------------------------------
function visit(id: string): any {
  return {
    id, scheduledDate: '2026-10-01', status: 'completed', technicianId: 'mo', technicianName: 'Mo', additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'submitted',
    priceCharged: 100, completedAt: '2026-10-01T10:00:00Z', reportId: `rep-${id}`, reportReviewStatus: 'approved', sentToClientAt: null, sentToAccountsAt: null,
    reportCompletedAt: null, reportCompletedBy: null, invoiceId: null, invoiceStatus: null,
  };
}
function reportFor(visitId: string): any {
  return {
    id: `rep-${visitId}`, visitId, submittedBy: 'Mo', submittedAt: '2026-10-01T11:00:00Z', onSiteStart: null, onSiteEnd: null, workCarriedOut: 'Cleaned', technicianNotes: null, issues: null,
    specMet: true, reviewStatus: 'approved', reviewedBy: 'luke', reviewedAt: '2026-10-01T12:00:00Z', returnReason: null, includePhotos: true, includeNotes: true, includeIssues: true, includePrice: false,
    sentToClientAt: null, sentToClientBy: null, sentToAccountsAt: null, sentToAccountsBy: null, completedAt: null, completedBy: null,
  };
}
function reportPage(contacts: JobContactSummary[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['jobRows'], [{
    id: 'ja', buildingId: 'b-ja', buildingName: 'Alpha Court', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: 'Alpha cleaning', division: 'General', visits: [visit('va')], clientContacts: contacts,
  }]);
  qc.setQueryData(['report', 'rep-va'], reportFor('va'));
  qc.setQueryData(['reportPhotos', 'rep-va'], []);
  qc.setQueryData(['clientSend', 'rep-va'], null);
  const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: () => {} };
  return decode(renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <ReadyForClientPage initialSelectedVisitId="va" />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  ));
}

test('PAGE 1: accounts-only contacts stay in the report recipient list, labelled "Accounts only"; ordinary ones are unlabelled', () => {
  const html = reportPage([OPS, ACC, contact('noemail', 'No Email', { email: null, isAccountsContact: true })]);
  assert.match(html, /<option value="acc">Accounts Team · acc@client\.test · Accounts only<\/option>/);
  assert.match(html, /<option value="noemail">No Email · no email on file · Accounts only<\/option>/);
  assert.match(html, /<option value="ops">Sam Ops · ops@client\.test<\/option>/);
});

test('PAGE 2: when every contact is accounts-only, nobody is chosen and the page explains why', () => {
  const html = reportPage([ACC]);
  assert.match(html, /data-testid="report-recipient-none-eligible"/);
  assert.match(html, /No contact of this client is set up for job reports: every contact is marked accounts only, so nobody has\s+been chosen\. Choose a recipient deliberately, or add an operational contact/);
  assert.doesNotMatch(html, /Sending to/);
});

test('PAGE 3: with ordinary contacts the existing message is unchanged (no accounts-only wording)', () => {
  const html = reportPage([OPS, contact('o2', 'Other')]);
  assert.match(html, /Multiple contacts exist for this client — choose one\s+before sending\./);
  assert.doesNotMatch(html, /report-recipient-none-eligible|Accounts only/);
});

test('PAGE 4: the default comes from the report-only rule; a deliberate accounts-only choice shows a warning but does NOT block sending', () => {
  const page = noComments(src('src', 'pages', 'ReadyForClientPage.tsx'));
  assert.match(page, /const resolved = resolveReportRecipientDefault\(selected\.job\.clientContacts\);/);
  assert.doesNotMatch(page, /resolveDisplayContact/);
  assert.match(page, /\{selectedContact\.isAccountsContact && \(\s*<div\s+data-testid="report-recipient-accounts-only"/);
  assert.match(page, /is marked accounts only\.\s+Job reports normally go to an operational contact;\s+this report will be sent to \{selectedContact\.name\}\{" "\}\s+because you chose them\./);
  // Sending rules are exactly as before: only an email is required; nothing about the classification.
  assert.match(page, /disabled=\{!model \|\| !selectedContact\?\.email\}/);
  assert.doesNotMatch(page.slice(page.indexOf('onClick={openSendDialog}') - 400, page.indexOf('Send to client')), /isAccountsContact/);
});

// ---- invoicing and Xero linking are unchanged -------------------------------------------------------------------------------
test('INVOICE: accounts-only contacts are still offered as invoice recipients and for Xero linking', () => {
  const inv: InvoiceDetail = {
    id: 'inv-1', jobId: 'j1', status: 'draft', dueDate: '2026-11-17', description: null, worksOrderNumber: null, xeroInvoiceId: null, xeroInvoiceNumber: null,
    xeroContactId: null, lastError: null, sentAt: null, xeroRecipientName: null, xeroRecipientEmail: null, notEmailedReason: null,
    lineItems: [{ id: 'li-1', visitId: 'v-1', description: 'Clean', quantity: 1, unitAmount: 100 }],
  } as InvoiceDetail;
  const qc = new QueryClient();
  qc.setQueryData(['invoice', 'inv-1'], inv);
  const html = decode(renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId="inv-1" onClose={() => {}} clientId="c1" clientContacts={[OPS, ACC]} buildingDefault={null} />
    </QueryClientProvider>,
  ));
  assert.match(html, /<option value="acc">Accounts Team — acc@client\.test · not linked to Xero yet<\/option>/, 'selectable invoice recipient');
  assert.doesNotMatch(html, /data-testid="find-xero-contact"/, 'linking moved to the Building File (Contacts & Defaults)');
  assert.doesNotMatch(noComments(src('src', 'components', 'jobs', 'FindXeroContactPanel.tsx')), /isAccountsContact/, 'the panel never filters on it');
  for (const f of [
    ['src', 'components', 'jobs', 'InvoiceEditor.tsx'], ['src', 'components', 'jobs', 'BuildingDefaultRecipientPanel.tsx'], ['src', 'components', 'jobs', 'LinkXeroContactDialog.tsx'],
    ['src', 'components', 'jobs', 'UnlinkedRecipientsList.tsx'], ['src', 'lib', 'invoiceRecipient.ts'], ['src', 'lib', 'xeroLinkStatus.ts'], ['src', 'repository', 'mapJobRow.ts'],
    ['supabase', 'functions', 'xero-create-invoice', 'index.ts'], ['supabase', 'functions', 'xero-link-contact', 'index.ts'], ['supabase', 'functions', '_shared', 'invoiceRecipients.ts'],
    ['supabase', 'functions', 'send-client-report', 'index.ts'],
  ]) {
    assert.doesNotMatch(noComments(src(...f)), /\.filter\([^)]*isAccountsContact|is_accounts_contact\s*[!=]==?|isAccountsContact\s*[!=]==?\s*(true|false)/, `${f.join('/')} must not filter on the classification`);
  }
});
