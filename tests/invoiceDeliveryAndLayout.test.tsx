// The invoice editor after a send: who the invoice went to and whether it was emailed (only ever "emailed" when the server says
// so, with the reason when it was not), and the layout that keeps Send / Discard reachable however long the recipient section
// gets. Real components rendered to static markup (there is no DOM library in this repo); layout checked on the rendered classes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import InvoiceEditor from '../src/components/jobs/InvoiceEditor';
import type { InvoiceDetail, JobContactSummary } from '../src/domain/types';
import { deliveryLine, formatRecipient, recipientOf, sendResultMessage } from '../src/lib/invoiceDelivery';

const contact = (id: string, name: string, email: string | null, xeroContactId: string | null): JobContactSummary => ({
  id, name, email, phoneNumber: null, isPrimary: false, isAccountsContact: false, xeroContactId, xeroOrgId: xeroContactId ? 'org' : null, xeroContactName: null, xeroLinkedAt: null,
});
const XC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function invoice(over: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: 'inv-1', jobId: 'job-1', status: 'draft', dueDate: '2026-11-17', description: null, worksOrderNumber: null,
    xeroInvoiceId: null, xeroInvoiceNumber: null, xeroContactId: null, xeroRecipientName: null, xeroRecipientEmail: null, notEmailedReason: null,
    lastError: null, sentAt: null, lineItems: [{ id: 'li-1', visitId: 'v-1', description: 'Clean', quantity: 1, unitAmount: 100 }], ...over,
  };
}
function render(inv: InvoiceDetail, contacts: JobContactSummary[] = []) {
  const qc = new QueryClient();
  qc.setQueryData(['invoice', inv.id], inv);
  // Automatic emails on, and this system allowed to email: the main button reads "Send invoice".
  qc.setQueryData(['appSettings', 'autoInvoiceEmails'], { enabled: true, updatedAt: '2026-10-18T00:00:00Z' });
  qc.setQueryData(['xeroInvoiceCapabilities'], { creationEnabled: true, sendingEnabled: true });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId={inv.id} onClose={() => {}} clientId="client-1" clientContacts={contacts} buildingDefault={null} />
    </QueryClientProvider>,
  );
}
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

// ---- wording ------------------------------------------------------------------------------------------------------------------------
test('emailed: "emailed to Name (email)" - only for status sent', () => {
  const line = deliveryLine(invoice({ status: 'sent', xeroInvoiceNumber: 'INV-0021', xeroRecipientName: 'Finity (New Client)', xeroRecipientEmail: 'f@new.test' }), []);
  assert.equal(line, 'Xero invoice INV-0021: emailed to Finity (New Client) (f@new.test).');
});

test('not emailed because of the SYSTEM setting: says so, with the recipient, and never claims it was emailed', () => {
  const line = deliveryLine(invoice({ status: 'in_xero_not_emailed', xeroInvoiceNumber: 'INV-0019', xeroRecipientName: 'Essex Ltd', xeroRecipientEmail: 'a@essex.test', notEmailedReason: 'environment' }), [])!;
  assert.match(line, /^Xero invoice INV-0019: created in Xero — not emailed to Essex Ltd \(a@essex\.test\)\./);
  assert.match(line, /Not emailed because invoice email sending is not enabled for this system \(an administrator setting\)\./);
  assert.doesNotMatch(line, /emailed to Essex Ltd \(a@essex\.test\)\.$/);
});

test('not emailed because the APP toggle was off: says that instead', () => {
  const line = deliveryLine(invoice({ status: 'in_xero_not_emailed', xeroInvoiceNumber: 'INV-0020', xeroRecipientName: 'Essex Ltd', xeroRecipientEmail: 'a@essex.test', notEmailedReason: 'app_setting_off' }), [])!;
  assert.match(line, /Not emailed because Automatic Invoice Emails is turned off in the app\./);
});

test('an OLDER invoice without a recorded recipient falls back to the one local contact linked to the same Xero contact, else says nothing about who', () => {
  const old = invoice({ status: 'sent', xeroInvoiceNumber: 'INV-0010', xeroContactId: XC });
  assert.equal(deliveryLine(old, [contact('c1', 'Sam', 'sam@x.test', XC), contact('c2', 'Other', 'o@x.test', null)]), 'Xero invoice INV-0010: emailed to Sam (sam@x.test).');
  // Two local contacts linked to the same Xero contact: ambiguous, so no name is guessed.
  assert.equal(deliveryLine(old, [contact('c1', 'Sam', 'sam@x.test', XC), contact('c3', 'Pat', 'pat@x.test', XC)]), 'Xero invoice INV-0010: emailed (recipient not recorded for this older invoice).');
  assert.equal(recipientOf({ xeroRecipientName: null, xeroRecipientEmail: null, xeroContactId: null }, []), null);
  assert.equal(deliveryLine(invoice({ status: 'in_xero_not_emailed', xeroInvoiceNumber: 'INV-0015' }), []), 'Xero invoice INV-0015: created in Xero — not emailed. Review and send it from Xero.');
});

