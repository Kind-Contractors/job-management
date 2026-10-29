// A brand-new client and building whose only contact is not linked to Xero, with no building default recipient: the contact is
// listed AND selectable in the invoice editor, the editor says it must be linked to its existing Xero contact before the invoice is
// sent (never "matched or created on submit"), the Link button is offered, and nothing can be sent for it - pressing the button
// stops before the invoice is saved. Real components rendered to static markup from a seeded query cache (there is no DOM library in this repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { recipientOptionsAsHtml } from './helpers/recipientOptions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import InvoiceEditor from '../src/components/jobs/InvoiceEditor';
import type { InvoiceDetail, JobContactSummary } from '../src/domain/types';
import { canSendInvoiceTo } from '../src/lib/xeroLinkStatus';
import { NOT_LINKED_RECIPIENT_MESSAGE, resolveSendRecipientId } from '../src/lib/invoiceRecipient';
import { QUERY_CACHE_SCHEMA_VERSION } from '../src/lib/userQueryCache';

const NEW_CONTACT: JobContactSummary = {
  id: 'ct-new', name: 'Pat New', email: 'pat@newclient.test', phoneNumber: null, isPrimary: true, isAccountsContact: false,
  xeroContactId: null, xeroOrgId: null, xeroContactName: null, xeroLinkedAt: null,
};
// The same contact as restored from a browser cache saved before the Xero fields existed: the fields are simply missing.
const { xeroContactId: _a, xeroOrgId: _b, xeroContactName: _c, xeroLinkedAt: _d, ...CACHED_SHAPE } = NEW_CONTACT;
const NO_EMAIL: JobContactSummary = { ...NEW_CONTACT, id: 'ct-noemail', name: 'No Email', email: null, isPrimary: false };

function invoice(): InvoiceDetail {
  return {
    id: 'inv-new', jobId: 'job-new', status: 'draft', dueDate: '2026-11-17', description: null, worksOrderNumber: null,
    xeroInvoiceId: null, xeroInvoiceNumber: null, xeroContactId: null, lastError: null, sentAt: null,
    lineItems: [{ id: 'li-1', visitId: 'v-1', description: 'First clean', quantity: 1, unitAmount: 150 }],
  };
}
function render(contacts: any[]) {
  const qc = new QueryClient();
  qc.setQueryData(['invoice', 'inv-new'], invoice());
  return recipientOptionsAsHtml(renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId="inv-new" onClose={() => {}} clientId="client-new" clientContacts={contacts} buildingDefault={null} />
    </QueryClientProvider>,
  ));
}

test('a NEW unlinked contact (valid email, no building default) is listed and SELECTABLE; it must be linked before sending', () => {
  const html = render([NEW_CONTACT]);
  assert.match(html, /<option value="ct-new"(?: class="[^"]*")?>Pat New — pat@newclient\.test · not linked to Xero yet<\/option>/);
  assert.doesNotMatch(html, /matched or created/);
  assert.equal(canSendInvoiceTo(NEW_CONTACT), false);
});

test('the editor says how to proceed: link a contact to its EXISTING Xero contact; the app never matches or creates one', () => {
  const html = render([NEW_CONTACT]);
  assert.match(html, /None of this client(?:'|&#x27;)s contacts is linked to a Xero contact yet\. You can choose any of them, but it must be linked to\s+its existing Xero contact \(“Link to Xero contact”, offered once you choose it\) before the invoice can be sent\.\s+The app never matches or creates a Xero contact by itself\./);
  assert.doesNotMatch(html, /created in Xero, when you submit/);
});

test('no default: it says so and offers "Set up contacts & defaults" (a new tab), not a search panel', () => {
  const html = render([NEW_CONTACT]);
  assert.doesNotMatch(html, /data-testid="find-xero-contact"/);
  assert.match(html, /data-testid="no-invoice-default"[^>]*>This building has no default invoice recipient, so one is chosen for each invoice\./);
});

test('a contact restored from an older browser cache (Xero fields MISSING, not null) is selectable but treated as unlinked, not as sendable', () => {
  assert.equal('xeroContactId' in CACHED_SHAPE, false);
  assert.equal(canSendInvoiceTo(CACHED_SHAPE as any), false);
  assert.match(render([CACHED_SHAPE]), /<option value="ct-new"(?: class="[^"]*")?>Pat New — pat@newclient\.test · not linked to Xero yet<\/option>/);
});

test('the persisted cache version is bumped, so data cached before the Xero fields existed is discarded on restore', () => {
  assert.notEqual(QUERY_CACHE_SCHEMA_VERSION, '2026-10-13-report-videos');
});

test('a contact with no email is selectable too (it still needs a link before sending), and a blank link is not treated as a link', () => {
  const html = render([NO_EMAIL]);
  assert.match(html, /<option value="ct-noemail"(?: class="[^"]*")?>No Email · not linked to Xero yet<\/option>/);
  assert.equal(canSendInvoiceTo({ ...NEW_CONTACT, xeroContactId: '   ' }), false);
});

test('choosing an unlinked contact is refused BEFORE anything is saved or sent (the send never starts)', () => {
  assert.throws(
    () => resolveSendRecipientId({
      addingNewContact: false,
      selectedContactId: NEW_CONTACT.id,
      usableDefaultContactId: null,
      selectedIsLinked: canSendInvoiceTo(NEW_CONTACT),
    }),
    (err: Error) => err.message === NOT_LINKED_RECIPIENT_MESSAGE,
  );
});

test('once linked (as the link dialog saves it), the same contact is selectable and its LOCAL id is what is sent', () => {
  const linked = { ...NEW_CONTACT, xeroContactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', xeroOrgId: 'org-1', xeroContactName: 'Pat New Ltd' };
  assert.equal(canSendInvoiceTo(linked), true);
  assert.match(render([linked]), /<option value="ct-new"(?: class="[^"]*")?>Pat New — pat@newclient\.test · Xero: Pat New Ltd<\/option>/);
  assert.equal(
    resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-new', usableDefaultContactId: null, selectedIsLinked: canSendInvoiceTo(linked) }),
    'ct-new',
  );
});
