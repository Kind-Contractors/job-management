// "Add another email address" on the invoice editor must never create a local contact that cannot be sent to.
//
// The server (xero-create-invoice) refuses a recipient that is not linked to an existing Xero contact, and a contact
// created on the spot has no link. Creating it first and sending second meant every attempt failed AND left an
// orphan, unlinked contact behind (one more on every retry). The rule now lives in src/lib/invoiceRecipient.ts and is
// applied before anything is saved or created.
//
// There is no DOM library in this repo, so the rule is tested directly, and the editor's wiring of it is checked in
// its source (the click-through itself is the DEV browser test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveSendRecipientId, UNLINKED_NEW_CONTACT_MESSAGE } from '../src/lib/invoiceRecipient';

const editor = readFileSync(join(process.cwd(), 'src', 'components', 'jobs', 'InvoiceEditor.tsx'), 'utf8');
const code = editor.replace(/\r\n/g, '\n').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('choosing "+ Add another email address" is refused with a clear message that the recipient must be linked first', () => {
  assert.throws(
    () => resolveSendRecipientId({ addingNewContact: true, selectedContactId: '' }),
    (e: Error) => e.message === UNLINKED_NEW_CONTACT_MESSAGE,
  );
  assert.match(UNLINKED_NEW_CONTACT_MESSAGE, /must be linked to an existing Xero contact before an invoice can be sent/);
  assert.match(UNLINKED_NEW_CONTACT_MESSAGE, /nothing was saved or sent/);
});

test('it is refused even if an existing contact was chosen earlier (the "add" choice wins: it is what is on screen)', () => {
  assert.throws(() => resolveSendRecipientId({ addingNewContact: true, selectedContactId: 'ct-1' }), /must be linked/);
});

test('an existing contact is passed straight through', () => {
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-1' }), 'ct-1');
});

test('with nothing chosen there is nothing to send to', () => {
  assert.throws(() => resolveSendRecipientId({ addingNewContact: false, selectedContactId: '' }), /Choose a recipient/);
});

test('the editor can no longer create a local contact at all: no import, no call, no new-contact inputs or state', () => {
  assert.doesNotMatch(code, /createContactForClient|contactsRepository/);
  assert.doesNotMatch(code, /newContactName|newContactEmail|isValidEmail/);
});

test('the refusal happens FIRST in the send: before the draft is saved and before anything is sent', () => {
  const mutation = code.slice(code.indexOf('const sendMutation'));
  const refuse = mutation.indexOf('resolveSendRecipientId(');
  const save = mutation.indexOf('await persistCurrentDraft()');
  const send = mutation.indexOf('sendInvoice(invoiceId');
  assert.ok(refuse >= 0 && save >= 0 && send >= 0, 'all three steps are in the send');
  assert.ok(refuse < save && save < send, `refuse (${refuse}) < save (${save}) < send (${send})`);
});

test('Send is disabled while the "add" option is selected, and the message is shown instead of inputs', () => {
  assert.match(code, /const recipientValid = recipientLocked \|\| \(!addingNewContact && /);
  assert.match(code, /disabled=\{anyMutationPending \|\| lines\.length === 0 \|\| !recipientValid\}/);
  assert.match(code, /addingNewContact \? \(\s*<div[^>]*>\{UNLINKED_NEW_CONTACT_MESSAGE\}<\/div>/);
});

test('a refused send surfaces its message through the existing error path (onError), not a silent failure', () => {
  assert.match(code, /onError: \(err\) => \{\s*invalidate\(\);\s*setSendResult\(\{ ok: false, message: err instanceof Error \? err\.message : 'Failed to send\.' \}\);\s*\},/);
});
