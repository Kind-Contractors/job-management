// No automatic matching or creation of Xero contacts. The manager adds contacts on the Building File and may confirm a second
// contact with an email another contact already has (one accounts mailbox). Since 2026-11-11 people are no longer linked to Xero
// contacts in the app at all: an invoice goes to the building's default recipient in Xero or a Xero contact chosen for that invoice
// (the screens for linking people were removed; links people already have stay in the database, and an older contact-based default
// still relies on its person's link until it is replaced). Report recipients do not depend on any of this. The server side of the
// same rules is in xeroCreateInvoiceFunction.test.ts (NO-AUTO and SHARED MAILBOX tests).
import { readSourceFile } from './helpers/sourceCode';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import NewContactForm from '../src/components/contacts/NewContactForm';
import { BLANK_CONTACT_FORM, checkContactForm, duplicateEmailWarning } from '../src/lib/contactForm';
import { canSendInvoiceTo, defaultRecipientProblem } from '../src/lib/xeroLinkStatus';
import { NOT_LINKED_RECIPIENT_MESSAGE, resolveSendRecipientId, sendAttemptOutcome } from '../src/lib/invoiceRecipient';

const src = (...p: string[]) => readSourceFile(...p);
const noComments = (code: string) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const CONTACTS = [{ id: 'c1', name: 'Sue (Kingfisher Court)', email: 'accounts@agent.test', isPrimary: true }];
const XA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const XB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ORG = 'org-live';

// ---- duplicate emails: refused unless explicitly confirmed ---------------------------------------------------------------------------
test('DUPLICATE 1: an email another contact of the client has is refused without a confirmation, and the result names that contact', () => {
  const r = checkContactForm({ ...BLANK_CONTACT_FORM, name: 'Accounts - Geller House', email: ' ACCOUNTS@agent.test ' }, CONTACTS);
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.duplicateOf, { id: 'c1', name: 'Sue (Kingfisher Court)' });
});

test('DUPLICATE 2: with the explicit confirmation the same email is accepted, exactly as typed (trimmed) - the other fields unchanged', () => {
  const r = checkContactForm({ ...BLANK_CONTACT_FORM, name: ' Accounts - Geller House ', email: ' accounts@agent.test ', phoneNumber: ' 0207 ' }, CONTACTS, null, { allowDuplicateEmail: true });
  assert.deepEqual(r, { ok: true, input: { name: 'Accounts - Geller House', email: 'accounts@agent.test', phoneNumber: '0207', isPrimary: false, isAccountsContact: false } });
});

test('DUPLICATE 3: the confirmation lifts ONLY the duplicate rule - a name is still required and a malformed email still refused', () => {
  const allow = { allowDuplicateEmail: true, requireEmail: true };
  assert.deepEqual(checkContactForm({ ...BLANK_CONTACT_FORM, email: 'accounts@agent.test' }, CONTACTS, null, allow), { ok: false, error: 'Enter a name.' });
  assert.deepEqual(checkContactForm({ ...BLANK_CONTACT_FORM, name: 'X', email: 'accounts@agent' }, CONTACTS, null, allow), { ok: false, error: 'Enter a valid email address.' });
  assert.deepEqual(checkContactForm({ ...BLANK_CONTACT_FORM, name: 'X' }, CONTACTS, null, allow), { ok: false, error: 'Enter an email address.' });
});

test('DUPLICATE 4: the warning names the existing contact, says when a duplicate is right, and that the existing contact is not changed', () => {
  const w = duplicateEmailWarning('Sue (Kingfisher Court)');
  assert.match(w, /^Sue \(Kingfisher Court\) already has this email address\./);
  assert.match(w, /linked to a DIFFERENT Xero contact/);
  assert.match(w, /separate buildings are invoiced to separate Xero contacts that share one accounts mailbox/);
  assert.match(w, /Sue \(Kingfisher Court\) is not changed\.$/);
});

