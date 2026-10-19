// The invoice editor's main button and recipient section follow the two settings that decide emailing: the app's Automatic
// Invoice Emails toggle and the system's XERO_SENDING_ENABLED (which the toggle never overrides).
//
//   toggle OFF                 -> "Create in Xero", no "Send invoice to"; the Xero contact is the building default (shown), or
//                                 one the manager must choose (shown as the Xero contact, with why), or the locked one
//   toggle ON,  sending ON     -> "Send invoice", "Send invoice to" shown
//   toggle ON,  sending OFF    -> "Create in Xero", "Send invoice to" still shown, and a notice that this system does not email
//   anything unknown           -> nothing promised either way
// Real components rendered to static markup with the query cache seeded (there is no DOM library in this repo).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import InvoiceEditor, { XERO_INVOICE_CAPABILITIES_QUERY_KEY } from '../src/components/jobs/InvoiceEditor';
import { AUTO_INVOICE_EMAIL_QUERY_KEY } from '../src/components/settings/AutoInvoiceEmailSetting';
import type { BuildingDefaultRecipient, InvoiceDetail, JobContactSummary } from '../src/domain/types';
import { invoiceActionMode, needsXeroContactChoice } from '../src/lib/invoiceActionMode';
import { resolveSendRecipientId } from '../src/lib/invoiceRecipient';

const ORG = 'org-1';
const XC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const contact = (id: string, name: string, over: Partial<JobContactSummary> = {}): JobContactSummary => ({
  id, name, email: `${id}@client.test`, phoneNumber: null, isPrimary: false, isAccountsContact: false,
  xeroContactId: XC, xeroOrgId: ORG, xeroContactName: `${name} Ltd`, xeroLinkedAt: '2026-10-01T00:00:00Z', ...over,
});
const SAM = contact('ct-sam', 'Sam');
const PAT = contact('ct-pat', 'Pat', { xeroContactId: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', xeroContactName: 'Pat Ltd' });
const DEFAULT: BuildingDefaultRecipient = { contactId: 'ct-sam', xeroContactId: XC, xeroOrgId: ORG };

function invoice(over: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: 'inv-1', jobId: 'job-1', status: 'draft', dueDate: '2026-11-17', description: null, worksOrderNumber: null,
    xeroInvoiceId: null, xeroInvoiceNumber: null, xeroContactId: null, xeroRecipientName: null, xeroRecipientEmail: null, notEmailedReason: null,
    lastError: null, sentAt: null, lineItems: [{ id: 'li-1', visitId: 'v-1', description: 'Clean', quantity: 1, unitAmount: 100 }], ...over,
  };
}
interface Setup { toggle: boolean | null; sending: boolean | null; inv?: InvoiceDetail; contacts?: JobContactSummary[]; def?: BuildingDefaultRecipient | null }
function render({ toggle, sending, inv = invoice(), contacts = [SAM, PAT], def = DEFAULT }: Setup): string {
  const qc = new QueryClient();
  qc.setQueryData(['invoice', inv.id], inv);
  if (toggle !== null) qc.setQueryData(AUTO_INVOICE_EMAIL_QUERY_KEY, { enabled: toggle, updatedAt: '2026-10-18T00:00:00Z' });
  if (sending !== null) qc.setQueryData(XERO_INVOICE_CAPABILITIES_QUERY_KEY, { creationEnabled: true, sendingEnabled: sending });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId={inv.id} onClose={() => {}} clientId="client-1" clientContacts={contacts} buildingDefault={def} />
    </QueryClientProvider>,
  );
  return html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}
const actionBar = (html: string) => html.slice(html.indexOf('data-testid="invoice-actions"'));
const mainButton = (html: string) => actionBar(html).match(/<button([^>]*)>([^<]+)<\/button>/)!;
const hasSendTo = (html: string) => /Send invoice to<select/.test(html);

