// Data-layer tests for Activities: creating / editing / cancelling / moving an activity, the combined day order,
// optional times on jobs, and the technician API (merged Today list, mark done / undo, isolation).
// The real repository and API code runs unchanged; only the network is replaced by a small fake Supabase server
// that records every request, so what is SENT (and what is never sent) can be asserted.
//
// The permission rules themselves (a technician sees only their own, nobody else's, no unassigned; done only for
// today or earlier; the manager-only table) live in the database and are tested there - see the Activities migrations.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { cancelActivity, createActivity, listActivitiesForRange, moveActivity, updateActivity } from '../src/repository/activitiesRepository';
import { createVisit, saveDayItemOrder, setDayOrder, setVisitTimeRange } from '../src/repository/techniciansRepository';
import { listPastVisits, listTodayItems, setActivityDone } from '../src/technician/api';
import { mergeDayItems } from '../src/lib/dayItems';
import type { ScheduleActivity, WeekVisit } from '../src/domain/types';

// ---- a tiny fake Supabase REST server --------------------------------------------------------
interface Logged { method: string; path: string; search: string; body: any }
const server = {
  log: [] as Logged[],
  activityRows: [] as any[],
  rpc: {} as Record<string, (body: any) => { status: number; body?: unknown }>,
  failNext: null as null | { match: RegExp; status: number; body: unknown },
};
function reset() {
  server.log = [];
  server.activityRows = [];
  server.rpc = {};
  server.failNext = null;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(url.pathname);
  const headers = new Headers(init?.headers);
  const body = init?.body ? JSON.parse(init.body) : undefined;
  server.log.push({ method, path, search: decodeURIComponent(url.search), body });

  if (server.failNext && server.failNext.match.test(`${method} ${path}${url.search}`)) {
    const f = server.failNext;
    server.failNext = null;
    return json(f.status, f.body);
  }
  const wantsObject = (headers.get('accept') ?? '').includes('vnd.pgrst.object');

  if (path === '/rest/v1/activities' && method === 'GET') return json(200, server.activityRows);
  if (path === '/rest/v1/activities' && method === 'POST') {
    const row = { id: 'act-new', sort_order: null, created_at: '2026-10-06T08:00:00Z', done_at: null, cancelled_at: null, ...body };
    return json(201, wantsObject ? row : [row]);
  }
  if (method === 'PATCH') return new Response(null, { status: 204 });
  if (path === '/rest/v1/visits' && method === 'POST') return json(201, wantsObject ? { id: 'visit-new' } : [{ id: 'visit-new' }]);
  if (path === '/rest/v1/activity_events' && method === 'POST') return new Response(null, { status: 201 });
  const rpcMatch = /^\/rest\/v1\/rpc\/(.+)$/.exec(path);
  if (rpcMatch && method === 'POST') {
    const handler = server.rpc[rpcMatch[1]];
    if (!handler) return json(404, { code: 'PGRST202', message: `Could not find the function public.${rpcMatch[1]} in the schema cache` });
    const r = handler(body);
    return r.body === undefined ? new Response(null, { status: r.status }) : json(r.status, r.body);
  }
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;

beforeEach(reset);

const calls = (re: RegExp) => server.log.filter((l) => re.test(`${l.method} ${l.path}`));
const ok = (body?: unknown) => ({ status: body === undefined ? 204 : 200, body });

// ---- reading activities ------------------------------------------------------------------------
test('activities for a range are read with the same inclusive date filters as visits, and mapped (times normalised, order numeric)', async () => {
  server.activityRows = [
    { id: 'a1', description: 'Pick up keys', scheduled_date: '2026-10-06', technician_id: 'mo', location: 'Office', notes: null, start_time: '08:30:00', end_time: '09:00:00', sort_order: '1', created_at: 'c', done_at: null, cancelled_at: null },
    { id: 'a2', description: 'Quote', scheduled_date: '2026-10-07', technician_id: null, location: null, notes: 'ring first', start_time: null, end_time: null, sort_order: null, created_at: 'c', done_at: 'd', cancelled_at: null },
  ];
  const result = await listActivitiesForRange('2026-10-05', '2026-10-10');
  const [get] = calls(/^GET \/rest\/v1\/activities$/);
  assert.match(get.search, /scheduled_date=gte\.2026-10-05/);
  assert.match(get.search, /scheduled_date=lte\.2026-10-10/);
  assert.deepEqual(result[0], {
    id: 'a1', description: 'Pick up keys', scheduledDate: '2026-10-06', technicianId: 'mo', location: 'Office', notes: null,
    startTime: '08:30', endTime: '09:00', sortOrder: 1, createdAt: 'c', doneAt: null, cancelledAt: null,
  });
  assert.equal(result[1].technicianId, null, 'an unassigned activity stays unassigned');
  assert.equal(result[1].startTime, null);
  assert.equal(result[1].sortOrder, null);
  assert.equal(result[1].doneAt, 'd');
});

test('a failed read says so (the schedule treats it as "no activities", never as a crash)', async () => {
  server.failNext = { match: /GET \/rest\/v1\/activities/, status: 500, body: { message: 'boom' } };
  await assert.rejects(listActivitiesForRange('2026-10-05', '2026-10-10'), /Failed to load activities: boom/);
});

// ---- creating ----------------------------------------------------------------------------------------
test('creating an activity sends only the activity table: trimmed description, blanks as null, unassigned as null', async () => {
  await createActivity({ description: '  Pick up keys  ', scheduledDate: '2026-10-06', technicianId: null, location: '   ', notes: '' });
  const [post] = calls(/^POST \/rest\/v1\/activities$/);
  assert.deepEqual(post.body, {
    description: 'Pick up keys', scheduled_date: '2026-10-06', technician_id: null, location: null, notes: null, start_time: null, end_time: null,
  });
  assert.equal(calls(/\/rest\/v1\/(visits|reports|invoices|photos)/).length, 0, 'it never touches the job / report / invoice tables');
  assert.equal(server.log.some((l) => 'sort_order' in (l.body ?? {})), false, 'a new activity starts unordered');
});

test('a created activity with an assignee, location, notes and a start-only time is sent as given', async () => {
  const created = await createActivity({ description: 'Quote at Oak Court', scheduledDate: '2026-10-06', technicianId: 'mo', location: 'Oak Court', notes: 'Ask for Sam', startTime: '10:00' });
  const [post] = calls(/^POST \/rest\/v1\/activities$/);
  assert.equal(post.body.technician_id, 'mo');
  assert.equal(post.body.location, 'Oak Court');
  assert.equal(post.body.notes, 'Ask for Sam');
  assert.equal(post.body.start_time, '10:00');
  assert.equal(post.body.end_time, null);
  assert.equal(created.id, 'act-new');
  assert.equal(created.startTime, '10:00');
});

test('a time range is sent as start + end; an end WITHOUT a start is never sent', async () => {
  await createActivity({ description: 'Meeting', scheduledDate: '2026-10-06', technicianId: 'mo', startTime: '11:00', endTime: '12:00' });
  await createActivity({ description: 'Orphan end', scheduledDate: '2026-10-06', technicianId: 'mo', startTime: '', endTime: '12:00' });
  const [range, orphan] = calls(/^POST \/rest\/v1\/activities$/);
  assert.deepEqual([range.body.start_time, range.body.end_time], ['11:00', '12:00']);
  assert.deepEqual([orphan.body.start_time, orphan.body.end_time], [null, null]);
});

test('a refused create surfaces the database message', async () => {
  server.failNext = { match: /POST \/rest\/v1\/activities/, status: 400, body: { code: 'P0001', message: 'Cannot assign this activity to an inactive technician.' } };
  await assert.rejects(createActivity({ description: 'x', scheduledDate: '2026-10-06', technicianId: 'gone' }), /inactive technician/);
});

// ---- editing / reassigning / rescheduling -----------------------------------------------------------------
test('editing saves every editable field in ONE update of that activity (including leaving it unassigned and clearing the time)', async () => {
  await updateActivity('act-1', { description: ' Renamed ', scheduledDate: '2026-10-08', technicianId: null, location: 'New place', notes: '', startTime: '', endTime: '' });
  const patches = calls(/^PATCH /);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, '/rest/v1/activities');
  assert.match(patches[0].search, /id=eq\.act-1/);
  assert.deepEqual(patches[0].body, {
    description: 'Renamed', scheduled_date: '2026-10-08', technician_id: null, location: 'New place', notes: null, start_time: null, end_time: null,
  });
});

