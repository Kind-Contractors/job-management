// The Building File layout (2026-10-27 redesign): header + stats strip, jobs table with the yearly total, report rows, the Invoicing
// card, compact contacts. Only existing features were rearranged - these tests pin that nothing was lost or added. Components are
// rendered to static markup (there is no DOM library in this repo); the page itself is checked from its source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSourceFile } from './helpers/sourceCode';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import BuildingDefaultRecipientPanel from '../src/components/jobs/BuildingDefaultRecipientPanel';
import { contactInitials } from '../src/lib/contactDisplay';

const src = (...p: string[]) => readSourceFile(...p);
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const page = () => src('src', 'pages', 'BuildingFilePage.tsx');

const LINKED = { id: 'c1', name: 'Sam Client', email: 'sam@atlas.test', isPrimary: true, xeroContactId: 'X1', xeroOrgId: 'ORG', xeroContactName: 'Atlas Ltd' };
const UNLINKED = { id: 'c2', name: 'Pat Ops', email: 'pat@atlas.test', isPrimary: false, xeroContactId: null, xeroOrgId: null, xeroContactName: null };
const building = (over: Record<string, unknown> = {}) => ({ id: 'b1', clientId: 'cl1', invoiceDetails: 'PO 4471\nAttn: accounts', defaultRecipient: null, ...over });

const renderPanel = (b: Record<string, unknown>, contacts: any[]) =>
  decode(
    renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <BuildingDefaultRecipientPanel building={b as any} contacts={contacts} />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );

// ---- helpers ------------------------------------------------------------------------------------------------------------------------
test('INITIALS: first letters of the first two words, else the first two letters; never empty', () => {
  assert.equal(contactInitials('Sam Client'), 'SC');
  assert.equal(contactInitials('  mo   ham  smith '), 'MH');
  assert.equal(contactInitials('Accounts'), 'AC');
  assert.equal(contactInitials('M'), 'M');
  assert.equal(contactInitials('   '), '?');
});

// ---- the invoice default (Contacts & Defaults tab) -----------------------------------------------------------------------------------------
test('INVOICING: with a default, the recipient is shown with its email and Xero contact; Change / Verify with Xero / Clear default; picker hidden', () => {
  const html = renderPanel(building({ defaultRecipient: { contactId: 'c1', xeroContactId: 'X1', xeroOrgId: 'ORG' } }), [LINKED, UNLINKED]);
  assert.match(html, /Invoices · default recipient/);
  assert.match(html, /For this building only\. Invoices for it go to this Xero-linked contact unless another is chosen for a single invoice \(which\s+never changes this default\)\./);
  assert.match(html, />Sam Client<\/div><div class="truncate text-\[11\.5px\] text-neutral-600">sam@atlas\.test<\/div><div class="truncate text-\[11\.5px\] text-teal-700">✓ Xero: Atlas Ltd<\/div>/, 'name, then email, then the Xero contact');
  for (const label of ['Change', 'Verify with Xero', 'Clear default']) assert.match(html, new RegExp(`>${label}</button>`));
  assert.doesNotMatch(html, /<select/, 'the picker opens only from Change');
  assert.doesNotMatch(html, /Save default/);
});

