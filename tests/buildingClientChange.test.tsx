// Changing a building's client (management company). The change itself is the database function change_building_client
// (migration 20261023100000; its refusals, permissions and history rows are exercised against a real PostgreSQL copy by the
// local rehearsal). Here: the impact shown before confirming, the choice rules, the readable management history, the panel's
// states, and how the page and repository use them. Static markup only (there is no DOM library in this repo).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import ChangeBuildingClientPanel from '../src/components/buildings/ChangeBuildingClientPanel';
import BuildingManagementHistory from '../src/components/buildings/BuildingManagementHistory';
import { clientChangeImpact, clientChoiceProblem, managementHistory, newClientNameProblem, tidyCompanyName } from '../src/lib/buildingClientChange';
import type { BuildingClientChange } from '../src/repository/buildingClientRepository';
import { HISTORY_EVENT_LABEL } from '../src/lib/historyEventLabels';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-01', status: 'completed', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: null,
    priceCharged: 100, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
const job = (id: string, visits: any[]): any => ({ id, buildingId: 'b1', visits });
const BUILDING: any = { id: 'b1', clientId: 'atlas', clientName: 'Atlas Property', address: '1A Bath Place', name: null, buildingName: '1A Bath Place', postcode: 'EC2A 3DR', invoiceDetails: 'Atlas Property, 1 High St', siteInstructions: 'Ring bell', access: null, defaultRecipient: { contactId: 'c1', xeroContactId: 'x', xeroOrgId: 'o' } };
const CLIENTS = [{ id: 'atlas', companyName: 'Atlas Property' }, { id: 'contour', companyName: 'Contour Property' }];

// ---- what the change affects ---------------------------------------------------------------------------------------------------------
test('IMPACT: unfinished invoices (block), work not yet invoiced, reports awaiting the client, and every job (closed ones too, once each)', () => {
  const jobs = [
    job('j1', [
      visit('a', { invoiceId: 'i1', invoiceStatus: 'draft', reportId: 'r', reportReviewStatus: 'approved' }),
      visit('b', { invoiceId: 'i2', invoiceStatus: 'failed' }),
      visit('c', { invoiceId: 'i3', invoiceStatus: 'sending' }),
      visit('d', { invoiceId: 'i4', invoiceStatus: 'sent', reportReviewStatus: 'approved', reportId: 'r4', reportCompletedAt: '2026-10-02' }),
      visit('e', { reportId: 'r5', reportReviewStatus: 'approved' }),
    ]),
    job('j2', [visit('f', { invoiceId: 'i6', invoiceStatus: 'in_xero_not_emailed', reportReviewStatus: 'approved', reportId: 'r6', reportCompletedAt: '2026-10-02' })]),
  ];
  assert.deepEqual(clientChangeImpact([...jobs, jobs[0]]), { unfinishedInvoices: 3, notYetInvoiced: 1, reportsAwaitingClient: 2, jobs: 2 });
  assert.deepEqual(clientChangeImpact([]), { unfinishedInvoices: 0, notYetInvoiced: 0, reportsAwaitingClient: 0, jobs: 0 });
});

test('CHOICE: a client must be chosen, must be another client, and must be an existing one', () => {
  const ids = CLIENTS.map((c) => c.id);
  assert.equal(clientChoiceProblem('atlas', null, ids), 'Choose the new client.');
  assert.match(clientChoiceProblem('atlas', 'atlas', ids)!, /already belongs to that client/);
  assert.match(clientChoiceProblem('atlas', 'deleted-client', ids)!, /not in the client list/);
  assert.equal(clientChoiceProblem('atlas', 'contour', ids), null);
});

// ---- the management history -----------------------------------------------------------------------------------------------------------
const change = (id: string, from: string, to: string, at: string): BuildingClientChange => ({
  id, previousClientId: from, previousClientName: from, newClientId: to, newClientName: to, changedAt: at, changedBy: 'luke@kindcontractors.co.uk', defaultRecipientCleared: false,
});

test('HISTORY: with nothing recorded, only the current client - no dates are invented', () => {
  assert.deepEqual(managementHistory('Atlas Property', []), { current: { clientName: 'Atlas Property', from: null, until: null, changedBy: null }, previous: [] });
});

test('HISTORY: each recorded change ends one period; the first period\'s start is unknown, not guessed; newest first', () => {
  const h = managementHistory('Contour Property', [
    change('2', 'Brook Estates', 'Contour Property', '2026-10-23T10:00:00Z'),
    change('1', 'Atlas Property', 'Brook Estates', '2025-03-01T09:00:00Z'),
  ]);
  assert.deepEqual(h.current, { clientName: 'Contour Property', from: '2026-10-23T10:00:00Z', until: null, changedBy: null });
  assert.deepEqual(h.previous.map((p) => [p.clientName, p.from, p.until]), [
    ['Brook Estates', '2025-03-01T09:00:00Z', '2026-10-23T10:00:00Z'],
    ['Atlas Property', null, '2025-03-01T09:00:00Z'],
  ]);
});

