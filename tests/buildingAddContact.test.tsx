// "Add contact" on the Building File, and the checks it shares with All Live Jobs' contact popover. The checks are tested directly;
// the form is rendered to static markup (there is no DOM library in this repo); the save, refresh, duplicate refusal and a refused
// save are also exercised in a real browser against DEV (see the report).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import BuildingAddContactForm from '../src/components/buildings/BuildingAddContactForm';
import { BLANK_CONTACT_FORM, checkContactForm } from '../src/lib/contactForm';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const CONTACTS = [
  { id: 'c1', name: 'Sam Client', email: 'Sam@Atlas.test', isPrimary: true },
  { id: 'c2', name: 'Pat Ops', email: null, isPrimary: false },
];

// ---- the shared checks ------------------------------------------------------------------------------------------------------------------
test('CHECKS: a name is required; everything else is optional and tidied', () => {
  assert.deepEqual(checkContactForm({ ...BLANK_CONTACT_FORM, name: '   ' }, CONTACTS), { ok: false, error: 'Enter a name.' });
  assert.deepEqual(checkContactForm({ name: ' Alex New ', email: ' alex@contour.test ', phoneNumber: ' 0207 ', isPrimary: false, isAccountsContact: false }, CONTACTS), {
    ok: true,
    input: { name: 'Alex New', email: 'alex@contour.test', phoneNumber: '0207', isPrimary: false, isAccountsContact: false },
  });
  assert.deepEqual(checkContactForm({ name: 'Alex', email: '', phoneNumber: '', isPrimary: true, isAccountsContact: false }, CONTACTS), {
    ok: true,
    input: { name: 'Alex', email: null, phoneNumber: null, isPrimary: true, isAccountsContact: false },
  });
});

test('DUPLICATES: an email another contact of this client already has is refused (any case or spacing) unless confirmed - and names that contact', () => {
  const r = checkContactForm({ ...BLANK_CONTACT_FORM, name: 'Sam Again', email: '  sam@ATLAS.test ' }, CONTACTS);
  assert.deepEqual(r, { ok: false, error: 'Sam Client already has this email address. Edit that contact instead of adding another.', duplicateOf: { id: 'c1', name: 'Sam Client' } });
  assert.equal(checkContactForm({ ...BLANK_CONTACT_FORM, name: 'Pat Ops' }, CONTACTS).ok, true, 'the same name without a shared email is allowed (two people can share a name)');
  assert.equal(checkContactForm({ ...BLANK_CONTACT_FORM, name: 'Sam Client', email: 'sam@atlas.test' }, CONTACTS, 'c1').ok, true, 'editing a contact may keep its own email');
  assert.equal(checkContactForm({ ...BLANK_CONTACT_FORM, name: 'X', email: 'other@atlas.test' }, CONTACTS).ok, true);
});

// ---- the Building File form -------------------------------------------------------------------------------------------------------------
const form = (contacts = CONTACTS) =>
  decode(renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <BuildingAddContactForm clientId="client-1" clientName="Atlas Property" buildingId="b1" contacts={contacts} onClose={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  ));

test('FORM: the same fields as All Live Jobs - name, email, phone, primary - for the building\'s client, with Create and Cancel', () => {
  const html = form();
  assert.match(html, /New contact for Atlas Property/);
  assert.match(html, /data-testid="add-contact-form"/);
  for (const label of ['Name', 'Email', 'Phone']) assert.match(html, new RegExp(`${label}<input`));
  assert.match(html, /Set as this client's primary contact/);
  assert.match(html, />Create contact<\/button>/);
  assert.match(html, />Cancel<\/button>/);
  assert.doesNotMatch(html, /Xero/, 'nothing about Xero: linking stays a separate step');
});

test('FORM: the first contact of a client defaults to primary; otherwise not', () => {
  assert.match(form([]), /<input type="checkbox" checked=""\/>Set as this client's primary contact/);
  assert.match(form(), /<input type="checkbox"\/>Set as this client's primary contact/);
});

test("SAVE: the building's client id, the shared form (shared checks, the existing repository function); the contacts everywhere are refreshed", () => {
  const wrapper = src('src', 'components', 'buildings', 'BuildingAddContactForm.tsx');
  assert.match(wrapper, /<NewContactForm\s+clientId=\{clientId\}/);
  assert.match(wrapper, /refreshKeys=\{\[\['contacts', clientId\], \['jobRows'\], \['historicalJobRows'\], \['buildingHistory', buildingId\]\]\}/);
  assert.doesNotMatch(wrapper, /requireEmail/, 'an email stays optional on the Building File, as in All Live Jobs');
  const shared = src('src', 'components', 'contacts', 'NewContactForm.tsx');
  assert.match(shared, /const created = await createContactForClient\(clientId, input\);/);
  assert.match(shared, /const checked = checkContactForm\(form, contacts, null, \{ requireEmail, allowDuplicateEmail \}\);\s+if \(!checked\.ok\) \{/);
  assert.match(shared, /setDuplicate\(null\);\s+setError\(checked\.error\);\s+\}\s+return;/, 'any other refusal is shown and nothing is saved');
  assert.match(shared, /await Promise\.all\(refreshKeys\.map\(\(queryKey\) => queryClient\.invalidateQueries\(\{ queryKey \}\)\)\);/);
  assert.match(shared, /onError: \(err\) => setError\(err instanceof Error \? err\.message : 'Failed to create contact\.'\)/, 'a refused save shows the reason');
  for (const code of [wrapper, shared]) assert.doesNotMatch(code, /xeroLinks|linkContact|xero-link-contact|xero-create|sendInvoice/i, 'no Xero call, nothing sent');
});

test('PAGE: "+ Add contact" on the Contacts panel opens the form for the building\'s client; Cancel closes it; success says so; the list scrolls', () => {
  const page = src('src', 'pages', 'BuildingFilePage.tsx');
  assert.match(page, />\s*\+ Add contact\s*<\/button>/);
  assert.match(page, /disabled=\{contactsLoading \|\| contactsError\}/, 'not offered until the contacts have loaded');
  assert.match(page, /<BuildingAddContactForm\s+clientId=\{building\.clientId\}\s+clientName=\{building\.clientName\}\s+buildingId=\{building\.id\}\s+contacts=\{contacts\}\s+onClose=\{\(\) => setAddingContact\(false\)\}/);
  assert.match(page, /setContactNotice\(`Contact added: \$\{contact\.name\}\.`\);\s+setJustAddedContactId\(contact\.id\);/);
  assert.match(page, /<div className="max-h-\[320px\] overflow-y-auto">/);
  assert.match(page, /No contacts recorded for this client\./, 'the empty state is kept');
  assert.match(page, /Couldn't load contacts\./, 'the error state is kept');
});

// ---- All Live Jobs: the same checks, nothing else changed ---------------------------------------------------------------------------------
test('REGRESSION: All Live Jobs creates and edits through the same checks and the same repository functions as before', () => {
  const popover = src('src', 'components', 'jobs', 'ContactPopover.tsx');
  assert.match(popover, /const checked = checkContactForm\(form, contacts, adding \? null : selectedId\);/);
  assert.match(popover, /if \(adding\) createMutation\.mutate\(input\);\s+else updateMutation\.mutate\(input\);/);
  assert.match(popover, /mutationFn: \(input: ContactFieldsInput\) => createContactForClient\(clientId, input\)/);
  assert.match(popover, /return updateContact\(selected\.id, clientId, patch\);/);
  assert.match(popover, />\s*\+ Add new contact\s*<\/button>/);
});
