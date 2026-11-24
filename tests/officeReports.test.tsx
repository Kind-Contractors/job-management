// Office-written reports (Luke, Nov 2026): a manager ("Administrator") completes a visit and writes its report in one step - also for
// work done before the job was added to JMS (no visit yet). One database call (manager_complete_visit_with_report), saved already
// approved and marked "written by the office" with the real author. Guards are enforced by the database (this file checks the
// migration's text; its behaviour was also run on real Postgres - PGlite - and on DEV) and mirrored in the UI. Technician reporting
// is unchanged: a technician's later send for that visit is refused and ends cleanly.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { openDB } from 'idb';

import {
  completeVisitWithOfficeReport,
  getReportAuthorship,
  officeAuthorLabel,
  officeReportBlockedReason,
  officeReportFormError,
  technicianLockoutWarning,
  isDefiniteRefusal,
  OfficeReportOutcomeUnknownError,
} from '../src/repository/officeReportsRepository';
import OfficeReportForm from '../src/components/jobs/OfficeReportForm';
import VisitRow from '../src/components/jobs/VisitRow';
import { HISTORY_EVENT_LABEL } from '../src/lib/historyEventLabels';
import { AuthContext } from '../src/auth/AuthProvider';
import { setCurrentUserId } from '../src/auth/currentUser';
import { getDraft, listPhotosForVisit, putDraft, putPhoto } from '../src/technician/offline/db';
import { OFFICE_REPORT_EXISTS_MESSAGE, readSyncStatusForTests, resetUploadQueueStateForTests, runSyncSweepForTests, setTechnicianUploadDepsForTests } from '../src/technician/offline/syncEngine';

const online = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: online, configurable: true });
const noop = () => {};

// ---- fake server --------------------------------------------------------------------------------------------------------------------
interface Logged { method: string; path: string; body: any }
let log: Logged[] = [];
let rpc: Record<string, () => Response> = {};
let rows: Record<string, unknown> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  const path = decodeURIComponent(url.pathname);
  log.push({ method, path, body });
  const name = path.replace('/rest/v1/rpc/', '');
  if (path.startsWith('/rest/v1/rpc/') && rpc[name]) return rpc[name]();
  if (path === '/rest/v1/reports' && method === 'GET') return json(200, rows.report ?? {});
  return json(404, { message: `unexpected ${method} ${path}` });
}) as typeof fetch;
beforeEach(() => { log = []; rpc = {}; rows = {}; });

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const MIG = src('supabase', 'migrations', '20261124100000_manager_office_reports.sql');

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-11-20', status: 'booked', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id: 'job-1', buildingId: 'b1', buildingName: 'Acme House', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: 'Window cleaning', division: 'General', lifecycleStatus: 'active',
    serviceEndsOn: null, frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 55, yearlyValue: null, monthlyValue: null, nextDueLabel: '',
    status: 'booked', technician: 'Unassigned', defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null,
    recontactNotes: null, recontactIntervalMonths: null, street: '', postcode: 'AB1', buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: null, clientContacts: [],
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

// ---- repository ---------------------------------------------------------------------------------------------------------------------
test('SAVE: one database call with every field; the result says which visit and report (and whether the visit was new)', async () => {
  rpc.manager_complete_visit_with_report = () => json(200, { visit_id: 'v-new', report_id: 'r-1', visit_created: true });
  const r = await completeVisitWithOfficeReport({
    visitId: null, jobId: 'job-1', workDate: '2026-10-03', completedAt: '2026-10-03T15:00:00.000Z', priceCharged: 120, workCarriedOut: 'Window cleaning',
    technicianNotes: null, issues: 'Blocked gutter', specMet: false, onSiteStart: '2026-10-03T13:00:00.000Z', onSiteEnd: '2026-10-03T14:30:00.000Z',
    requestId: 'req-1',
  });
  assert.deepEqual(r, { visitId: 'v-new', reportId: 'r-1', visitCreated: true, replayed: false });
  const call = log.filter((l) => l.path === '/rest/v1/rpc/manager_complete_visit_with_report');
  assert.equal(call.length, 1, 'exactly one call - visit and report are saved together');
  assert.deepEqual(call[0].body, {
    p_visit_id: null, p_job_id: 'job-1', p_work_date: '2026-10-03', p_completed_at: '2026-10-03T15:00:00.000Z', p_price_charged: 120, p_work_carried_out: 'Window cleaning',
    p_technician_notes: null, p_issues: 'Blocked gutter', p_spec_met: false, p_on_site_start: '2026-10-03T13:00:00.000Z', p_on_site_end: '2026-10-03T14:30:00.000Z',
    p_request_id: 'req-1',
  });
  assert.equal(log.filter((l) => l.path === '/rest/v1/reports' || l.path === '/rest/v1/visits').length, 0, 'no separate visit/report writes from the app');
});

