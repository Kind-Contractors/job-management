// Contacts are no longer added from the invoice screen ("+ Add another email address" was removed): they are added and edited in
// the Building File (Contacts & Defaults). The shared new-contact form keeps its checks, including the optional required-email
// variant; a new contact still cannot be invoiced until it is linked to its existing Xero contact.
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
  assert.deepEqual(ok, { ok: true, input: { name: 'Alex', email: 'alex@contour.test', phoneNumber: '0207', isPrimary: false, isAccountsContact: false } });
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

test('SAVE: the shared form creates the contact, then reloads the lists - and never saves, creates in Xero or sends anything else', () => {
  const form = src('src', 'components', 'contacts', 'NewContactForm.tsx');
  const fn = form.slice(form.indexOf('mutationFn: async'), form.indexOf('onSuccess:'));
  assert.ok(fn.indexOf('createContactForClient(clientId, input)') < fn.indexOf('invalidateQueries'), 'created, then reloaded');
  assert.match(form, /disabled=\{createMutation\.isPending\}/, 'no double submit while saving');
  assert.doesNotMatch(form, /sendInvoice|updateInvoiceDraft|xeroLinks|xero-create|xero-link|linkContact/i);
});

test('REMOVED: the invoice editor no longer adds contacts; it points to Contacts & Defaults in a new tab instead', () => {
  const editor = src('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  assert.doesNotMatch(editor, /Add another email address|ADD_NEW_CONTACT_VALUE|<NewContactForm|NewRecipientDialog|createContactForClient/);
  assert.match(editor, /Set up contacts &amp; defaults/);
});

test('the invoice screen passes the job\'s client, its name and its building (for the Contacts & Defaults link)', () => {
  const page = src('src', 'pages', 'ReadyForAccountsPage.tsx');
  assert.match(page, /clientId=\{selected\.job\.clientId\}\s+clientName=\{selected\.job\.clientName\}\s+buildingId=\{selected\.job\.buildingId\}\s+clientContacts=\{selected\.job\.clientContacts\}/);
});

test('REGRESSION: the Building File keeps an optional email; All Live Jobs keeps its own popover with the shared checks', () => {
  assert.doesNotMatch(src('src', 'components', 'buildings', 'BuildingAddContactForm.tsx'), /requireEmail/);
  const popover = src('src', 'components', 'jobs', 'ContactPopover.tsx');
  assert.match(popover, /checkContactForm\(form, contacts, adding \? null : selectedId\)/);
  assert.doesNotMatch(popover, /requireEmail/);
});

