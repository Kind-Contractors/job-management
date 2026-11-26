// "Mark as already invoiced" (Nov 2026): Ready for accounts work that Luke has ALREADY invoiced by hand in Xero is marked as such and
// moves to Records - through one database function (manager only, all-or-nothing, visits locked), never through Xero. These tests
// cover the app side: the call (and that nothing goes to Xero), the queue/Records rules for the new status, which rows can be
// marked, the selection, the confirmation and Records' display. The database function itself is rehearsed separately on Postgres.
import 'fake-indexeddb/auto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { markVisitsInvoicedManually } from '../src/repository/invoicesRepository';
import { mapInvoiceRecord } from '../src/repository/invoiceRecordsRepository';
import { canMarkAsAlreadyInvoiced, visitsMarkedTogether } from '../src/lib/markInvoiced';
import { accountsQueueRows, isVisitInAccountsQueue } from '../src/lib/queueJobs';
import { isInvoiceInXero } from '../src/lib/invoiceStatus';
import { INVOICE_STATUS_LABEL } from '../src/lib/records';
import { HISTORY_EVENT_LABEL } from '../src/lib/historyEventLabels';
import MarkInvoicedDialog from '../src/components/accounts/MarkInvoicedDialog';
import InvoiceRecordItem from '../src/components/records/InvoiceRecordItem';
import ReadyForAccountsPage from '../src/pages/ReadyForAccountsPage';
import { AuthContext } from '../src/auth/AuthProvider';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');

// ---- fake server: records every request; answers the RPC as told -----------------------------------------------------------
interface Logged { method: string; path: string; body: any }
let log: Logged[] = [];
let rpcAnswer: () => Response = () => json(200, { visits: 1, invoices: 1, created: 1, marked_existing: 0 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  log.push({ method: (init?.method ?? 'GET').toUpperCase(), path: decodeURIComponent(url.pathname), body });
  if (url.pathname === '/rest/v1/rpc/manager_mark_visits_invoiced_manually') return rpcAnswer();
  return json(404, { message: `unexpected ${url.pathname}` });
}) as typeof fetch;
beforeEach(() => { log = []; rpcAnswer = () => json(200, { visits: 1, invoices: 1, created: 1, marked_existing: 0 }); });