test('SAVE refused by the database: its message is shown as is (e.g. the visit already has a report)', async () => {
  rpc.manager_complete_visit_with_report = () => json(409, { code: '23505', message: 'This visit already has a report. Open it in Report review or Ready for client to check or edit it.' });
  await assert.rejects(
    completeVisitWithOfficeReport({ visitId: 'v1', jobId: null, workDate: null, completedAt: 'x', priceCharged: 1, workCarriedOut: null, technicianNotes: null, issues: null, specMet: true, onSiteStart: null, onSiteEnd: null, requestId: 'req-2' }),
    (e: Error) => /already has a report\. Open it in Report review/.test(e.message) && !(e instanceof OfficeReportOutcomeUnknownError),
  );
});

const SAVE_INPUT = { visitId: null, jobId: 'job-1', workDate: '2026-10-03', completedAt: '2026-10-03T15:00:00.000Z', priceCharged: 1, workCarriedOut: null, technicianNotes: null, issues: null, specMet: true, onSiteStart: null, onSiteEnd: null, requestId: 'req-3' };

test('SAVE replayed: the same request id answered with the ORIGINAL visit and report - reported as replayed', async () => {
  rpc.manager_complete_visit_with_report = () => json(200, { visit_id: 'v-1', report_id: 'r-1', visit_created: true, replayed: true });
  assert.deepEqual(await completeVisitWithOfficeReport(SAVE_INPUT), { visitId: 'v-1', reportId: 'r-1', visitCreated: true, replayed: true });
});

test('OUTCOME UNKNOWN: no reply (connection lost), a 5xx / gateway timeout, or an unreadable reply - never treated as "nothing saved"', async () => {
  const unknown = (e: unknown) => e instanceof OfficeReportOutcomeUnknownError && /couldn’t confirm whether the report was saved/.test((e as Error).message);
  rpc.manager_complete_visit_with_report = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(completeVisitWithOfficeReport(SAVE_INPUT), unknown, 'connection lost');
  rpc.manager_complete_visit_with_report = () => json(504, { message: 'upstream request timeout' });
  await assert.rejects(completeVisitWithOfficeReport(SAVE_INPUT), unknown, 'gateway timeout');
  rpc.manager_complete_visit_with_report = () => json(500, { code: '57014', message: 'canceling statement due to statement timeout' });
  await assert.rejects(completeVisitWithOfficeReport(SAVE_INPUT), unknown, 'server error');
  rpc.manager_complete_visit_with_report = () => json(200, {});
  await assert.rejects(completeVisitWithOfficeReport(SAVE_INPUT), unknown, 'unreadable reply');
  // ...whereas a 4xx is the server's own refusal: its transaction rolled back, so nothing was saved.
  rpc.manager_complete_visit_with_report = () => json(400, { code: '22023', message: 'The work can’t be recorded as done in the future.' });
  await assert.rejects(completeVisitWithOfficeReport(SAVE_INPUT), (e: unknown) => !(e instanceof OfficeReportOutcomeUnknownError) && /in the future/.test((e as Error).message));
  assert.deepEqual([0, 200, 399, 400, 404, 409, 499, 500, 502, 503, 504].map(isDefiniteRefusal), [false, false, false, true, true, true, true, false, false, false, false]);
});

