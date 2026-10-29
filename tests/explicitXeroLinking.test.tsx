// Explicit Xero linking (no automatic matching or creation): the manager adds contacts on the Building File or the invoice screen,
// links each one to the right EXISTING Xero contact (offered straight after creating it, and on the Building File's contact list),
// may confirm a second contact with an email another contact already has (one accounts mailbox, separate Xero contacts per
// building), and an unlinked contact can never be invoiced. Report recipients do not depend on any of this. The server side of the
// same rules is in xeroCreateInvoiceFunction.test.ts (NO-AUTO and SHARED MAILBOX tests).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
test('BUILDING FILE 1: every contact row (Contacts & Defaults) offers Link to Xero (or Change Xero link) and opens the SHARED dialog for exactly that contact', () => {
  const tab = noComments(src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx'));
  assert.match(tab, /onClick=\{\(\) => setLinkingContact\(c\)\}/);
  assert.match(tab, /\{status === 'linked' \? 'Change Xero link' : 'Link to Xero'\}/);
  assert.match(tab, /<LinkXeroContactDialog\s+localContactId=\{linkingContact\.id\}\s+localContactName=\{linkingContact\.name\}\s+localContactEmail=\{linkingContact\.email\}/);
  assert.match(tab, /currentXeroContactId=\{linkingContact\.xeroContactId\}/, 'replacing an existing link still needs its explicit confirmation in the dialog');
  assert.doesNotMatch(tab, /suggestedTerm/, 'nothing is pre-filled: the manager types the name to search');
  assert.match(tab, /refreshAfterXeroLink\(queryClient\);/, 'only the contacts and job rows are refreshed');
  assert.doesNotMatch(noComments(src('src', 'pages', 'BuildingFilePage.tsx')), /setLinkingContact|<LinkXeroContactDialog/, 'the Site file only summarises');
});

test('BUILDING FILE 2: after "+ Add contact" the notice OFFERS to link the new contact (optional); once linked it says so instead', () => {
  const tab = noComments(src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx'));
  assert.match(tab, /setJustAddedId\(contact\.id\);/);
  assert.match(tab, /\(isUsableRecipient\(justAdded\) \? \(\s*<> \{linkStatusLabel\(justAdded\)\}\.<\/>\s*\) : \(/);
  assert.match(tab, /onClick=\{\(\) => setLinkingContact\(justAdded\)\}[^>]*>\s*Link to Xero contact now\s*<\/button>/);
  const wrapper = src('src', 'components', 'buildings', 'BuildingAddContactForm.tsx');
  assert.match(wrapper, /onCreated=\{onCreated\}/, 'the saved contact itself is passed on');
  assert.doesNotMatch(noComments(wrapper), /linkContact|xero-link|xeroLinks/i, 'creating a contact links nothing');
});

test('BUILDING FILE 3: the default-recipient panel points at the Building File\'s own Link to Xero, not the jobs list', () => {
  const panel = src('src', 'components', 'jobs', 'BuildingDefaultRecipientPanel.tsx');
  assert.doesNotMatch(panel, /open the contact from the jobs list/);
  assert.match(panel, /Link a contact to its Xero contact first \(&ldquo;Link to Xero&rdquo; under Manage contacts\)\./);
});

// ---- the invoice screen: link offered after adding a recipient; unlinked never sendable; unsaved edits kept ---------------------------------
test('INVOICE 1: contacts are no longer added from the invoice ("+ Add another email address" removed); they are added in Contacts & Defaults', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  assert.doesNotMatch(editor, /Add another email address|ADD_NEW_CONTACT_VALUE|NewContactForm|NewRecipientDialog|createContactForClient|FindXeroContactPanel/);
  assert.match(editor, /href=\{`\/buildings\/\$\{buildingId\}\?tab=contacts`\}\s+target="_blank"\s+rel="noopener noreferrer"/);
});

test('INVOICE 2: a chosen contact that is not linked shows why and a Link button; the main button can be pressed but does not send', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  assert.match(editor, /data-testid="recipient-not-linked"/);
  assert.match(editor, /must be linked to their existing Xero contact before this invoice\s+can be sent: link them, then press &ldquo;\{mode\.label\}\s*&rdquo; again\./);
  assert.match(editor, /onClick=\{\(\) => setLinkingContact\(selectedContact\)\}/);
  assert.match(editor, /\(selectedContact \? true : !!usableDefaultContactId\)/, 'any listed contact counts as chosen');
  assert.match(editor, /disabled=\{anyMutationPending \|\| lines\.length === 0 \|\| !recipientChosen\}/);
});

// ---- Step A: unlinked contacts are selectable; pressing the button stops before anything is saved or sent ----------------------------
test('STEP A 1: sendAttemptOutcome - an unlinked chosen contact (with or without email, or an untagged link) needs a Xero link; nothing else does', () => {
  const linked = { xeroContactId: XA, xeroOrgId: ORG };
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: linked }), 'send');
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: { xeroContactId: null, xeroOrgId: null } }), 'needs_xero_link');
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: { xeroContactId: null, xeroOrgId: null, email: null } as any }), 'needs_xero_link', 'no email');
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: { xeroContactId: XA, xeroOrgId: null } }), 'needs_xero_link', 'a legacy link without its organisation');
  assert.equal(sendAttemptOutcome({ recipientLocked: false, selectedContact: null }), 'send', 'nothing chosen: the building default path (the button needs a usable default for that)');
  assert.equal(sendAttemptOutcome({ recipientLocked: true, selectedContact: { xeroContactId: null, xeroOrgId: null } }), 'send', 'a locked invoice goes to its own Xero contact, whatever is chosen locally');
});

