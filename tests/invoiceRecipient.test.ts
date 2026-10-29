// "+ Add another email address" on the invoice editor opens the shared new-contact form. A new contact is saved on its OWN (an
// app contact only); sending never creates one. The server sends to a linked contact, or to an unlinked one with a valid email
// (matched to its Xero contact by email, or created in Xero, on the first send - autoXeroContact.ts).
//
// Earlier history: the option once created the contact inside the send; when the server required a Xero link it became a
// refusal message; once the server could match/create Xero contacts the form came back - as a separate step, never as part of
// sending. There is no DOM library in this repo, so the rule is tested directly and the editor's wiring in its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSourceFile } from './helpers/sourceCode';

import { resolveSendRecipientId, UNLINKED_NEW_CONTACT_MESSAGE } from '../src/lib/invoiceRecipient';

const editor = readSourceFile('src', 'components', 'jobs', 'InvoiceEditor.tsx');
const code = editor.replace(/\r\n/g, '\n').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('sending while the new-contact form is open is refused: save the contact first - nothing is saved or sent', () => {
  assert.throws(
    () => resolveSendRecipientId({ addingNewContact: true, selectedContactId: '' }),
    (e: Error) => e.message === UNLINKED_NEW_CONTACT_MESSAGE,
  );
  assert.match(UNLINKED_NEW_CONTACT_MESSAGE, /Save the new contact first \(Create contact\), then send\./);
  assert.match(UNLINKED_NEW_CONTACT_MESSAGE, /Nothing was saved or sent\./);
});

test('it is refused even if an existing contact was chosen earlier (the open form wins: it is what is on screen)', () => {
  assert.throws(() => resolveSendRecipientId({ addingNewContact: true, selectedContactId: 'ct-1' }), /Save the new contact first/);
});

test('an existing contact is passed straight through', () => {
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-1' }), 'ct-1');
});

test('with nothing chosen there is nothing to send to', () => {
  assert.throws(() => resolveSendRecipientId({ addingNewContact: false, selectedContactId: '' }), /Choose a recipient/);
});

test('sending never creates a contact: the send has no contact creation in it, and the editor has no contact inputs of its own', () => {
  const mutation = code.slice(code.indexOf('const sendMutation'), code.indexOf('const anyMutationPending'));
  assert.doesNotMatch(mutation, /createContactForClient|NewContactForm/);
  assert.doesNotMatch(code, /createContactForClient|newContactName|newContactEmail/, 'only the shared form creates contacts');
  assert.deepEqual(code.match(/isValidEmail\([^)]*\)/g), ['isValidEmail(selectedContact.email)'], 'email validity is only read, to explain a contact without one');
});

test('the refusal happens FIRST in the send: before the draft is saved and before anything is sent', () => {
  const mutation = code.slice(code.indexOf('const sendMutation'));
  const refuse = mutation.indexOf('resolveSendRecipientId(');
  const save = mutation.indexOf('await persistCurrentDraft()');
  const send = mutation.indexOf('sendInvoice(invoiceId');
  assert.ok(refuse >= 0 && save >= 0 && send >= 0, 'all three steps are in the send');
  assert.ok(refuse < save && save < send, `refuse (${refuse}) < save (${save}) < send (${send})`);
});

test('Send needs a chosen recipient (locked, a listed contact, or the usable default); there is no "add" option on the invoice any more', () => {
  assert.match(code, /const recipientChosen = recipientLocked \|\| \(!recipientUnavailable && \(selectedContact \? true : !!usableDefaultContactId\)\);/);
  assert.match(code, /disabled=\{anyMutationPending \|\| lines\.length === 0 \|\| !recipientChosen\}/);
  assert.doesNotMatch(code, /NewRecipientDialog|<NewContactForm|ADD_NEW_CONTACT_VALUE/);
});

test('a refused send surfaces its message through the existing error path (onError), not a silent failure', () => {
  assert.match(code, /onError: \(err\) => \{\s*invalidate\(\);\s*setSendResult\(\{ ok: false, message: err instanceof Error \? err\.message : 'Failed to send\.' \}\);\s*\},/);
});
