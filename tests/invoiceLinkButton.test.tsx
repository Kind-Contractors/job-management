// The "Link" action beside unlinked recipients in the invoice editor. Rendered on the REAL components (static markup from a seeded
// query cache; there is no DOM library in this repo), plus the Link button's click handler invoked directly from the element tree.
//
// Proved: every unlinked contact gets a Link button and linked ones do not; clicking it reports exactly that contact; the editor
// opens the shared LinkXeroContactDialog for it; a successful link refreshes the queries the editor reads its contacts from, after
// which the contact is offered as a selectable recipient; and nothing on this path can send an invoice.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

import InvoiceEditor from '../src/components/jobs/InvoiceEditor';
import LinkXeroContactDialog from '../src/components/jobs/LinkXeroContactDialog';
import UnlinkedRecipientsList, { refreshAfterXeroLink } from '../src/components/jobs/UnlinkedRecipientsList';
import type { InvoiceDetail, JobContactSummary } from '../src/domain/types';

const XC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contact = (id: string, name: string, over: Partial<JobContactSummary> = {}): JobContactSummary => ({
  id, name, email: `${id}@example.test`, phoneNumber: null, isPrimary: false, isAccountsContact: false,
  xeroContactId: null, xeroOrgId: null, xeroContactName: null, xeroLinkedAt: null, ...over,
});
const LINKED = contact('ct-linked', 'Linked Person', { xeroContactId: XC, xeroOrgId: ORG, xeroContactName: 'Oak Estates Ltd' });
const MO = contact('ct-mo', 'Mo');
const LEGACY = contact('ct-legacy', 'Old Link', { xeroContactId: XC, xeroOrgId: null });

function invoice(over: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: 'inv-1', jobId: 'job-1', status: 'draft', dueDate: '2026-11-15', description: null, worksOrderNumber: null,
    xeroInvoiceId: null, xeroInvoiceNumber: null, xeroContactId: null, lastError: null, sentAt: null,
    lineItems: [{ id: 'li-1', visitId: 'v-1', description: 'Window cleaning', quantity: 1, unitAmount: 120 }], ...over,
  };
}
function renderEditor(contacts: JobContactSummary[], inv: InvoiceDetail = invoice()) {
  const qc = new QueryClient();
  qc.setQueryData(['invoice', inv.id], inv);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId={inv.id} onClose={() => {}} clientId="client-1" clientContacts={contacts} buildingDefault={null} />
    </QueryClientProvider>,
  );
}

/** Every <button> element in a rendered element tree (function components are not expanded: the list renders plain elements). */
function buttonsIn(node: ReactNode): ReactElement<any>[] {
  const out: ReactElement<any>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<any>;
    if (el.type === 'button') out.push(el);
    walk(el.props?.children);
  };
  walk(node);
  return out;
}

const src = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const code = (...p: string[]) => src(...p).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- the list ---------------------------------------------------------------------------------------------------------------------------
test('every unlinked contact (including an old link with no organisation) gets a Link button; a linked contact does not', () => {
  const tree = UnlinkedRecipientsList({ contacts: [LINKED, MO, LEGACY], onLink: () => {} });
  const buttons = buttonsIn(tree);
  assert.deepEqual(buttons.map((b) => b.props['aria-label']), ['Link Mo to a Xero contact', 'Link Old Link to a Xero contact']);
  assert.ok(buttons.every((b) => b.props.type === 'button'), 'type="button": a click can never submit a form');
});

test('clicking Link reports EXACTLY the contact beside it', () => {
  const clicked: string[] = [];
  const buttons = buttonsIn(UnlinkedRecipientsList({ contacts: [LINKED, MO, LEGACY], onLink: (c) => clicked.push(c.id) }));
  buttons[1].props.onClick();
  buttons[0].props.onClick();
  assert.deepEqual(clicked, ['ct-legacy', 'ct-mo']);
});

test('with every contact linked there is nothing to show', () => {
  assert.equal(UnlinkedRecipientsList({ contacts: [LINKED], onLink: () => {} }), null);
});