test('dragging an activity changes its date and/or assignee in ONE update and keeps everything else (so its time is retained)', async () => {
  await moveActivity('act-1', { scheduledDate: '2026-10-09' });
  await moveActivity('act-1', { technicianId: 't1' });
  await moveActivity('act-1', { scheduledDate: '2026-10-10', technicianId: null });
  await moveActivity('act-1', {});
  const patches = calls(/^PATCH /);
  assert.equal(patches.length, 3, 'an empty change sends nothing');
  assert.deepEqual(patches[0].body, { scheduled_date: '2026-10-09' });
  assert.deepEqual(patches[1].body, { technician_id: 't1' });
  assert.deepEqual(patches[2].body, { scheduled_date: '2026-10-10', technician_id: null });
  for (const p of patches) assert.equal('start_time' in p.body || 'end_time' in p.body || 'sort_order' in p.body, false, 'the time and order are never part of a move');
});

// ---- cancelling ---------------------------------------------------------------------------------------------
test('cancelling sets cancelled_at on a live activity and NEVER deletes anything', async () => {
  await cancelActivity('act-1');
  const [patch] = calls(/^PATCH /);
  assert.match(patch.search, /id=eq\.act-1/);
  assert.match(patch.search, /cancelled_at=is\.null/, 'only a live activity is cancelled');
  assert.deepEqual(Object.keys(patch.body), ['cancelled_at']);
  assert.ok(!Number.isNaN(Date.parse(patch.body.cancelled_at)));
  assert.equal(server.log.some((l) => l.method === 'DELETE'), false, 'activities are never hard-deleted');
});