test('DUPLICATE 5: the form confirms only through the warning\'s own button, for the email it names; editing the email withdraws it', () => {
  const form = noComments(src('src', 'components', 'contacts', 'NewContactForm.tsx'));
  assert.match(form, /const duplicateShown = duplicate !== null && duplicate\.email === normalEmail\(form\.email\);/);
  assert.match(form, /onClick=\{\(\) => submit\(true\)\}[\s\S]*?Add as a separate contact/, 'the confirm button');
  assert.match(form, /onClick=\{\(\) => submit\(\)\}/, 'Create contact never confirms a duplicate');
  assert.equal((form.match(/submit\(true\)/g) ?? []).length, 1, 'the only confirmation');
  assert.match(form, /duplicateEmailWarning\(duplicate\.name\)/);
  assert.doesNotMatch(form, /updateContact|merge|linkContact|xero-link|xeroLinks|sendInvoice/i, 'the existing contact is never changed; nothing is linked or sent');
});

test('DUPLICATE 6: the form renders normally (no warning) until a duplicate is actually submitted', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NewContactForm clientId="client-1" title="New contact" contacts={CONTACTS} refreshKeys={[['contacts', 'client-1']]} onCancel={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  );
  assert.doesNotMatch(html, /duplicate-email-warning|Add as a separate contact/);
  assert.match(html, />Create contact<\/button>/);
});

test('DUPLICATE 7: All Live Jobs\' contact popover is unchanged - it still refuses a duplicate (no confirmation there)', () => {
  const popover = noComments(src('src', 'components', 'jobs', 'ContactPopover.tsx'));
  assert.match(popover, /checkContactForm\(form, contacts, adding \? null : selectedId\)/);
  assert.doesNotMatch(popover, /allowDuplicateEmail/);
});

// ---- two contacts sharing one email, linked to different Xero contacts; per-building defaults -----------------------------------------------
const A = { id: 'ct-a', xeroContactId: XA, xeroOrgId: ORG };
const B = { id: 'ct-b', xeroContactId: XB, xeroOrgId: ORG };

test('BUILDINGS 1: two buildings of the same client keep their own default recipient, each pointing at its own Xero contact', () => {
  assert.equal(defaultRecipientProblem({ contactId: 'ct-a', xeroContactId: XA, xeroOrgId: ORG } as any, [A, B]), null);
  assert.equal(defaultRecipientProblem({ contactId: 'ct-b', xeroContactId: XB, xeroOrgId: ORG } as any, [A, B]), null);
});

test("BUILDINGS 2: re-pointing one contact's link makes ONLY the default that uses it stale - the other building is unaffected, nothing is substituted", () => {
  const bRepointed = { ...B, xeroContactId: XA };
  assert.match(defaultRecipientProblem({ contactId: 'ct-b', xeroContactId: XB, xeroOrgId: ORG } as any, [A, bRepointed]) ?? '', /./, 'building B: stale, refused');
  assert.equal(defaultRecipientProblem({ contactId: 'ct-a', xeroContactId: XA, xeroOrgId: ORG } as any, [A, bRepointed]), null, 'building A: still valid');
});

test('BUILDINGS 3: the server refuses to re-link a contact that is any building\'s default (so a link change cannot move another building\'s invoices)', () => {
  const fn = noComments(src('supabase', 'functions', 'xero-link-contact', 'index.ts'));
  assert.match(fn, /countBuildingDefaults\(db, localId\)\) > 0\) \{\s+throw new LinkError\(\s+'DEFAULT_IN_USE'/);
  const migration = src('supabase', 'migrations', '20261017120000_xero_recipient_links.sql');
  assert.match(migration, /contact_is_building_default: this contact is a building''s default invoice recipient; clear that default before changing its Xero link/);
});

// ---- the Building File: Link to Xero on every contact, and offered after "+ Add contact" ---------------------------------------------------
test('BUILDING FILE: since 2026-11-11 no contact is linked to a Xero contact on the Building File - no Link / Change / Verify, no "link it now" notice', () => {
  // Code only: the file's own comments explain that links people already have are kept in the database.
  const tab = src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(tab, /LinkXeroContactDialog|FindXeroContactPanel|setLinkingContact|verifyContactLink|Link to Xero|Change Xero link|>\s*Verify\s*</);
  assert.doesNotMatch(tab, /Link to Xero contact now|linked to Xero/);
  assert.match(tab, /<BuildingInvoiceRecipientPanel building=\{building\} contacts=\{contacts\} \/>/, "the invoice default is the building's default recipient in Xero");
  assert.doesNotMatch(tab, /<BuildingDefaultRecipientPanel/, 'the contact-based panel is gone (an older default is shown, replaced or cleared in the new panel)');
});

