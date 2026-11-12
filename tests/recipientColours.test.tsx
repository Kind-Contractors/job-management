// Recipient dropdowns colour the contacts that need care, and the invoice shows more about its default recipient:
//   - Ready for accounts: since 2026-11-11 there is no person dropdown on the invoice (people are not invoice recipients), so
//     nothing is coloured there; an older contact-based default is shown by its Xero name, with the building's invoice details.
//   - Ready for client: an "Accounts only" contact is amber in the report recipient dropdown, with a key.
// A native <option> can only be coloured whole. Rendered to static markup with the query cache seeded (no DOM library here).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import InvoiceEditor, { XERO_INVOICE_CAPABILITIES_QUERY_KEY } from '../src/components/jobs/InvoiceEditor';
import { AUTO_INVOICE_EMAIL_QUERY_KEY } from '../src/components/settings/AutoInvoiceEmailSetting';
import type { BuildingDefaultRecipient, InvoiceDetail, JobContactSummary } from '../src/domain/types';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const ORG = 'org-1';
const XC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const contact = (id: string, name: string, over: Partial<JobContactSummary> = {}): JobContactSummary => ({
  id, name, email: `${id}@client.test`, phoneNumber: null, isPrimary: false, isAccountsContact: false,
  xeroContactId: XC, xeroOrgId: ORG, xeroContactName: `${name} Ltd`, xeroLinkedAt: '2026-10-01T00:00:00Z', ...over,
});
const SAM = contact('ct-sam', 'Sam');
const NEW = contact('ct-new', 'Pat New', { xeroContactId: null, xeroOrgId: null, xeroContactName: null });
const DEFAULT: BuildingDefaultRecipient = { contactId: 'ct-sam', xeroContactId: XC, xeroOrgId: ORG };
const INVOICE: InvoiceDetail = {
  id: 'inv-1', jobId: 'job-1', status: 'draft', dueDate: '2026-11-17', description: null, worksOrderNumber: null,
  xeroInvoiceId: null, xeroInvoiceNumber: null, xeroContactId: null, xeroRecipientName: null, xeroRecipientEmail: null, notEmailedReason: null,
  lastError: null, sentAt: null, lineItems: [{ id: 'li-1', visitId: 'v-1', description: 'Clean', quantity: 1, unitAmount: 100 }],
};
function render(opts: { contacts: JobContactSummary[]; def?: BuildingDefaultRecipient | null; invoiceDetails?: string }): string {
  const qc = new QueryClient();
  qc.setQueryData(['invoice', INVOICE.id], INVOICE);
  qc.setQueryData(AUTO_INVOICE_EMAIL_QUERY_KEY, { enabled: true, updatedAt: '2026-10-18T00:00:00Z' });
  qc.setQueryData(XERO_INVOICE_CAPABILITIES_QUERY_KEY, { creationEnabled: true, sendingEnabled: true });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvoiceEditor invoiceId={INVOICE.id} onClose={() => {}} clientId="client-1" clientContacts={opts.contacts} buildingDefault={opts.def ?? null} invoiceDetails={opts.invoiceDetails} />
    </QueryClientProvider>,
  ).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

// ---- Ready for accounts: the invoice recipient -------------------------------------------------------------------------------
test('INVOICE: there is no person dropdown on the invoice any more (removed 2026-11-11), so no recipient is coloured there', () => {
  const html = render({ contacts: [SAM, NEW] });
  assert.doesNotMatch(html, /role="combobox"|data-value="ct-new"|data-value="ct-sam"|not linked to Xero yet/);
  assert.doesNotMatch(src('src', 'components', 'jobs', 'InvoiceEditor.tsx'), /RecipientSelect/);
});

test("INVOICE DEFAULT: an older contact-based default is shown by its Xero name, with the building's invoice details", () => {
  const html = render({ contacts: [SAM, NEW], def: DEFAULT, invoiceDetails: 'PO 4471\nAttn: accounts' });
  const card = html.slice(html.indexOf('data-testid="invoice-recipient"'), html.indexOf('data-testid="invoice-email-notice"'));
  assert.match(card, />Sam Ltd<\/span><span class="text-neutral-500">· this building's default \(contact-based, the older\s+way\)<\/span>/);
  assert.match(card, /data-testid="invoice-details"[^>]*><span[^>]*>Invoice details<\/span><span class="whitespace-pre-line text-ink">PO 4471\nAttn: accounts<\/span>/);
});

test('INVOICE DETAILS: not shown when the building has none; Ready for accounts reads them from the buildings list', () => {
  assert.doesNotMatch(render({ contacts: [SAM], def: DEFAULT, invoiceDetails: '' }), /data-testid="invoice-details"/);
  assert.doesNotMatch(render({ contacts: [SAM], def: DEFAULT }), /data-testid="invoice-details"/);
  const page = src('src', 'pages', 'ReadyForAccountsPage.tsx');
  assert.match(page, /useQuery\(\{ queryKey: \['buildingRows'\], queryFn: listBuildingRows \}\)/, 'the same cached list the Buildings screens use');
  assert.match(page, /invoiceDetails=\{buildingRows\.find\(\(b\) => b\.id === selected\.job\.buildingId\)\?\.invoiceDetails \?\? ''\}/);
});

// ---- Ready for client: the report recipient ------------------------------------------------------------------------------------
test('REPORT: only the words "Accounts only" are amber in the report recipient dropdown - the name and email keep the normal colour', () => {
  const page = src('src', 'pages', 'ReadyForClientPage.tsx');
  assert.match(page, /<RecipientSelect\s+label="Recipient"/);
  assert.match(page, /note: c\.isAccountsContact \? \{ text: "Accounts only", warn: true \} : undefined,/);
  assert.match(page, /text: `\$\{c\.name\}\$\{c\.email \? ` · \$\{c\.email\}` : " · no email on file"\}`,/);
  assert.doesNotMatch(page, /report-recipient-colour-key/);
});