// ---- the combined day order ----------------------------------------------------------------------------------
const wv = (id: string, over: Partial<WeekVisit> = {}): WeekVisit => ({
  id, jobId: `j-${id}`, technicianId: 'mo', additionalTechnicianIds: [], sortOrder: null, createdAt: '2026-10-06T08:00:00Z', scheduledDate: '2026-10-06', status: 'booked', startTime: null, endTime: null, ...over,
});
const sa = (id: string, over: Partial<ScheduleActivity> = {}): ScheduleActivity => ({
  id, description: id, scheduledDate: '2026-10-06', technicianId: 'mo', location: null, notes: null, startTime: null, endTime: null, sortOrder: null, createdAt: '2026-10-06T08:00:00Z', doneAt: null, cancelledAt: null, ...over,
});

test('the whole day (jobs and activities) is saved in one set_day_order call: date, then [{kind,id}] in order', async () => {
  server.rpc.set_day_order = () => ok();
  const items = mergeDayItems([wv('v1', { sortOrder: 2 })], [sa('a1', { sortOrder: 1 })]);
  await setDayOrder('2026-10-06', items);
  const [rpc] = calls(/rpc\/set_day_order$/);
  assert.deepEqual(rpc.body, { p_date: '2026-10-06', p_items: [{ kind: 'activity', id: 'a1' }, { kind: 'visit', id: 'v1' }] });
});

test('a day with an activity is saved with set_day_order; a jobs-only day still uses the ORIGINAL set_visit_order', async () => {
  server.rpc.set_day_order = () => ok();
  server.rpc.set_visit_order = () => ok();
  await saveDayItemOrder('2026-10-06', mergeDayItems([wv('v1'), wv('v2')], [sa('a1')]));
  await saveDayItemOrder('2026-10-06', mergeDayItems([wv('v2', { sortOrder: 1 }), wv('v1', { sortOrder: 2 })], []));
  assert.equal(calls(/rpc\/set_day_order$/).length, 1);
  const [visitOnly] = calls(/rpc\/set_visit_order$/);
  assert.deepEqual(visitOnly.body, { p_visit_ids: ['v2', 'v1'] }, 'existing manual visit ordering is unchanged');
});

