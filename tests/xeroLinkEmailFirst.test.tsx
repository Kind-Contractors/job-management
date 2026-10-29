// The link dialog looks for the Xero contact by EMAIL first, and says plainly what it found: one exact match, several, only ones
// that cannot be linked, none, or that the contact has no usable email. A name search remains as the fallback for a contact that
// uses a different email in Xero. Nothing is chosen or linked for the manager in any of these cases.
// Real components rendered to static markup (there is no DOM library in this repo), with the query cache seeded.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import LinkXeroContactDialog, { emailLookupMessage } from '../src/components/jobs/LinkXeroContactDialog';
import type { XeroContactCandidate, XeroEmailMatchResult } from '../src/repository/xeroLinksRepository';

const EMAIL = 'amanda@dasilva.test';
const candidate = (contactId: string, name: string, blockedReason: XeroContactCandidate['blockedReason'] = null): XeroContactCandidate => ({
  contactId, name, status: blockedReason === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE', accountNumber: null, emailHint: 'a***@dasilva.test', hasEmail: true,
  location: null, personsIncludedInEmails: 0, mergedToContactId: null, blockedReason, sameNameAsOthers: 0, sameEmailAsOthers: 0,
});
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function render(email: string | null, seeded?: XeroEmailMatchResult) {
  const qc = new QueryClient();
  if (seeded) qc.setQueryData(['xeroEmailMatch', 'ct-1', email?.trim() ?? ''], seeded);
  return decode(
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LinkXeroContactDialog localContactId="ct-1" localContactName="Amanda Da Silva" localContactEmail={email} currentXeroContactId={null} onClose={() => {}} onLinked={() => {}} />
      </QueryClientProvider>,
    ),
  );
}
const emailSection = (html: string) => html.slice(html.indexOf('data-testid="email-lookup"'), html.indexOf('>By name<'));

test('one exact email match: shown under "By email" with a Choose button, and NOT chosen for the manager', () => {
  const html = render(EMAIL, { outcome: 'one', results: [candidate('x1', 'Da Silva Property Services Ltd')], mayBeIncomplete: false });
  const section = emailSection(html);
  assert.match(section, /Found by email: one Xero contact has exactly the email amanda@dasilva\.test/);
  assert.match(section, /Da Silva Property Services Ltd/);
  assert.match(section, />Choose<\/button>/);
  assert.doesNotMatch(html, /Link this contact/, 'nothing is confirmed until the manager chooses');
});

test('several exact matches: all listed, the manager must choose', () => {
  const html = render(EMAIL, { outcome: 'several', results: [candidate('x1', 'Da Silva Ltd'), candidate('x2', 'Amanda Da Silva')], mayBeIncomplete: false });
  assert.match(emailSection(html), /2 Xero contacts have exactly the email amanda@dasilva\.test\. Choose the right one: the app does not pick for you\./);
  assert.equal((emailSection(html).match(/>Choose<\/button>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Link this contact/);
});

test('only archived / merged matches: shown, cannot be chosen, and the reason is given', () => {
  const html = render(EMAIL, { outcome: 'only_blocked', results: [candidate('x1', 'Old', 'ARCHIVED')], mayBeIncomplete: false });
  assert.match(emailSection(html), /has exactly the email amanda@dasilva\.test, but it cannot be linked/);
  assert.match(emailSection(html), /Archived in Xero/);
  assert.match(emailSection(html), /<button disabled=""[^>]*>Choose<\/button>/);
});

test('no email match: says so and points to the name search, which is still offered', () => {
  const html = render(EMAIL, { outcome: 'none', results: [], mayBeIncomplete: false });
  assert.match(emailSection(html), /No Xero contact has the email amanda@dasilva\.test\. If the contact uses a different email in Xero, search by name below\./);
  assert.match(html, /aria-label="Search Xero contacts"/);
  assert.match(html, /<input (?![^>]*value="[^"])[^>]*aria-label="Search Xero contacts"/, 'the name search is offered EMPTY: the manager types it');
});

test('no email match on a full page: says it cannot be sure, rather than "none"', () => {
  assert.match(emailLookupMessage({ outcome: 'none', results: [], mayBeIncomplete: true }, EMAIL), /too many contacts containing amanda@dasilva\.test to be sure/);
});

test('no email on the contact: no lookup is made, and the name search is offered', () => {
  const html = render(null);
  assert.match(emailSection(html), /This contact has no email address in the app, so Xero cannot be searched by email\. Search by name below\./);
  assert.doesNotMatch(html, /Looking for a Xero contact/);
  assert.match(emailLookupMessage({ outcome: 'invalid_local_email', results: [], mayBeIncomplete: false }, 'x'), /not valid/);
});

test('while the email lookup runs it says what it is looking for', () => {
  assert.match(emailSection(render(EMAIL)), /Looking for a Xero contact with the email amanda@dasilva\.test…/);
});

test('the name-search "no results" text says it was a NAME search, and the dialog never auto-chooses or creates', () => {
  const code = readFileSync(join(process.cwd(), 'src', 'components', 'jobs', 'LinkXeroContactDialog.tsx'), 'utf8');
  assert.match(code, /No Xero contact&apos;s name or email contains/);
  assert.match(code, /Found by name: the email in Xero may differ/);
  assert.doesNotMatch(code, /setChosen\((emailQuery|results|searchMutation)/, 'a result is only chosen by a click');
  assert.doesNotMatch(code, /createContact|xero-create-invoice/);
});
