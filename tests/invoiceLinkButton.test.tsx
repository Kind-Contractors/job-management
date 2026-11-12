// The invoice editor no longer offers people as recipients or links them to Xero contacts (removed 2026-11-11): an invoice is
// addressed to the building's default recipient in Xero, an older contact-based default that still works, or a Xero contact chosen
// for this invoice only (found by name). Rendered on the REAL editor (static markup from a seeded query cache; there is no DOM
// library in this repo).
//
// Proved: no Link button, link dialog, person picker or "not linked" notice for any contact; with no recipient, "Choose a Xero
// contact for this invoice" and the way to set the building's default recipient are offered; an older contact-based default is
// shown by its Xero name with a one-off choice beside it; a stale one is explained; an invoice already in Xero offers no change.
import { readSourceFile } from './helpers/sourceCode';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { recipientOptionsAsHtml } from './helpers/recipientOptions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import InvoiceEditor from '../src/components/jobs/InvoiceEditor';
import type { BuildingDefaultRecipient, InvoiceDetail, JobContactSummary } from '../src/domain/types';

const XC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contact = (id: string, name: string, over: Partial<JobContactSummary> = {}): JobContactSummary => ({
  id, name, email: `${id}@example.test`, phoneNumber: null, isPrimary: false, isAccountsContact: false,
  xeroContactId: null, xeroOrgId: null, xeroContactName: null, xeroLinkedAt: null, ...over,
});
const LINKED = contact('ct-linked', 'Linked Person', { xeroContactId: XC, xeroOrgId: ORG, xeroContactName: 'Oak Estates Ltd' });
const MO = contact('ct-mo', 'Mo');
const LEGACY = contact('ct-legacy', 'Old Link', { xeroContactId: XC, xeroOrgId: null });

function invoice(over: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: 'inv-1', jobId: 'job-1', status: 'draft', dueDate: '2026-11-15', description: null, worksOrderNumber: null,
    xeroInvoiceId: null, xeroInvoiceNumber: null, xeroContactId: null, lastError: null, sentAt: null,
    lineItems: [{ id: 'li-1', visitId: 'v-1', description: 'Window cleaning', quantity: 1, unitAmount: 120 }], ...over,
  };
}
function renderEditor(contacts: JobContactSummary[], inv: InvoiceDetail = invoice(), buildingDefault: BuildingDefaultRecipient | null = null) {
  const qc = new QueryClient();
  qc.setQueryData(['invoice', inv.id], inv);
  return recipientOptionsAsHtml(renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId={inv.id} onClose={() => {}} clientId="client-1" buildingId="b-1" clientContacts={contacts} buildingDefault={buildingDefault} />
    </QueryClientProvider>,
  )).replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

const src = (...p: string[]) => readSourceFile('src', ...p);
const code = (...p: string[]) => src(...p).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('NO PERSON LINKING: no Link button, link dialog, person picker or "not linked" notice - linked, unlinked or old links alike', () => {
  const html = renderEditor([LINKED, MO, LEGACY]);
  assert.doesNotMatch(html, /Link to Xero|not linked to Xero|recipient-not-linked|unlinked-recipients/i);
  assert.doesNotMatch(html, /role="combobox"/, 'people are not offered as recipients');
  assert.doesNotMatch(html, /Linked Person|Old Link|>Mo</, 'no person is listed as a recipient');
});

test("NO RECIPIENT: a Xero contact can be chosen for this invoice, or the building's default recipient set (new tab)", () => {
  const html = renderEditor([LINKED, MO]);
  assert.match(html, /data-testid="no-recipient-yet"/);
  assert.match(html, />Choose a Xero contact for this invoice</);
  assert.match(html, /data-testid="no-invoice-default"[^>]*>This building has no default recipient in Xero yet, so a Xero contact is chosen for each invoice\./);
  assert.match(html, /<a href="\/buildings\/b-1\?tab=contacts" target="_blank" rel="noopener noreferrer"[^>]*>Set the building's default recipient<\/a>/);
  // (Whether the main button is enabled is not checked in static markup - line items load in an effect that does not run here;
  // the rule itself is checked from source in xeroRecipientUi.test.ts and invoiceRecipient.test.ts.)
});

test('OLDER CONTACT-BASED DEFAULT: shown by its Xero name, with a one-off Xero choice beside it', () => {
  const html = renderEditor([LINKED, MO], invoice(), { contactId: 'ct-linked', xeroContactId: XC, xeroOrgId: ORG });
  assert.match(html, /data-testid="contact-default-recipient"/);
  assert.match(html, />Oak Estates Ltd</);
  assert.match(html, /this building's default \(contact-based, the older\s+way\)/);
  assert.match(html, />Use a different Xero contact for this invoice</);
  assert.doesNotMatch(html, /data-testid="no-invoice-default"/);
});

test('STALE CONTACT-BASED DEFAULT: explained, and a Xero contact can still be chosen for this invoice', () => {
  const html = renderEditor([LEGACY], invoice(), { contactId: 'ct-legacy', xeroContactId: XC, xeroOrgId: ORG });
  assert.match(html, /data-testid="no-invoice-default"/);
  assert.doesNotMatch(html, /This building has no default recipient in Xero yet/, 'the reason given is the stale default, not "none"');
  assert.match(html, />Choose a Xero contact for this invoice</);
});

test('LOCKED: once the invoice exists in Xero, no recipient change is offered', () => {
  const html = renderEditor([LINKED], invoice({ status: 'failed', xeroInvoiceId: 'x-inv', xeroContactId: XC }));
  assert.match(html, /locked: this invoice is already in Xero/);
  assert.doesNotMatch(html, /Choose a Xero contact for this invoice|Use a different Xero contact/);
});

test('SOURCE: the editor has no linking code left, and pressing the main button just sends (no "needs a link" detour)', () => {
  const editor = code('components', 'jobs', 'InvoiceEditor.tsx');
  assert.doesNotMatch(editor, /LinkXeroContactDialog|UnlinkedRecipientsList|refreshAfterXeroLink|RecipientSelect|sendAttemptOutcome|linkingContact|xeroLinkNeededFor/);
  assert.match(editor, /onClick=\{\(\) => \{\s+setSendResult\(null\);\s+sendMutation\.mutate\(\);\s+\}\}/);
});