test('MIGRATION (20261124120000): idempotent per request id - lock on the id first, replay only the caller\'s own for the same target, recorded in the same transaction', () => {
  const IDEM = src('supabase', 'migrations', '20261124120000_office_reports_idempotency.sql');
  const fn = IDEM.slice(IDEM.indexOf('create or replace function public.manager_complete_visit_with_report('));
  assert.match(IDEM, /drop function if exists public\.manager_complete_visit_with_report\(uuid, uuid, date, timestamptz, numeric, text, text, text, boolean, timestamptz, timestamptz\);/, 'one function, never two overloads');
  assert.match(fn, /p_on_site_end timestamptz,\n  p_request_id uuid default null\n\)/);
  assert.match(fn, /security invoker/);
  const lock = fn.indexOf("pg_advisory_xact_lock(hashtextextended('office-report-request:'");
  const lookup = fn.indexOf('from private.office_report_requests r');
  const firstWrite = fn.indexOf('insert into visits');
  assert.ok(lock > 0 && lock < lookup && lookup < firstWrite, 'lock, then look up, before anything is written');
  assert.match(fn, /v_prior\.created_by is distinct from auth\.uid\(\)/, 'only the caller\'s own request');
  assert.match(fn, /p_visit_id is not null and v_prior\.visit_id is distinct from p_visit_id/);
  assert.match(fn, /p_job_id is not null and v_prior\.job_id is distinct from p_job_id/);
  assert.match(fn, /'replayed', true\);\n    end if;\n  end if;/, 'a replay returns before any check or write');
  const record = fn.indexOf('insert into private.office_report_requests');
  assert.ok(record > fn.indexOf('insert into reports ('), 'recorded after (and in the same transaction as) the report');
  assert.match(fn, /exception when unique_violation then\n      raise exception 'This save was already used for a different report/);
  // The guards are all still there, unchanged.
  for (const guard of ['Not authorized.', 'in the future', 'This visit was cancelled', 'already has a report', 'more than one technician', 'already on an invoice', 'work can\'\'t be recorded on it here']) {
    assert.ok(fn.includes(guard), guard);
  }
  assert.match(IDEM, /create table if not exists private\.office_report_requests \(\n  request_id uuid primary key,/);
  assert.match(IDEM, /report_id uuid not null unique references public\.reports\(id\) on delete cascade/);
  assert.match(IDEM, /alter table private\.office_report_requests enable row level security;/);
  assert.match(IDEM, /revoke all on table private\.office_report_requests from public, anon, authenticated;\ngrant select, insert on table private\.office_report_requests to authenticated;/, 'no update / delete for anyone');
  assert.match(IDEM, /using \(private\.current_app_role\(\) = 'manager' and created_by = auth\.uid\(\)\)/);
  assert.match(IDEM, /with check \(private\.current_app_role\(\) = 'manager' and created_by = auth\.uid\(\)\)/);
  const RB = src('supabase', 'rollbacks', '20261124120000_office_reports_idempotency.rollback.sql');
  const FUT = src('supabase', 'migrations', '20261124110000_office_reports_no_future_completion.sql');
  assert.ok(RB.includes(FUT.slice(FUT.indexOf('create or replace function')).trimEnd()), 'the rollback restores the previous function word for word');
  assert.match(RB, /drop table if exists private\.office_report_requests;/);
  assert.doesNotMatch(RB, /delete from|drop table if exists public\./, 'no visit/report data touched');
});

test('ATTRIBUTION: "Written by the office · <who>" for Luke and Tamika; nothing for a technician\'s report or an old (unrecorded) one', async () => {
  assert.equal(officeAuthorLabel('manager', 'Luke'), 'Written by the office · Luke');
  assert.equal(officeAuthorLabel('manager', 'Tamika'), 'Written by the office · Tamika');
  assert.equal(officeAuthorLabel('technician', 'Mo'), null);
  assert.equal(officeAuthorLabel(null, 'ai@kindcontractors.co.uk'), null, 'reports from before the marker are never labelled');
  rows.report = { source: 'manager', submitted_by: 'Tamika' };
  assert.deepEqual(await getReportAuthorship('r-9'), { source: 'manager', submittedBy: 'Tamika' });
  rows.report = { submitted_by: 'Mo' };
  assert.deepEqual(await getReportAuthorship('r-8'), { source: null, submittedBy: 'Mo' });
});