test('a stale day (something was added meanwhile) is refused with the database message, so the screen can refresh', async () => {
  server.rpc.set_day_order = () => ({ status: 400, body: { code: 'P0001', message: 'The day has changed since it was loaded. Refresh and try again.' } });
  await assert.rejects(setDayOrder('2026-10-06', mergeDayItems([wv('v1')], [sa('a1')])), /The day has changed since it was loaded/);
});

// ---- optional time on a job -------------------------------------------------------------------------------------------
test('booking a job WITHOUT a time sends exactly the original insert (no time columns); with a start + end it adds them', async () => {
  await createVisit('job-1', 'mo', '2026-10-06');
  await createVisit('job-1', 'mo', '2026-10-06', [], { startTime: '09:00', endTime: '11:00' });
  const [plain, timed] = calls(/^POST \/rest\/v1\/visits$/);
  assert.deepEqual(plain.body, { job_id: 'job-1', technician_id: 'mo', scheduled_date: '2026-10-06', status: 'booked' });
  assert.deepEqual(timed.body, { job_id: 'job-1', technician_id: 'mo', scheduled_date: '2026-10-06', status: 'booked', start_time: '09:00', end_time: '11:00' });
});

test('booking a multi-technician job with a time books atomically first, then saves the time on that one visit', async () => {
  server.rpc.create_visit_with_technicians = () => ok('visit-multi');
  await createVisit('job-1', 'mo', '2026-10-06', ['t1'], { startTime: '08:00' });
  const rpc = calls(/rpc\/create_visit_with_technicians$/);
  assert.equal(rpc.length, 1);
  assert.equal('start_time' in rpc[0].body, false, 'the existing atomic function is not changed');
  const [patch] = calls(/^PATCH \/rest\/v1\/visits$/);
  assert.match(patch.search, /id=eq\.visit-multi/);
  assert.deepEqual(patch.body, { start_time: '08:00', end_time: null });
});

test('if only the time could not be saved after the booking, the message says the visit WAS booked', async () => {
  server.rpc.create_visit_with_technicians = () => ok('visit-multi');
  server.failNext = { match: /PATCH \/rest\/v1\/visits/, status: 400, body: { message: 'nope' } };
  await assert.rejects(createVisit('job-1', 'mo', '2026-10-06', ['t1'], { startTime: '08:00' }), /visit was booked, but its time could not be saved/);
});

test('setting or clearing a job time updates only that visit\'s two time columns; an end without a start is never stored', async () => {
  await setVisitTimeRange('v1', '09:00', '10:00');
  await setVisitTimeRange('v1', null, null);
  await setVisitTimeRange('v1', '', '10:00');
  const patches = calls(/^PATCH \/rest\/v1\/visits$/);
  assert.deepEqual(patches.map((p) => p.body), [
    { start_time: '09:00', end_time: '10:00' },
    { start_time: null, end_time: null },
    { start_time: null, end_time: null },
  ]);
  for (const p of patches) assert.equal('sort_order' in p.body, false, 'a time never touches the order');
});

// ---- the technician's merged Today list ----------------------------------------------------------------------------------
const dayRow = (over: Record<string, unknown>) => ({
  item_kind: 'visit', item_id: 'x', day_position: 1, scheduled_date: '2026-10-06', start_time: null, end_time: null, visit_status: null, job_id: null, job_summary: null,
  job_type: null, building_name: null, building_address: null, building_postcode: null, report_submitted: null, description: null, location: null, notes: null, done: null, ...over,
});

