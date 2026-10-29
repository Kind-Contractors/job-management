// "Find a contact in Xero" on the Ready for accounts invoice editor: search existing Xero contacts, choose one deliberately, say
// which app contact it belongs to, confirm. Reuses xero-link-contact's read-only search and its link action unchanged. The confirm
// rules are a pure helper (tested directly); the result card is rendered to static markup (no DOM library in this repo); the
// wiring is checked from source. The live search and link are exercised in a browser against DEV with test records only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { XeroCandidateCard } from '../src/components/jobs/FindXeroContactPanel';
import { xeroPanelLinkState } from '../src/lib/xeroPanelLink';
import type { XeroContactCandidate } from '../src/repository/xeroLinksRepository';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (code: string) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const X_DOME = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const X_OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const contact = (id: string, name: string, xeroContactId: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ id, name, email: `${id}@client.test`, phoneNumber: null, isPrimary: false, xeroContactId, xeroOrgId: xeroContactId ? ORG : null, xeroContactName: xeroContactId ? 'Xero Name' : null, ...extra }) as any;
const UNLINKED = contact('ct-new', 'Pat New');
const LINKED_OTHER = contact('ct-old', 'Sam Old', X_OTHER);
const LINKED_DOME = contact('ct-dome', 'Dome Office', X_DOME);
const base = { contacts: [LINKED_OTHER, UNLINKED], chosenXeroContactId: X_DOME, pickedLocalId: '', newContactId: null, buildingDefaultContactId: null, replaceConfirmed: false };

const candidate = (over: Partial<XeroContactCandidate> = {}): XeroContactCandidate => ({
  contactId: X_DOME, name: 'Dome Assets', status: 'ACTIVE', accountNumber: 'DOME01', emailHint: 'a***@domeassets.test', hasEmail: true,
  location: 'SE1 2AA, London', personsIncludedInEmails: 0, mergedToContactId: null, blockedReason: null, sameNameAsOthers: 0, sameEmailAsOthers: 0, ...over,
});
const card = (c: XeroContactCandidate, chosen = false) => decode(renderToStaticMarkup(<XeroCandidateCard candidate={c} chosen={chosen} disabled={false} onChoose={() => {}} />));

// ---- the confirm rules --------------------------------------------------------------------------------------------------------
test('NO GUESS: with a Xero contact chosen, no app contact is picked for the manager; confirm stays off until one is', () => {
  const s = xeroPanelLinkState(base);
  assert.equal(s.localId, '');
  assert.equal(s.local, null);
  assert.equal(s.canConfirm, false);
  assert.equal(xeroPanelLinkState({ ...base, chosenXeroContactId: null, pickedLocalId: 'ct-new' }).canConfirm, false, 'no Xero contact chosen: nothing to confirm');
});

test('ORDER: unlinked app contacts are listed first, then linked ones; every contact is offered', () => {
  assert.deepEqual(xeroPanelLinkState(base).ordered.map((c) => c.id), ['ct-new', 'ct-old']);
});

test('PICKED: an unlinked app contact can be confirmed straight away', () => {
  const s = xeroPanelLinkState({ ...base, pickedLocalId: 'ct-new' });
  assert.equal(s.local?.id, 'ct-new');
  assert.equal(s.replacing, false);
  assert.equal(s.canConfirm, true);
});

test('REPLACE: an app contact linked to a DIFFERENT Xero contact needs "Replace that link" ticked', () => {
  const s = xeroPanelLinkState({ ...base, pickedLocalId: 'ct-old' });
  assert.equal(s.replacing, true);
  assert.equal(s.canConfirm, false);
  assert.equal(xeroPanelLinkState({ ...base, pickedLocalId: 'ct-old', replaceConfirmed: true }).canConfirm, true);
  const sameLink = xeroPanelLinkState({ ...base, contacts: [LINKED_DOME], pickedLocalId: 'ct-dome' });
  assert.equal(sameLink.replacing, false, 'already linked to this very Xero contact: nothing is replaced');
  assert.equal(xeroPanelLinkState({ ...base, contacts: [contact('ct-case', 'Case', X_DOME.toUpperCase())], pickedLocalId: 'ct-case' }).replacing, false, 'ids compared ignoring case');
});