test('nothing is said about delivery for a draft or a failed invoice', () => {
  assert.equal(deliveryLine(invoice({ status: 'draft' }), []), null);
  assert.equal(deliveryLine(invoice({ status: 'failed' }), []), null);
  assert.equal(formatRecipient(' ', ''), null);
});

test('the message right after a send comes from the SERVER\'s answer: code EMAIL_DISABLED vs AUTO_EMAIL_OFF, recipient included', () => {
  assert.deepEqual(sendResultMessage({ status: 'sent', xeroInvoiceNumber: 'INV-1', recipientName: 'A', recipientEmail: 'a@x.test' }), { ok: true, message: 'Xero invoice INV-1: emailed to A (a@x.test).' });
  const env = sendResultMessage({ status: 'in_xero_not_emailed', xeroInvoiceNumber: 'INV-2', code: 'EMAIL_DISABLED', recipientName: 'A', recipientEmail: 'a@x.test' });
  assert.match(env.message, /created in Xero — not emailed to A \(a@x\.test\)\. Not emailed because invoice email sending is not enabled for this system/);
  const off = sendResultMessage({ status: 'in_xero_not_emailed', xeroInvoiceNumber: 'INV-3', code: 'AUTO_EMAIL_OFF', recipientName: 'A', recipientEmail: null });
  assert.match(off.message, /not emailed to A\. Not emailed because Automatic Invoice Emails is turned off in the app/);
  assert.deepEqual(sendResultMessage({ status: 'failed', error: 'Xero said no' }), { ok: false, message: 'Xero said no' });
});

test('the editor shows the delivery line for a sent and for a not-emailed invoice', () => {
  assert.match(decode(render(invoice({ status: 'sent', xeroInvoiceId: 'x', xeroInvoiceNumber: 'INV-0021', xeroRecipientName: 'Finity', xeroRecipientEmail: 'f@new.test' }))), /data-testid="invoice-delivery"[^>]*>Xero invoice INV-0021: emailed to Finity \(f@new\.test\)\./);
  assert.match(decode(render(invoice({ status: 'in_xero_not_emailed', xeroInvoiceId: 'x', xeroInvoiceNumber: 'INV-0019', xeroRecipientName: 'Essex', xeroRecipientEmail: 'e@x.test', notEmailedReason: 'environment' }))), /created in Xero — not emailed to Essex \(e@x\.test\)/);
});

// ---- layout: Send / Discard stay reachable ------------------------------------------------------------------------------------------
test('LAYOUT: the action bar (Send invoice, Discard) is sticky at the bottom with its own background and border, so it never hides behind content', () => {
  const html = render(invoice(), [contact('c1', 'Mo', 'mo@x.test', null)]);
  const bar = html.match(/<div data-testid="invoice-actions" class="([^"]+)"/);
  assert.ok(bar, 'the action bar is rendered');
  for (const cls of ['sticky', 'bottom-0', 'bg-white', 'border-t', 'z-10']) assert.ok(bar![1].split(' ').includes(cls), `action bar has ${cls}`);
  const after = html.slice(html.indexOf('data-testid="invoice-actions"'));
  assert.match(after, /Send invoice<\/button>/);
  assert.match(after, /Discard<\/button>/);
});

test('LAYOUT: the Ready for accounts detail column scrolls (it was the one part of the page that could not), giving the sticky bar its container', () => {
  const page = readFileSync(join(process.cwd(), 'src', 'pages', 'ReadyForAccountsPage.tsx'), 'utf8');
  const col = page.match(/data-testid="accounts-detail" className="([^"]+)"/);
  assert.ok(col);
  for (const cls of ['overflow-y-auto', 'min-h-0', 'flex-1']) assert.ok(col![1].split(' ').includes(cls), `detail column has ${cls}`);
});

test('LAYOUT: with many contacts every one is still a recipient option, and no search panel crowds the invoice', () => {
  const many = Array.from({ length: 30 }, (_, i) => contact(`c${i}`, `Person ${i}`, `p${i}@x.test`, null));
  const html = render(invoice(), many);
  assert.doesNotMatch(html, /data-testid="find-xero-contact"|data-testid="unlinked-list"/);
  assert.equal((html.match(/<option value="c\d+"/g) ?? []).length, 30, 'every contact is still a recipient option');
});