test('HISTORY PANEL: current client marked Current; previous companies listed with dates and who changed it', () => {
  const qc = new QueryClient();
  qc.setQueryData(['buildingClientHistory', 'b1'], [change('1', 'Atlas Property', 'Contour Property', '2026-10-23T10:00:00Z')]);
  const html = decode(renderToStaticMarkup(<QueryClientProvider client={qc}><BuildingManagementHistory buildingId="b1" currentClientName="Contour Property" /></QueryClientProvider>));
  assert.match(html, />Current<\/span><span class="font-semibold">Contour Property<\/span><span class="text-neutral-500">since 23 Oct 2026<\/span>/);
  assert.match(html, /Previously[\s\S]*Atlas Property[\s\S]*Before changes were recorded – 23 Oct 2026 · changed by luke@kindcontractors\.co\.uk/);
  const empty = new QueryClient();
  empty.setQueryData(['buildingClientHistory', 'b1'], []);
  assert.match(renderToStaticMarkup(<QueryClientProvider client={empty}><BuildingManagementHistory buildingId="b1" currentClientName="Atlas Property" /></QueryClientProvider>), /No earlier management companies recorded\. Changes made here are recorded from now on\./);
});

// ---- the panel --------------------------------------------------------------------------------------------------------------------------
function panel(jobs: any[] = [], over: Record<string, unknown> = {}, building: any = BUILDING) {
  const qc = new QueryClient();
  qc.setQueryData(['clients'], CLIENTS);
  return decode(renderToStaticMarkup(<QueryClientProvider client={qc}><ChangeBuildingClientPanel building={building} buildingJobs={jobs} onDone={() => {}} onCancel={() => {}} {...over} /></QueryClientProvider>));
}

test('PANEL: shows the current client, searches existing clients, and cannot be reviewed until a different client is chosen', () => {
  const html = panel();
  assert.match(html, /Current client: <span class="font-semibold">Atlas Property<\/span>/);
  assert.match(html, /aria-label="Search for the new client"/);
  assert.match(html, /<button type="button" disabled="" class="[^"]*">Review change<\/button>/);
  assert.match(html, />Cancel<\/button>/);
  const chosen = panel([], { initialChosenClientId: 'contour' });
  assert.match(chosen, /<span class="font-semibold">Contour Property<\/span>/);
  assert.doesNotMatch(chosen, /<button type="button" disabled="" class="[^"]*">Review change/);
});

