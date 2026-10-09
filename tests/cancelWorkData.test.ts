// Data-layer tests for cancelling work, against a tiny fake Supabase REST server (no network, nothing real is touched):
// the cancel call, the schedule query (cancelled visits and closed jobs stay off the active schedule), and the extra
// source the report queues read for closed jobs.
import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { cancelJobWork, listJobRowsWithOpenReportWork } from '../src/repository/jobsRepository';
import { listVisitsForRange } from '../src/repository/techniciansRepository';

interface Logged { method: string; path: string; search: string; body: any }
const server = {
  log: [] as Logged[],
  rpc: {} as Record<string, { status?: number; body: unknown }>,
  visitsRows: [] as unknown[],
  jobsRows: [] as unknown[],
};
function reset() {
  server.log = [];
  server.rpc = {};
  server.visitsRows = [];
  server.jobsRows = [];
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(url.pathname);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  server.log.push({ method, path, search: decodeURIComponent(url.search), body });
  const rpcName = path.startsWith('/rest/v1/rpc/') ? path.slice('/rest/v1/rpc/'.length) : null;
  if (rpcName) {
    const r = server.rpc[rpcName];
    return r ? json(r.status ?? 200, r.body) : json(404, { message: `unexpected rpc ${rpcName}` });
  }
  if (path === '/rest/v1/visits' && method === 'GET') return json(200, server.visitsRows);
  if (path === '/rest/v1/jobs' && method === 'GET') return json(200, server.jobsRows);
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;

beforeEach(reset);
const calls = (re: RegExp) => server.log.filter((l) => re.test(`${l.method} ${l.path}`));

// ---- the cancel call -------------------------------------------------------------------------------------------------
test('cancelJobWork is ONE database call with the scope, the job, the starting visit and the reason - nothing else is written', async () => {
  server.rpc.cancel_job_work = {
    body: { scope: 'this_and_future', already_done: false, cancelled_visit_ids: ['v1', 'v2'], kept_visits: [{ id: 'v3', scheduled_date: '2026-11-01', reason: 'has_report' }], service_ends_on: '2026-10-20', lifecycle_status: 'active' },
  };
  const res = await cancelJobWork({ jobId: 'j1', scope: 'this_and_future', fromVisitId: 'v1', reason: 'ending contract' });
  assert.equal(server.log.length, 1, 'a single request');
  assert.equal(server.log[0].path, '/rest/v1/rpc/cancel_job_work');
  assert.deepEqual(server.log[0].body, { p_job_id: 'j1', p_scope: 'this_and_future', p_from_visit_id: 'v1', p_reason: 'ending contract' });
  assert.deepEqual(res, {
    scope: 'this_and_future', alreadyDone: false, cancelledVisitIds: ['v1', 'v2'],
    keptVisits: [{ id: 'v3', scheduledDate: '2026-11-01', reason: 'has_report' }], serviceEndsOn: '2026-10-20', lifecycleStatus: 'active',
  });
  assert.equal(calls(/^(PATCH|DELETE|POST) \/rest\/v1\/(visits|jobs|reports|photos|invoices)/).length, 0, 'no direct table writes from the browser');
});

test('cancelJobWork for the entire job sends no starting visit; a repeat answers "already done"', async () => {
  server.rpc.cancel_job_work = { body: { scope: 'job', already_done: true, cancelled_visit_ids: [], kept_visits: [], service_ends_on: null, lifecycle_status: 'cancelled' } };
  const res = await cancelJobWork({ jobId: 'j1', scope: 'job', fromVisitId: null, reason: null });
  assert.deepEqual(server.log[0].body, { p_job_id: 'j1', p_scope: 'job', p_from_visit_id: null, p_reason: null });
  assert.equal(res.alreadyDone, true);
  assert.equal(res.lifecycleStatus, 'cancelled');
});

test('a refusal from the server (not a manager, job closed, ...) surfaces its own message', async () => {
  server.rpc.cancel_job_work = { status: 400, body: { message: 'Not authorized.', code: 'P0001' } };
  await assert.rejects(() => cancelJobWork({ jobId: 'j1', scope: 'job', fromVisitId: null, reason: null }), /Not authorized\./);
});

// ---- the active schedule -----------------------------------------------------------------------------------------------
test('SCHEDULE: the visit query leaves out cancelled visits and visits of jobs that are not active', async () => {
  await listVisitsForRange('2026-10-01', '2026-10-31');
  const [q] = calls(/^GET \/rest\/v1\/visits$/);
  assert.match(q.search, /status=neq\.cancelled/, 'cancelled visits are not shown on Month / Week / Day');
  assert.match(q.search, /jobs\.lifecycle_status=eq\.active/, 'nor are visits of cancelled / closed jobs');
  assert.match(q.search, /jobs!inner\(lifecycle_status\)/, 'the job is joined (inner) so the filter removes the visit');
  assert.match(q.search, /scheduled_date=gte\.2026-10-01/);
  assert.match(q.search, /scheduled_date=lte\.2026-10-31/);
});

test('SCHEDULE: rows are mapped as before (the joined job column is not leaked into a visit)', async () => {
  server.visitsRows = [{ id: 'v1', job_id: 'j1', technician_id: 't1', scheduled_date: '2026-10-05', status: 'booked', sort_order: null, created_at: 'c', start_time: null, end_time: null, visit_technicians: [{ technician_id: 't2' }], jobs: { lifecycle_status: 'active' } }];
  const [v] = await listVisitsForRange('2026-10-01', '2026-10-31');
  assert.deepEqual(Object.keys(v).sort(), ['additionalTechnicianIds', 'createdAt', 'endTime', 'id', 'jobId', 'scheduledDate', 'sortOrder', 'startTime', 'status', 'technicianId']);
  assert.deepEqual(v.additionalTechnicianIds, ['t2']);
});

// ---- the extra source for the report queues ------------------------------------------------------------------------
test('REPORT QUEUES: closed-job work is found with one id lookup and then one narrow job read', async () => {
  server.rpc.jobs_with_open_report_work = { body: ['j9', 'j8'] };
  server.jobsRows = [];
  const rows = await listJobRowsWithOpenReportWork();
  assert.deepEqual(rows, []);
  const [rpc] = calls(/^POST \/rest\/v1\/rpc\/jobs_with_open_report_work$/);
  assert.ok(rpc, 'asks the database which closed jobs still have open report work');
  const [jobs] = calls(/^GET \/rest\/v1\/jobs$/);
  assert.match(jobs.search, /id=in\.\(j9,j8\)/, 'reads only those jobs');
  assert.doesNotMatch(jobs.search, /lifecycle_status=eq\.active/, 'not limited to active jobs');
  assert.match(jobs.search, /service_ends_on/, 'same columns as the normal job read, including the end date');
});

test('REPORT QUEUES: no closed job with open work means no second request at all', async () => {
  server.rpc.jobs_with_open_report_work = { body: [] };
  assert.deepEqual(await listJobRowsWithOpenReportWork(), []);
  assert.equal(calls(/^GET \/rest\/v1\/jobs$/).length, 0);
});

test('REPORT QUEUES: a failed lookup is an error, never a silently empty list', async () => {
  server.rpc.jobs_with_open_report_work = { status: 500, body: { message: 'boom' } };
  await assert.rejects(() => listJobRowsWithOpenReportWork(), /Failed to load open report work on closed jobs/);
});