// ---- the rules, every combination ---------------------------------------------------------------------------------------------------
test('RULES: toggle OFF -> "Create in Xero" and no "Send invoice to", whatever the system switch says', () => {
  for (const sending of [true, false, null]) {
    const m = invoiceActionMode({ autoEmailEnabled: false, systemSendingEnabled: sending });
    assert.equal(m.label, 'Create in Xero', String(sending));
    assert.equal(m.kind, 'create');
    assert.equal(m.showSendTo, false);
    assert.match(m.notice.text, /created in Xero but not emailed/);
  }
});

test('RULES: toggle ON and system sending ON -> "Send invoice", "Send invoice to" shown', () => {
  const m = invoiceActionMode({ autoEmailEnabled: true, systemSendingEnabled: true });
  assert.deepEqual([m.kind, m.label, m.pendingLabel, m.showSendTo, m.notice.warn], ['send', 'Send invoice', 'Sending…', true, false]);
});

test('RULES: toggle ON but system sending OFF -> "Create in Xero", "Send invoice to" still shown, and a warning that this system will not email', () => {
  const m = invoiceActionMode({ autoEmailEnabled: true, systemSendingEnabled: false });
  assert.deepEqual([m.kind, m.label, m.showSendTo, m.notice.warn], ['create', 'Create in Xero', true, true]);
  assert.match(m.notice.text, /This system does not email invoices/);
  assert.match(m.notice.text, /even though Automatic Invoice Emails is on/);
});

test('RULES: the toggle never turns into "Send invoice" unless the system switch is known to be ON; unknown promises nothing', () => {
  for (const toggle of [true, false, null]) {
    for (const sending of [true, false, null]) {
      const m = invoiceActionMode({ autoEmailEnabled: toggle, systemSendingEnabled: sending });
      assert.equal(m.label === 'Send invoice', toggle === true && sending === true, `${toggle}/${sending}`);
    }
  }
  assert.equal(invoiceActionMode({ autoEmailEnabled: true, systemSendingEnabled: null }).label, 'Submit to Xero');
  assert.equal(invoiceActionMode({ autoEmailEnabled: null, systemSendingEnabled: true }).label, 'Submit to Xero');
  assert.equal(invoiceActionMode({ autoEmailEnabled: null, systemSendingEnabled: false }).label, 'Create in Xero');
  assert.equal(invoiceActionMode({ autoEmailEnabled: null, systemSendingEnabled: null }).showSendTo, true, 'unknown: keep the recipient visible');
});

test('RULES: with "Send invoice to" hidden, a Xero contact is still required unless the locked contact or a usable default decides it', () => {
  assert.equal(needsXeroContactChoice({ recipientLocked: true, usableDefault: false, chooseOther: false }), false);
  assert.equal(needsXeroContactChoice({ recipientLocked: false, usableDefault: true, chooseOther: false }), false);
  assert.equal(needsXeroContactChoice({ recipientLocked: false, usableDefault: true, chooseOther: true }), true);
  assert.equal(needsXeroContactChoice({ recipientLocked: false, usableDefault: false, chooseOther: false }), true, 'never guessed');
});