test('STEP A 2: every contact is a selectable option - no option is disabled for being unlinked or having no email', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  assert.match(editor, /\.\.\.clientContacts\.map\(\(c\) => \(\{\s+value: c\.id,\s+text: `\$\{c\.name\}\$\{c\.email \? ` — \$\{c\.email\}` : ''\}`,/);
  assert.doesNotMatch(editor, /disabled=\{!canSendInvoiceTo\(c\)\}/);
  const contactOptions = editor.slice(editor.indexOf('...clientContacts.map((c) => ({'), editor.indexOf(']}', editor.indexOf('...clientContacts.map((c) => ({')));
  assert.doesNotMatch(contactOptions, /disabled/, 'no contact option is ever disabled');
  assert.match(contactOptions, /: \{ text: 'not linked to Xero yet', warn: true \}/);
});

test('STEP A 3: pressing the button with an unlinked recipient saves NOTHING and calls NOTHING - it shows the explanation instead', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  const press = editor.slice(editor.indexOf('data-testid="invoice-actions"'), editor.indexOf('sendMutation.mutate();', editor.indexOf('data-testid="invoice-actions"')) + 'sendMutation.mutate();'.length);
  const stop = press.indexOf("if (sendAttemptOutcome({ recipientLocked, selectedContact }) === 'needs_xero_link') {");
  assert.ok(stop >= 0, 'the press checks the recipient first');
  const blocked = press.slice(stop, press.indexOf('return;', stop));
  assert.match(blocked, /setXeroLinkNeededFor\(selectedContact\?\.id \?\? null\);/);
  assert.doesNotMatch(blocked, /mutate|persistCurrentDraft|updateInvoiceDraft|sendInvoice/, 'no save, no send on that path');
  assert.ok(stop < press.lastIndexOf('sendMutation.mutate();'), 'the send happens only after the check');
  // The safeguards behind it are unchanged: the send itself still refuses an unlinked contact before saving, and so does the server.
  const send = editor.slice(editor.indexOf('const sendMutation'));
  assert.ok(send.indexOf('resolveSendRecipientId(') < send.indexOf('await persistCurrentDraft()'));
  assert.match(editor, /selectedIsLinked: selectedContact \? canSendInvoiceTo\(selectedContact\) : undefined,/);
  assert.match(src('supabase', 'functions', 'xero-create-invoice', 'index.ts'), /code: 'NOT_LINKED',/);
});

test('STEP A 4: the explanation becomes an alert after a press, says nothing was saved or sent, offers the Link dialog, and explains a missing email', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  assert.match(editor, /role=\{xeroLinkNeededFor === selectedContact\.id \? 'alert' : undefined\}/);
  assert.match(editor, /\{xeroLinkNeededFor === selectedContact\.id &&\s*\(?\s*<div className="font-semibold">\s*Not sent: a Xero contact is needed\.\s*<\/div>\s*\)?\s*\}/);
  assert.match(editor, /\{xeroLinkNeededFor === selectedContact\.id && ' Nothing has been saved or sent\.'\}/);
  assert.match(editor, /\{!isValidEmail\(selectedContact\.email\) && \(\s*<div data-testid="recipient-no-email"/);
  assert.match(editor, /has no email address in the app\. The invoice uses the email address held on the Xero contact\s+you link, so choose the Xero contact that has the right invoicing email\./);
  assert.match(editor, /onClick=\{\(\) => setLinkingContact\(selectedContact\)\}[\s\S]*?Link to Xero contact\s*<\/button>/);
});

test('STEP A 5: the press state is cleared when the choice or the invoice changes; a link keeps the chosen recipient (only contacts and job rows reload)', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  assert.match(editor, /onChange=\{\(value\) => \{\s+setSelectedContactId\(value\);\s+setXeroLinkNeededFor\(null\);/);
  assert.match(editor, /setChooseOtherContact\(false\);\s+setXeroLinkNeededFor\(null\);\s+\}, \[invoiceId\]\);/);
  const dialog = editor.slice(editor.indexOf('{linkingContact && ('));
  assert.match(dialog, /onLinked=\{\(\) => refreshAfterXeroLink\(queryClient\)\}/);
  assert.doesNotMatch(dialog.slice(0, dialog.indexOf('/>')), /setSelectedContactId|persistCurrentDraft|sendMutation/, 'linking neither changes the choice nor saves or sends');
});

test('INVOICE 3: an unresolved or unlinked recipient is refused BEFORE the invoice is saved (the check runs first in the send)', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  const fn = editor.slice(editor.indexOf('const sendMutation = useMutation'), editor.indexOf('onSuccess:', editor.indexOf('const sendMutation = useMutation')));
  assert.ok(fn.indexOf('resolveSendRecipientId(') >= 0 && fn.indexOf('resolveSendRecipientId(') < fn.indexOf('await persistCurrentDraft()'), 'checked, then saved');
  assert.throws(
    () => resolveSendRecipientId({ addingNewContact: false, selectedContactId: 'ct-new', usableDefaultContactId: null, selectedIsLinked: canSendInvoiceTo({ xeroContactId: null, xeroOrgId: null }) }),
    (e: Error) => e.message === NOT_LINKED_RECIPIENT_MESSAGE,
  );
  assert.match(NOT_LINKED_RECIPIENT_MESSAGE, /Nothing was saved or sent\./);
});