test('INVOICE: no person is chosen, linked or checked on the invoice - the main button just sends what is on screen', () => {
  const editor = src('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  assert.doesNotMatch(editor, /\bselectedContact\b|sendAttemptOutcome|xeroLinkNeededFor|setLinkingContact|LinkXeroContactDialog|recipient-not-linked|recipient-no-email/);
  assert.match(editor, /selectedContactId: '',/, 'no person is ever sent');
  assert.match(editor, /onClick=\{\(\) => \{\s+setSendResult\(null\);\s+sendMutation\.mutate\(\);\s+\}\}/);
  // Unsaved invoice edits are still never lost: the Building File opens in a NEW tab, and choosing a Xero contact saves nothing.
  assert.match(editor, /href=\{`\/buildings\/\$\{buildingId\}\?tab=contacts`\}\s+target="_blank"\s+rel="noopener noreferrer"/);
  const choose = editor.slice(editor.indexOf('onChoose={(c) => {'), editor.indexOf('onChoose={(c) => {') + 300);
  assert.doesNotMatch(choose, /persistCurrentDraft|invalidate\(|sendInvoice/);
});

test('INVOICE 1: contacts are no longer added from the invoice ("+ Add another email address" removed); they are added in Contacts & Defaults', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  assert.doesNotMatch(editor, /Add another email address|ADD_NEW_CONTACT_VALUE|NewContactForm|NewRecipientDialog|createContactForClient|FindXeroContactPanel/);
  assert.match(editor, /href=\{`\/buildings\/\$\{buildingId\}\?tab=contacts`\}\s+target="_blank"\s+rel="noopener noreferrer"/);
});

test('STEP A 1: sendAttemptOutcome - an unlinked chosen contact (with or without email, or an untagged link) needs a Xero link; nothing else does', () => {
  const linked = { xeroContactId: XA, xeroOrgId: ORG };
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: linked }), 'send');
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: { xeroContactId: null, xeroOrgId: null } }), 'needs_xero_link');
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: { xeroContactId: null, xeroOrgId: null, email: null } as any }), 'needs_xero_link', 'no email');
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: { xeroContactId: XA, xeroOrgId: null } }), 'needs_xero_link', 'a legacy link without its organisation');
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: null }), 'send', 'nothing chosen: the building default path (the button needs a usable default for that)');
  assert.equal(sendAttemptOutcome({ recipientLocked: true, selectedContact: { xeroContactId: null, xeroOrgId: null } }), 'send', 'a locked invoice goes to its own Xero contact, whatever is chosen locally');
});

test('INVOICE 3: an unresolved or unlinked recipient is refused BEFORE the invoice is saved (the check runs first in the send)', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  const fn = editor.slice(editor.indexOf('const sendMutation = useMutation'), editor.indexOf('onSuccess:', editor.indexOf('const sendMutation = useMutation')));
  assert.ok(fn.indexOf('resolveSendRequest(') >= 0 && fn.indexOf('resolveSendRequest(') < fn.indexOf('await persistCurrentDraft()'), 'checked, then saved');
  assert.throws(
    () => resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-new', usableDefaultContactId: null, selectedIsLinked: canSendInvoiceTo({ xeroContactId: null, xeroOrgId: null }) }),
    (e: Error) => e.message === NOT_LINKED_RECIPIENT_MESSAGE,
  );
  assert.match(NOT_LINKED_RECIPIENT_MESSAGE, /Nothing was saved or sent\./);
});

test('REPORTS: report recipients and delivery do not depend on Xero links or the accounts flag (unchanged)', () => {
  const fn = noComments(src('supabase', 'functions', 'send-client-report', 'index.ts'));
  assert.doesNotMatch(fn, /xero_contact_id|xero_org_id|is_accounts_contact/);
  assert.match(fn, /to: contact\.email/, 'a report goes to the chosen contact\'s own email');
  const page = noComments(src('src', 'pages', 'ReadyForClientPage.tsx'));
  assert.doesNotMatch(page, /canSendInvoiceTo|isUsableRecipient|xeroContactId/);
});
