// Step 3 on the manager's side: the building's OWN Xero invoice recipient is read from the building and shown as the invoice's
// recipient; a Xero contact can be chosen for ONE invoice (kept on screen until Send, never saved on the building); a person is never
// sent in place of the building's own recipient; buildings with a contact-based default or none keep today's controls.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readSourceFile } from './helpers/sourceCode';
import type { InvoiceDetail, JobContactSummary } from '../src/domain/types';
import { ownInvoiceRecipient } from '../src/repository/ownInvoiceRecipient';
import { mapBuildingRow } from '../src/repository/mapBuildingRow';
import { PERSON_WITH_BUILDING_RECIPIENT_MESSAGE, resolveSendRequest } from '../src/lib/invoiceRecipient';
import { sendInvoice } from '../src/repository/invoicesRepository';
import InvoiceEditor from '../src/components/jobs/InvoiceEditor';

const ORG = 'org-1';
const OWN = { xeroContactId: 'x-eml', xeroOrgId: ORG, name: 'Estate Management London Ltd', email: 'ap@eml.test' };

// ---- mapping -----------------------------------------------------------------------------------------------------------------------
test('MAP: a building\'s own recipient (Xero id + organisation, no person) is mapped; a contact-based default or an incomplete row is not', () => {
  assert.deepEqual(
    ownInvoiceRecipient({ default_invoice_contact_id: null, default_invoice_xero_contact_id: 'x-eml', default_invoice_xero_org_id: ORG, default_invoice_xero_contact_name: 'Estate Management London Ltd', default_invoice_xero_contact_email: 'ap@eml.test' }),
    OWN,
  );
  assert.equal(ownInvoiceRecipient({ default_invoice_contact_id: 'ct-laura', default_invoice_xero_contact_id: 'x-eml', default_invoice_xero_org_id: ORG }), null, 'a person-based default is never shown as the building\'s own recipient');
  assert.equal(ownInvoiceRecipient({ default_invoice_contact_id: null, default_invoice_xero_contact_id: null, default_invoice_xero_org_id: null }), null);
  assert.equal(ownInvoiceRecipient({ default_invoice_contact_id: null, default_invoice_xero_contact_id: 'x', default_invoice_xero_org_id: null }), null);
  assert.equal(ownInvoiceRecipient({ default_invoice_xero_contact_id: 'x', default_invoice_xero_org_id: ORG, default_invoice_xero_contact_email: ' ' })!.email, null);
});

test('MAP: the building row carries the own recipient, and the person-based default stays separate', () => {
  const base = { id: 'b1', client_id: 'c1', address: '16-17 Marylebone High St', invoice_details: '16-17 Marylebone Adrian Levy', extra_requirements: null, name: null, postcode: 'W1U', clients: { id: 'c1', company_name: 'EML' }, building_access: null };
  const own = mapBuildingRow({ ...base, default_invoice_contact_id: null, default_invoice_xero_contact_id: 'x-eml', default_invoice_xero_org_id: ORG, default_invoice_xero_contact_name: OWN.name, default_invoice_xero_contact_email: OWN.email } as any);
  assert.deepEqual(own.invoiceRecipient, OWN);
  assert.equal(own.defaultRecipient, null);
  const legacy = mapBuildingRow({ ...base, default_invoice_contact_id: 'ct-1', default_invoice_xero_contact_id: 'x-1', default_invoice_xero_org_id: ORG, default_invoice_xero_contact_name: 'Oak' } as any);
  assert.equal(legacy.invoiceRecipient, null);
  assert.deepEqual(legacy.defaultRecipient, { contactId: 'ct-1', xeroContactId: 'x-1', xeroOrgId: ORG });
});

test('QUERIES: the job and building reads fetch the recipient name and email', () => {
  for (const f of [['src', 'repository', 'jobsRepository.ts'], ['src', 'repository', 'buildingsRepository.ts']]) {
    const code = readSourceFile(...f);
    assert.match(code, /default_invoice_xero_contact_name,\s+default_invoice_xero_contact_email,/, f.join('/'));
  }
});

// ---- what is sent -----------------------------------------------------------------------------------------------------------------
test('SEND REQUEST: a building with its own recipient sends nothing (the server uses it); a person is refused before anything', () => {
  const base = { addingNewContact: false, selectedContactId: '', usableDefaultContactId: null, hasBuildingRecipient: true };
  assert.equal(resolveSendRequest(base), undefined);
  assert.throws(() => resolveSendRequest({ ...base, selectedContactId: 'ct-laura' }), (e: Error) => e.message === PERSON_WITH_BUILDING_RECIPIENT_MESSAGE);
});

