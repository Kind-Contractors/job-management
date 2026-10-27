// A chosen invoice recipient must be in the recipient list the screen shows. A contact just added from the invoice screen is chosen
// once the list has reloaded; if that reload fails, the chosen id is not in the list. Then nothing may be submitted - and never to
// the building default or anyone else in its place - until the list is reloaded. (Before this, the button fell back to "is there a
// usable default?", and the dropdown, unable to show the chosen id, displayed the default while the send would use the chosen id.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RECIPIENT_UNAVAILABLE_MESSAGE, recipientSelectionState, resolveSendRecipientId } from '../src/lib/invoiceRecipient';

const LIST = [{ id: 'ct-default' }, { id: 'ct-sam' }];
const editor = readFileSync(join(process.cwd(), 'src', 'components', 'jobs', 'InvoiceEditor.tsx'), 'utf8').replace(/\r\n/g, '\n');

test('a chosen recipient that IS in the list is available, and is what is sent', () => {
  assert.equal(recipientSelectionState('ct-sam', false, LIST), 'available');
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-sam', usableDefaultContactId: 'ct-default', selectedIsAvailable: true }), 'ct-sam');
});

test('a chosen recipient id that is NOT in the list is "missing"', () => {
  assert.equal(recipientSelectionState('ct-new', false, LIST), 'missing');
  assert.equal(recipientSelectionState('', false, LIST), 'default');
  assert.equal(recipientSelectionState('ct-new', true, LIST), 'adding', 'the open form is its own state');
});

test('FAILED REFRESH after adding a contact: the new id is chosen but the list still lacks it - the send is refused, never redirected', () => {
  // The list as it was before the contact was added (the reload failed), with a usable building default present.
  const state = recipientSelectionState('ct-new', false, LIST);
  assert.equal(state, 'missing');
  assert.throws(
    () => resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-new', usableDefaultContactId: 'ct-default', selectedIsAvailable: state !== 'missing' }),
    (e: Error) => e.message === RECIPIENT_UNAVAILABLE_MESSAGE,
  );
  assert.match(RECIPIENT_UNAVAILABLE_MESSAGE, /could not be refreshed[\s\S]*Nothing has been saved or sent\. Reload the recipients and try again\./);
  // Once the list reloads with it, the same choice goes through - to that contact.
  assert.equal(recipientSelectionState('ct-new', false, [...LIST, { id: 'ct-new' }]), 'available');
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-new', usableDefaultContactId: 'ct-default', selectedIsAvailable: true }), 'ct-new');
});

test('SUBMISSION BLOCKED while unavailable: the main button needs the chosen contact in the list, and the send passes the same fact', () => {
  assert.match(editor, /const recipientUnavailable = !recipientLocked && recipientSelectionState\(effectiveContactId, addingNewContact, clientContacts\) === 'missing';/);
  assert.match(editor, /const recipientChosen = recipientLocked \|\| \(!addingNewContact && !recipientUnavailable && \(selectedContact \? true : !!usableDefaultContactId\)\);/);
  assert.match(editor, /disabled=\{anyMutationPending \|\| lines\.length === 0 \|\| !recipientChosen\}/);
  assert.match(editor, /selectedIsAvailable: !recipientUnavailable,/);
  const send = editor.slice(editor.indexOf('const sendMutation'));
  assert.ok(send.indexOf('resolveSendRecipientId(') < send.indexOf('await persistCurrentDraft()'), 'refused before the draft is saved');
});

test('the screen never shows a different recipient: a "not loaded yet" entry is shown for the chosen id, with the reason and a reload', () => {
  assert.match(editor, /\{recipientUnavailable && \(\s*<option value=\{effectiveContactId\} disabled>\s*Chosen contact not loaded yet\s*<\/option>\s*\)\}/);
  assert.match(editor, /\{recipientUnavailable && \(\s*<div data-testid="recipient-unavailable" role="alert"[^>]*>\s*\{RECIPIENT_UNAVAILABLE_MESSAGE\}/);
  assert.match(editor, /onClick=\{\(\) => void queryClient\.invalidateQueries\(\{ queryKey: \['jobRows'\] \}\)\}[\s\S]{0,120}Reload recipients/);
});

test('DEFAULT unchanged: with nothing chosen, a usable building default is used (no contactId sent); without one, nothing is guessed', () => {
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: 'ct-default', selectedIsAvailable: true }), undefined);
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: 'ct-default' }), undefined);
  assert.throws(() => resolveSendRecipientId({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: null }), /no usable default/);
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-default', usableDefaultContactId: 'ct-default' }), undefined, 'choosing the default itself still sends no contactId');
  assert.equal(resolveSendRecipientId({ recipientLocked: true, addingNewContact: false, selectedContactId: 'ct-new', selectedIsAvailable: false }), undefined, 'a locked recipient is decided by the server, as before');
});
