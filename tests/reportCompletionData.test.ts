// Data-layer tests for report completion: Completed / Reopen, who + when, the audit events, the "reopen first"
// refusals, and that Send to client is unchanged. The real repository code runs unchanged; only the network is replaced
// by a small fake Supabase server that records every request, so what is SENT (and what is never sent) can be asserted.
//
// The database rules themselves (approval required, pair check, manager-only access, existing triggers) are tested against
// the DEV database - see the report-completion migration. Here the client side is tested against a server that refuses.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REOPEN_FIRST_MESSAGE,
  completeReport,
  getReport,
  reopenReport,
  returnContributionForCorrection,
  returnReportForCorrection,
  sendClientReport,
} from '../src/repository/reportsRepository';

// ---- a tiny fake Supabase REST server --------------------------------------------------------
interface Logged { method: string; path: string; search: string; body: any }
const server = {
  log: [] as Logged[],
  /** What an UPDATE of `reports` answers with (the rows it changed). */
  reportsPatchRows: [{ id: 'r1' }] as unknown[],
  failNext: null as null | { match: RegExp; status: number; body: unknown },
  reportRow: null as null | Record<string, unknown>,
};
function reset() {
  server.log = [];
  server.reportsPatchRows = [{ id: 'r1' }];
  server.failNext = null;
  server.reportRow = null;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(url.pathname);
  const headers = new Headers(init?.headers);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  server.log.push({ method, path, search: decodeURIComponent(url.search), body });

  if (server.failNext && server.failNext.match.test(`${method} ${path}${url.search}`)) {
    const f = server.failNext;
    server.failNext = null;
    return json(f.status, f.body);
  }
  const wantsObject = (headers.get('accept') ?? '').includes('vnd.pgrst.object');

  if (path === '/rest/v1/reports' && method === 'PATCH') return json(200, server.reportsPatchRows);
  if (path === '/rest/v1/reports' && method === 'GET') return json(200, wantsObject ? server.reportRow : [server.reportRow]);
  if (path === '/rest/v1/report_contributions' && method === 'PATCH') return new Response(null, { status: 204 });
  if (path === '/rest/v1/activity_events' && method === 'POST') return new Response(null, { status: 201 });
  if (path === '/functions/v1/send-client-report' && method === 'POST') return json(200, { status: 'sent' });
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;

beforeEach(reset);

const calls = (re: RegExp) => server.log.filter((l) => re.test(`${l.method} ${l.path}`));
const events = () => calls(/^POST \/rest\/v1\/activity_events$/).map((c) => c.body);
const CONSTRAINT = { code: '23514', message: 'new row for relation "reports" violates check constraint "reports_completion_requires_approval_check"' };

// ---- Completed ---------------------------------------------------------------------------------------
test('Completed records WHO and WHEN, only for an approved, not-yet-completed report, and touches nothing else', async () => {
  const before = Date.now();
  await completeReport('r1', 'luke@kindcontractors.co.uk');
  const [patch] = calls(/^PATCH \/rest\/v1\/reports$/);
  assert.match(patch.search, /id=eq\.r1/);
  assert.match(patch.search, /review_status=eq\.approved/, 'only an approved report');
  assert.match(patch.search, /completed_at=is\.null/, 'only one that is not already completed (no double completion)');
  assert.deepEqual(Object.keys(patch.body).sort(), ['completed_at', 'completed_by'], 'exactly the two completion fields');
  assert.equal(patch.body.completed_by, 'luke@kindcontractors.co.uk');
  const at = Date.parse(patch.body.completed_at);
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'completed_at is now');
  assert.equal('sent_to_client_at' in patch.body || 'sent_to_client_by' in patch.body || 'review_status' in patch.body, false, 'the send record and review status are never written');
});

test('Completed writes the existing audit event, with the same timestamp', async () => {
  await completeReport('r1', 'luke@kindcontractors.co.uk');
  const [patch] = calls(/^PATCH \/rest\/v1\/reports$/);
  const [event] = events();
  assert.equal(events().length, 1);
  assert.equal(event.entity_type, 'report');
  assert.equal(event.entity_id, 'r1');
  assert.equal(event.event_type, 'report_completed');
  assert.equal(event.actor, 'luke@kindcontractors.co.uk');
  assert.equal(event.occurred_at, patch.body.completed_at);
});

