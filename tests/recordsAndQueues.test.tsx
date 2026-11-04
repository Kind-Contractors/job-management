// Outstanding-work queues and Records (approved by Luke):
//   * Ready for client holds approved reports until they are DELIVERED - emailed successfully (they then leave by themselves) or
//     marked Completed (hand delivery). A failed email changes nothing.
//   * Ready for accounts holds a visit until its invoice is IN XERO ('sent' or 'in_xero_not_emailed'); no invoice, draft, sending
//     and failed stay. One rule for the list, its heading and the rail badge, per visit, with the division filter.
//   * Records lists delivered reports and every invoice (read-only); the Building File lists its own invoices.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { accountsQueueRows, clientQueueRows, isVisitInAccountsQueue, queueCounts } from '../src/lib/queueJobs';
import { isReportAwaitingCompletion, isReportDelivered, isReportReadyForClient, isVisitReadyForAccounts } from '../src/lib/statusPresentation';
import { hasIncompleteReportWork } from '../src/components/jobs/JobLifecycleDialog';
import { clientChangeImpact } from '../src/lib/buildingClientChange';
import { deliveredReportRecords, exVatTotal, filterInvoiceRecords, filterReportRecords, INVOICE_STATUS_LABEL, xeroInvoiceUrl } from '../src/lib/records';
import { listBuildingInvoiceRecords, mapInvoiceRecord, type InvoiceRecord } from '../src/repository/invoiceRecordsRepository';
import RecordsPage from '../src/pages/RecordsPage';
import ReadyForAccountsPage from '../src/pages/ReadyForAccountsPage';
import ReadyForClientPage from '../src/pages/ReadyForClientPage';
import { BuildingInvoicesList } from '../src/components/buildings/BuildingInvoicesPanel';
import { AuthContext } from '../src/auth/AuthProvider';
import type { LocalInvoiceStatus } from '../src/domain/types';
import { isSearchableRoute } from '../src/components/shell/TopBar';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const SENT = '2026-10-02T09:00:00Z';
const DONE = '2026-10-03T09:00:00Z';

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-01', status: 'completed', technicianId: 'mo', technicianName: 'Mo', additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'submitted',
    priceCharged: 100, completedAt: '2026-10-01T10:00:00Z', reportId: `rep-${id}`, reportReviewStatus: 'approved', sentToClientAt: null, sentToAccountsAt: null,
    reportCompletedAt: null, reportCompletedBy: null, invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id, buildingId: `b-${id}`, buildingName: `${id} House`, street: `1 ${id} Street`, postcode: 'AB1 2CD', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: `${id} cleaning`,
    division: 'General', lifecycleStatus: 'active', visits, clientContacts: [], pricePerVisit: 100, ...over,
  };
}
const inv = (status: LocalInvoiceStatus) => ({ invoiceId: `inv-${status}`, invoiceStatus: status });

// ---- Ready for accounts, one state at a time ----------------------------------------------------------------------------------
test('ACCOUNTS: no invoice, draft, failed and sending stay in the queue; sent and in-Xero-not-emailed leave', () => {
  const j = job('j', []);
  const inQueue = (over: Record<string, unknown>) => isVisitInAccountsQueue(j, visit('v', over));
  assert.equal(inQueue({}), true, 'approved, no invoice');
  assert.equal(inQueue(inv('draft')), true, 'draft');
  assert.equal(inQueue(inv('failed')), true, 'failed');
  assert.equal(inQueue(inv('sending')), true, 'sending - never hidden, it may need checking');
  assert.equal(inQueue(inv('sent')), false, 'sent (created in Xero and emailed)');
  assert.equal(inQueue(inv('in_xero_not_emailed')), false, 'created in Xero, not emailed - still left the queue');
  assert.equal(inQueue({ reportReviewStatus: 'awaiting_review' }), false, 'not approved yet and no invoice');
  assert.equal(inQueue({ reportReviewStatus: 'returned_for_correction', ...inv('draft') }), true, 'an open draft is never hidden, even if the report went back');
  assert.equal(inQueue({ sentToAccountsAt: '2026-01-01' }), true, 'the old sent_to_accounts_at field no longer decides anything');
});