// ---- the editor, rendered -----------------------------------------------------------------------------------------------------------
test('EDITOR toggle OFF, building default usable: "Create in Xero" (enabled), no "Send invoice to", the default Xero contact is shown', () => {
  const html = render({ toggle: false, sending: true });
  // (The button's enabled state is not checked in static markup: line items load in an effect that does not run here.)
  assert.equal(mainButton(html)[2], 'Create in Xero');
  assert.doesNotMatch(html, /Choose the Xero contact|Choose who to send/, 'the default decides the Xero contact, so nothing needs choosing');
  assert.equal(hasSendTo(html), false);
  assert.doesNotMatch(html, /<select/, 'no picker at all');
  assert.match(html, /data-testid="invoice-xero-contact"[^>]*>Created in Xero for <span[^>]*>Sam Ltd<\/span>, this building's\s*default invoice contact\. It will not be emailed\./);
  assert.match(html, />Use a different contact<\/button>/);
  assert.doesNotMatch(html, /Send invoice</);
});

test('EDITOR toggle OFF, NO usable default: a Xero-contact picker (not "Send invoice to") with the reason, and the button waits for a choice', () => {
  const html = render({ toggle: false, sending: false, def: null });
  assert.equal(hasSendTo(html), false);
  assert.match(html, /Xero contact for this invoice<select/);
  assert.match(html, /Xero needs a contact on every invoice, and this building has no usable default invoice contact, so choose which contact this invoice is for\. It will not be emailed\./);
  assert.match(html, /Choose the Xero contact this invoice is for\. A contact/);
  assert.equal(mainButton(html)[2], 'Create in Xero');
  assert.match(html, /<option value="" disabled="" selected="">Choose a recipient…<\/option>/, 'nothing is preselected: not the first, primary or only contact');
});

test('EDITOR toggle OFF, invoice already in Xero: the locked Xero contact is shown, no picker', () => {
  const html = render({ toggle: false, sending: true, inv: invoice({ status: 'failed', xeroInvoiceId: 'x-inv', xeroInvoiceNumber: 'INV-9', xeroContactId: XC }) });
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /Xero contact: <span[^>]*>Sam Ltd<\/span>\./);
  assert.match(html, /recipient is locked/);
  assert.match(html, /Clicking "Create in Xero" again will update this same Xero invoice/);
  assert.doesNotMatch(html, /retry emailing it/);
});

test('EDITOR toggle ON, system sending ON: "Send invoice" and "Send invoice to"', () => {
  const html = render({ toggle: true, sending: true });
  assert.equal(mainButton(html)[2], 'Send invoice');
  assert.equal(hasSendTo(html), true);
  assert.match(html, /<option value="" selected="">Building default: Sam Ltd<\/option>/);
  assert.doesNotMatch(html, /data-testid="invoice-xero-contact"/);
});

test('EDITOR toggle ON, system sending OFF: "Create in Xero", "Send invoice to" still shown, and the warning notice', () => {
  const html = render({ toggle: true, sending: false });
  assert.equal(mainButton(html)[2], 'Create in Xero');
  assert.equal(hasSendTo(html), true);
  assert.match(html, /data-testid="invoice-email-notice" class="border border-due[^"]*">This system does not email invoices/);
});

test('EDITOR settings not loaded yet: neutral "Submit to Xero", recipient visible', () => {
  const html = render({ toggle: null, sending: null });
  assert.equal(mainButton(html)[2], 'Submit to Xero');
  assert.equal(hasSendTo(html), true);
});

test('EDITOR: the sticky action bar is unchanged in every mode', () => {
  for (const [toggle, sending] of [[false, true], [true, true], [true, false]] as const) {
    const bar = render({ toggle, sending }).match(/<div data-testid="invoice-actions" class="([^"]+)"/)!;
    for (const cls of ['sticky', 'bottom-0', 'bg-white', 'border-t', 'z-10']) assert.ok(bar[1].split(' ').includes(cls), `${toggle}/${sending} ${cls}`);
  }
});

// ---- what is sent: never a guessed or stale contact ----------------------------------------------------------------------------------
test('SEND: with the picker hidden the default is used (no contactId) - a choice made earlier while it was visible is ignored', () => {
  const code = readFileSync(join(process.cwd(), 'src', 'components', 'jobs', 'InvoiceEditor.tsx'), 'utf8');
  assert.match(code, /const effectiveContactId = showContactPicker \? selectedContactId : '';/);
  assert.match(code, /selectedContactId: effectiveContactId,/);
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: 'ct-sam' }), undefined, 'the server uses the default');
  assert.throws(() => resolveSendRecipientId({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: null }), /no usable default/, 'no default and no choice: refused, never guessed');
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-pat', usableDefaultContactId: 'ct-sam' }), 'ct-pat', '"Use a different contact" sends that contact');
});

test('SEND: the editor reads the system switch only through the read-only capabilities request; the server still decides', () => {
  const repo = readFileSync(join(process.cwd(), 'src', 'repository', 'invoicesRepository.ts'), 'utf8');
  assert.match(repo, /invoke<XeroInvoiceCapabilities>\('xero-create-invoice', \{ body: \{ action: 'capabilities' \} \}\)/);
});
