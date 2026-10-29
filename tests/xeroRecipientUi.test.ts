// The recipient rules the Manager UI applies before anything is sent, and the wiring that keeps the UI honest about the server's
// rules (the server enforces every one of them regardless of what the screen shows). Pure rules are tested directly; there is no
// DOM library in this repo, so the components' wiring is checked in their source, and the click-through is the DEV browser test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LOCKED_RECIPIENT_MESSAGE,
  NO_USABLE_DEFAULT_MESSAGE,
  NOT_LINKED_RECIPIENT_MESSAGE,
  resolveSendRecipientId,
} from '../src/lib/invoiceRecipient';
import { canSendInvoiceTo, defaultRecipientProblem, isUsableRecipient, isValidEmail, linkStatusLabel, localLinkStatus } from '../src/lib/xeroLinkStatus';

const src = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (t: string) => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const XC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const linked = { id: 'ct-1', xeroContactId: XC, xeroOrgId: ORG };

// ---- link status ----------------------------------------------------------------------------------------------------------------------
test('a contact is linked only when it has a Xero contact AND the organisation it was linked in', () => {
  assert.equal(localLinkStatus({ xeroContactId: XC, xeroOrgId: ORG }), 'linked');
  assert.equal(localLinkStatus({ xeroContactId: XC, xeroOrgId: null }), 'needs_relink');
  assert.equal(localLinkStatus({ xeroContactId: XC, xeroOrgId: '  ' }), 'needs_relink');
  assert.equal(localLinkStatus({ xeroContactId: null, xeroOrgId: null }), 'not_linked');
  assert.equal(isUsableRecipient({ xeroContactId: XC, xeroOrgId: null }), false, 'an untagged legacy link is not usable until re-linked');
});

test('the link label says what the manager needs to know', () => {
  assert.match(linkStatusLabel({ xeroContactId: XC, xeroOrgId: ORG, xeroContactName: 'Oak Estates Ltd' }), /Linked to Xero: Oak Estates Ltd/);
  assert.match(linkStatusLabel({ xeroContactId: XC, xeroOrgId: null, xeroContactName: null }), /link it again/);
  assert.match(linkStatusLabel({ xeroContactId: null, xeroOrgId: null, xeroContactName: null }), /Not linked/);
});

// ---- the building default as the UI sees it ----------------------------------------------------------------------------------------------
test('a building default is only usable while the contact still has the link the default was chosen with', () => {
  const def = { contactId: 'ct-1', xeroContactId: XC, xeroOrgId: ORG };
  assert.equal(defaultRecipientProblem(null, [linked]), null, 'no default is not a problem, it simply is not used');
  assert.equal(defaultRecipientProblem(def, [linked]), null);
  assert.match(defaultRecipientProblem(def, [{ ...linked, xeroContactId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }])!, /link has changed/);
  assert.match(defaultRecipientProblem(def, [{ ...linked, xeroOrgId: null }])!, /link has changed/);
  assert.match(defaultRecipientProblem(def, [])!, /no longer a contact of this client/);
});

// ---- what is sent as contactId ------------------------------------------------------------------------------------------------------------
test('with the building default chosen (or nothing chosen), no contactId is sent: the server uses the default', () => {
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: 'ct-1' }), undefined);
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-1', usableDefaultContactId: 'ct-1' }), undefined);
});

test('choosing ANOTHER linked contact for this invoice sends that contact', () => {
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-2', usableDefaultContactId: 'ct-1', selectedIsLinked: true }), 'ct-2');
});

test('with no usable default and nothing chosen the send is refused with an explanation: nothing is guessed', () => {
  assert.throws(() => resolveSendRecipientId({ addingNewContact: false, selectedContactId: '', usableDefaultContactId: null }), (e: Error) => e.message === NO_USABLE_DEFAULT_MESSAGE);
  assert.match(NO_USABLE_DEFAULT_MESSAGE, /no usable default recipient/);
});

test('an unlinked contact is refused before anything is saved', () => {
  assert.throws(
    () => resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-2', usableDefaultContactId: 'ct-1', selectedIsLinked: false }),
    (e: Error) => e.message === NOT_LINKED_RECIPIENT_MESSAGE,
  );
});