test('if nothing was updated (already completed, or not approved) the manager is told, and no audit event is written', async () => {
  server.reportsPatchRows = [];
  await assert.rejects(completeReport('r1', 'luke@x'), /could not be marked completed.*already be completed.*not approved/);
  assert.equal(events().length, 0);
});

test('a database error is reported and no audit event is written', async () => {
  server.failNext = { match: /PATCH \/rest\/v1\/reports/, status: 400, body: { code: '42501', message: 'permission denied' } };
  await assert.rejects(completeReport('r1', 'luke@x'), /Failed to mark report completed: permission denied/);
  assert.equal(events().length, 0);
});

// ---- Reopen -------------------------------------------------------------------------------------------
test('Reopen clears who and when, only on a completed report, and writes its own audit event', async () => {
  await reopenReport('r1', 'luke@kindcontractors.co.uk');
  const [patch] = calls(/^PATCH \/rest\/v1\/reports$/);
  assert.match(patch.search, /id=eq\.r1/);
  assert.match(patch.search, /completed_at=not\.is\.null/, 'only a report that is completed');
  assert.deepEqual(patch.body, { completed_at: null, completed_by: null });
  const [event] = events();
  assert.equal(events().length, 1);
  assert.equal(event.entity_type, 'report');
  assert.equal(event.event_type, 'report_reopened');
  assert.equal(event.actor, 'luke@kindcontractors.co.uk');
});

test('Reopen on a report that is not completed says so and writes nothing', async () => {
  server.reportsPatchRows = [];
  await assert.rejects(reopenReport('r1', 'luke@x'), /not completed, so there is nothing to reopen/);
  assert.equal(events().length, 0);
});

test('completing and reopening touch ONLY the reports table (never visits, invoices, send history or a delete)', async () => {
  await completeReport('r1', 'luke@x');
  await reopenReport('r1', 'luke@x');
  assert.equal(calls(/\/rest\/v1\/(visits|invoices|report_client_sends|photos|activities)/).length, 0);
  assert.equal(server.log.some((l) => l.method === 'DELETE'), false);
  assert.equal(calls(/^PATCH \/rest\/v1\/reports$/).length, 2);
});

// ---- the one rule completion adds -----------------------------------------------------------------------
test('returning a COMPLETED report for correction is refused with "reopen it first", and no audit event is written', async () => {
  server.failNext = { match: /PATCH \/rest\/v1\/reports/, status: 400, body: CONSTRAINT };
  await assert.rejects(returnReportForCorrection('r1', 'redo the photos', 'luke@x'), (err: Error) => {
    assert.equal(err.message, REOPEN_FIRST_MESSAGE);
    return true;
  });
  assert.equal(events().length, 0);
});

test('flagging a technician\'s section on a COMPLETED report is refused with the same plain explanation', async () => {
  server.failNext = { match: /PATCH \/rest\/v1\/report_contributions/, status: 400, body: CONSTRAINT };
  await assert.rejects(returnContributionForCorrection('r1', 't1', 'Tech 1', 'wrong photo', 'luke@x'), (err: Error) => {
    assert.equal(err.message, REOPEN_FIRST_MESSAGE);
    return true;
  });
  assert.equal(events().length, 0);
});

test('other failures when returning a report keep their original wording (only the completion rule is rewritten)', async () => {
  server.failNext = { match: /PATCH \/rest\/v1\/reports/, status: 500, body: { message: 'boom' } };
  await assert.rejects(returnReportForCorrection('r1', 'x', 'luke@x'), /Failed to return report: boom/);
  server.failNext = { match: /PATCH \/rest\/v1\/report_contributions/, status: 500, body: { message: 'kaboom' } };
  await assert.rejects(returnContributionForCorrection('r1', 't1', 'Tech 1', 'x', 'luke@x'), /Failed to return contribution: kaboom/);
});