test('SEND REQUEST: a one-off Xero contact is sent with the name the manager saw - with or without a building recipient', () => {
  const oneOffXero = { xeroContactId: 'x-dci', name: '137 Randolph DCI Finance Limited' };
  const expected = { xeroContactId: 'x-dci', expectedName: '137 Randolph DCI Finance Limited' };
  assert.deepEqual(resolveSendRequest({ addingNewContact: false, selectedContactId: '', hasBuildingRecipient: true, oneOffXero }), expected);
  assert.deepEqual(resolveSendRequest({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: null, oneOffXero }), expected);
  assert.deepEqual(resolveSendRequest({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: 'ct-1', oneOffXero }), expected);
});

test('SEND REQUEST: a locked invoice sends nothing, whatever is chosen; buildings without their own recipient keep today\'s rules', () => {
  assert.equal(resolveSendRequest({ recipientLocked: true, addingNewContact: false, selectedContactId: 'ct-2', oneOffXero: { xeroContactId: 'x', name: 'X' } }), undefined);
  assert.equal(resolveSendRequest({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: 'ct-1' }), undefined);
  assert.equal(resolveSendRequest({ addingNewContact: false, selectedContactId: 'ct-2', usableDefaultContactId: 'ct-1', selectedIsLinked: true }), 'ct-2');
  assert.throws(() => resolveSendRequest({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: null }), /no usable default/);
});