// ---- inside the invoice editor ------------------------------------------------------------------------------------------------------------
test('the invoice editor has no search panel and no per-contact Link list (both in Contacts & Defaults), and keeps every contact selectable', () => {
  const html = renderEditor([LINKED, MO]);
  assert.doesNotMatch(html, /data-testid="find-xero-contact"|Find a contact in Xero/);
  assert.doesNotMatch(html, /aria-label="Link Mo to a Xero contact"|data-testid="unlinked-list"/, 'the per-contact Link list is gone');
  assert.match(html, /<option value="ct-linked">Linked Person — ct-linked@example\.test · Xero: Oak Estates Ltd<\/option>/, 'linked: selectable');
  assert.match(html, /<option value="ct-mo">Mo — ct-mo@example\.test · not linked to Xero yet<\/option>/, 'unlinked: selectable; it must be linked before the invoice is sent');
});

test('after a link, the refreshed contacts show the contact as linked and selectable, and its Link button is gone', () => {
  const after = renderEditor([LINKED, { ...MO, xeroContactId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', xeroOrgId: ORG, xeroContactName: 'Mo Ltd' }]);
  assert.doesNotMatch(after, /Link Mo to a Xero contact/);
  assert.doesNotMatch(after, /Not linked to Xero/);
  assert.match(after, /<option value="ct-mo">Mo — ct-mo@example\.test · Xero: Mo Ltd<\/option>/);
});

test('a successful link refreshes the queries the recipient list is read from', () => {
  const qc = new QueryClient();
  const invalidated: unknown[] = [];
  qc.invalidateQueries = ((filters: { queryKey: unknown }) => { invalidated.push(filters.queryKey); return Promise.resolve(); }) as any;
  refreshAfterXeroLink(qc);
  assert.deepEqual(invalidated, [['jobRows'], ['contacts']]);
});

test('once the invoice exists in Xero (recipient locked) no Link list is offered', () => {
  const html = renderEditor([LINKED, MO], invoice({ status: 'failed', xeroInvoiceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', xeroContactId: XC }));
  assert.doesNotMatch(html, /Link Mo to a Xero contact/);
});

test('the editor still opens the SHARED link dialog for a chosen unlinked contact (alert and notice), and refreshes on success', () => {
  const editor = code('components', 'jobs', 'InvoiceEditor.tsx');
  assert.doesNotMatch(editor, /<UnlinkedRecipientsList/, 'replaced by the Find-in-Xero panel');
  assert.match(editor, /onClick=\{\(\) => setLinkingContact\(selectedContact\)\}/);
  assert.match(editor, /<LinkXeroContactDialog\s+localContactId=\{linkingContact\.id\}\s+localContactName=\{linkingContact\.name\}/);
  assert.match(editor, /currentXeroContactId=\{linkingContact\.xeroContactId\}/);
  assert.match(editor, /onLinked=\{\(\) => refreshAfterXeroLink\(queryClient\)\}/);
});

test('the dialog opened this way is for that contact', () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <LinkXeroContactDialog localContactId="ct-mo" localContactName="Mo" localContactEmail={null} suggestedTerm="Mo" currentXeroContactId={null} onClose={() => {}} onLinked={() => {}} />
    </QueryClientProvider>,
  );
  assert.match(html, /Link to Xero contact/);
  assert.match(html, />Mo<\/h2>/);
  assert.match(html, /value="Mo"/, 'the search starts from the contact name (editable, nothing searched yet)');
});

test('nothing on the Link path can send an invoice', () => {
  assert.doesNotMatch(code('components', 'jobs', 'UnlinkedRecipientsList.tsx'), /sendInvoice|xero-create-invoice|repository/);
  assert.doesNotMatch(code('components', 'jobs', 'LinkXeroContactDialog.tsx'), /sendInvoice|xero-create-invoice|invoicesRepository/);
  assert.doesNotMatch(code('repository', 'xeroLinksRepository.ts'), /xero-create-invoice|sendInvoice\(/);
});

test('a contact with no email shows just its name in the selector', () => {
  const html = renderEditor([{ ...MO, email: null }]);
  assert.match(html, /<option value="ct-mo">Mo · not linked to Xero yet<\/option>/, 'unlinked, no email: still selectable');
});