test('WHEN IT IS OFFERED: not for a visit with a report, cancelled, more than one technician, or on an invoice (the database refuses these too)', () => {
  assert.equal(officeReportBlockedReason(visit('v')), null);
  assert.equal(officeReportBlockedReason(visit('v', { status: 'completed' })), null, 'completed with no report: write the report');
  assert.match(officeReportBlockedReason(visit('v', { reportId: 'r' }))!, /already has a report.*Report review/);
  assert.match(officeReportBlockedReason(visit('v', { status: 'cancelled' }))!, /cancelled/);
  assert.match(officeReportBlockedReason(visit('v', { additionalTechnicians: [{ technicianId: 't2', name: 'B', contribution: 'pending' }] }))!, /more than one technician/);
  assert.match(officeReportBlockedReason(visit('v', { invoiceId: 'inv' }))!, /invoice/);
});

test('TECHNICIAN WARNING: none if unassigned; strong for today or a later visit; always says they can\'t submit and a phone draft won\'t be sent', () => {
  assert.equal(technicianLockoutWarning(visit('v'), '2026-11-24'), null);
  const today = technicianLockoutWarning(visit('v', { technicianId: 't', technicianName: 'Mo', scheduledDate: '2026-11-24' }), '2026-11-24')!;
  assert.equal(today.strong, true);
  assert.match(today.text, /^This visit is today\. Mo won’t be able to submit their own report for this visit/);
  assert.match(today.text, /completed one on their phone, it won’t be sent — it stays on their phone, marked as not sent/);
  const later = technicianLockoutWarning(visit('v', { technicianId: 't', technicianName: 'Mo', scheduledDate: '2026-12-01' }), '2026-11-24')!;
  assert.equal(later.strong, true);
  assert.match(later.text, /still to come/);
  const past = technicianLockoutWarning(visit('v', { technicianId: 't', technicianName: 'Mo', scheduledDate: '2026-11-01' }), '2026-11-24')!;
  assert.equal(past.strong, false);
  assert.match(past.text, /^Mo won’t be able to submit/);
});

test('FORM CHECKS: date (no visit), time, price (incl. 0 allowed, negative not), on-site times both-or-neither and in order', () => {
  const ok = { needsWorkDate: true, workDate: '2026-10-03', completedAt: '2026-10-03T15:00', price: '55', onSiteStart: '', onSiteEnd: '' };
  assert.equal(officeReportFormError(ok), null);
  assert.match(officeReportFormError({ ...ok, workDate: '' })!, /date the work was done/);
  assert.match(officeReportFormError({ ...ok, completedAt: '' })!, /when the work was done/);
  assert.match(officeReportFormError({ ...ok, price: '' })!, /price charged/);
  assert.match(officeReportFormError({ ...ok, price: '-1' })!, /price charged/);
  assert.equal(officeReportFormError({ ...ok, price: '0' }), null);
  assert.match(officeReportFormError({ ...ok, onSiteStart: '09:00' })!, /both on-site times, or neither/);
  assert.match(officeReportFormError({ ...ok, onSiteStart: '10:00', onSiteEnd: '09:00' })!, /end time is before/);
  assert.equal(officeReportFormError({ ...ok, needsWorkDate: false, workDate: '' }), null);
});

test('NOT IN THE FUTURE: a completion time ahead of now is refused (2-minute allowance); an already completed visit is not checked', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const base = { needsWorkDate: false, workDate: '', price: '40', onSiteStart: '', onSiteEnd: '' };
  assert.match(officeReportFormError({ ...base, completedAt: '2026-11-24T15:00:00Z' }, now)!, /can’t be recorded as done in the future/);
  assert.match(officeReportFormError({ ...base, completedAt: '2026-11-25T09:00:00Z' }, now)!, /in the future/, 'a later day too');
  assert.equal(officeReportFormError({ ...base, completedAt: '2026-11-24T12:01:30Z' }, now), null, 'within the clock allowance');
  assert.equal(officeReportFormError({ ...base, completedAt: '2026-11-24T11:00:00Z' }, now), null, 'earlier today');
  assert.equal(officeReportFormError({ ...base, completedAt: null }, now), null, 'already completed: its recorded time is kept, nothing to check');
});

