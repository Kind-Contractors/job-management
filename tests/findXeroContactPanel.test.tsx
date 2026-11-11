// "Find a contact in Xero" (linking a PERSON to a Xero contact) was removed on 2026-11-11, with the person link dialog and every
// per-contact link control: invoices are addressed to a Xero contact found by name (the building's default recipient in Xero, or
// one chosen for a single invoice), never through a person. Links people already have stay in the database (an older
// contact-based default still relies on its person's link until it is replaced) - only the screens went. These tests pin that the
// old screens are gone and that the one remaining Xero search (XeroRecipientSearch) searches the way the old panel did.
import { readSourceFile } from './helpers/sourceCode';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const src = (...p: string[]) => readSourceFile(...p);
const noComments = (code: string) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const SCREENS = [
  ['src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx'],
  ['src', 'components', 'buildings', 'BuildingInvoiceRecipientPanel.tsx'],
  ['src', 'components', 'jobs', 'InvoiceEditor.tsx'],
  ['src', 'components', 'jobs', 'ContactPopover.tsx'],
  ['src', 'pages', 'BuildingFilePage.tsx'],
  ['src', 'pages', 'ReadyForAccountsPage.tsx'],
];

test('GONE: the person-linking components no longer exist', () => {
  for (const f of [
    ['src', 'components', 'jobs', 'FindXeroContactPanel.tsx'],
    ['src', 'components', 'jobs', 'LinkXeroContactDialog.tsx'],
    ['src', 'components', 'jobs', 'UnlinkedRecipientsList.tsx'],
    ['src', 'components', 'jobs', 'BuildingDefaultRecipientPanel.tsx'],
    ['src', 'lib', 'xeroPanelLink.ts'],
  ]) {
    assert.throws(() => src(...f), undefined, f.join('/'));
  }
});

test("GONE: no screen links, re-links, verifies or unlinks a person's Xero contact, or shows a person's link state", () => {
  for (const f of SCREENS) {
    const code = noComments(src(...f));
    assert.doesNotMatch(code, /FindXeroContactPanel|LinkXeroContactDialog|UnlinkedRecipientsList|BuildingDefaultRecipientPanel|xeroPanelLink/, f.join('/'));
    assert.doesNotMatch(code, /(linkContact|unlinkContact|verifyContactLink|findXeroContactsByEmail|searchXeroContacts|setBuildingDefaultRecipient|clearBuildingDefaultRecipient)\(/, f.join('/'));
    assert.doesNotMatch(code, /linkStatusLabel|localLinkStatus|Find a contact in Xero|Link to Xero|Change Xero link|Verify link|>Unlink</, f.join('/'));
  }
});

test('SEARCH: the remaining Xero search (XeroRecipientSearch) searches as you type once typing pauses, or at once with Enter; 2-50 characters; never cached', () => {
  const p = src('src', 'components', 'jobs', 'XeroRecipientSearch.tsx');
  assert.match(p, /export const XERO_AUTOSEARCH_DELAY_MS = 450;/);
  assert.match(p, /const SEARCH_TERM_MAX = 50;/);
  assert.match(p, /const debounced = useDebouncedValue\(term\.trim\(\), XERO_AUTOSEARCH_DELAY_MS\);/);
  assert.match(p, /const searchTerm = submitted \?\? debounced;/);
  assert.match(p, /setSubmitted\(term\.trim\(\)\);/, 'Enter / Search: at once');
  assert.match(p, /queryKey: \['xeroRecipientSearch', searchTerm\],\s+queryFn: \(\) => searchXeroRecipients\(searchTerm\),\s+enabled: searchTerm\.length >= 2 && searchTerm\.length <= SEARCH_TERM_MAX,/);
  assert.match(p, /meta: \{ persist: false \}/, 'Xero results are never written to the saved browser cache');
  assert.doesNotMatch(p, /useMutation/, 'a query keyed by the term: an older answer can never replace a newer one');
});