test('ACCOUNTS: a job with several approved visits is judged per visit', () => {
  const j = job('multi', [visit('a'), visit('b', inv('draft')), visit('c', inv('sent')), visit('d', inv('in_xero_not_emailed')), visit('e', inv('failed'))]);
  assert.deepEqual(accountsQueueRows([j], 'Both').map((r) => r.visit.id), ['a', 'b', 'e']);
});

test('ACCOUNTS: closed jobs follow the same rule', () => {
  const closed = job('closed', [visit('a'), visit('b', inv('sent'))], { lifecycleStatus: 'cancelled' });
  assert.deepEqual(accountsQueueRows([closed], 'Both').map((r) => r.visit.id), ['a']);
});

// ---- Ready for client -----------------------------------------------------------------------------------------------------------
test('CLIENT: approved & undelivered is in; emailed or completed is out; a failed email (no sent time) stays; sent and completed stay separate', () => {
  assert.equal(isReportReadyForClient(visit('a')), true);
  assert.equal(isReportReadyForClient(visit('b', { sentToClientAt: SENT })), false);
  assert.equal(isReportReadyForClient(visit('c', { reportCompletedAt: DONE })), false);
  assert.equal(isReportDelivered(visit('b', { sentToClientAt: SENT })), true);
  assert.equal(isReportDelivered(visit('a')), false);
  // the send code only sets the sent time after the provider accepted the email; a failure records a failed attempt only
  const fn = src('supabase', 'functions', 'send-client-report', 'index.ts');
  assert.ok(fn.indexOf(".update({ status: 'sent'") > 0 && fn.indexOf(".update({ status: 'sent'") < fn.indexOf('.update({ sent_to_client_at'), 'sent_to_client_at is written after the send succeeded');
});

// ---- badge == list, with the division filter ---------------------------------------------------------------------------------
const mixed = [
  job('g1', [visit('g1a'), visit('g1b', inv('draft')), visit('g1c', { sentToClientAt: SENT, ...inv('sent') })]),
  job('s1', [visit('s1a'), visit('s1b', { reportCompletedAt: DONE, ...inv('in_xero_not_emailed') })], { division: 'Specialist' }),
];

test('BADGES: each badge equals the number of rows its page lists - for every division', () => {
  for (const division of ['Both', 'General', 'Specialist']) {
    const c = queueCounts(mixed, division);
    assert.equal(c.readyForAccounts, accountsQueueRows(mixed, division).length, `accounts ${division}`);
    assert.equal(c.readyForClient, clientQueueRows(mixed, division).length, `client ${division}`);
  }
  assert.deepEqual(queueCounts(mixed, 'Both'), { review: 0, readyForAccounts: 3, readyForClient: 3 });
  assert.deepEqual(queueCounts(mixed, 'General'), { review: 0, readyForAccounts: 2, readyForClient: 2 });
});

function wrap(node: React.ReactNode, url: string, seed: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  seed(qc);
  const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: () => {} };
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[url]}>{node}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
const seedQueues = (qc: QueryClient) => {
  qc.setQueryData(['jobRows'], mixed);
  qc.setQueryData(['jobRows', 'openReportWork'], []);
  qc.setQueryData(['buildingRows'], []);
};

test('PAGE HEADINGS match the badges, including the division filter', () => {
  for (const division of ['Both', 'General', 'Specialist']) {
    const c = queueCounts(mixed, division);
    const accounts = wrap(<ReadyForAccountsPage />, `/ready-for-accounts?division=${division}`, seedQueues);
    assert.match(accounts, new RegExp(`${c.readyForAccounts} needing attention`), `accounts ${division}`);
    const client = wrap(<ReadyForClientPage />, `/ready-for-client?division=${division}`, seedQueues);
    assert.match(client, new RegExp(`${c.readyForClient} awaiting delivery`), `client ${division}`);
  }
});