test("DEFAULT: the building's default contact cannot have its link changed here (even with replace ticked); keeping the same link is fine", () => {
  const s = xeroPanelLinkState({ ...base, pickedLocalId: 'ct-old', buildingDefaultContactId: 'ct-old', replaceConfirmed: true });
  assert.equal(s.blockedAsDefault, true);
  assert.equal(s.canConfirm, false);
  assert.equal(xeroPanelLinkState({ ...base, pickedLocalId: 'ct-new', buildingDefaultContactId: 'ct-new' }).blockedAsDefault, false, 'unlinked default: linking is not a change of link');
});

test('ALREADY LINKED: other app contacts linked to the chosen Xero contact are reported (a notice, not a block)', () => {
  const s = xeroPanelLinkState({ ...base, contacts: [LINKED_DOME, UNLINKED], pickedLocalId: 'ct-new' });
  assert.deepEqual(s.alreadyLinkedHere.map((c) => c.id), ['ct-dome']);
  assert.equal(s.canConfirm, true);
  assert.deepEqual(xeroPanelLinkState({ ...base, contacts: [LINKED_DOME], pickedLocalId: 'ct-dome' }).alreadyLinkedHere, [], 'not itself');
});

test('NEW CONTACT: a contact added from the panel is offered once listed; until then the panel says it is loading', () => {
  const waiting = xeroPanelLinkState({ ...base, newContactId: 'ct-added' });
  assert.equal(waiting.waitingForNewContact, true);
  assert.equal(waiting.canConfirm, false);
  const listed = xeroPanelLinkState({ ...base, contacts: [...base.contacts, contact('ct-added', 'Added Person')], newContactId: 'ct-added' });
  assert.equal(listed.localId, 'ct-added');
  assert.equal(listed.canConfirm, true);
  const overridden = xeroPanelLinkState({ ...base, contacts: [...base.contacts, contact('ct-added', 'Added Person')], newContactId: 'ct-added', pickedLocalId: 'ct-new' });
  assert.equal(overridden.localId, 'ct-new', "the manager's own pick wins");
});

test('ACCOUNTS ONLY: accounts-only contacts are offered like any other (invoicing is what they are for)', () => {
  const acc = contact('ct-acc', 'Accounts Team', null, { isAccountsContact: true });
  assert.deepEqual(xeroPanelLinkState({ ...base, contacts: [acc] }).ordered.map((c) => c.id), ['ct-acc']);
});

