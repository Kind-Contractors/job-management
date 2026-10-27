// "+ Add another email address" on the invoice screen (Ready for accounts): the shared new-contact form, for the job's client,
// with a REQUIRED valid email. A new contact is saved on its own (in the app only), becomes the chosen recipient once the
// recipient list has reloaded, and cannot be invoiced until the manager links it to its existing Xero contact - which the notice
// offers straight away. Nothing is saved, created in Xero or emailed until the manager presses the main button.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import NewContactForm from '../src/components/contacts/NewContactForm';
import { BLANK_CONTACT_FORM, checkContactForm } from '../src/lib/contactForm';
import { canSendInvoiceTo } from '../src/lib/xeroLinkStatus';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const CONTACTS = [{ id: 'c1', name: 'Sam Client', email: 'sam@atlas.test', isPrimary: true }];

test('CHECKS: an invoice recipient needs a valid email; name still required; duplicates still refused', () => {
  const check = (over: Partial<typeof BLANK_CONTACT_FORM>) => checkContactForm({ ...BLANK_CONTACT_FORM, ...over }, CONTACTS, null, { requireEmail: true });
  assert.deepEqual(check({ name: '' }), { ok: false, error: 'Enter a name.' });
  assert.deepEqual(check({ name: 'Alex' }), { ok: false, error: 'Enter an email address.' });
  assert.deepEqual(check({ name: 'Alex', email: 'not-an-email' }), { ok: false, error: 'Enter a valid email address.' });
  assert.match((check({ name: 'Sam 2', email: ' SAM@atlas.test ' }) as { error: string }).error, /Sam Client already has this email address/);
  const ok = check({ name: ' Alex ', email: ' alex@contour.test ', phoneNumber: '0207' });
  assert.deepEqual(ok, { ok: true, input: { name: 'Alex', email: 'alex@contour.test', phoneNumber: '0207', isPrimary: false } });
});

test('a contact created this way is NOT a valid recipient until it is linked: it is never matched or created in Xero on send', () => {
  assert.equal(canSendInvoiceTo({ xeroContactId: null, xeroOrgId: null }), false);
  assert.equal(canSendInvoiceTo({ xeroContactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', xeroOrgId: 'org-1' }), true, 'once linked');
});

test('FORM: the invoice variant marks the email required and carries its note; Create and Cancel', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NewContactForm clientId="client-1" title="New recipient for Atlas Property" contacts={CONTACTS} requireEmail refreshKeys={[['jobRows']]} note={<div>NOTE</div>} onCancel={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  );
  assert.match(html, /New recipient for Atlas Property/);
  assert.match(html, /<input type="email" aria-required="true"/);
  assert.match(html, /NOTE/);
  assert.match(html, />Create contact<\/button>/);
  assert.match(html, />Cancel<\/button>/);
});

test('SAVE: the contact is created, the recipient lists reload, THEN it is chosen - and nothing is saved, created in Xero or sent', () => {
  const form = src('src', 'components', 'contacts', 'NewContactForm.tsx');
  const fn = form.slice(form.indexOf('mutationFn: async'), form.indexOf('onSuccess:'));
  assert.ok(fn.indexOf('createContactForClient(clientId, input)') < fn.indexOf('invalidateQueries'), 'created, then reloaded');
  assert.match(form, /disabled=\{createMutation\.isPending\}/, 'no double submit while saving');
  assert.doesNotMatch(form, /sendInvoice|updateInvoiceDraft|xeroLinks|xero-create|xero-link|linkContact/i);
  const editor = src('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  const block = editor.slice(editor.indexOf('<NewContactForm'), editor.indexOf('/>', editor.indexOf('onCreated={(contact)')) + 2);
  assert.match(block, /clientId=\{clientId\}/);
  assert.match(block, /contacts=\{clientContacts\}/);
  assert.match(block, /requireEmail/);
  assert.match(block, /refreshKeys=\{\[\['jobRows'\], \['historicalJobRows'\], \['contacts', clientId\]\]\}/);
  assert.match(block, /onCancel=\{\(\) => setSelectedContactId\(''\)\}/);
  assert.match(block, /setSelectedContactId\(contact\.id\);/);
  assert.match(block, /The invoice has not been saved, created in Xero or emailed\./);
  assert.doesNotMatch(block, /sendMutation|sendInvoice|persistCurrentDraft|updateInvoiceDraft/, 'adding a contact never saves or sends the invoice');
  assert.match(block, /This invoice is not saved, created in Xero or emailed until you press\s+“\{mode\.label\}”/);
  assert.match(block, /nothing is created or linked in Xero\. Before this invoice can be submitted, link the\s+contact to its existing Xero contact \(offered next\)/);
  assert.match(block, /setJustAdded\(contact\);/, 'the notice then offers the link for this contact');
});

test('the invoice screen passes the job\'s client and its name; the editor keeps its own unsaved edits (it stays open)', () => {
  const page = src('src', 'pages', 'ReadyForAccountsPage.tsx');
  assert.match(page, /clientId=\{selected\.job\.clientId\}\s+clientName=\{selected\.job\.clientName\}\s+clientContacts=\{selected\.job\.clientContacts\}/);
  const editor = src('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  assert.doesNotMatch(editor.slice(editor.indexOf('<NewContactForm'), editor.indexOf('</div>', editor.indexOf('onCreated={(contact)'))), /setDescription|setLines|setDueDate|onClose\(/);
});

test('REGRESSION: the Building File keeps an optional email; All Live Jobs keeps its own popover with the shared checks', () => {
  assert.doesNotMatch(src('src', 'components', 'buildings', 'BuildingAddContactForm.tsx'), /requireEmail/);
  const popover = src('src', 'components', 'jobs', 'ContactPopover.tsx');
  assert.match(popover, /checkContactForm\(form, contacts, adding \? null : selectedId\)/);
  assert.doesNotMatch(popover, /requireEmail/);
});

test('DIALOG: "+ Add another email address" opens the form in a dialog over the invoice; Close, Cancel, a click outside or Escape go back', () => {
  const editor = src('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  const dialog = editor.slice(editor.indexOf('function NewRecipientDialog('));
  assert.match(dialog, /className="fixed inset-0 z-\[60\] flex items-center justify-center bg-ink\/30"\s+onClick=\{onClose\}/, 'a click outside closes it');
  assert.match(dialog, /if \(e\.key === 'Escape'\) onClose\(\);/);
  assert.match(dialog, /role="dialog"\s+aria-modal="true"/);
  assert.match(dialog, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/, 'clicks inside do not close it');
  assert.match(dialog, />\s*Close\s*<\/button>/);
  assert.match(editor, /<NewRecipientDialog clientName=\{clientName\} onClose=\{\(\) => setSelectedContactId\(''\)\}>/, 'closing returns to the recipient list with nothing chosen');
  assert.match(editor, /\{editable && !recipientLocked && addingNewContact && \(/, 'only for an invoice that can still change recipient');
  assert.match(src('src', 'components', 'contacts', 'NewContactForm.tsx'), /aria-required="true"\s+autoFocus/, 'the cursor starts in Name');
});