test('once Xero holds the invoice, the recipient is the server\'s (locked) one: no contactId is sent, whatever was picked', () => {
  assert.equal(resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-2', usableDefaultContactId: 'ct-1', recipientLocked: true }), undefined);
  assert.match(LOCKED_RECIPIENT_MESSAGE, /already exists in Xero, so its recipient is locked/);
});

// ---- wiring (source) ----------------------------------------------------------------------------------------------------------------------
test('the invoice editor no longer guesses a recipient from the primary or only contact', () => {
  const code = stripComments(src('components', 'jobs', 'InvoiceEditor.tsx'));
  assert.doesNotMatch(code, /resolveDisplayContact/);
  assert.doesNotMatch(code, /isPrimary/);
  assert.match(code, /usableDefaultContactId/);
});

test('the invoice editor locks the recipient once the invoice exists in Xero (shown, no picker), and offers every contact (linked or not)', () => {
  const code = stripComments(src('components', 'jobs', 'InvoiceEditor.tsx'));
  assert.match(code, /const recipientLocked = !!invoice\?\.xeroInvoiceId;/);
  assert.match(code, /const showContactPicker = needsXeroContactChoice\(\{ recipientLocked, usableDefault: !!usableDefaultContactId, chooseOther: chooseOtherContact \}\);/);
  assert.match(code, /\{recipientLocked \? \(\s*<>[\s\S]*?locked: this invoice is already in Xero\./);
  assert.match(code, /<option key=\{c\.id\} value=\{c\.id\}>/);
  assert.match(code, /LOCKED_RECIPIENT_MESSAGE/);
});

test('the Ready for accounts page hands the invoice editor the building default', () => {
  assert.match(src('pages', 'ReadyForAccountsPage.tsx'), /buildingDefault=\{selected\.job\.buildingDefaultRecipient\}/);
});

test('the link dialog selects nothing for the manager, searches only on submit, and links only on an explicit confirm', () => {
  const code = stripComments(src('components', 'jobs', 'LinkXeroContactDialog.tsx'));
  assert.match(code, /useState<XeroContactCandidate \| null>\(null\)/, 'nothing is chosen initially');
  assert.match(code, /onSubmit=/, 'a search needs a submit');
  assert.doesNotMatch(code, /results\.length === 1|results\[0\]/, 'a single result is never auto-chosen');
  assert.match(code, /disabled=\{blocked\}/, 'archived / merged / email-less candidates cannot be chosen');
  assert.match(code, /expectedName: c\.name/, 'the name the manager saw is confirmed to the server');
  assert.match(code, /replacing && !replace/, 'replacing an existing link needs an explicit confirmation');
});

test('the Xero link repository only ever calls the manager-only link function, with explicit actions', () => {
  const code = stripComments(src('repository', 'xeroLinksRepository.ts'));
  assert.deepEqual([...code.matchAll(/functions\.invoke<[^>]*>\('([^']+)'/g)].map((m) => m[1]), ['xero-link-contact']);
  for (const a of ['findByEmail', 'search', 'verify', 'link', 'unlink', 'setBuildingDefault', 'clearBuildingDefault']) assert.match(code, new RegExp(`action: '${a}'`));
  assert.doesNotMatch(code, /from\('contacts'\)|from\('buildings'\)|\.update\(|\.insert\(/, 'it never writes links or defaults straight to the database');
});

test('the browser never writes link or default columns directly (the server decides, after checking the manager and the organisation)', () => {
  for (const f of [['repository', 'contactsRepository.ts'], ['repository', 'buildingsRepository.ts'], ['repository', 'jobsRepository.ts']]) {
    assert.doesNotMatch(stripComments(src(...f)), /xero_contact_id\s*:|xero_org_id\s*:|default_invoice_\w+\s*:/, `${f.join('/')} must not write link columns`);
  }
});

test('only an explicitly LINKED contact can be invoiced: an unlinked one never is, whatever its email (no automatic matching)', () => {
  assert.equal(canSendInvoiceTo({ xeroContactId: XC, xeroOrgId: ORG }), true, 'linked');
  assert.equal(canSendInvoiceTo({ xeroContactId: XC, xeroOrgId: null }), false, 'an untagged legacy link must be re-linked by hand');
  assert.equal(canSendInvoiceTo({ xeroContactId: null, xeroOrgId: null }), false, 'unlinked: refused, never matched by email or created');
  assert.equal(canSendInvoiceTo({ xeroContactId: '', xeroOrgId: null }), false, 'a blank link is not a link');
  const withEmail = { xeroContactId: null, xeroOrgId: null, email: 'sam@client.test' };
  assert.equal(canSendInvoiceTo(withEmail), false, 'a valid email does not make an unlinked contact sendable');
  assert.equal(isValidEmail('sam@client.test'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail(null), false);
});

test('no screen or helper offers automatic matching or creation any more', () => {
  for (const f of [['lib', 'xeroLinkStatus.ts'], ['lib', 'invoiceRecipient.ts'], ['components', 'jobs', 'InvoiceEditor.tsx'], ['components', 'jobs', 'UnlinkedRecipientsList.tsx'], ['lib', 'contactForm.ts']]) {
    const code = src(...f);
    assert.doesNotMatch(code, /canLinkAutomatically|autoXeroContact|matched or created|created in Xero on send/, f.join('/'));
  }
});