test('INVOICING: without a default, the picker is shown straight away and offers linked contacts only; nothing is assumed', () => {
  const html = renderPanel(building(), [LINKED, UNLINKED]);
  assert.match(html, /None set\. An invoice for this building needs a recipient chosen each time\. Nothing is assumed from the client's contacts\./);
  assert.match(html, /Set default to/);
  assert.match(html, /<option value="c1">Sam Client — sam@atlas\.test · Xero: Atlas Ltd<\/option>/, 'each choice shows the email too');
  assert.doesNotMatch(html, /<option value="c2"(?: class="[^"]*")?>/, 'an unlinked contact cannot be the default');
  assert.match(html, />Save default<\/button>/);
  assert.doesNotMatch(html, />Cancel<\/button>/, 'nothing to cancel back to');
  assert.doesNotMatch(html, />Change<\/button>|Verify with Xero|Clear default/);
});

test('INVOICING: no linked contact points at Link to Xero under Manage contacts', () => {
  const html = renderPanel(building(), [UNLINKED]);
  assert.match(html, /No contact is linked to Xero yet/);
  assert.match(html, /Link a contact to its Xero contact first \(“Link to Xero” under Manage contacts\)\./);
});

test('INVOICING: a stale default still says invoices cannot be sent', () => {
  const html = renderPanel(building({ defaultRecipient: { contactId: 'c1', xeroContactId: 'OTHER', xeroOrgId: 'ORG' } }), [LINKED]);
  assert.match(html, /Invoices for this building cannot be sent until it is fixed\./);
});

test('INVOICING: the building\'s invoice details are shown read-only at the bottom (line breaks kept); "Not recorded" when there are none', () => {
  const html = renderPanel(building({ defaultRecipient: { contactId: 'c1', xeroContactId: 'X1', xeroOrgId: 'ORG' } }), [LINKED]);
  assert.match(html, /data-testid="invoice-default-details"[^>]*><span[^>]*>Invoice details<\/span><span class="ml-auto text-right whitespace-pre-line text-ink">PO 4471\nAttn: accounts<\/span>/);
  assert.doesNotMatch(html, /<textarea|<input/, 'read-only here: edited with the building');
  assert.match(renderPanel(building({ invoiceDetails: '' }), [LINKED]), /data-testid="invoice-default-details"[^>]*><span[^>]*>Invoice details<\/span><span class="ml-auto text-right whitespace-pre-line text-neutral-500">Not recorded<\/span>/);
});

test('SITE FILE: the Invoicing card keeps the invoice details (read-only) and the Ready for accounts link', () => {
  const p = page();
  const card = p.slice(p.indexOf('data-testid="building-invoicing"'), p.indexOf('<BuildingManagementHistory'));
  assert.match(card, /<Link to="\/ready-for-accounts"[^>]*>\s*Ready for accounts →\s*<\/Link>/);
  assert.match(card, /Invoice details<\/span>\s*<span className="text-right whitespace-pre-line text-ink">\{building\.invoiceDetails \|\| '—'\}<\/span>/);
  assert.doesNotMatch(card, /<BuildingDefaultRecipientPanel|<select/, 'the default is managed on the Contacts & Defaults tab');
});

test('INVOICING: Change opens the picker with Save default and Cancel; saving closes it (source)', () => {
  const panel = src('src', 'components', 'jobs', 'BuildingDefaultRecipientPanel.tsx');
  assert.match(panel, /const showPicker = !def \|\| changing;/);
  assert.match(panel, /onSuccess: \(\) => \{\s+setPickedId\(''\);\s+setChanging\(false\);/);
  assert.match(panel, /\{def && \(\s*<button[\s\S]*?setChanging\(false\);[\s\S]*?Cancel\s*<\/button>/);
});

// ---- the page -----------------------------------------------------------------------------------------------------------------------
test('PAGE: header - breadcrumbs back to Buildings, "Managed by" the client, Edit building / Change client / Add job', () => {
  const p = page();
  assert.match(p, /<Breadcrumbs\s+items=\{\[\{ label: 'Buildings', to: '\/buildings' \}, \{ label: building\.clientName \?\? '' \}, \{ label: building\.buildingName \|\| 'Building' \}\]\}/);
  assert.match(p, /Managed by <span className="font-semibold text-ink">\{building\.clientName \|\| '—'\}<\/span>/);
  assert.match(p, /setEditingBuilding\(true\);\s+setChangingClient\(false\);\s+\}\}[^>]*>\s+Edit building\s+<\/button>/);
  assert.match(p, /\{changingClient \? 'Close' : 'Change client'\}/);
  assert.match(p, /setCreatingJob\(true\);[\s\S]*?Add job\s+<\/button>/);
});

test('PAGE: stats strip reads the same rows as the panels - jobs, yearly value, ready reports, contacts linked to Xero', () => {
  const p = page();
  assert.match(p, /data-testid="building-stats"/);
  assert.match(p, /<Stat label="Live jobs" value=\{String\(buildingJobs\.length\)\} \/>/);
  assert.match(p, /<Stat label="Value per year" value=\{yearlyTotal \? money\(yearlyTotal\) : '—'\} \/>/);
  assert.match(p, /const reports = buildingReports\(building\.id, jobRows, historicalJobs\.data \?\? \[\]\);/, 'the same split as the Job reports panel');
  assert.match(p, /value=\{historicalJobs\.isLoading \? '…' : String\(reports\.available\.length\)\}/);
  assert.match(p, /`\$\{reports\.notYetAvailable\} not ready yet`/);
  assert.match(p, /const linkedContacts = contacts\.filter\(isUsableRecipient\)\.length;/);
  assert.match(p, /`\$\{linkedContacts\} linked to Xero`/);
  assert.doesNotMatch(p, /At a glance/, 'replaced by the stats strip and the Invoicing card');
});

test('PAGE: jobs table - Service / Repeats / Price per visit, rows open the inspector, the yearly total says what it leaves out', () => {
  const p = page();
  assert.match(p, /<span>Service<\/span>\s+<span>Repeats<\/span>\s+<span className="text-right">Price per visit<\/span>/);
  assert.match(p, /setSelectedJobId\(job\.id\);/);
  assert.match(p, /\{job\.frequencyRaw \|\| '—'\}/);
  assert.match(p, /const jobsWithoutYearlyValue = buildingJobs\.filter\(\(j\) => j\.yearlyValue == null\)\.length;/);
  assert.match(p, /\{yearlyTotal \? `\$\{money\(yearlyTotal\)\} \/ yr` : '—'\}/, 'no "£0 / yr" when nothing can be totalled');
});

test('PAGE: Site file keeps every panel; right column order is Contacts & defaults, Invoicing, Management history, Internal access', () => {
  const p = page();
  const site = p.slice(p.indexOf("tab === 'site' ? ("), p.indexOf(') : (\n        <div className="flex flex-col gap-4">'));
  const order = ['data-testid="building-contacts"', 'data-testid="building-invoicing"', '<BuildingManagementHistory', 'Internal only · access'].map((s) => site.indexOf(s));
  assert.ok(order.every((i) => i > 0), String(order));
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], String(order));
  assert.doesNotMatch(site, /Edit site instructions|setEditingBuilding/, 'site instructions have no Edit of their own - "Edit building" covers them');
});

test('PAGE: the Site file contact summary is read-only: badges, Xero state, both defaults, and "Edit contacts & defaults"', () => {
  const p = page();
  const card = p.slice(p.indexOf('data-testid="building-contacts"'), p.indexOf('data-testid="building-invoicing"'));
  assert.match(card, /\{contactInitials\(c\.name\)\}/);
  assert.match(card, />\s*Main contact\s*<\/span>/);
  assert.match(card, />\s*Accounts only\s*<\/span>/);
  assert.match(card, /title=\{linkStatusLabel\(c\)\}/);
  assert.match(card, /Job reports go to/);
  assert.match(card, /\{REPORT_DEFAULT_PROBLEM\[reportDefault\.why\]\}/);
  assert.match(card, /Invoices for this building go to/);
  assert.match(card, /\{invoiceDefaultProblem \?\? 'no default yet: a recipient is chosen for each invoice\.'\}/);
  assert.match(card, /onClick=\{\(\) => setTab\('contacts'\)\}[\s\S]*?Edit contacts &amp; defaults/);
  assert.doesNotMatch(card, /setLinkingContact|setAddingContact/, 'no link or add actions on the Site file');
});

test('SCOPE: nothing new was added - no Download all, no Monthly plan link, no extra tabs', () => {
  const p = page();
  const reportsPanel = src('src', 'components', 'buildings', 'BuildingReportsPanel.tsx');
  for (const code of [p, reportsPanel]) assert.doesNotMatch(code, /Download all|Monthly plan|Open Report review/);
  assert.match(p, /\(\['site', 'contacts', 'history'\] as Tab\[\]\)/, 'Site file, Contacts & Defaults, History');
});

test('EDIT BUILDING: opens as a dialog; closed only by Cancel, the close button or Escape (not a click outside), and not mid-save', () => {
  const editor = src('src', 'components', 'jobs', 'BuildingEditor.tsx');
  assert.match(editor, /className="fixed inset-0 z-50 flex items-center justify-center bg-ink\/30"/);
  assert.match(editor, /role="dialog"\s+aria-modal="true"\s+aria-label=\{`Edit building: \$\{building\.buildingName\}`\}/);
  assert.match(editor, /const close = \(\) => \{\s+if \(!saveMutation\.isPending\) onDone\(\);\s+\};/);
  assert.match(editor, /if \(e\.key === 'Escape'\) close\(\);/);
  assert.match(editor, /aria-label="Close"/);
  assert.doesNotMatch(editor.slice(0, editor.indexOf('role="dialog"')), /onClick=/, 'the backdrop does not close it (unsaved edits are kept)');
  assert.match(editor, /onMouseDown=\{\(e\) => \{\s+if \(e\.target === e\.currentTarget\) e\.preventDefault\(\);/, 'a backdrop click keeps focus in the dialog');
  for (const field of ['Building name (optional)', 'Postcode (optional)', 'Address', 'Invoice details (optional)', 'Site instructions (optional)']) assert.ok(editor.includes(field), field);
  assert.match(page(), /\{editingBuilding && <BuildingEditor building=\{building\} onDone=\{\(\) => setEditingBuilding\(false\)\} \/>\}/);
});

test('ADD CONTACT: opens as a dialog; closed only by Cancel, the close button or Escape (not a click outside)', () => {
  const wrapper = src('src', 'components', 'buildings', 'BuildingAddContactForm.tsx');
  assert.match(wrapper, /className="fixed inset-0 z-50 flex items-center justify-center bg-ink\/30"/);
  assert.match(wrapper, /data-testid="add-contact-form"\s+role="dialog"\s+aria-modal="true"/);
  assert.match(wrapper, /if \(e\.key === 'Escape'\) onClose\(\);/);
  assert.match(wrapper, /<button onClick=\{onClose\} aria-label="Close"/);
  assert.doesNotMatch(wrapper.slice(0, wrapper.indexOf('role="dialog"')), /onClick=/, 'the backdrop does not close it');
  assert.match(wrapper, /onMouseDown=\{\(e\) => \{\s+if \(e\.target === e\.currentTarget\) e\.preventDefault\(\);/, 'a backdrop click keeps focus in the dialog');
  assert.match(wrapper, /onCancel=\{onClose\}/);
});

test('LAYOUT: the right column gets the larger share of the width (it carries more)', () => {
  assert.match(page(), /grid-cols-\[minmax\(0,3fr\)_minmax\(360px,2fr\)\]/);
});
