// A brand-new client and building whose only contact is not in Xero yet, with no building default recipient: the contact must be
// selectable in the invoice editor, the editor must explain that it will be matched or created in Xero on submit (not tell the
// manager to link it first), and its local contact id must be what is sent to xero-create-invoice. Real components rendered to
// static markup from a seeded query cache (there is no DOM library in this repo); the request body is captured by a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import InvoiceEditor from '../src/components/jobs/InvoiceEditor';
import type { InvoiceDetail, JobContactSummary } from '../src/domain/types';
import { canLinkAutomatically, canSendInvoiceTo } from '../src/lib/xeroLinkStatus';
import { resolveSendRecipientId } from '../src/lib/invoiceRecipient';
import { sendInvoice } from '../src/repository/invoicesRepository';
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
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId="inv-new" onClose={() => {}} clientId="client-new" clientContacts={contacts} buildingDefault={null} />
    </QueryClientProvider>,
  );
}

test('a NEW unlinked contact with a valid email and NO building default is selectable, labelled as matched or created on send', () => {
  const html = render([NEW_CONTACT]);
  assert.match(html, /<option value="ct-new">Pat New — pat@newclient\.test · not linked: matched or created in Xero on send<\/option>/);
  assert.doesNotMatch(html, /<option value="ct-new" disabled/);
});

test('the editor explains the workflow instead of saying a linked contact or a building default is required', () => {
  const html = render([NEW_CONTACT]);
  assert.doesNotMatch(html, /Choose a contact that is linked to Xero, or set the default recipient/, 'the old blocking message is gone');
  assert.match(html, /A contact that is not in Xero yet can be chosen: it is matched to its Xero contact\s+by email, or created in Xero, when you submit the invoice\./);
});

test('the manual Link button is still offered for it (for a contact that already exists in Xero)', () => {
  const html = render([NEW_CONTACT]);
  assert.match(html, /aria-label="Link Pat New to a Xero contact"[^>]*>Link<\/button>/);
  assert.match(html, /Can still be chosen above: matched or created in Xero when the invoice is submitted\./);
});

test('ROOT CAUSE: a contact restored from an older browser cache (Xero fields MISSING, not null) is still selectable', () => {
  assert.equal('xeroContactId' in CACHED_SHAPE, false);
  assert.equal(canLinkAutomatically(CACHED_SHAPE as any), true);
  assert.equal(canSendInvoiceTo(CACHED_SHAPE as any), true);
  assert.doesNotMatch(render([CACHED_SHAPE]), /<option value="ct-new" disabled/);
});

test('ROOT CAUSE: the persisted cache version is bumped, so data cached before the Xero fields existed is discarded on restore', () => {
  assert.notEqual(QUERY_CACHE_SCHEMA_VERSION, '2026-10-13-report-videos');
});

test('a contact WITHOUT a valid email stays unselectable, and the editor says what to do', () => {
  const html = render([NO_EMAIL]);
  assert.match(html, /<option value="ct-noemail" disabled="">No Email · not linked to Xero<\/option>/);
  assert.match(html, /None of this client(?:'|&#x27;)s contacts can receive an invoice yet: add an email address to a contact, or link one to its Xero\s+contact\./);
  assert.equal(canSendInvoiceTo({ ...NEW_CONTACT, email: 'not-an-email' }), false);
  assert.equal(canSendInvoiceTo({ ...NEW_CONTACT, xeroContactId: '   ' }), false, 'a blank link is not silently treated as unlinked');
});

test('choosing it sends the LOCAL contact id to xero-create-invoice (where the contact is matched or created)', async () => {
  const contactId = resolveSendRecipientId({
    addingNewContact: false,
    selectedContactId: NEW_CONTACT.id,
    usableDefaultContactId: null,
    selectedIsLinked: canSendInvoiceTo(NEW_CONTACT),
  });
  assert.equal(contactId, 'ct-new');

  const seen: Array<{ url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    seen.push({ url: typeof input === 'string' ? input : input.url, body: JSON.parse(init?.body ?? '{}') });
    return new Response(JSON.stringify({ status: 'in_xero_not_emailed', emailed: false, xeroInvoiceNumber: 'INV-0001' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const result = await sendInvoice('inv-new', contactId);
    assert.equal(result.status, 'in_xero_not_emailed');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/functions\/v1\/xero-create-invoice$/);
  assert.deepEqual(seen[0].body, { invoiceId: 'inv-new', contactId: 'ct-new' });
});