test('READY FOR CLIENT: a successful send moves the view to "Sent or completed" (the report is not lost from sight); a failure does not', () => {
  const page = src('src', 'pages', 'ReadyForClientPage.tsx');
  const sentBranch = page.slice(page.indexOf('if (result.status === "sent") {'), page.indexOf('} else {', page.indexOf('if (result.status === "sent") {')));
  assert.match(sentBranch, /setView\("completed"\);/);
  assert.match(page, /\?view=delivered&visit=|searchParams\.get\("view"\) === "delivered"/, 'Records can open a delivered report here');
  assert.doesNotMatch(page, /completeReport\([^)]*\)[\s\S]{0,40}sendClientReport|sendClientReport[\s\S]{0,200}completeReport\(/, 'emailing never marks Completed');
});

// ---- Records: job reports ------------------------------------------------------------------------------------------------------
const histJob = job('h1', [visit('h1a', { reportCompletedAt: DONE })], { lifecycleStatus: 'cancelled' });
const recordsJobs = [
  job('r1', [visit('r1a', { sentToClientAt: SENT }), visit('r1b', { reportCompletedAt: DONE, sentToClientAt: SENT }), visit('r1c'), visit('r1d', { reportReviewStatus: 'awaiting_review' })]),
];

test('RECORDS reports: emailed and completed reports appear exactly once; approved-undelivered and in-review do not; historical jobs are kept', () => {
  const entries = deliveredReportRecords(recordsJobs, [histJob], recordsJobs);
  assert.deepEqual(entries.map((e) => e.visit.id).sort(), ['h1a', 'r1a', 'r1b']);
  assert.equal(new Set(entries.map((e) => e.reportId)).size, entries.length, 'no duplicates even when a job list is passed twice');
});

test('RECORDS reports: search, status and delivery-date filters', () => {
  const entries = deliveredReportRecords(recordsJobs, [histJob]);
  const f = (o: Partial<Parameters<typeof filterReportRecords>[1]>) => filterReportRecords(entries, { search: '', status: 'all', from: '', to: '', ...o }).map((e) => e.visit.id).sort();
  assert.deepEqual(f({ status: 'emailed' }), ['r1a', 'r1b']);
  assert.deepEqual(f({ status: 'completed' }), ['h1a', 'r1b']);
  assert.deepEqual(f({ search: 'h1 house' }), ['h1a']);
  assert.deepEqual(f({ search: '1 r1 street' }), ['r1a', 'r1b']);
  assert.deepEqual(f({ from: '2026-10-03' }), ['h1a', 'r1b']);
  assert.deepEqual(f({ to: '2026-10-02' }), ['r1a']);
});

test('RECORDS page, reports tab: lists delivered reports; active jobs link to Ready for client for Send again / Reopen, closed jobs are view-only', () => {
  const html = wrap(<RecordsPage />, '/records', (qc) => {
    qc.setQueryData(['jobRows'], recordsJobs);
    qc.setQueryData(['historicalJobRows'], [histJob]);
    qc.setQueryData(['invoiceRecords'], []);
  });
  assert.equal((html.match(/data-testid="report-record"/g) ?? []).length, 3);
  assert.match(html, /href="\/ready-for-client\?view=delivered&amp;visit=r1a"[^>]*>Send again…/);
  assert.match(html, /href="\/ready-for-client\?view=delivered&amp;visit=r1b"[^>]*>Reopen…/);
  assert.match(html, /View only/);
  assert.match(html, /Job reports \(3\)/);
  assert.doesNotMatch(html, /r1c cleaning · Visit|r1d cleaning · Visit/);
});

// ---- Records: invoices --------------------------------------------------------------------------------------------------------
function invRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'i1', status: 'sent', description: null, works_order_number: null, due_date: '2026-11-01', sent_at: SENT, created_at: '2026-10-01T09:00:00Z', last_error: null,
    xero_invoice_id: '11111111-2222-3333-4444-555555555555', xero_invoice_number: 'INV-0042', xero_recipient_name: 'Sam Client', xero_recipient_email: 'sam@acme.test', not_emailed_reason: null,
    invoice_line_items: [
      { id: 'l2', description: 'Second visit', quantity: 1, unit_amount: 50.25, sort_order: 1, visit_id: 'v2', visits: { scheduled_date: '2026-09-15' } },
      { id: 'l1', description: 'First visit', quantity: 2, unit_amount: 100, sort_order: 0, visit_id: 'v1', visits: { scheduled_date: '2026-09-01' } },
    ],
    jobs: { id: 'j1', job_summary: 'Window cleaning', lifecycle_status: 'active', building_id: 'b1', buildings: { id: 'b1', name: 'Oak Court', address: '1 Oak Road', postcode: 'OK1 1AA', clients: { company_name: 'Acme Ltd' } } },
    ...over,
  };
}