test('the merged Today list keeps the database order and maps both kinds, with times and the done flag', async () => {
  server.rpc.technician_shared_visits = () => ok([{ visit_id: 'v-shared', assigned_count: 2 }]);
  server.rpc.technician_day_items = () =>
    ok([
      dayRow({ item_kind: 'visit', item_id: 'v-shared', day_position: 3, visit_status: 'booked', job_id: 'j2', job_summary: 'Gutters', job_type: 'general', building_name: 'Oak Court', building_address: '2 High St', report_submitted: false }),
      dayRow({ item_kind: 'activity', item_id: 'a-keys', day_position: 1, start_time: '08:30:00', end_time: '09:00:00', description: 'Pick up keys', location: 'Office', notes: 'Ask Sam', done: true }),
      dayRow({ item_kind: 'visit', item_id: 'v-solo', day_position: 2, visit_status: 'booked', job_id: 'j1', job_summary: 'Windows', job_type: 'specialist', building_name: null, building_address: '1 Low Rd', start_time: '09:30:00', report_submitted: true }),
    ]);
  const items = await listTodayItems();
  assert.deepEqual(items.map((i) => (i.kind === 'visit' ? i.visitId : i.activityId)), ['a-keys', 'v-solo', 'v-shared'], 'rendered in the order the database gave');
  assert.deepEqual(items[0], { kind: 'activity', activityId: 'a-keys', scheduledDate: '2026-10-06', startTime: '08:30', endTime: '09:00', description: 'Pick up keys', location: 'Office', notes: 'Ask Sam', done: true });
  const solo = items[1] as any;
  assert.equal(solo.kind, 'visit');
  assert.equal(solo.startTime, '09:30');
  assert.equal(solo.endTime, null);
  assert.equal(solo.reportSubmitted, true);
  assert.equal(solo.assignedCount, 1);
  assert.equal((items[2] as any).assignedCount, 2, 'shared-visit counts still apply to jobs');
});

test('ISOLATION: the technician app reads their day ONLY through the function - never the activities table', async () => {
  server.rpc.technician_shared_visits = () => ok([]);
  server.rpc.technician_day_items = () => ok([]);
  await listTodayItems();
  assert.equal(calls(/\/rest\/v1\/activities/).length, 0, 'no direct read of the manager-only table');
  assert.deepEqual(
    server.log.map((l) => l.path).sort(),
    ['/rest/v1/rpc/technician_day_items', '/rest/v1/rpc/technician_shared_visits'],
  );
});

test('Past (and Needs correction) never involve activities: the Past list reads only its own function', async () => {
  server.rpc.technician_shared_visits = () => ok([]);
  server.rpc.technician_past_visits = () => ok([]);
  await listPastVisits();
  assert.equal(calls(/technician_day_items/).length, 0);
  assert.equal(calls(/\/rest\/v1\/activities/).length, 0);
});

test('if the database function is not there yet, the technician still gets their jobs (older database, newer app)', async () => {
  server.rpc.technician_shared_visits = () => ok([]);
  server.rpc.technician_today_visits = () =>
    ok([{ visit_id: 'v1', scheduled_date: '2026-10-06', visit_status: 'booked', job_id: 'j1', job_summary: 'Windows', job_type: 'general', building_name: 'Flair', building_address: '1 High St', building_postcode: null, report_submitted: false }]);
  const items = await listTodayItems(); // technician_day_items is missing -> PGRST202 from the fake server
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'visit');
  assert.equal((items[0] as any).startTime, null);
});

test('any other failure of the merged list is reported, not silently swapped for the job-only list', async () => {
  server.rpc.technician_shared_visits = () => ok([]);
  server.rpc.technician_day_items = () => ({ status: 500, body: { code: 'XX000', message: 'database exploded' } });
  await assert.rejects(listTodayItems(), /Failed to load today's items: database exploded/);
});

// ---- mark done / undo --------------------------------------------------------------------------------------------------------
test('mark done and undo call the one function with the activity id and the wanted state', async () => {
  server.rpc.technician_set_activity_done = () => ok();
  await setActivityDone('a-keys', true);
  await setActivityDone('a-keys', false);
  const sent = calls(/rpc\/technician_set_activity_done$/).map((c) => c.body);
  assert.deepEqual(sent, [{ p_activity_id: 'a-keys', p_done: true }, { p_activity_id: 'a-keys', p_done: false }]);
  assert.equal(calls(/\/rest\/v1\/(activities|visits|reports)/).length, 0, 'marking done touches nothing in the job workflow');
});

test('when the database refuses (not yours, not due yet, cancelled) the reason reaches the technician', async () => {
  server.rpc.technician_set_activity_done = () => ({ status: 400, body: { code: 'P0001', message: 'This activity is not due yet.' } });
  await assert.rejects(setActivityDone('a-future', true), /not due yet/);
  server.rpc.technician_set_activity_done = () => ({ status: 400, body: { code: 'P0001', message: 'Activity not found.' } });
  await assert.rejects(setActivityDone('someone-elses', true), /Activity not found/);
});