// ---- reading it back --------------------------------------------------------------------------------------
test('the full report read includes completed_at / completed_by and maps them', async () => {
  server.reportRow = {
    id: 'r1', visit_id: 'v1', submitted_by: 'Mo', submitted_at: 's', on_site_start: null, on_site_end: null, work_carried_out: 'w', technician_notes: null, issues: null, spec_met: true,
    review_status: 'approved', reviewed_by: 'luke', reviewed_at: 'r', return_reason: null, include_photos: true, include_notes: true, include_issues: true, include_price: false,
    sent_to_client_at: null, sent_to_client_by: null, sent_to_accounts_at: null, sent_to_accounts_by: null, completed_at: '2026-10-03T09:00:00Z', completed_by: 'luke@x',
  };
  const report = await getReport('r1');
  const [get] = calls(/^GET \/rest\/v1\/reports$/);
  assert.match(get.search, /completed_at/);
  assert.match(get.search, /completed_by/);
  assert.equal(report.completedAt, '2026-10-03T09:00:00Z');
  assert.equal(report.completedBy, 'luke@x');
  assert.equal(report.sentToClientAt, null, 'completed by hand: never emailed');
});

test('a report row from before completion existed maps to "not completed"', async () => {
  server.reportRow = {
    id: 'r1', visit_id: 'v1', submitted_by: 'Mo', submitted_at: 's', on_site_start: null, on_site_end: null, work_carried_out: 'w', technician_notes: null, issues: null, spec_met: true,
    review_status: 'approved', reviewed_by: 'luke', reviewed_at: 'r', return_reason: null, include_photos: true, include_notes: true, include_issues: true, include_price: false,
    sent_to_client_at: null, sent_to_client_by: null, sent_to_accounts_at: null, sent_to_accounts_by: null,
  };
  const report = await getReport('r1');
  assert.equal(report.completedAt, null);
  assert.equal(report.completedBy, null);
});

// ---- Send to client is unchanged ---------------------------------------------------------------------------
test('Send to client is the same single edge-function call with the same body, and does NOT complete the report', async () => {
  const result = await sendClientReport({ reportId: 'r1', contactId: 'c1', pdfBase64: 'JVBERi0=' });
  assert.equal(result.status, 'sent');
  const [fn] = calls(/^POST \/functions\/v1\/send-client-report$/);
  assert.deepEqual(fn.body, { reportId: 'r1', contactId: 'c1', pdfBase64: 'JVBERi0=' });
  assert.equal(calls(/^PATCH \/rest\/v1\/reports$/).length, 0, 'sending never sets completed_at: that is the manager\'s explicit step');
  assert.equal(events().length, 0, 'and writes no completion event');
});

test('Send to client with a confirmed message passes exactly that message, unchanged, alongside the same fields', async () => {
  const message = 'Hi Sam,\n\nThanks for your patience & support <3\n\nLuke';
  await sendClientReport({ reportId: 'r1', contactId: 'c1', pdfBase64: 'JVBERi0=', message });
  const [fn] = calls(/^POST \/functions\/v1\/send-client-report$/);
  assert.deepEqual(fn.body, { reportId: 'r1', contactId: 'c1', pdfBase64: 'JVBERi0=', message });
});

test('the send request is built from the confirmed message, cleaned like the server does, and never built from an invalid one', async () => {
  const { buildSendClientReportInput } = await import('../src/lib/clientEmailSend');
  const ok = buildSendClientReportInput('r1', 'c1', 'JVBERi0=', '  Hi Sam,\r\n\r\nThanks  \n');
  assert.deepEqual(ok, { ok: true, input: { reportId: 'r1', contactId: 'c1', pdfBase64: 'JVBERi0=', message: 'Hi Sam,\n\nThanks' } });
  assert.equal(buildSendClientReportInput('r1', 'c1', 'x', '   \n').ok, false);
  assert.equal(buildSendClientReportInput('r1', 'c1', 'x', 'a'.repeat(2001)).ok, false);
  assert.equal(buildSendClientReportInput('r1', 'c1', 'x', 'a'.repeat(2000)).ok, true);
});