test('RECORDS invoices: mapping, ex-VAT total from the JMS lines, labels and the Xero link', () => {
  const r = mapInvoiceRecord(invRow());
  assert.deepEqual([r.xeroInvoiceNumber, r.clientName, r.buildingName, r.jobSummary, r.buildingId], ['INV-0042', 'Acme Ltd', 'Oak Court', 'Window cleaning', 'b1']);
  assert.deepEqual(r.lines.map((l) => l.description), ['First visit', 'Second visit'], 'lines in their order');
  assert.equal(exVatTotal(r.lines), 250.25);
  assert.equal(xeroInvoiceUrl(r.xeroInvoiceId), 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=11111111-2222-3333-4444-555555555555');
  assert.equal(xeroInvoiceUrl(null), null);
  assert.equal(INVOICE_STATUS_LABEL.in_xero_not_emailed, 'In Xero · not emailed');
  assert.notEqual(INVOICE_STATUS_LABEL.in_xero_not_emailed, INVOICE_STATUS_LABEL.sent, 'not emailed is never shown as emailed');
});

test('RECORDS invoices: missing optional fields (no Xero id/number, no lines, no building) never break', () => {
  const r = mapInvoiceRecord(invRow({ status: 'draft', xero_invoice_id: null, xero_invoice_number: null, invoice_line_items: null, sent_at: null, due_date: null, jobs: { id: 'j9', job_summary: null, lifecycle_status: 'cancelled', building_id: null, buildings: null } }));
  assert.equal(exVatTotal(r.lines), 0);
  assert.equal(r.buildingName, '—');
  const html = renderToStaticMarkup(<MemoryRouter><BuildingInvoicesList invoices={[r]} loading={false} error={false} onRetry={() => {}} /></MemoryRouter>);
  assert.match(html, /No number yet/);
  assert.match(html, /Not in Xero/);
});

const allStatuses: InvoiceRecord[] = (['draft', 'sending', 'failed', 'sent', 'in_xero_not_emailed'] as LocalInvoiceStatus[]).map((status, i) =>
  mapInvoiceRecord(invRow({ id: `i-${status}`, status, xero_invoice_number: `INV-${i}`, created_at: `2026-10-0${i + 1}T09:00:00Z` })),
);

test('RECORDS page, invoices tab: every status is listed, amounts are labelled ex VAT, and the JMS-status caveat is shown', () => {
  const html = wrap(<RecordsPage />, '/records?tab=invoices', (qc) => {
    qc.setQueryData(['jobRows'], []);
    qc.setQueryData(['historicalJobRows'], []);
    qc.setQueryData(['invoiceRecords'], allStatuses);
  });
  assert.equal((html.match(/data-testid="invoice-record"/g) ?? []).length, 5);
  for (const label of Object.values(INVOICE_STATUS_LABEL)) assert.ok(html.includes(label), label);
  assert.match(html, /£250\.25 <span[^>]*>ex VAT<\/span>/);
  assert.match(html, /Statuses are as recorded in JMS/);
  assert.match(html, /Paid, voided or credited invoices are only shown in Xero/);
});

test('RECORDS invoices: search (number, client, building, job), status and created-date filters', () => {
  const f = (o: Partial<Parameters<typeof filterInvoiceRecords>[1]>) => filterInvoiceRecords(allStatuses, { search: '', status: 'all', from: '', to: '', ...o }).map((r) => r.status);
  assert.deepEqual(f({ status: 'in_xero_not_emailed' }), ['in_xero_not_emailed']);
  assert.deepEqual(f({ search: 'inv-2' }), ['failed']);
  assert.equal(f({ search: 'oak court' }).length, 5);
  assert.equal(f({ search: 'window' }).length, 5);
  assert.deepEqual(f({ from: '2026-10-04' }), ['sent', 'in_xero_not_emailed']);
});

// ---- Building File: invoice history ---------------------------------------------------------------------------------------------
test('BUILDING FILE: the query asks for this building only, and an invoice of another building is dropped even if it came back', async () => {
  const urls: URL[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    urls.push(new URL(typeof input === 'string' ? input : input.url));
    const other = invRow({ id: 'other', jobs: { id: 'j2', job_summary: 'Other', lifecycle_status: 'active', building_id: 'b2', buildings: { id: 'b2', name: 'Elm House', address: '', postcode: '', clients: { company_name: 'Other Ltd' } } } });
    const hist = invRow({ id: 'hist', jobs: { id: 'j3', job_summary: 'Old job', lifecycle_status: 'cancelled', building_id: 'b1', buildings: { id: 'b1', name: 'Oak Court', address: '', postcode: '', clients: { company_name: 'Acme Ltd' } } } });
    return new Response(JSON.stringify([invRow(), hist, other]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const rows = await listBuildingInvoiceRecords('b1');
    assert.deepEqual(rows.map((r) => r.id), ['i1', 'hist'], 'this building only - active AND historical jobs');
    assert.equal(urls[0].searchParams.get('jobs.building_id'), 'eq.b1');
  } finally {
    globalThis.fetch = real;
  }
});

test('BUILDING FILE: the Invoices panel sits right after Job reports; empty and error states explain themselves', () => {
  const page = src('src', 'pages', 'BuildingFilePage.tsx');
  assert.ok(page.indexOf('<BuildingReportsPanel') < page.indexOf('<BuildingInvoicesPanel buildingId={building.id} />'));
  const empty = renderToStaticMarkup(<MemoryRouter><BuildingInvoicesList invoices={[]} loading={false} error={false} onRetry={() => {}} /></MemoryRouter>);
  assert.match(empty, /No invoices for this building yet/);
  const failed = renderToStaticMarkup(<MemoryRouter><BuildingInvoicesList invoices={[]} loading={false} error onRetry={() => {}} /></MemoryRouter>);
  assert.match(failed, /could not be loaded[\s\S]*Try again/);
});

// ---- guards ----------------------------------------------------------------------------------------------------------------------
test('GUARD: Records and the invoice panel only READ - no writes, no Xero or email calls', () => {
  for (const file of ['src/repository/invoiceRecordsRepository.ts', 'src/lib/records.ts', 'src/pages/RecordsPage.tsx', 'src/components/records/InvoiceRecordItem.tsx', 'src/components/buildings/BuildingInvoicesPanel.tsx']) {
    const s = src(file);
    assert.doesNotMatch(s, /\.(insert|update|upsert)\(|\.delete\(\)|\.rpc\(|functions\.invoke|sendInvoice|sendClientReport|completeReport|reopenReport|api\.xero\.com|resend/i, file);
  }
  assert.match(src('src', 'App.tsx'), /<Route path="\/records" element=\{<RecordsPage \/>\} \/>/);
  assert.match(src('src', 'components', 'shell', 'NavRail.tsx'), /key: 'records',\s*label: 'Records'/);
});

test('GUARD: the Ready for accounts rule no longer reads sent_to_accounts_at; every caller uses the one shared rule', () => {
  assert.doesNotMatch(src('src', 'lib', 'statusPresentation.ts').slice(src('src', 'lib', 'statusPresentation.ts').indexOf('export function isVisitReadyForAccounts')).split('\n').slice(0, 5).join('\n'), /sentToAccountsAt/);
  assert.equal(isVisitReadyForAccounts(visit('x', inv('sent'))), false);
  assert.match(src('src', 'pages', 'ReadyForAccountsPage.tsx'), /accountsQueueRows\(jobRows, division\)/);
  assert.match(src('src', 'pages', 'ReadyForClientPage.tsx'), /clientQueueRows\(jobRows, division\)/);
});

// ---- follow-up review: lifecycle unchanged, historical reports kept, Reopen, no Records badge ------------------------------
test('LIFECYCLE unchanged: closing a job still needs every approved report marked Completed - emailing alone is not enough', () => {
  const emailedInXero = visit('e', { sentToClientAt: SENT, ...inv('sent') });
  assert.equal(isReportReadyForClient(emailedInXero), false, 'it has left Ready for client');
  assert.equal(hasIncompleteReportWork(emailedInXero), true, 'but it still blocks closing the job, exactly as before');
  assert.equal(hasIncompleteReportWork(visit('c', { sentToClientAt: SENT, reportCompletedAt: DONE, ...inv('draft') })), false, 'completed: no longer blocks (as before)');
  assert.equal(hasIncompleteReportWork(visit('a', { reportReviewStatus: 'awaiting_review' })), true);
  const lc = src('src', 'components', 'jobs', 'JobLifecycleDialog.tsx');
  assert.match(lc, /if \(isReportAwaitingCompletion\(visit\)\) return true;/);
  assert.doesNotMatch(lc, /isReportReadyForClient/, 'the job rule does not follow the queue rule');
});

test('CHANGE CLIENT warning unchanged: "not yet completed" still counts emailed-but-not-completed reports', () => {
  const impact = clientChangeImpact([job('x', [visit('a', { sentToClientAt: SENT }), visit('b'), visit('c', { reportCompletedAt: DONE })])]);
  assert.equal(impact.reportsAwaitingClient, 2);
  assert.equal(isReportAwaitingCompletion(visit('a', { sentToClientAt: SENT })), true);
});

test('RECORDS keeps reports of COMPLETED, LOST and CANCELLED jobs (view-only), alongside active ones', () => {
  const closed = (['completed', 'lost', 'cancelled'] as const).map((s) => job(`hx-${s}`, [visit(`v-${s}`, { sentToClientAt: SENT })], { lifecycleStatus: s }));
  const html = wrap(<RecordsPage />, '/records', (qc) => {
    qc.setQueryData(['jobRows'], recordsJobs);
    qc.setQueryData(['historicalJobRows'], closed);
    qc.setQueryData(['invoiceRecords'], []);
  });
  assert.equal((html.match(/data-testid="report-record"/g) ?? []).length, 5, '2 active + 3 closed');
  for (const s of ['completed', 'lost', 'cancelled']) assert.ok(html.includes(`hx-${s} cleaning · Visit 1 Oct 2026<span class="ml-1 text-[11px] text-neutral-500">(job ${s})</span>`), s);
  assert.equal((html.match(/>View only</g) ?? []).length, 3, 'closed-job reports are view-only');
});

test('REOPEN keeps the send record: an emailed + completed report is NOT outstanding after Reopen; a hand-delivered one is', () => {
  const both = visit('b', { sentToClientAt: SENT, reportCompletedAt: DONE, reportCompletedBy: 'luke@x' });
  const reopened = { ...both, reportCompletedAt: null, reportCompletedBy: null };
  assert.equal(isReportReadyForClient(reopened), false);
  assert.equal(reopened.sentToClientAt, SENT);
  assert.equal(isReportReadyForClient({ ...visit('h', { reportCompletedAt: DONE }), reportCompletedAt: null }), true);
  // the repository clears completion only - never sent_to_client_at
  const repo = src('src', 'repository', 'reportsRepository.ts');
  const reopenFn = repo.slice(repo.indexOf('export async function reopenReport'), repo.indexOf('export async function resubmitReport'));
  assert.match(reopenFn, /\.update\(\{ completed_at: null, completed_by: null \}\)/);
  assert.doesNotMatch(reopenFn, /sent_to_client/);
  // and the page says so instead of claiming it is back in the queue
  const page = src('src', 'pages', 'ReadyForClientPage.tsx');
  assert.match(page, /if \(emailed\) \{\s*setNotice\("Report reopened\. It was emailed to the client, so it stays under Sent or completed/);
  assert.match(page, /reopenMutation\.mutate\(\{ id: reportId!, emailed: !!alreadySentAt \}\)/);
});

test('NAV: Records has no count badge; Ready for client and Ready for accounts keep theirs', () => {
  const nav = src('src', 'components', 'shell', 'NavRail.tsx');
  const records = nav.slice(nav.indexOf("key: 'records'"), nav.indexOf("onClick: () => navigate('/records')"));
  assert.doesNotMatch(records, /count:/);
  assert.doesNotMatch(nav, /invoiceRecords|deliveredReportRecords/);
  assert.match(nav, /count=\{readyForAccountsCount\}/);
  assert.match(nav, /count=\{readyForClientCount\}/);
});

// ---- global search, paging, "New" tags -------------------------------------------------------------------------------------------
test('SEARCH: Records uses the global search box (?q=) - the box is enabled there and the page has no search box of its own', () => {
  assert.equal(isSearchableRoute('/records'), true);
  const page = src('src', 'pages', 'RecordsPage.tsx');
  assert.match(page, /searchParams\.get\('q'\)/);
  assert.doesNotMatch(page, /type="search"/);
  const seed = (qc: QueryClient) => {
    qc.setQueryData(['jobRows'], recordsJobs);
    qc.setQueryData(['historicalJobRows'], [histJob]);
    qc.setQueryData(['invoiceRecords'], allStatuses);
  };
  // useDebouncedValue starts from the current value, so the first render is already filtered
  assert.equal((wrap(<RecordsPage />, '/records?q=h1%20house', seed).match(/data-testid="report-record"/g) ?? []).length, 1);
  assert.equal((wrap(<RecordsPage />, '/records?tab=invoices&q=inv-3', seed).match(/data-testid="invoice-record"/g) ?? []).length, 1);
});

test('PAGING: Records shows 25 per page with Previous / Next; a short list has no pager', () => {
  const many = Array.from({ length: 30 }, (_, i) => mapInvoiceRecord(invRow({ id: `p${i}`, xero_invoice_number: `INV-${100 + i}` })));
  const html = wrap(<RecordsPage />, '/records?tab=invoices', (qc) => {
    qc.setQueryData(['jobRows'], []);
    qc.setQueryData(['historicalJobRows'], []);
    qc.setQueryData(['invoiceRecords'], many);
  });
  assert.equal((html.match(/data-testid="invoice-record"/g) ?? []).length, 25);
  assert.match(html, /1–25 of 30/);
  assert.match(html, /Page 1 of 2/);
  assert.match(html, /disabled=""[^>]*>Previous</);
  assert.doesNotMatch(wrap(<RecordsPage />, '/records', (qc) => { qc.setQueryData(['jobRows'], recordsJobs); qc.setQueryData(['historicalJobRows'], []); qc.setQueryData(['invoiceRecords'], []); }), /data-testid="pager"/);
  assert.match(src('src', 'components', 'shared', 'Pager.tsx'), /state\.key === resetKey \? state\.page : 0/, 'a new search or filter starts again at page 1');
});

test('NAV: Monthly plan, Waste reports and Records carry a "New" tag', () => {
  const nav = src('src', 'components', 'shell', 'NavRail.tsx');
  assert.match(nav, /const NEW_SECTIONS = new Set\(\['monthlyPlan', 'waste', 'records'\]\);/);
  for (const key of ['monthlyPlan', 'waste', 'records']) assert.match(nav, new RegExp(`key: '${key}'`));
  assert.match(nav, /isNew=\{NEW_SECTIONS\.has\(item\.key\)\}/);
});

test('NAV: Ready for accounts, Ready for client, Report review and Waste reports show their count as a badge (other rows stay plain numbers)', () => {
  const nav = src('src', 'components', 'shell', 'NavRail.tsx');
  assert.match(nav, /count=\{readyForAccountsCount\}\s*attention/);
  assert.match(nav, /count=\{readyForClientCount\}\s*attention/);
  assert.match(nav, /count: reviewCount, attention: true/);
  assert.match(nav, /count: unsentWasteReports, attention: true/);
  assert.equal((nav.match(/attention: true/g) ?? []).length, 2, 'only those two view rows');
  assert.match(nav, /const badge = attention && \(count \?\? 0\) > 0;/, 'a 0 count is not shown as a badge');
});