test('INVOICE 4: linking a contact never reloads or saves the invoice, so unsaved edits stay on screen; contacts & defaults open in a NEW tab', () => {
  const editor = noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));
  const dialog = editor.slice(editor.indexOf('{linkingContact && ('), editor.indexOf('</div>', editor.indexOf('{linkingContact && (')));
  assert.match(dialog, /onLinked=\{\(\) => refreshAfterXeroLink\(queryClient\)\}/);
  const refresh = src('src', 'components', 'jobs', 'UnlinkedRecipientsList.tsx');
  assert.match(refresh, /queryClient\.invalidateQueries\(\{ queryKey: \['jobRows'\] \}\);\s+queryClient\.invalidateQueries\(\{ queryKey: \['contacts'\] \}\);\s+\}/, 'jobRows and contacts only - never the invoice');
  assert.ok(editor.includes('setLinkingContact(selectedContact)'), 'the contextual Link to Xero contact is kept');
  assert.match(editor, /target="_blank"/, 'Set up contacts & defaults never navigates this page away (unsaved invoice edits kept)');
});

// ---- job reports are independent of invoice recipients and Xero links ----------------------------------------------------------------------
test('REPORTS: report recipients and delivery do not depend on Xero links or the accounts flag (unchanged)', () => {
  const fn = noComments(src('supabase', 'functions', 'send-client-report', 'index.ts'));
  assert.doesNotMatch(fn, /xero_contact_id|xero_org_id|is_accounts_contact/);
  assert.match(fn, /to: contact\.email/, 'a report goes to the chosen contact\'s own email');
  const page = noComments(src('src', 'pages', 'ReadyForClientPage.tsx'));
  assert.doesNotMatch(page, /canSendInvoiceTo|isUsableRecipient|xeroContactId/);
});