// ---- fixtures -------------------------------------------------------------------------------------------------------------
function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-11-20', status: 'completed', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: 80, completedAt: '2026-11-20T12:00:00Z', reportId: 'r-' + id, reportReviewStatus: 'approved', reportApprovedAt: '2026-11-21T09:00:00Z', sentToClientAt: null,
    sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null, invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id, buildingId: `b-${id}`, buildingName: `House ${id}`, clientId: 'c1', clientName: 'Acme Ltd', jobSummary: 'Window cleaning', division: 'General', lifecycleStatus: 'active', serviceEndsOn: null,
    frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 80, yearlyValue: null, monthlyValue: null, nextDueLabel: '', status: 'booked', technician: 'Unassigned',
    defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null, recontactNotes: null, recontactIntervalMonths: null,
    street: '', postcode: 'AB1', buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: null, clientContacts: [], ...over,
  };
}
const auth: any = { status: 'authorized', role: 'manager', session: { user: { id: 'u1', email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
function render(el: React.ReactElement, active: any[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['jobRows'], active);
  qc.setQueryData(['jobRows', 'openReportWork'], []);
  qc.setQueryData(['buildingRows'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{el}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

// ---- the call -------------------------------------------------------------------------------------------------------------
test('CALL: one database function with the selected visit ids - and nothing else (no Edge Function, nothing to Xero)', async () => {
  rpcAnswer = () => json(200, { visits: 3, invoices: 3, created: 2, marked_existing: 1 });
  const r = await markVisitsInvoicedManually(['v1', 'v2', 'v3']);
  assert.deepEqual(r, { visits: 3, invoices: 3, created: 2, marked_existing: 1 });
  assert.equal(log.length, 1);
  assert.equal(log[0].method, 'POST');
  assert.equal(log[0].path, '/rest/v1/rpc/manager_mark_visits_invoiced_manually');
  assert.deepEqual(log[0].body, { p_visit_ids: ['v1', 'v2', 'v3'] });
  assert.ok(!log.some((l) => l.path.startsWith('/functions/')), 'no Edge Function call (xero-create-invoice is the only way to Xero)');
});

test('CALL: a refusal from the database is shown as it was worded (e.g. already in Records, being sent)', async () => {
  rpcAnswer = () => json(400, { code: '55000', message: 'The invoice for House A is already in Records. Nothing was marked.' });
  await assert.rejects(markVisitsInvoicedManually(['v1']), /already in Records\. Nothing was marked\./);
  rpcAnswer = () => json(403, { code: '42501', message: 'Only a manager can mark work as already invoiced.' });
  await assert.rejects(markVisitsInvoicedManually(['v1']), /Only a manager/);
});

test('NO XERO: the feature never references the Xero function, and the Xero function still only claims draft / failed invoices', () => {
  for (const f of [['src', 'lib', 'markInvoiced.ts'], ['src', 'components', 'accounts', 'MarkInvoicedDialog.tsx']]) {
    assert.doesNotMatch(src(...f), /xero-create-invoice|functions\.invoke|sendInvoice/, f.join('/'));
  }
  const repo = src('src', 'repository', 'invoicesRepository.ts');
  const fn = repo.slice(repo.indexOf('export async function markVisitsInvoicedManually'));
  assert.doesNotMatch(fn, /functions\.invoke|xero/i);
  const edge = src('supabase', 'functions', 'xero-create-invoice', 'index.ts');
  assert.match(edge, /\.in\("status", \["draft", "failed"\]\)|\.in\('status', \['draft', 'failed'\]\)/, 'the atomic claim is unchanged');
  assert.doesNotMatch(edge, /invoiced_manually/, 'the Xero function is untouched');
});

// ---- queue and Records rules -------------------------------------------------------------------------------------------------
test('QUEUE / RECORDS: a marked invoice leaves Ready for accounts and is in Records - exactly one place, like a sent one', () => {
  const marked = visit('m', { invoiceId: 'i-m', invoiceStatus: 'invoiced_manually' });
  assert.equal(isVisitInAccountsQueue(job('j', []), marked), false);
  assert.equal(isInvoiceInXero('invoiced_manually'), true);
  const rows = accountsQueueRows([job('j', [marked, visit('open')])], 'Both');
  assert.deepEqual(rows.map((r) => r.visit.id), ['open']);
  assert.equal(INVOICE_STATUS_LABEL.invoiced_manually, 'Invoiced outside JMS');
  assert.equal(HISTORY_EVENT_LABEL.invoice_marked_manually, 'Marked as already invoiced (outside JMS)');
});

test('ELIGIBLE: no invoice + approved + completed, or a draft / failed invoice; never sending, in Xero, unapproved or needing completion', () => {
  const j = job('j', []);
  assert.equal(canMarkAsAlreadyInvoiced(j, visit('a')), true);
  assert.equal(canMarkAsAlreadyInvoiced(j, visit('d', { invoiceId: 'i', invoiceStatus: 'draft' })), true);
  assert.equal(canMarkAsAlreadyInvoiced(j, visit('f', { invoiceId: 'i', invoiceStatus: 'failed' })), true);
  for (const s of ['sending', 'sent', 'in_xero_not_emailed', 'invoiced_manually']) {
    assert.equal(canMarkAsAlreadyInvoiced(j, visit('x', { invoiceId: 'i', invoiceStatus: s })), false, s);
  }
  assert.equal(canMarkAsAlreadyInvoiced(j, visit('r', { reportReviewStatus: 'returned_for_correction' })), false);
  assert.equal(canMarkAsAlreadyInvoiced(j, visit('b', { status: 'booked' })), false);
  assert.equal(canMarkAsAlreadyInvoiced(job('closed', [], { lifecycleStatus: 'cancelled' }), visit('k', { status: 'booked' })), false, 'complete it first');
});

test('ONE ACTION, ONE INVOICE: a visit on a combined draft brings every visit on that invoice; a lone visit only itself', () => {
  const rows = [visit('a', { invoiceId: 'i1', invoiceStatus: 'draft' }), visit('b', { invoiceId: 'i1', invoiceStatus: 'draft' }), visit('c')].map((v) => ({ visit: v }));
  assert.deepEqual(visitsMarkedTogether(rows, rows[0].visit), ['a', 'b']);
  assert.deepEqual(visitsMarkedTogether(rows, rows[1].visit), ['a', 'b']);
  assert.deepEqual(visitsMarkedTogether(rows, rows[2].visit), ['c']);
});

// ---- UI ------------------------------------------------------------------------------------------------------------------
test('CONFIRMATION: names the count, says nothing goes to Xero, lists the work; Cancel and the confirm button; errors shown', () => {
  const rows = [{ job: job('A', []), visit: visit('a') }, { job: job('B', []), visit: visit('b', { invoiceId: 'i', invoiceStatus: 'failed' }) }];
  const html = render(<MarkInvoicedDialog rows={rows} pending={false} error={null} onConfirm={noop} onCancel={noop} />);
  assert.match(html, /Manual reconciliation/);
  assert.match(html, /Mark 2 visits as already invoiced\?/);
  assert.match(html, /JMS will not create, update or send anything in Xero/);
  assert.match(html, /move from Ready for\s+accounts to Records/);
  assert.match(html, /can&#x27;t be undone/);
  assert.match(html, /House A<\/span>[\s\S]*£80\.00/);
  assert.match(html, /House B[\s\S]*failed invoice[\s\S]*as on the invoice/, 'a draft/failed invoice keeps its own amounts');
  assert.match(html, />Cancel</);
  assert.match(html, /data-testid="mark-invoiced-confirm"[^>]*>Mark 2 as already invoiced</);
  const pending = render(<MarkInvoicedDialog rows={rows} pending error="The invoice for House B is being sent to Xero right now." onConfirm={noop} onCancel={noop} />);
  assert.match(pending, /<button[^>]*disabled=""[^>]*data-testid="mark-invoiced-confirm"[^>]*>Marking…</);
  assert.match(pending, /role="alert"[^>]*>The invoice for House B is being sent to Xero right now\.</);
});

test('PAGE: "Already invoiced in Xero…" on eligible rows only - none on one being sent or needing completion; no selection mode', () => {
  const eligible = job('ok', [visit('a')]);
  const draft = job('dr', [visit('d', { invoiceId: 'i-d', invoiceStatus: 'draft' })]);
  const sending = job('se', [visit('s', { invoiceId: 'i-s', invoiceStatus: 'sending' })]);
  const kept = job('kp', [visit('k', { status: 'booked', priceCharged: null, completedAt: null })], { lifecycleStatus: 'cancelled' });
  const html = render(<ReadyForAccountsPage initialSelectedVisitId="a" />, [eligible, draft, sending, kept]);
  const actions = [...html.matchAll(/aria-label="Already invoiced in Xero: ([^,]+), visit [^"]+"/g)].map((m) => m[1]);
  assert.deepEqual(actions.sort(), ['House dr', 'House ok'], 'eligible rows only');
  assert.match(html, /data-testid="mark-invoiced-action"[^>]*opacity-100[^>]*>Already invoiced in Xero…</, 'always shown on the selected row');
  assert.match(html, /group-hover:opacity-100[^>]*>Already invoiced in Xero…</, 'shown on hover / focus on the others');
  assert.doesNotMatch(html, /mark-invoiced-start|mark-invoiced-bar|mark-invoiced-checkbox|mark-invoiced-dialog/, 'no selection mode, no dialog until asked for');
});

test('PAGE: the action opens the confirmation for exactly that invoice, never touches the combine selection, and refreshes on success', () => {
  const page = src('src', 'pages', 'ReadyForAccountsPage.tsx');
  const action = page.slice(page.indexOf('data-testid="mark-invoiced-action"') - 900, page.indexOf('data-testid="mark-invoiced-action"'));
  assert.match(action, /e\.stopPropagation\(\);/, 'does not select the row');
  assert.match(action, /setMarkVisitIds\(visitsMarkedTogether\(rows, row\.visit\)\);/, 'that row (its whole invoice)');
  assert.doesNotMatch(action, /toggleSelectedForInvoice|setSelectedForInvoiceIds/, 'never selects for combining');
  assert.match(page, /\{markVisitIds && \(\s*<MarkInvoicedDialog\s+rows=\{markRows\}/);
  assert.match(page, /onCancel=\{\(\) => \{\s*setMarkVisitIds\(null\);\s*setMarkError\(null\);\s*\}\}/, 'Cancel only closes it');
  assert.match(page, /onConfirm=\{\(\) => markInvoicedMutation\.mutate\(markRows\.map\(\(r\) => r\.visit\.id\)\)\}/);
  assert.match(page, /queryClient\.invalidateQueries\(\{ queryKey: \['jobRows'\] \}\);\s*queryClient\.invalidateQueries\(\{ queryKey: \['invoiceRecords'\] \}\);/, 'list and Records refresh');
  assert.match(page, /Nothing was sent to Xero\./);
});

test('COMBINING UNCHANGED: the combine checkbox and panel are exactly as before this feature (commit bc95cf1)', () => {
  const page = src('src', 'pages', 'ReadyForAccountsPage.tsx');
  const before = execFileSync('git', ['show', 'bc95cf1:src/pages/ReadyForAccountsPage.tsx'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
  const between = (code: string, from: string, to: string) => code.slice(code.indexOf(from), code.indexOf(to, code.indexOf(from)));
  for (const [from, to] of [
    ['{selectedForInvoiceIds.size >= 2 && (', '<ClosedJobsNotice'],
    ['{canSelectForInvoice && (', '<span className="text-[12.5px] font-semibold text-ink">{row.job.buildingName}</span>'],
    ['const createCombinedInvoiceMutation = useMutation({', 'onError: (err) => setCombineError('],
  ]) {
    const was = between(before, from, to);
    assert.ok(was.length > 40, from);
    assert.equal(between(page, from, to), was, `unchanged: ${from}`);
  }
  // A combine checkbox still renders, independent of the new action.
  const html = render(<ReadyForAccountsPage />, [job('j', [visit('a'), visit('b')])]);
  assert.equal((html.match(/title="Select for a combined invoice"/g) ?? []).length, 2);
  assert.equal((html.match(/data-testid="mark-invoiced-action"/g) ?? []).length, 2);
});

test('RECORDS: shows "Invoiced outside JMS", who marked it and when, no invented Xero number or link', () => {
  const rec = mapInvoiceRecord({
    id: 'i1', status: 'invoiced_manually', description: 'Window cleaning', works_order_number: null, due_date: '2026-12-20', sent_at: null, created_at: '2026-11-26T10:00:00Z',
    last_error: null, xero_invoice_id: null, xero_invoice_number: null, xero_recipient_name: null, xero_recipient_email: null, not_emailed_reason: null,
    marked_invoiced_by: 'Luke', marked_invoiced_at: '2026-11-26T10:00:00Z',
    invoice_line_items: [{ id: 'l1', description: 'Window cleaning', quantity: 1, unit_amount: 80, sort_order: 0, visit_id: 'v1', visits: { scheduled_date: '2026-11-20' } }],
    jobs: { id: 'j', job_summary: 'Window cleaning', lifecycle_status: 'active', building_id: 'b', buildings: { id: 'b', name: 'Oak Court', address: '', postcode: '', clients: { company_name: 'Acme' } } },
  });
  assert.equal(rec.markedInvoicedBy, 'Luke');
  const html = renderToStaticMarkup(<MemoryRouter><InvoiceRecordItem invoice={rec} /></MemoryRouter>);
  assert.match(html, />See Xero</);
  assert.match(html, />Invoiced outside JMS</);
  assert.match(html, />Invoiced in Xero by hand</);
  assert.doesNotMatch(html, /No number yet|Not in Xero|View in Xero/);
  assert.match(src('src', 'repository', 'invoiceRecordsRepository.ts'), /marked_invoiced_by, marked_invoiced_at/);
});

test('MIGRATION (source): manager only, all-or-nothing in one function, visits locked, final status, Xero fields never written', () => {
  const m = src('supabase', 'migrations', '20261126100000_invoices_invoiced_manually.sql');
  assert.match(m, /if private\.current_app_role\(\) is distinct from 'manager' then/);
  assert.match(m, /perform 1 from visits where id = any\(v_ids\) order by id for update;/);
  assert.match(m, /security invoker/);
  assert.match(m, /revoke all on function public\.manager_mark_visits_invoiced_manually\(uuid\[\]\) from public, anon;/);
  assert.match(m, /check \(\(status = 'invoiced_manually'\) = \(marked_invoiced_at is not null\)\)/);
  assert.match(m, /create trigger invoices_invoiced_manually_final/);
  const fn = m.slice(m.indexOf('create or replace function public.manager_mark_visits_invoiced_manually'));
  assert.doesNotMatch(fn.replace(/--[^\n]*/g, ''), /xero_invoice_id\s*=|xero_invoice_number\s*=|sent_at\s*=|xero_contact_id\s*=/, 'no Xero metadata written');
  assert.ok(readFileSync(join(process.cwd(), 'supabase', 'rollbacks', '20261126100000_invoices_invoiced_manually.rollback.sql'), 'utf8').includes('Rollback refused'));
});