interface Call { url: string; body: unknown }
let calls: Call[] = [];
beforeEach(() => { calls = []; });
globalThis.fetch = (async (input: any, init?: any) => {
  calls.push({ url: typeof input === 'string' ? input : input.url, body: init?.body });
  return new Response(JSON.stringify({ status: 'sent' }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

test('SEND BODY: a one-off Xero contact goes as xeroContactId + expectedXeroContactName; a person as contactId; nothing as neither', async () => {
  await sendInvoice('inv-1', { xeroContactId: 'x-dci', expectedName: '137 Randolph DCI Finance Limited' });
  await sendInvoice('inv-1', 'ct-1');
  await sendInvoice('inv-1');
  assert.deepEqual(calls.map((c) => JSON.parse(String(c.body))), [
    { invoiceId: 'inv-1', xeroContactId: 'x-dci', expectedXeroContactName: '137 Randolph DCI Finance Limited' },
    { invoiceId: 'inv-1', contactId: 'ct-1' },
    { invoiceId: 'inv-1' },
  ]);
});

// ---- the editor -------------------------------------------------------------------------------------------------------------------
const LAURA: JobContactSummary = { id: 'ct-laura', name: 'Laura Newton', email: 'laura@eml.test', phoneNumber: null, isPrimary: true, isAccountsContact: false, xeroContactId: 'x-adrian', xeroOrgId: ORG, xeroContactName: '16-17 Marylebone Adrian Levy', xeroLinkedAt: '2026-10-01T00:00:00Z' } as JobContactSummary;
function invoice(over: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: 'inv-1', jobId: 'j1', status: 'draft', dueDate: '2026-11-17', description: null, worksOrderNumber: null, xeroInvoiceId: null, xeroInvoiceNumber: null,
    xeroContactId: null, lastError: null, sentAt: null, xeroRecipientName: null, xeroRecipientEmail: null, notEmailedReason: null,
    lineItems: [{ id: 'li-1', visitId: 'v-1', description: 'Clean', quantity: 1, unitAmount: 100 }],
    ...over,
  } as InvoiceDetail;
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function editor(props: Record<string, unknown>, inv: InvoiceDetail = invoice()) {
  const qc = new QueryClient();
  qc.setQueryData(['invoice', 'inv-1'], inv);
  return decode(renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId="inv-1" onClose={() => {}} clientId="c1" clientContacts={[LAURA]} buildingDefault={null} {...props} />
    </QueryClientProvider>,
  ));
}

test('EDITOR: the building\'s own recipient is shown as the recipient - no person picker, no "no default" warning, Laura not offered', () => {
  const html = editor({ buildingRecipient: OWN });
  assert.match(html, /data-testid="building-xero-recipient"/);
  assert.match(html, /Estate Management London Ltd/);
  assert.match(html, /ap@eml\.test/);
  assert.match(html, /this building's default recipient/);
  assert.match(html, /Use a different Xero contact for this invoice/);
  assert.doesNotMatch(html, /role="combobox"/, 'no person picker');
  assert.doesNotMatch(html, /Laura Newton/);
  assert.doesNotMatch(html, /data-testid="no-invoice-default"/);
  assert.doesNotMatch(html, /Choose a Xero contact for this invoice/, 'the building already has a recipient');
});

test('EDITOR: without any default, a Xero contact can be chosen for this invoice and the building default set (no person picker since 2026-11-11)', () => {
  const html = editor({ buildingRecipient: null });
  assert.doesNotMatch(html, /role="combobox"/, 'people are not offered as recipients');
  assert.match(html, /data-testid="no-invoice-default"/);
  assert.match(html, />Choose a Xero contact for this invoice</);
  assert.doesNotMatch(html, /data-testid="building-xero-recipient"/);
});

test('EDITOR: an invoice Xero already holds shows its recorded recipient, locked - no change offered, not the building\'s recipient', () => {
  const html = editor({ buildingRecipient: OWN }, invoice({ status: 'failed', xeroInvoiceId: 'xi-1', xeroContactId: 'x-original', xeroRecipientName: 'Original Recipient Ltd' }));
  assert.match(html, /Original Recipient Ltd/);
  assert.match(html, /locked: this invoice is already in Xero/);
  assert.doesNotMatch(html, /Estate Management London Ltd/);
  assert.doesNotMatch(html, /Use a different Xero contact/);
  assert.doesNotMatch(html, /Or choose a Xero contact/);
});

test('EDITOR: a one-off choice lives only on screen - the editor never writes the building or saves the choice on the draft', () => {
  const code = readSourceFile('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  assert.doesNotMatch(code, /setBuildingRecipient|setBuildingDefaultRecipient|updateBuilding|clearBuildingRecipient/);
  assert.match(code, /setOneOffXero\(\{\s*xeroContactId: c\.contactId,\s*name: c\.name,\s*email: c\.email,?\s*\}\)/);
  const draftSave = code.slice(code.indexOf('const persistCurrentDraft'), code.indexOf('const discardMutation'));
  assert.doesNotMatch(draftSave, /oneOffXero|xeroContactId/, 'the draft save never includes the one-off recipient');
});

test('SEARCH: nothing is chosen for the manager - a contact is used only from its own button, blocked ones cannot be chosen', () => {
  const code = readSourceFile('src', 'components', 'jobs', 'XeroRecipientSearch.tsx');
  assert.equal((code.match(/onChoose\(/g) ?? []).length, 1);
  assert.match(code, /onClick=\{\(\) => onChoose\(c\)\}\s+disabled=\{disabled \|\| c\.blockedReason !== null\}/);
  assert.match(code, /meta: \{ persist: false \}/, 'results are never kept in the browser\'s saved cache');
});

// ---- the outdated "Choose who to send this invoice to..." hint (removed 2026-11-11) ------------------------------------------------
const OLD_HINT = /A contact that is not linked to Xero yet can be chosen/;
const NONE_LINKED = /data-testid="no-linked-contacts"/;
const UNLINKED: JobContactSummary = { ...LAURA, id: 'ct-unlinked', name: 'Unlinked Person', xeroContactId: null, xeroOrgId: null, xeroContactName: null, xeroLinkedAt: null } as JobContactSummary;

test('HINT: neither the old general hint nor the "no linked contacts" warning appears any more - with or without a building recipient', () => {
  // The warning was about linking people to Xero contacts, which the invoice no longer does (removed 2026-11-11).
  for (const buildingRecipient of [OWN, null]) {
    for (const contacts of [[LAURA], [UNLINKED], []]) {
      const html = editor({ buildingRecipient, clientContacts: contacts });
      assert.doesNotMatch(html, OLD_HINT);
      assert.doesNotMatch(html, NONE_LINKED);
      assert.doesNotMatch(html, /None of this client's contacts is linked/);
    }
  }
  const code = readSourceFile('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  assert.doesNotMatch(code, /no-linked-contacts|choosePhrase|canSendInvoiceTo/);
  assert.match(code, /const recipientChosen = recipientLocked \|\| usingOneOffXero \|\| hasBuildingRecipient \|\| usingContactDefault;/);
});

