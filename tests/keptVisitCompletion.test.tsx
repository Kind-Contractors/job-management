// Completing a "kept" visit: an open (due/booked) visit that has a report, on a job that has since been cancelled or closed.
// The manager completes it (price + date) from Ready for accounts - with the very same form the Job Inspector uses - before
// it can be invoiced, and completing it never reopens the job. Server-rendered from a seeded query cache (no DOM library in
// this repo); the one write is covered against a fake REST server, and the database side by the database suite.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import CompleteVisitForm, { completionPriceError } from '../src/components/jobs/CompleteVisitForm';
import VisitRow from '../src/components/jobs/VisitRow';
import ReadyForAccountsPage from '../src/pages/ReadyForAccountsPage';
import { visitNeedsCompletion } from '../src/lib/queueJobs';
import { completeVisit } from '../src/repository/reportsRepository';
import { AuthContext } from '../src/auth/AuthProvider';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};

// ---- fake REST server (for the one write) ---------------------------------------------------------------------------
interface Logged { method: string; path: string; search: string; body: any }
let log: Logged[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  log.push({ method, path: decodeURIComponent(url.pathname), search: decodeURIComponent(url.search), body });
  if (url.pathname === '/rest/v1/visits' && method === 'PATCH') return new Response(null, { status: 204 });
  if (url.pathname === '/rest/v1/activity_events' && method === 'POST') return new Response(null, { status: 201 });
  return new Response(JSON.stringify({ message: `unexpected ${method} ${url.pathname}` }), { status: 404, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
beforeEach(() => { log = []; });

// ---- fixtures -------------------------------------------------------------------------------------------------------
function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-20', status: 'booked', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: 'r-' + id, reportReviewStatus: 'approved', sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, buildingName: string, visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id, buildingId: `b-${id}`, buildingName, clientId: 'c1', clientName: 'Acme Ltd', jobSummary: `${buildingName} cleaning`, division: 'General', lifecycleStatus: 'active', serviceEndsOn: null,
    frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: null, yearlyValue: null, monthlyValue: null, nextDueLabel: '', status: 'booked', technician: 'Unassigned',
    defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null, recontactNotes: null, recontactIntervalMonths: null,
    street: '', postcode: 'AB1', buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: null,
    clientContacts: [{ id: 'ct1', name: 'Sam Client', email: 'sam@acme.test', phoneNumber: null, isPrimary: true, isAccountsContact: false }],
    ...over,
  };
}
const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
function wrap(el: ReactElement, seed: (qc: QueryClient) => void = noop) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{el}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
const accounts = (selected: string, active: any[], closed: any[]) =>
  wrap(<ReadyForAccountsPage initialSelectedVisitId={selected} />, (qc) => {
    qc.setQueryData(['jobRows'], active);
    qc.setQueryData(['jobRows', 'openReportWork'], closed);
  });
const has = (html: string, text: string) => html.includes(text);
const createInvoiceDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>Create invoice</.test(html);
const createInvoiceButton = (html: string) => /<button[^>]*>Create invoice</.test(html);

const kept = visit('kept');                                            // booked, approved report, variable-price job
const keptJob = (over: Record<string, unknown> = {}) => job('jc', 'Closed Court', [kept], { lifecycleStatus: 'cancelled', ...over });

// ---- logic -------------------------------------------------------------------------------------------------------------
test('visitNeedsCompletion: only an open (due/booked) visit on a job that is not active', () => {
  const rows: [string, string, boolean][] = [
    ['cancelled', 'booked', true], ['cancelled', 'due', true], ['lost', 'booked', true], ['completed', 'booked', true], ['on_hold', 'due', true],
    ['cancelled', 'completed', false], ['cancelled', 'missed', false], ['cancelled', 'cancelled', false],
    ['active', 'booked', false], ['active', 'due', false],
  ];
  for (const [lifecycleStatus, status, expected] of rows) {
    assert.equal(visitNeedsCompletion(job('x', 'X', [], { lifecycleStatus }), visit('v', { status })), expected, `${lifecycleStatus} job, ${status} visit`);
  }
  assert.equal(visitNeedsCompletion({ lifecycleStatus: undefined } as any, visit('v')), false, 'job rows cached before lifecycle status existed are active');
});

// ---- the extracted form -----------------------------------------------------------------------------------------------------
test('FORM: the same completion form as before - price, completed-at, Save, Cancel - with the variable-price hint', () => {
  const html = wrap(<CompleteVisitForm job={job('v', 'V', [], { pricePerVisit: null })} visit={kept} actor="luke" onDone={noop} onCancel={noop} />);
  assert.match(html, /Price charged/);
  assert.match(html, /\(variable job — enter actual amount\)/);
  assert.match(html, /type="number"[^>]*step="0\.01"|step="0\.01"[^>]*type="number"/);
  assert.match(html, /Completed at/);
  assert.match(html, /type="datetime-local"/);
  assert.match(html, />Save</);
  assert.match(html, />Cancel</);
});

test('FORM: a fixed-price job starts with its price and shows no variable hint', () => {
  const html = wrap(<CompleteVisitForm job={job('f', 'F', [], { pricePerVisit: 85 })} visit={kept} actor="luke" onDone={noop} onCancel={noop} />);
  assert.match(html, /value="85"/);
  assert.doesNotMatch(html, /variable job/);
});

test('FORM: the price rule is unchanged - an empty price is refused with the same message; any entered price is passed on', () => {
  assert.equal(completionPriceError(''), 'Enter a price charged.');
  assert.equal(completionPriceError('250.50'), null);
  assert.equal(completionPriceError('0'), null, 'as before, only an empty box is refused here');
});

test('VISIT ROW (Job Inspector) regression: an open visit still offers Mark complete / Mark missed / Cancel…; completed ones do not', () => {
  const j = job('a', 'Active', [kept], { pricePerVisit: 100 });
  const open = wrap(<VisitRow job={j} visit={kept} actor="luke" technicians={[]} />);
  assert.match(open, />Mark complete</);
  assert.match(open, />Mark missed</);
  assert.match(open, />Cancel…</);
  const done = wrap(<VisitRow job={j} visit={visit('d', { status: 'completed', priceCharged: 100, completedAt: 'x' })} actor="luke" technicians={[]} />);
  assert.doesNotMatch(done, />Mark complete</);
});

test('ONE implementation: the Job Inspector row and Ready for accounts both use CompleteVisitForm, and completeVisit() is called from it only', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
  assert.match(src('components/jobs/VisitRow.tsx'), /<CompleteVisitForm/);
  assert.match(src('pages/ReadyForAccountsPage.tsx'), /<CompleteVisitForm/);
  assert.doesNotMatch(src('components/jobs/VisitRow.tsx'), /completeVisit\(visit/, 'no second copy of the completion call');
  assert.doesNotMatch(src('pages/ReadyForAccountsPage.tsx'), /completeVisit\(visit/);
  assert.equal((src('components/jobs/CompleteVisitForm.tsx').match(/completeVisit\(visit/g) ?? []).length, 1);
});

// ---- the one write ---------------------------------------------------------------------------------------------------------------
test('DATA: completing a kept visit is ONE visit update (status, price, time) plus its audit event - the job is never written', async () => {
  await completeVisit('v-kept', 250.5, '2026-10-21T09:30:00.000Z', 'luke@kindcontractors.co.uk');
  const patches = log.filter((l) => l.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, '/rest/v1/visits');
  assert.match(patches[0].search, /id=eq\.v-kept/);
  assert.deepEqual(patches[0].body, { status: 'completed', price_charged: 250.5, completed_at: '2026-10-21T09:30:00.000Z' });
  assert.equal(log.filter((l) => /\/rest\/v1\/jobs/.test(l.path)).length, 0, 'the job (its lifecycle status) is never touched');
  assert.equal(log.filter((l) => /\/rest\/v1\/(reports|photos|invoices|invoice_line_items)/.test(l.path)).length, 0);
  const events = log.filter((l) => l.method === 'POST' && l.path === '/rest/v1/activity_events');
  assert.equal(events.length, 1);
  assert.equal(events[0].body.event_type, 'visit_completed');
  assert.equal(events[0].body.entity_type, 'visit');
});

// ---- Ready for accounts: a kept visit on a cancelled / closed job -------------------------------------------------------------------
test('ACCOUNTS (cancelled job, open visit): shows the completion block and form, says completing does not reopen the job, and blocks Create invoice', () => {
  const html = accounts('kept', [], [keptJob()]);
  assert.match(html, /Complete this visit first/);
  assert.match(html, /This visit is still marked Booked, but its job has been cancelled\./);
  assert.match(html, /Completing the visit does not reopen or reactivate the job: the job stays\s*cancelled and off the schedule\./);
  assert.match(html, /Price charged/, 'the existing completion form is shown');
  assert.match(html, /variable job — enter actual amount/);
  assert.ok(createInvoiceDisabled(html), 'Create invoice is disabled');
  assert.match(html, /Complete the visit above first/);
});

test('ACCOUNTS: a lost / completed (closed) job says "closed", and a Due visit says Due', () => {
  const html = accounts('kept', [], [job('jl', 'Lost Lane', [visit('kept', { status: 'due' })], { lifecycleStatus: 'lost' })]);
  assert.match(html, /This visit is still marked Due, but its job has been closed\./);
  assert.ok(createInvoiceDisabled(html));
});

test('ACCOUNTS: once the visit is completed the block goes, Create invoice is enabled, the recorded price is the default, and the job stays cancelled', () => {
  const doneJob = keptJob({ visits: [visit('kept', { status: 'completed', priceCharged: 250, completedAt: '2026-10-21T09:30:00Z' })] });
  const html = accounts('kept', [], [doneJob]);
  assert.doesNotMatch(html, /Complete this visit first/);
  assert.ok(createInvoiceButton(html) && !createInvoiceDisabled(html), 'Create invoice is enabled');
  assert.match(html, /£250(\.00)? for this visit\./, 'the recorded visit price is what the invoice will default to');
  assert.equal(doneJob.lifecycleStatus, 'cancelled');
  assert.ok(has(html, 'Closed Court'), 'the row is still in the accounts queue (it still needs invoicing)');
});

test('ACCOUNTS regression: a normal ACTIVE job with an open visit has no completion block and Create invoice works as before', () => {
  const active = job('ja', 'Active Arms', [visit('kept')], { lifecycleStatus: 'active' });
  const html = accounts('kept', [active], []);
  assert.doesNotMatch(html, /Complete this visit first/);
  assert.ok(createInvoiceButton(html) && !createInvoiceDisabled(html));
});

test('COMBINED INVOICE: the checkbox is off for an open visit on a closed job, and still there for completed ones and for active jobs', () => {
  const closedOpen = job('j1', 'Closed Open', [visit('a')], { lifecycleStatus: 'cancelled' });
  const closedDone = job('j2', 'Closed Done', [visit('b', { status: 'completed', priceCharged: 10, completedAt: 'x' })], { lifecycleStatus: 'cancelled' });
  const active = job('j3', 'Active Open', [visit('c')]);
  const boxes = (html: string) => (html.match(/type="checkbox"/g) ?? []).length;
  assert.equal(boxes(accounts('', [], [closedOpen])), 0, 'open visit on a closed job: no checkbox');
  assert.equal(boxes(accounts('', [], [closedDone])), 1, 'completed visit on a closed job: checkbox');
  assert.equal(boxes(accounts('', [active], [])), 1, 'active job: unchanged');
  assert.equal(boxes(accounts('', [active], [closedOpen, closedDone])), 2);
});
