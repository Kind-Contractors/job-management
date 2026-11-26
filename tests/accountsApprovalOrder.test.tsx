// Ready for accounts and Ready for client (Nov 2026): listed by the date the report was approved, most recent first, and that
// approval date is shown on each row and in the selected row's header. (Ready for client's "Sent or completed" tab keeps its own
// most-recently-delivered order, and shows the approval date too.) The date is the report's own reviewed_at (set on approval), loaded with the job
// rows - only while the report is approved. Server-rendered from a seeded query cache (no DOM library in this repo).
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import ReadyForAccountsPage from '../src/pages/ReadyForAccountsPage';
import ReadyForClientPage from '../src/pages/ReadyForClientPage';
import { byApprovalNewestFirst, byCompletedNewestFirst } from '../src/lib/queueJobs';
import ReportReviewPage from '../src/pages/ReportReviewPage';
import { mapVisitRow } from '../src/repository/mapJobRow';
import { AuthContext } from '../src/auth/AuthProvider';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-20', status: 'completed', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: 50, completedAt: '2026-10-20T12:00:00Z', reportId: 'r-' + id, reportReviewStatus: 'approved', reportApprovedAt: null, sentToClientAt: null, sentToAccountsAt: null,
    reportCompletedAt: null, reportCompletedBy: null, invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, buildingName: string, visits: any[]): any {
  return {
    id, buildingId: `b-${id}`, buildingName, clientId: 'c1', clientName: 'Acme Ltd', jobSummary: `${buildingName} cleaning`, division: 'General', lifecycleStatus: 'active', serviceEndsOn: null,
    frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 50, yearlyValue: null, monthlyValue: null, nextDueLabel: '', status: 'booked', technician: 'Unassigned',
    defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null, recontactNotes: null, recontactIntervalMonths: null,
    street: '', postcode: 'AB1', buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: null, clientContacts: [],
  };
}
const auth: any = { status: 'authorized', role: 'manager', session: { user: { id: 'u1', email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
function page(active: any[], selected: string | null = null, which: 'accounts' | 'client' | 'client-delivered' = 'accounts') {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['jobRows'], active);
  qc.setQueryData(['jobRows', 'openReportWork'], []);
  const el: ReactElement =
    which === 'accounts' ? <ReadyForAccountsPage initialSelectedVisitId={selected} />
      : <ReadyForClientPage initialView={which === 'client' ? 'awaiting' : 'completed'} initialSelectedVisitId={selected} />;
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{el}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
const row = (j: any, v: any) => ({ job: j, visit: v });

test('LOADED: the job rows ask for reviewed_at, and it becomes the approval date only while the report is approved', () => {
  const repo = src('src', 'repository', 'jobsRepository.ts');
  assert.equal((repo.match(/reports \( id, review_status, reviewed_at,/g) ?? []).length, 2, 'both visit selects');
  const base: any = { id: 'v', technician_id: null, scheduled_date: '2026-10-01', status: 'completed', price_charged: 10, completed_at: null, technicians: null, visit_technicians: [], invoice_line_items: [], report_videos: [] };
  const report = (review_status: string) => ({ id: 'r', review_status, reviewed_at: '2026-11-20T09:30:00Z', sent_to_client_at: null, sent_to_accounts_at: null, completed_at: null, completed_by: null, report_contributions: [] });
  assert.equal(mapVisitRow({ ...base, reports: [report('approved')] }).reportApprovedAt, '2026-11-20T09:30:00Z');
  assert.equal(mapVisitRow({ ...base, reports: [report('returned_for_correction')] }).reportApprovedAt, null, 'a return is not an approval');
  assert.equal(mapVisitRow({ ...base, reports: [] }).reportApprovedAt, null);
});

test('ORDER: most recently approved first; no approval date last; ties by the latest visit date', () => {
  const j = job('j', 'X', []);
  const rows = [
    row(j, visit('old', { reportApprovedAt: '2026-11-01T08:00:00Z', scheduledDate: '2026-10-30' })),
    row(j, visit('none', { reportApprovedAt: null, scheduledDate: '2026-11-24' })),
    row(j, visit('newest', { reportApprovedAt: '2026-11-25T16:10:00Z', scheduledDate: '2026-09-01' })),
    row(j, visit('mid-a', { reportApprovedAt: '2026-11-20T10:00:00Z', scheduledDate: '2026-11-02' })),
    row(j, visit('mid-b', { reportApprovedAt: '2026-11-20T10:00:00Z', scheduledDate: '2026-11-15' })),
    row(j, visit('cached', { reportApprovedAt: undefined, scheduledDate: '2026-08-01' })),
  ];
  assert.deepEqual(rows.sort(byApprovalNewestFirst).map((r) => r.visit.id), ['newest', 'mid-b', 'mid-a', 'old', 'none', 'cached']);
  assert.match(src('src', 'pages', 'ReadyForAccountsPage.tsx'), /accountsQueueRows\(jobRows, division\)\.sort\(byApprovalNewestFirst\)/);
});

test('PAGE: rows listed newest approval first, each showing "Approved <date, time>"; the header repeats it for the selected one', () => {
  const a = visit('a', { reportApprovedAt: '2026-11-10T09:00:00Z', scheduledDate: '2026-11-25' });
  const b = visit('b', { reportApprovedAt: '2026-11-24T15:45:00Z', scheduledDate: '2026-11-01' });
  const html = page([job('ja', 'Alpha House', [a]), job('jb', 'Beta Court', [b])], 'b');
  assert.ok(html.indexOf('Beta Court') < html.indexOf('Alpha House'), 'approved later = listed first, despite the older visit');
  const approved = [...html.matchAll(/data-testid="accounts-approved-at"[^>]*>Approved ([^<]+)</g)].map((m) => m[1]);
  assert.equal(approved.length, 2);
  assert.match(approved[0], /^24\/11\/2026, \d\d:45$/);
  assert.match(approved[1], /^10\/11\/2026, \d\d:00$/);
  assert.match(html, />Report approved 24\/11\/2026, \d\d:45</);
});

test('PAGE: a row without an approval date (old cache) shows no "Approved" line and still lists', () => {
  const html = page([job('jc', 'Cached Court', [visit('c', { reportApprovedAt: undefined })])]);
  assert.match(html, /Cached Court/);
  assert.doesNotMatch(html, /accounts-approved-at/);
});

test('READY FOR CLIENT: awaiting reports listed newest approval first, each showing "Approved <date, time>"', () => {
  const a = visit('a', { reportApprovedAt: '2026-11-10T09:00:00Z', scheduledDate: '2026-11-25' });
  const b = visit('b', { reportApprovedAt: '2026-11-24T15:45:00Z', scheduledDate: '2026-11-01' });
  const html = page([job('ja', 'Alpha House', [a]), job('jb', 'Beta Court', [b])], null, 'client');
  assert.ok(html.indexOf('Beta Court') < html.indexOf('Alpha House'), 'approved later = listed first, despite the older visit');
  const approved = [...html.matchAll(/data-testid="client-approved-at"[^>]*>Approved ([^<]+)</g)].map((m) => m[1]);
  assert.equal(approved.length, 2);
  assert.match(approved[0], /^24\/11\/2026, \d\d:45$/);
  assert.match(approved[1], /^10\/11\/2026, \d\d:00$/);
  const code = src('src', 'pages', 'ReadyForClientPage.tsx');
  assert.match(code, /awaiting\.sort\(byApprovalNewestFirst\);/);
  assert.match(code, /` · Report approved \$\{formatApprovedAt\(selected\.visit\.reportApprovedAt\)\}`/, 'and in the selected report\'s header');
});

test('READY FOR CLIENT, "Sent or completed": still most recently delivered first; the approval date is shown there too', () => {
  const early = visit('e', { reportApprovedAt: '2026-11-24T10:00:00Z', sentToClientAt: '2026-11-24T11:00:00Z' });
  const late = visit('l', { reportApprovedAt: '2026-11-01T10:00:00Z', reportCompletedAt: '2026-11-25T09:00:00Z', reportCompletedBy: 'luke' });
  const html = page([job('je', 'Early Sent', [early]), job('jl', 'Late Done', [late])], null, 'client-delivered');
  assert.ok(html.indexOf('Late Done') < html.indexOf('Early Sent'), 'delivered order, not approval order');
  assert.equal((html.match(/data-testid="client-approved-at"/g) ?? []).length, 2);
});

test('REPORT REVIEW: most recently completed first; no completion time last; the card says "Completed <date>" once', () => {
  const j = job('j', 'X', []);
  const ordered = [
    row(j, visit('old', { completedAt: '2026-11-01T08:00:00Z' })),
    row(j, visit('none', { completedAt: null, scheduledDate: '2026-11-24' })),
    row(j, visit('new', { completedAt: '2026-11-25T16:00:00Z' })),
  ].sort(byCompletedNewestFirst).map((r) => r.visit.id);
  assert.deepEqual(ordered, ['new', 'old', 'none']);
  assert.match(src('src', 'pages', 'ReportReviewPage.tsx'), /return rows\.sort\(byCompletedNewestFirst\);/);

  const review = (id: string, building: string, completedAt: string | null) =>
    job('j' + id, building, [visit(id, { reportReviewStatus: 'awaiting_review', reportApprovedAt: null, completedAt })]);
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['jobRows'], [review('a', 'Older House', '2026-11-02T10:00:00Z'), review('b', 'Newer Court', '2026-11-20T10:00:00Z'), review('c', 'Unknown Lodge', null)]);
  qc.setQueryData(['jobRows', 'openReportWork'], []);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter><ReportReviewPage /></MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  assert.ok(html.indexOf('Newer Court') < html.indexOf('Older House') && html.indexOf('Older House') < html.indexOf('Unknown Lodge'));
  assert.match(html, />Completed 20\/11\/2026</);
  assert.match(html, />Completed date unknown</);
  assert.doesNotMatch(html, /Completed Completed/);
});