test('MIGRATION (follow-up 20261124110000): the function refuses a future completion time where it uses it - nothing else changes', () => {
  const FUT = src('supabase', 'migrations', '20261124110000_office_reports_no_future_completion.sql');
  const fn = FUT.slice(FUT.indexOf('create or replace function public.manager_complete_visit_with_report('));
  assert.match(fn, /if p_completed_at > now\(\) \+ interval '2 minutes' or p_work_date > \(now\(\) at time zone 'Europe\/London'\)::date then\s+raise exception 'The work can''t be recorded as done in the future\.'/, 'new visit (work already done)');
  assert.match(fn, /if not v_created and not v_was_completed and p_completed_at > now\(\) \+ interval '2 minutes' then\s+raise exception 'The work can''t be recorded as done in the future\.'/, 'an open visit being completed');
  // identical to the first definition apart from those two checks
  const ORIG = MIG.slice(MIG.indexOf('create or replace function public.manager_complete_visit_with_report('));
  const strip = (s: string) => s.replace(/\n    if p_completed_at > now\(\)[\s\S]*?end if;/, '').replace(/\n  if not v_created and not v_was_completed and p_completed_at[\s\S]*?end if;/, '');
  assert.equal(strip(fn), ORIG);
  assert.doesNotMatch(FUT, /alter table|reports_set_source|technician_submit_report/, 'only the office-report function');
  const RB = src('supabase', 'rollbacks', '20261124110000_office_reports_no_future_completion.rollback.sql');
  assert.ok(RB.includes(ORIG), 'the rollback restores the first definition exactly');
});

// ---- UI ------------------------------------------------------------------------------------------------------------------------------
const formProps = { formId: 'f', locked: false, onSubmit: noop, onError: noop };

test('FORM (no visit): work already done - date, time, price prefilled, work defaulting to the job summary, spec, optional on-site times', () => {
  const html = wrap(<OfficeReportForm job={job([])} visit={null} {...formProps} />);
  assert.match(html, /Date the work was done/);
  assert.match(html, /Finished at/);
  assert.match(html, /value="55"/, 'fixed price prefilled');
  assert.match(html, />Window cleaning<\/textarea>/);
  assert.match(html, /Everything as specified/);
  assert.match(html, /Something not done/);
  assert.match(html, /On site from \(optional\)/);
  assert.doesNotMatch(html, /office-report-technician-warning/);
});

test('FORM (assigned visit, today): the strong technician warning is shown; variable-price job asks for the amount', () => {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const html = wrap(<OfficeReportForm job={job([], { pricePerVisit: null })} visit={visit('v1', { technicianId: 't', technicianName: 'Mo', scheduledDate: iso })} {...formProps} />);
  assert.match(html, /Date done/);
  assert.match(html, /data-testid="office-report-technician-warning" class="[^"]*border-missed/);
  assert.match(html, /This visit is today\. Mo won’t be able to submit/);
  assert.match(html, /variable job — enter actual amount/);
});

test('FORM (completed visit, no report): recorded price and time kept, not asked again', () => {
  const html = wrap(<OfficeReportForm job={job([])} visit={visit('v1', { status: 'completed', priceCharged: 30, completedAt: '2026-11-01T12:00:00Z' })} {...formProps} />);
  assert.match(html, /£30 — kept as recorded/);
  assert.doesNotMatch(html, /Price charged/);
});

test('VISIT ROW: the office report actions are gone (they live in the All live jobs Actions column); the other visit actions are unchanged', () => {
  const booked = wrap(<VisitRow job={job([])} visit={visit('v1')} actor="luke@x" technicians={[]} />);
  assert.doesNotMatch(booked, /Complete &amp; write report/);
  assert.match(booked, /Mark complete/);
  assert.match(booked, /Mark missed/);
  assert.match(booked, /Cancel…/);
  assert.doesNotMatch(booked, /office-report-form/);
  const completed = wrap(<VisitRow job={job([])} visit={visit('v2', { status: 'completed', priceCharged: 30, completedAt: '2026-11-01T12:00:00Z' })} actor="luke@x" technicians={[]} />);
  assert.doesNotMatch(completed, />Write report</);
  assert.doesNotMatch(completed, /Create report/);
  assert.match(completed, /No report yet\./);
  const multi = wrap(<VisitRow job={job([])} visit={visit('v3', { additionalTechnicians: [{ technicianId: 't2', name: 'B', contribution: 'pending' }] })} actor="luke@x" technicians={[]} />);
  assert.doesNotMatch(multi, /isn’t available/);
});

