// A brand-new client and building whose only contact is not linked to Xero, with no building default recipient. Since 2026-11-11
// people are not invoice recipients in the editor: it offers "Choose a Xero contact for this invoice" (found by name) and the way to
// set the building's default recipient - nothing is listed, linked, matched or created for the person. The pure send rules below
// (an unlinked person is never sendable) still hold for older callers. Real components rendered to static markup from a seeded
// query cache (there is no DOM library in this repo).
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

test('a NEW client and building (one unlinked contact, no default): the editor offers a Xero contact for this invoice and setting the building default', () => {
  const html = render([NEW_CONTACT]).replace(/&#x27;/g, "'");
  assert.match(html, />Choose a Xero contact for this invoice</);
  assert.match(html, /data-testid="no-invoice-default"[^>]*>This building has no default recipient in Xero yet, so a Xero contact is chosen for each invoice\./);
  assert.doesNotMatch(html, /Pat New|<option value="ct-new"|role="combobox"/, 'the person is not offered as a recipient (removed 2026-11-11)');
  assert.doesNotMatch(html, /Link to Xero|not linked to Xero|matched or created|created in Xero, when you submit/);
  assert.doesNotMatch(html, /data-testid="find-xero-contact"/);
});

test('contacts restored from an older browser cache (Xero fields MISSING) or with no email change nothing on screen, and are never sendable', () => {
  for (const c of [CACHED_SHAPE, NO_EMAIL]) {
    const html = render([c]);
    assert.match(html, />Choose a Xero contact for this invoice</);
    assert.doesNotMatch(html, /Pat New|No Email/);
  }
  assert.equal('xeroContactId' in CACHED_SHAPE, false);
  assert.equal(canSendInvoiceTo(CACHED_SHAPE as any), false);
  assert.equal(canSendInvoiceTo({ ...NEW_CONTACT, xeroContactId: '   ' }), false, 'a blank link is not a link');
});

test('the persisted cache version is bumped, so data cached before the Xero fields existed is discarded on restore', () => {
  assert.notEqual(QUERY_CACHE_SCHEMA_VERSION, '2026-10-13-report-videos');
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