// ---- the result card ----------------------------------------------------------------------------------------------------------
test('CARD: name, location, the MASKED email as the server returns it, account number; a Choose button', () => {
  const html = card(candidate());
  assert.match(html, />Dome Assets<\/span>/);
  assert.match(html, /SE1 2AA, London · a\*\*\*@domeassets\.test · Account DOME01/);
  assert.match(html, /<button type="button" aria-label="Choose the Xero contact Dome Assets"[^>]*>Choose<\/button>/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('CARD: archived, not active, merged or no-email contacts are shown with why, and cannot be chosen', () => {
  for (const [reason, text] of [['ARCHIVED', 'Archived in Xero'], ['NOT_ACTIVE', 'Not active in Xero'], ['MERGED', 'Merged into another contact'], ['NO_EMAIL', 'No email address in Xero']] as const) {
    const html = card(candidate({ blockedReason: reason }));
    assert.match(html, new RegExp(`>${text}</span>`), reason);
    assert.match(html, /<button type="button" disabled=""/, `${reason} not choosable`);
  }
});

test('CARD: look-alikes are flagged; the chosen one is marked', () => {
  assert.match(card(candidate({ sameNameAsOthers: 1 })), /Possible duplicate in Xero: another contact has the same name\. Check which is the right one\./);
  assert.match(card(candidate({ sameNameAsOthers: 1, sameEmailAsOthers: 2 })), /another contact has the same name, another shares this email\./);
  assert.match(card(candidate(), true), />Chosen<\/button>/);
  assert.match(card(candidate({ location: null, emailHint: null, accountNumber: null })), /No address or email shown/);
});

// ---- wiring and safeguards (source) -------------------------------------------------------------------------------------------
const panel = () => noComments(src('src', 'components', 'jobs', 'FindXeroContactPanel.tsx'));
const editor = () => noComments(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'));

test('SEARCH: only on submit (at least 2 characters, at most 50), through the existing read-only search; a new search clears the choice', () => {
  const p = panel();
  assert.match(p, /if \(term\.trim\(\)\.length >= 2\) searchMutation\.mutate\(term\.trim\(\)\);/);
  assert.match(p, /mutationFn: \(t: string\) => searchXeroContacts\(t\)/);
  assert.match(p, /maxLength=\{SEARCH_TERM_MAX\}/);
  assert.match(p, /const SEARCH_TERM_MAX = 50;/);
  assert.match(p, /onMutate: \(\) => \{\s+setChosen\(null\);\s+setLocalId\(''\);\s+setReplace\(false\);/);
  assert.doesNotMatch(p, /onChange=\{\(e\) => \{?\s*setTerm\(e\.target\.value\);?\s*searchMutation/, 'not on every keystroke');
});

test('NO AUTO-CHOICE: a Xero contact is chosen only by its own Choose button; nothing is chosen from the results by the app', () => {
  const p = panel();
  assert.equal((p.match(/setChosen\(c\)/g) ?? []).length, 1);
  assert.match(p, /onChoose=\{\(\) => \{\s+setChosen\(c\);/);
  assert.doesNotMatch(p, /setChosen\(results|results\[0\]|\.length === 1/);
});

test('LINK: exactly the existing link call with the chosen contact and its name as seen; replace only when ticked; only after confirming', () => {
  const p = panel();
  assert.match(p, /linkContact\(\{ localContactId: local\.id, xeroContactId: xero\.contactId, expectedName: xero\.name, replace: replace \|\| undefined \}\)/);
  assert.match(p, /onClick=\{\(\) => local && canConfirm && linkMutation\.mutate\(\{ local, xero: chosen \}\)\}/);
  assert.match(p, /disabled=\{!canConfirm \|\| busy\}/);
  assert.match(p, /'Link contact'/);
  assert.doesNotMatch(p, /for this invoice/, 'the panel is not tied to an invoice any more');
});

test('NO SIDE EFFECTS: the panel never creates a contact, sends, saves or emails an invoice, and does not touch masking', () => {
  const p = panel();
  assert.doesNotMatch(p, /invoicesRepository|sendInvoice|xero-create-invoice|persistCurrentDraft|createContact|NewContactForm/);
  assert.doesNotMatch(p, /maskEmail|EmailAddress/);
  assert.match(src('supabase', 'functions', '_shared', 'xeroContactSummary.ts'), /emailHint: maskEmail\(c\.EmailAddress\)/, 'emails still masked by the server');
});

test('PLACE: the panel lives in the Building File (Contacts & Defaults), not the invoice; a link refreshes and says nothing was created', () => {
  const tab = noComments(src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx'));
  assert.doesNotMatch(editor(), /FindXeroContactPanel|<UnlinkedRecipientsList/, 'no permanent search panel on the invoice');
  assert.match(tab, /<FindXeroContactPanel\s+contacts=\{contacts\}\s+buildingDefaultContactId=\{building\.defaultRecipient\?\.contactId \?\? null\}/);
  assert.match(tab, /onLinked=\{\(\{ localContactName, xeroContactName, alsoLinkedToOtherContacts \}\) => \{\s+refreshAfterXeroLink\(queryClient\);/);
  assert.match(tab, /is now linked to the Xero contact \$\{xeroContactName\}\. Nothing was created in Xero\./);
  assert.match(tab, /this Xero contact is also linked to \$\{alsoLinkedToOtherContacts\} other/);
  assert.doesNotMatch(tab, /sendInvoice|xero-create-invoice|invoicesRepository|setBuildingDefaultRecipient/, 'linking never touches invoices or the default');
});

test('ADD CONTACT: "+ Add a new contact" opens the existing form; the contact added is offered back in the panel, not linked', () => {
  const tab = noComments(src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx'));
  assert.match(tab, /onAddContact=\{\(\) => \{\s+setAddingForXero\(true\);\s+setAddingContact\(true\);/);
  assert.match(tab, /if \(addingForXero\) \{\s+setAddingForXero\(false\);\s+setXeroNewContactId\(contact\.id\);/);
  assert.match(tab, /Confirm its Xero link in "Find a contact in Xero" below\. Nothing is linked yet\./);
  assert.match(tab, /onClose=\{\(\) => \{\s+setAddingContact\(false\);\s+setAddingForXero\(false\);/, 'cancelling leaves the panel flow');
});

test('UNCHANGED: the shared dialog (tab and invoice), the link Edge Function and invoice sending', () => {
  assert.match(src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx'), /<LinkXeroContactDialog/);
  assert.match(editor(), /<LinkXeroContactDialog\s+localContactId=\{linkingContact\.id\}/, 'still used for the chosen unlinked contact');
  assert.match(editor(), /sendAttemptOutcome\(\{ recipientLocked, selectedContact \}\) === 'needs_xero_link'/, 'unlinked recipients still stopped on press');
});