test('VISIT ROW with a report: "Written by the office · Tamika" next to the status - nothing for a technician\'s report', () => {
  const v = visit('v4', { status: 'completed', reportId: 'r-4', reportReviewStatus: 'approved', priceCharged: 30, completedAt: '2026-11-01T12:00:00Z' });
  const office = wrap(<VisitRow job={job([])} visit={v} actor="x" technicians={[]} />, (qc) => qc.setQueryData(['reportAuthorship', 'r-4'], { source: 'manager', submittedBy: 'Tamika' }));
  assert.match(office, /data-testid="office-author">· Written by the office · Tamika</);
  const tech = wrap(<VisitRow job={job([])} visit={v} actor="x" technicians={[]} />, (qc) => qc.setQueryData(['reportAuthorship', 'r-4'], { source: 'technician', submittedBy: 'Mo' }));
  assert.doesNotMatch(tech, /Written by the office/);
});

test('HISTORY labels: the office report and the older manager-created report read in plain words', () => {
  assert.equal(HISTORY_EVENT_LABEL.report_written_by_office, 'Report written by the office');
  assert.equal(HISTORY_EVENT_LABEL.report_created, 'Report created by the office');
});

// ---- the migration (behaviour also run on real Postgres + DEV) -------------------------------------------------------------------------
test('MIGRATION: managers only, one transaction, the technician lock, every guard - and auto-approved, attributed to the caller', () => {
  const fn = MIG.slice(MIG.indexOf('create or replace function public.manager_complete_visit_with_report('));
  assert.match(fn, /security invoker/);
  assert.match(fn, /if private\.current_app_role\(\) is distinct from 'manager' then\s+raise exception 'Not authorized\.'/);
  assert.match(fn, /v_actor := private\.current_manager_label\(\);/);
  assert.match(fn, /perform pg_advisory_xact_lock\(hashtextextended\('report:' \|\| v_visit_id::text, 0\)\);/, 'the same lock as a technician\'s submit');
  for (const guard of [/if v_visit_status = 'cancelled' then/, /if exists \(select 1 from reports r where r\.visit_id = v_visit_id\) then/, /if exists \(select 1 from visit_technicians vt where vt\.visit_id = v_visit_id\) then/, /if exists \(select 1 from invoice_line_items il where il\.visit_id = v_visit_id\) then/, /if v_job_status not in \('active', 'on_hold'\) then/]) {
    assert.match(fn, guard);
  }
  assert.match(fn, /'approved', v_actor, now\(\)/, 'saved approved, reviewed by the same manager');
  assert.match(MIG, /revoke all on function public\.manager_complete_visit_with_report\([^)]*\)\s+from public, anon;/);
  assert.doesNotMatch(MIG, /technician_submit_report|technician_resubmit_report|recompose_report/, 'technician reporting is not touched');
});

test('MIGRATION: reports.source is set by the database from the role, never changed, and old reports stay unrecorded (no backfill)', () => {
  assert.match(MIG, /alter table public\.reports add column if not exists source text;/);
  assert.doesNotMatch(MIG, /source text not null|set default|update public\.reports/i, 'no default and no backfill: existing reports keep NULL');
  assert.match(MIG, /new\.source := case private\.current_app_role\(\) when 'manager' then 'manager' when 'technician' then 'technician' else null end;/);
  assert.match(MIG, /else\s+new\.source := old\.source;/);
  assert.match(MIG, /before insert or update on public\.reports/);
  assert.ok(src('supabase', 'rollbacks', '20261124100000_manager_office_reports.rollback.sql').includes('drop column if exists source'));
});