test('CONFIRM: current and proposed client, and every consequence - default recipient cleared, contacts stay, details kept', () => {
  const html = panel([job('j1', [visit('a')]), job('j2', [])], { initialChosenClientId: 'contour', initialConfirming: true });
  assert.match(html, /Change this building's client from <span class="font-semibold">Atlas Property<\/span> to <span class="font-semibold">Contour Property<\/span>\?/);
  assert.match(html, /All 2 jobs at this building, including past visits and reports, will show\s+Contour Property as the client\. Invoices already in Xero are not changed\./);
  assert.match(html, /Atlas Property's contacts \(and their Xero links\) stay with Atlas Property\./);
  assert.match(html, /default invoice recipient belongs to the current client, so it will be cleared/);
  assert.match(html, /address, site instructions, access details and invoice details are kept as they are/);
  assert.match(html, />Confirm change<\/button>/);
  assert.doesNotMatch(html, /<button type="button" disabled="" class="[^"]*">Confirm change/);
  assert.match(html, />Back<\/button>/);
  const noDefault = panel([], { initialChosenClientId: 'contour', initialConfirming: true }, { ...BUILDING, defaultRecipient: null });
  assert.doesNotMatch(noDefault, /so it will be cleared/);
});

test('CONFIRM: work not yet invoiced and reports awaiting the client are warned about by name of the new client', () => {
  const html = panel([job('j1', [visit('a', { reportId: 'r', reportReviewStatus: 'approved' })])], { initialChosenClientId: 'contour', initialConfirming: true });
  assert.match(html, /1 completed visit is not invoiced yet and would be invoiced to\s+Contour Property\./);
  assert.match(html, /1 report is not yet completed and would go to\s+Contour Property's contacts\./);
});

test('CONFIRM: an unfinished invoice blocks the change - Confirm is disabled and the reason is shown (the database refuses too)', () => {
  const html = panel([job('j1', [visit('a', { invoiceId: 'i1', invoiceStatus: 'draft' })])], { initialChosenClientId: 'contour', initialConfirming: true });
  assert.match(html, /role="alert"[^>]*>1 invoice is not finished yet \(draft, sending or failed\)\.\s+Send or discard it first, so nothing is billed to the wrong client\./);
  assert.match(html, /<button type="button" disabled="" class="[^"]*">Confirm change<\/button>/);
});

test('SAVE: one database call with the building, the new client and the client confirmed FROM; everything that reads the client is refreshed', () => {
  const panelSrc = src('src', 'components', 'buildings', 'ChangeBuildingClientPanel.tsx');
  assert.match(panelSrc, /changeBuildingClient\(\{ buildingId: building\.id, newClientId: chosenId!, expectedClientId: building\.clientId \}\)/);
  for (const key of ["['buildingRows']", "['jobRows']", "['historicalJobRows']", "['contacts']", "['buildingHistory', building.id]", "['buildingClientHistory', building.id]"]) assert.ok(panelSrc.includes(key), key);
  const repo = src('src', 'repository', 'buildingClientRepository.ts');
  assert.match(repo, /supabase\.rpc\('change_building_client', \{\s*p_building_id: input\.buildingId,\s*p_new_client_id: input\.newClientId,\s*p_expected_client_id: input\.expectedClientId,\s*\}\)/);
  assert.doesNotMatch(repo, /from\('buildings'\)\.update|from\('contacts'\)|\.insert\(/, 'never writes the building, contacts or history directly');
});

test('PAGE: Change client sits beside Edit; the history panel is on the Site file tab; History shows "Client changed"', () => {
  const page = src('src', 'pages', 'BuildingFilePage.tsx');
  assert.match(page, /\{changingClient \? 'Close' : 'Change client'\}/);
  assert.match(page, /<ChangeBuildingClientPanel\s+building=\{building\}\s+buildingJobs=\{\[\.\.\.buildingJobs, \.\.\.\(historicalJobs\.data \?\? \[\]\)\.filter\(\(j\) => j\.buildingId === building\.id\)\]\}/);
  const site = page.slice(page.indexOf("tab === 'site' ? ("), page.indexOf(') : (\n        <div className="flex flex-col gap-4">'));
  assert.match(site, /<BuildingManagementHistory buildingId=\{building\.id\} currentClientName=\{building\.clientName\} \/>/);
  assert.equal(HISTORY_EVENT_LABEL.building_client_changed, 'Client changed');
});

test('MIGRATION: manager-only function, unfinished invoices refused, default cleared with the change, history + timeline written, history read-only', () => {
  const sql = src('supabase', 'migrations', '20261023100000_building_client_history.sql');
  assert.match(sql, /if private\.current_app_role\(\) is distinct from 'manager' then\s+raise exception 'Not authorized\.'/);
  assert.match(sql, /if v_building\.client_id is distinct from p_expected_client_id then/);
  assert.match(sql, /i\.status in \('draft', 'sending', 'failed'\)/);
  assert.match(sql, /set client_id = p_new_client_id,\s+default_invoice_contact_id = null,\s+default_invoice_xero_contact_id = null,\s+default_invoice_xero_org_id = null,/);
  assert.match(sql, /insert into building_client_history/);
  assert.match(sql, /'building_client_changed'/);
  assert.match(sql, /revoke all on public\.building_client_history from public, anon, authenticated;\s+grant select on public\.building_client_history to authenticated;/);
  assert.match(sql, /revoke execute on function public\.change_building_client\(uuid, uuid, uuid\) from public, anon;/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /update (public\.)?(contacts|jobs|visits|reports|invoices)\b/i, 'contacts, jobs, visits, reports and invoices are never rewritten');
});

// ---- a NEW client -----------------------------------------------------------------------------------------------------------------------
test('NEW NAME: blank, too long and existing names (any case or spacing) are refused; spaces are tidied', () => {
  assert.equal(tidyCompanyName('  Contour   Property  Ltd '), 'Contour Property Ltd');
  assert.equal(newClientNameProblem('   ', CLIENTS), "Enter the new client's company name.");
  assert.match(newClientNameProblem('x'.repeat(201), CLIENTS)!, /too long/);
  assert.match(newClientNameProblem('  contour   PROPERTY ', CLIENTS)!, /A client named "Contour Property" already exists\. Choose it under "Existing client" instead of creating a duplicate\./);
  assert.equal(newClientNameProblem('Brook Estates', CLIENTS), null);
});

test('NEW PANEL: two clear options; "Create new client" asks for the company name (and an optional contact), and waits for a valid one', () => {
  const start = panel();
  assert.match(start, />Existing client<\/button>/);
  assert.match(start, />Create new client<\/button>/);
  const blank = panel([], { initialMode: 'new' });
  assert.match(blank, /aria-label="New client's company name"/);
  assert.match(blank, />\+ Add a contact<\/button>/);
  assert.match(blank, /<button type="button" disabled="" class="[^"]*">Review change<\/button>/);
  const dup = panel([], { initialMode: 'new', initialCompanyName: 'atlas property' });
  assert.match(dup, /A client named "Atlas Property" already exists\. Choose it under "Existing client"/);
  assert.match(dup, /<button type="button" disabled="" class="[^"]*">Review change<\/button>/, 'a duplicate cannot be reviewed');
  const ok = panel([], { initialMode: 'new', initialCompanyName: 'Brook Estates' });
  assert.doesNotMatch(ok, /<button type="button" disabled="" class="[^"]*">Review change/);
  assert.match(ok, />Cancel<\/button>/);
});

test('NEW PANEL: while the client list is not loaded, a new name cannot be reviewed (duplicates could not be checked)', () => {
  const html = decode(renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}><ChangeBuildingClientPanel building={BUILDING} buildingJobs={[]} onDone={() => {}} onCancel={() => {}} initialMode="new" initialCompanyName="Brook Estates" /></QueryClientProvider>,
  ));
  assert.match(html, /The client list must load first, so the name can be checked for duplicates\./);
  assert.match(html, /<button type="button" disabled="" class="[^"]*">Review change<\/button>/);
});

test('NEW CONFIRM: says a client will be created, with the same consequences as an existing one', () => {
  const html = panel([job('j1', [])], { initialMode: 'new', initialCompanyName: '  Brook   Estates ', initialConfirming: true });
  assert.match(html, /Change this building's client from <span class="font-semibold">Atlas Property<\/span> to <span class="font-semibold">Brook Estates<\/span>\?/);
  assert.match(html, /A new client, <span class="font-semibold">Brook Estates<\/span>, will be created\s+with no contacts yet: add one before invoicing or sending reports\./);
  assert.match(html, /default invoice recipient belongs to the current client, so it will be cleared/);
  assert.match(html, /Atlas Property's contacts \(and their Xero links\) stay with Atlas Property/);
  assert.match(html, />Confirm change<\/button>/);
});

test('NEW SAVE: one database call creates the client AND changes the building; the optional contact follows, and its failure never undoes the change', () => {
  const panelSrc = src('src', 'components', 'buildings', 'ChangeBuildingClientPanel.tsx');
  assert.match(panelSrc, /changeBuildingClientToNewClient\(\{ buildingId: building\.id, companyName: tidyCompanyName\(companyName\), expectedClientId: building\.clientId \}\)/);
  assert.match(panelSrc, /await createContactForClient\(r\.newClientId, \{/);
  assert.match(panelSrc, /contactError = err instanceof Error \? err\.message : 'Failed to save the contact\.';/);
  assert.ok(panelSrc.includes("['clients']"), 'the client list is refreshed');
  assert.match(panelSrc, /onError: \(err\) => setError\(/, 'a refused change shows the reason and changes nothing');
  const repo = src('src', 'repository', 'buildingClientRepository.ts');
  assert.match(repo, /supabase\.rpc\('change_building_client_to_new_client', \{\s*p_building_id: input\.buildingId,\s*p_company_name: input\.companyName,\s*p_expected_client_id: input\.expectedClientId,\s*\}\)/);
  assert.match(repo, /if \(typeof result\?\.newClientId !== 'string'\) throw new Error/);
});

test('NEW MIGRATION: manager-only; name tidied and checked for duplicates under a lock; the client is created and the building changed in one call', () => {
  const sql = src('supabase', 'migrations', '20261023100000_building_client_history.sql');
  const fn = sql.slice(sql.indexOf('create or replace function public.change_building_client_to_new_client('));
  assert.match(fn, /if private\.current_app_role\(\) is distinct from 'manager' then\s+raise exception 'Not authorized\.'/);
  assert.ok(fn.includes("v_name := regexp_replace(btrim(coalesce(p_company_name, '')), '\\s+', ' ', 'g');"), 'the name is tidied');
  assert.match(fn, /perform pg_advisory_xact_lock\(hashtext\('new_client:' \|\| v_key\)\);/);
  assert.ok(fn.includes("where lower(regexp_replace(btrim(company_name), '\\s+', ' ', 'g')) = v_key"), 'duplicates are found ignoring case and spacing');
  assert.match(fn, /insert into clients \(company_name\) values \(v_name\) returning id into v_new_id;\s+[\s\S]*v_result := public\.change_building_client\(p_building_id, v_new_id, p_expected_client_id\);/);
  assert.match(sql, /revoke execute on function public\.change_building_client_to_new_client\(uuid, text, uuid\) from public, anon;/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /delete from (public\.)?(clients|contacts)/i, 'no client or contact is ever deleted');
});