// ---- the technician side ---------------------------------------------------------------------------------------------------------------
const OWNER = 'tech-owner';
async function technicianWithCompletedReport(visitId: string) {
  setCurrentUserId(OWNER);
  resetUploadQueueStateForTests();
  await listPhotosForVisit(OWNER, 'none');
  const db = await openDB('kind-contractors-technician-offline');
  await db.clear('pendingPhotos');
  await db.clear('draftReports');
  db.close();
  await putDraft({ ownerId: OWNER, visitId, mode: 'submit', reportId: null, workCarriedOut: 'Cleaned all windows', technicianNotes: null, issues: 'Ladder access poor', onSiteStart: '2026-11-24T08:00:00Z', onSiteEnd: '2026-11-24T09:00:00Z', specMet: true, readyToSubmit: true, submitting: false, submitError: null, updatedAt: '2026-11-24T09:00:00Z' });
  await putPhoto({ id: `${visitId}-p1`, ownerId: OWNER, visitId, phase: 'after', blob: new Blob([new Uint8Array(10).fill(7)], { type: 'image/jpeg' }), storagePath: `${visitId}/after/p1.jpg`, status: 'uploaded', lastError: null, createdAt: '2026-11-24T08:30:00Z' });
  rpc.technician_submit_report = () => json(400, { code: 'P0001', message: 'A report already exists for this visit.' });
}
const submits = () => log.filter((l) => l.path === '/rest/v1/rpc/technician_submit_report').length;

test('TECHNICIAN: the office already wrote the report - their send is refused, but the draft and photos are KEPT, marked "can\'t be sent" with the reason, never retried', async () => {
  await technicianWithCompletedReport('v-office');
  setTechnicianUploadDepsForTests({
    // what the server holds for the visit: the OFFICE's report (different text, none of this phone's photos)
    fetchMyServerReport: async () => ({ reportId: 'r-office', reviewStatus: 'approved', workCarriedOut: 'Window cleaning', technicianNotes: null, issues: null, specMet: true, photoPaths: [] }),
  });
  await runSyncSweepForTests();
  assert.equal(submits(), 1, 'tried once');
  const kept = await getDraft(OWNER, 'v-office');
  assert.ok(kept, 'the draft is kept on the phone');
  assert.equal(kept!.permanentFailure, true);
  assert.equal(kept!.submitError, OFFICE_REPORT_EXISTS_MESSAGE);
  assert.match(OFFICE_REPORT_EXISTS_MESSAGE, /office has already written the report.*can’t be sent.*kept on this phone/);
  assert.equal(kept!.workCarriedOut, 'Cleaned all windows', 'the technician\'s text is intact');
  const photos = await listPhotosForVisit(OWNER, 'v-office');
  assert.equal(photos.length, 1, 'their photo is kept');
  assert.deepEqual(new Uint8Array(await photos[0].blob.arrayBuffer()), new Uint8Array(10).fill(7));
  assert.equal((await readSyncStatusForTests()).failedDraftCount, 1, 'shown as a report that was not sent (honest)');
  await runSyncSweepForTests(true);
  await runSyncSweepForTests(true);
  assert.equal(submits(), 1, 'never retried');
  setTechnicianUploadDepsForTests(null);
});

test('TECHNICIAN: their OWN earlier send that did arrive (reply lost) is still recognised and cleared, exactly as before', async () => {
  await technicianWithCompletedReport('v-own');
  setTechnicianUploadDepsForTests({
    fetchMyServerReport: async () => ({ reportId: 'r-own', reviewStatus: 'awaiting_review', workCarriedOut: 'Cleaned all windows', technicianNotes: null, issues: 'Ladder access poor', specMet: true, photoPaths: ['v-own/after/p1.jpg'] }),
  });
  await runSyncSweepForTests();
  assert.equal(await getDraft(OWNER, 'v-own'), undefined, 'cleared: the server holds exactly this report');
  assert.equal((await listPhotosForVisit(OWNER, 'v-own')).length, 0);
  assert.equal((await readSyncStatusForTests()).failedDraftCount, 0);
  setTechnicianUploadDepsForTests(null);
});

test('TECHNICIAN: if that check can\'t be made (no answer), nothing is discarded - the draft is kept', async () => {
  await technicianWithCompletedReport('v-unknown');
  setTechnicianUploadDepsForTests({ fetchMyServerReport: async () => { throw new TypeError('Failed to fetch'); } });
  await runSyncSweepForTests();
  const kept = await getDraft(OWNER, 'v-unknown');
  assert.ok(kept && kept.permanentFailure, 'kept');
  assert.equal((await listPhotosForVisit(OWNER, 'v-unknown')).length, 1);
  setTechnicianUploadDepsForTests(null);
});
