// Rendering tests for Activities, on the REAL components: the manager's day list / drawer / week-and-day grid /
// month grid / forms, and the technician's Today rows. Server-rendered to static markup (no DOM library in this
// repo), so these check what is shown and in what order; the click-through behaviour is covered at the data layer
// (activitiesData.test.ts) and by the pure logic tests.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import type { ScheduleActivity, Technician, WeekVisit } from '../src/domain/types';
import DayBookingsList from '../src/components/calendar/DayBookingsList';
import ScheduleTechnicianGrid from '../src/components/calendar/ScheduleTechnicianGrid';
import ScheduleDayDrawer from '../src/components/calendar/ScheduleDayDrawer';
import MonthGrid from '../src/components/calendar/MonthGrid';
import ActivityForm from '../src/components/calendar/ActivityForm';
import TimeRangeFields from '../src/components/calendar/TimeRangeFields';
import { ActivityRow, StopRow } from '../src/technician/DayViewPage';
import { technicianKeys, visitListQueryKeys } from '../src/technician/queryKeys';
import type { TechnicianActivityItem, TechnicianVisitItem } from '../src/technician/api';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

// ---- fixtures -------------------------------------------------------------------------
const technicians: Technician[] = [
  { id: 'mo', name: 'Mo', isActive: true, notes: null, appUserId: null },
  { id: 't1', name: 'Tech 1', isActive: true, notes: null, appUserId: null },
  { id: 'old', name: 'Retired', isActive: false, notes: null, appUserId: null },
];
const technicianById = new Map(technicians.map((t) => [t.id, t]));
const jobById = new Map<string, any>([
  ['j-abc', { id: 'j-abc', buildingName: 'Flair ABC', jobSummary: 'Windows', division: 'General' }],
  ['j-xyz', { id: 'j-xyz', buildingName: 'Oak Court XYZ', jobSummary: 'Gutters', division: 'General' }],
]);
const statusStyle: any = { due: 'S-due', booked: 'S-booked', completed: 'S-completed', missed: 'S-missed', cancelled: 'S-cancelled' };
const DAY = '2026-10-06';

const wv = (id: string, jobId: string, over: Partial<WeekVisit> = {}): WeekVisit => ({
  id, jobId, technicianId: 'mo', additionalTechnicianIds: [], sortOrder: null, createdAt: '2026-10-06T08:00:00Z', scheduledDate: DAY, status: 'booked', startTime: null, endTime: null, ...over,
});
const sa = (id: string, description: string, over: Partial<ScheduleActivity> = {}): ScheduleActivity => ({
  id, description, scheduledDate: DAY, technicianId: 'mo', location: null, notes: null, startTime: null, endTime: null, sortOrder: null, createdAt: '2026-10-06T08:00:00Z', doneAt: null, cancelledAt: null, ...over,
});
const wrap = (el: ReactElement) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);
const at = (html: string, text: string) => {
  const i = html.indexOf(text);
  assert.ok(i >= 0, `expected the markup to contain "${text}"`);
  return i;
};
const noop = () => {};

// The example from the brief: keys 08:30-09:00, cleaning ABC (no time), client meeting 11:00-12:00, cleaning XYZ (no time).
const briefVisits = [wv('v-abc', 'j-abc', { sortOrder: 2 }), wv('v-xyz', 'j-xyz', { sortOrder: 4 })];
const briefActivities = [
  sa('a-keys', 'Pick up keys', { sortOrder: 1, startTime: '08:30', endTime: '09:00' }),
  sa('a-meeting', 'Client meeting', { sortOrder: 3, startTime: '11:00', endTime: '12:00' }),
];

// ---- manager: the day list --------------------------------------------------------------------
test('the day list shows jobs and activities in ONE ordered sequence, activities marked, times shown separately', () => {
  const html = wrap(
    <DayBookingsList dayVisits={briefVisits} dayActivities={briefActivities} dateISO={DAY} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop} onSelectActivity={noop} />,
  );
  const order = ['Pick up keys', 'Flair ABC', 'Client meeting', 'Oak Court XYZ'].map((t) => at(html, `>${t}<`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'keys, cleaning ABC, client meeting, cleaning XYZ');
  assert.match(html, /08:30\u201309:00/);
  assert.match(html, /11:00\u201312:00/);
  assert.equal((html.match(/>Activity</g) ?? []).length, 2, 'both activities carry the Activity marker');
  assert.match(html, /Time \(display only - it does not set the order\)/);
  // numbers 1..4 on the badges, independent of the times
  const badges = [...html.matchAll(/tabular-nums">(\d)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(badges, ['1', '2', '3', '4']);
});

test('an item with an order but NO time shows no time; a time-less job is not given one', () => {
  const html = wrap(<DayBookingsList dayVisits={[wv('v-abc', 'j-abc', { sortOrder: 1 })]} dayActivities={[sa('a1', 'Quote', { sortOrder: 2 })]} dateISO={DAY} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop} />);
  assert.doesNotMatch(html, /\d\d:\d\d/, 'no time anywhere');
});

test('a start-only time reads "from 09:00"; a job time shows beside the job', () => {
  const html = wrap(<DayBookingsList dayVisits={[wv('v-abc', 'j-abc', { sortOrder: 1, startTime: '09:00', endTime: '10:30' })]} dayActivities={[sa('a1', 'Quote', { sortOrder: 2, startTime: '13:00' })]} dateISO={DAY} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop} />);
  assert.match(html, /09:00\u201310:30/);
  assert.match(html, /from 13:00/);
});

test('time does not reorder: an earlier-time item sits after a later-time item when its number says so', () => {
  const html = wrap(
    <DayBookingsList
      dayVisits={[wv('v-late', 'j-abc', { sortOrder: 1, startTime: '16:00' })]}
      dayActivities={[sa('a-early', 'Early thing', { sortOrder: 2, startTime: '07:00' })]}
      dateISO={DAY} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop}
    />,
  );
  assert.ok(at(html, '>Flair ABC<') < at(html, '>Early thing<'));
});

test('who: an assigned activity names the technician, an unassigned one says Unassigned; location is shown', () => {
  const html = wrap(<DayBookingsList dayVisits={[]} dayActivities={[sa('a1', 'Quote', { sortOrder: 1, location: 'Oak Court' }), sa('a2', 'Collect post', { sortOrder: 2, technicianId: null })]} dateISO={DAY} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop} />);
  assert.match(html, /Mo · Oak Court/);
  assert.match(html, /Unassigned/);
});

test('a done activity stays in the list marked done; a cancelled one is listed last, unnumbered, without move buttons', () => {
  const html = wrap(
    <DayBookingsList
      dayVisits={[wv('v-abc', 'j-abc', { sortOrder: 2 })]}
      dayActivities={[sa('a-done', 'Done thing', { sortOrder: 1, doneAt: '2026-10-06T09:00:00Z' }), sa('a-cancelled', 'Cancelled thing', { cancelledAt: '2026-10-06T09:00:00Z' })]}
      dateISO={DAY} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop}
    />,
  );
  assert.ok(at(html, '>Done thing<') < at(html, '>Flair ABC<') && at(html, '>Flair ABC<') < at(html, '>Cancelled thing<'));
  assert.match(html, /✓ Done/);
  assert.match(html, /Cancelled/);
  assert.doesNotMatch(html, /Move Cancelled thing/, 'a cancelled activity has no move controls');
  assert.match(html, /Move Done thing up/);
  assert.equal((html.match(/tabular-nums">(\d|–)<\/span>/g) ?? []).length, 3, 'two numbered, one dash');
});

test('a day WITHOUT activities renders exactly the job list as before (no Activity marker, jobs numbered)', () => {
  const html = wrap(<DayBookingsList dayVisits={[wv('v1', 'j-abc', { sortOrder: 1 }), wv('v2', 'j-xyz', { sortOrder: 2 })]} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop} />);
  assert.doesNotMatch(html, />Activity</);
  assert.ok(at(html, '>Flair ABC<') < at(html, '>Oak Court XYZ<'));
  assert.match(html, /Move Flair ABC down/);
});

// ---- manager: week / day grid -----------------------------------------------------------------
const gridProps = {
  days: [new Date(2026, 9, 6)], visits: [] as WeekVisit[], displayVisits: [] as WeekVisit[], jobById, visitStatusStyle: statusStyle,
  todayISO: DAY, selectedDateISO: null as string | null, onSelectDay: noop, onSelectVisit: noop, onDrop: () => () => {}, onToggleTechnicianActive: noop,
};

test('the grid shows an activity as a distinct chip in the assigned technician\'s row, numbered with the jobs', () => {
  const html = renderToStaticMarkup(
    <ScheduleTechnicianGrid {...gridProps} technicians={[technicians[0]]} visits={briefVisits} displayVisits={briefVisits} activities={briefActivities} onSelectActivity={noop} />,
  );
  assert.match(html, /border-dashed/, 'activities are visually distinct from jobs');
  const order = ['Pick up keys', 'Flair ABC', 'Client meeting', 'Oak Court XYZ'].map((t) => at(html, t));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /08:30\u201309:00/);
  assert.match(html, />1\.<\/span>/);
  assert.match(html, />4\.<\/span>/);
  assert.match(html, /application\/x-activity-id|draggable="true"/);
});

test('an activity only appears in ITS technician\'s row, never another\'s', () => {
  const forTech1 = [sa('a1', 'Tech one thing', { technicianId: 't1' })];
  const moOnly = renderToStaticMarkup(<ScheduleTechnicianGrid {...gridProps} technicians={[technicians[0]]} activities={forTech1} />);
  assert.doesNotMatch(moOnly, /Tech one thing/);
  const t1Row = renderToStaticMarkup(<ScheduleTechnicianGrid {...gridProps} technicians={[technicians[1]]} activities={forTech1} />);
  assert.match(t1Row, /Tech one thing/);
});

test('unassigned activities get their own "Unassigned" row - and only while one exists', () => {
  const none = renderToStaticMarkup(<ScheduleTechnicianGrid {...gridProps} technicians={technicians} activities={[sa('a1', 'Assigned')]} />);
  assert.doesNotMatch(none, /activities only/);
  const some = renderToStaticMarkup(<ScheduleTechnicianGrid {...gridProps} technicians={technicians} activities={[sa('a2', 'Nobody yet', { technicianId: null })]} />);
  assert.match(some, /Unassigned/);
  assert.match(some, /Nobody yet/);
});

test('cancelled activities are not on the grid; done ones are, ticked', () => {
  const html = renderToStaticMarkup(
    <ScheduleTechnicianGrid {...gridProps} technicians={[technicians[0]]} activities={[sa('a1', 'Gone', { cancelledAt: 'x' }), sa('a2', 'Finished', { doneAt: 'x' })]} />,
  );
  assert.doesNotMatch(html, /Gone/);
  assert.match(html, /Finished/);
  assert.match(html, /✓/);
});

test('the per-technician job count stays jobs-only (activities are not counted as visits)', () => {
  const html = renderToStaticMarkup(<ScheduleTechnicianGrid {...gridProps} technicians={[technicians[0]]} visits={[wv('v1', 'j-abc')]} displayVisits={[wv('v1', 'j-abc')]} activities={[sa('a1', 'X'), sa('a2', 'Y')]} />);
  assert.match(html, /not a capacity estimate \(activities are not counted\)[^>]*>1</);
});

test('a job time is shown on its grid chip', () => {
  const v = wv('v1', 'j-abc', { startTime: '09:00', endTime: '11:00' });
  const html = renderToStaticMarkup(<ScheduleTechnicianGrid {...gridProps} technicians={[technicians[0]]} visits={[v]} displayVisits={[v]} />);
  assert.match(html, /09:00\u201311:00/);
});

// ---- manager: month grid ---------------------------------------------------------------------------
const monthProps = {
  days: [{ date: new Date(2026, 9, 6), dateISO: DAY, inMonth: true }], jobById, visitStatusStyle: statusStyle, activeTechnicians: technicians, pendingDrop: null, pendingTechnicianId: '',
  onPendingTechnicianChange: noop, onDropJob: noop, onRescheduleVisit: noop, onConfirmBooking: noop, onCancelBooking: noop, bookingPending: false, onSelectVisit: noop, onSelectDay: noop,
  todayISO: DAY, selectedDateISO: null as string | null, technicianById,
};

test('the month grid shows activity chips among the jobs and counts them in "+N more"; cancelled ones are not counted', () => {
  const html = renderToStaticMarkup(
    <MonthGrid {...monthProps} visits={[wv('v1', 'j-abc', { sortOrder: 3 })]} activities={[sa('a1', 'First', { sortOrder: 1 }), sa('a2', 'Second', { sortOrder: 2 }), sa('a3', 'Hidden by cancel', { cancelledAt: 'x' })]} onSelectActivity={noop} />,
  );
  assert.match(html, /First/);
  assert.match(html, /Second/);
  assert.doesNotMatch(html, /Hidden by cancel/);
  assert.doesNotMatch(html, /Flair ABC/, 'the job is 3rd, past the two chips shown');
  assert.match(html, /\+1 more/);
  assert.match(html, /border-dashed/);
});

// ---- manager: forms --------------------------------------------------------------------------------------
const blank = { description: '', scheduledDate: DAY, technicianId: '', location: '', notes: '', startTime: '', endTime: '' };

test('the create form has description, who (Unassigned is the default choice), time, location and notes - and no cancel button', () => {
  const html = renderToStaticMarkup(<ActivityForm mode="create" initial={blank} technicians={technicians} showDate={false} pending={false} error={null} onSubmit={noop} />);
  assert.match(html, /aria-label="Activity description"/);
  assert.match(html, /<option value="" selected[^>]*>Unassigned|<option value="">Unassigned/);
  assert.match(html, /Start time \(optional\)/);
  assert.match(html, /End time \(optional\)/);
  assert.match(html, /Location \(optional\)/);
  assert.match(html, /Notes \(optional\)/);
  assert.match(html, /Save activity/);
  assert.doesNotMatch(html, /Cancel activity/);
  assert.doesNotMatch(html, /aria-label="Activity date"/, 'create uses the drawer\'s date');
  assert.doesNotMatch(html, /Retired/, 'an inactive technician cannot be newly chosen');
});

test('the edit form shows the date, keeps a now-inactive assignee selectable, offers Cancel activity, and notes when it is done', () => {
  const html = renderToStaticMarkup(
    <ActivityForm mode="edit" initial={{ ...blank, description: 'Quote', technicianId: 'old', startTime: '10:00' }} technicians={technicians} showDate pending={false} error={null} doneNote="The assigned technician has marked this done." onSubmit={noop} onClose={noop} onCancelActivity={noop} />,
  );
  assert.match(html, /aria-label="Activity date"/);
  assert.match(html, /Retired \(inactive\)/);
  assert.match(html, /Cancel activity/);
  assert.match(html, /Save changes/);
  assert.match(html, /Back/);
  assert.match(html, /has marked this done/);
  assert.match(html, /value="10:00"/);
});

test('the form shows a database error and a saving state', () => {
  const html = renderToStaticMarkup(<ActivityForm mode="create" initial={{ ...blank, description: 'x' }} technicians={technicians} showDate={false} pending error="Cannot assign this activity to an inactive technician." onSubmit={noop} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /inactive technician/);
  assert.match(html, /Saving…/);
});

test('the time fields: the end box is disabled until there is a start; a bad range is explained; Clear appears when set', () => {
  const empty = renderToStaticMarkup(<TimeRangeFields start="" end="" onChange={noop} />);
  assert.match(empty, /aria-label="Item end time"[^>]*disabled|disabled[^>]*aria-label="Item end time"/);
  assert.doesNotMatch(empty, />Clear</);
  const bad = renderToStaticMarkup(<TimeRangeFields start="11:00" end="09:00" onChange={noop} />);
  assert.match(bad, /end time must be after the start time/);
  assert.match(bad, />Clear</);
  const good = renderToStaticMarkup(<TimeRangeFields start="09:00" end="" onChange={noop} />);
  assert.doesNotMatch(good, /must be after|valid time/);
});

// ---- manager: the day drawer ----------------------------------------------------------------------------------
const drawerProps = { dateISO: DAY, visits: briefVisits, jobRows: [] as any[], technicians, visitStatusStyle: statusStyle, onClose: noop, onSelectVisit: noop };

test('the day drawer lists jobs and activities together, with a Job visit / Activity switch for adding', () => {
  const html = wrap(<ScheduleDayDrawer {...drawerProps} activities={briefActivities} />);
  assert.match(html, /Bookings &amp; activities \(4\)/);
  assert.match(html, />Pick up keys</);
  assert.match(html, /Job visit/);
  assert.match(html, />Activity</);
  assert.match(html, /Save booking/, 'the existing job booking form is still the default');
  assert.match(html, /aria-label="Visit start time"/, 'a job booking can have an optional time');
});

test('opening the drawer on an activity goes straight to editing it', () => {
  const html = wrap(<ScheduleDayDrawer {...drawerProps} activities={briefActivities} initialActivityId="a-meeting" />);
  assert.match(html, /Edit activity/);
  assert.match(html, /value="Client meeting"/);
  assert.match(html, /Cancel activity/);
  assert.doesNotMatch(html, /Save booking/);
});

test('the drawer counts only live items and still works with no activities at all', () => {
  const html = wrap(<ScheduleDayDrawer {...drawerProps} visits={[wv('v1', 'j-abc'), wv('v2', 'j-xyz', { status: 'cancelled' })]} activities={[sa('a1', 'Live'), sa('a2', 'Dead', { cancelledAt: 'x' })]} />);
  assert.match(html, /Bookings &amp; activities \(2\)/);
  const none = wrap(<ScheduleDayDrawer {...drawerProps} visits={[]} />);
  assert.match(none, /Nothing booked for this day yet/);
});

// ---- technician: Today rows ----------------------------------------------------------------------------------------------
const actItem = (over: Partial<TechnicianActivityItem> = {}): TechnicianActivityItem => ({
  kind: 'activity', activityId: 'a1', scheduledDate: DAY, startTime: null, endTime: null, description: 'Pick up keys', location: null, notes: null, done: false, ...over,
});
const jobItem = (over: Partial<TechnicianVisitItem> = {}): TechnicianVisitItem => ({
  kind: 'visit', visitId: 'v1', scheduledDate: DAY, status: 'booked', jobId: 'j1', jobSummary: 'Windows', jobType: 'general', buildingName: 'Flair', buildingAddress: '1 High St',
  buildingPostcode: null, reportSubmitted: false, assignedCount: 1, startTime: null, endTime: null, ...over,
});

test('technician: an activity row says Activity, shows description, time, location and notes, and offers Mark done', () => {
  const html = renderToStaticMarkup(
    <ActivityRow item={actItem({ startTime: '08:30', endTime: '09:00', location: 'The office', notes: 'Ask for Sam' })} index={0} isNext={false} canChange pending={false} onToggleDone={noop} />,
  );
  assert.match(html, />Activity</);
  assert.match(html, /Pick up keys/);
  assert.match(html, /08:30\u201309:00/);
  assert.match(html, /The office/);
  assert.match(html, /Ask for Sam/);
  assert.match(html, />Mark done</);
});

test('technician: a done activity stays visible, ticked and faded, and offers Undo', () => {
  const html = renderToStaticMarkup(<ActivityRow item={actItem({ done: true })} index={0} isNext={false} canChange pending={false} onToggleDone={noop} />);
  assert.match(html, /Pick up keys/);
  assert.match(html, /✓/);
  assert.match(html, /opacity-60/);
  assert.match(html, /line-through/);
  assert.match(html, />Undo</);
  assert.doesNotMatch(html, />Mark done</);
});

test('technician: an incomplete activity can be the Next stop; a done one never is', () => {
  const next = renderToStaticMarkup(<ActivityRow item={actItem()} index={0} isNext canChange pending={false} onToggleDone={noop} />);
  assert.match(next, /Next stop/);
  const doneNext = renderToStaticMarkup(<ActivityRow item={actItem({ done: true })} index={0} isNext canChange pending={false} onToggleDone={noop} />);
  assert.doesNotMatch(doneNext, /Next stop/);
});

test('technician: offline disables Mark done with a reason; saving and errors are shown on that row', () => {
  const offline = renderToStaticMarkup(<ActivityRow item={actItem()} index={0} isNext={false} canChange={false} pending={false} onToggleDone={noop} />);
  assert.match(offline, /disabled/);
  assert.match(offline, /needs a connection/);
  const saving = renderToStaticMarkup(<ActivityRow item={actItem()} index={0} isNext={false} canChange pending onToggleDone={noop} />);
  assert.match(saving, /Saving…/);
  const failed = renderToStaticMarkup(<ActivityRow item={actItem()} index={0} isNext={false} canChange pending={false} error="This activity is not due yet." onToggleDone={noop} />);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /not due yet/);
});

test('technician: an activity with no time / location / notes shows only its description', () => {
  const html = renderToStaticMarkup(<ActivityRow item={actItem()} index={2} isNext={false} canChange pending={false} onToggleDone={noop} />);
  assert.doesNotMatch(html, /\d\d:\d\d/);
  assert.doesNotMatch(html, /📍/);
  assert.match(html, />3</, 'it takes its place in the shared numbering');
});

test('technician: a job row shows its optional time; without one it looks as before', () => {
  const timed = renderToStaticMarkup(<StopRow visit={jobItem({ startTime: '09:00', endTime: '11:00' })} index={1} isNext={false} onSelect={noop} />);
  assert.match(timed, /09:00\u201311:00/);
  const plain = renderToStaticMarkup(<StopRow visit={jobItem()} index={1} isNext={false} onSelect={noop} />);
  assert.doesNotMatch(plain, /\d\d:\d\d/);
  assert.match(plain, /Flair/);
});

test('technician query keys: the merged list has its own key (never the old jobs-only shape) and is refreshed with the other lists', () => {
  assert.notDeepEqual(technicianKeys.todayItems('u'), technicianKeys.todayVisits('u'));
  assert.ok(visitListQueryKeys('u').some((k) => k.join('/') === technicianKeys.todayItems('u').join('/')));
  assert.equal(technicianKeys.todayItems('u')[1], 'u', 'still scoped to the signed-in user');
});

// ---- stale cache: shapes persisted before Activities existed ---------------------------------------------------------------
const oldVisit = (id: string, jobId: string): any => ({ id, jobId, technicianId: 'mo', additionalTechnicianIds: [], sortOrder: null, createdAt: '2026-10-06T08:00:00Z', scheduledDate: DAY, status: 'booked' }); // no startTime / endTime

test('stale cache: every manager component renders old-shaped visits (no times) and NO activities prop', () => {
  const visits = [oldVisit('a', 'j-abc'), oldVisit('b', 'j-xyz')];
  assert.doesNotThrow(() => {
    const list = wrap(<DayBookingsList dayVisits={visits} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop} />);
    assert.match(list, /Flair ABC/);
    const grid = renderToStaticMarkup(<ScheduleTechnicianGrid {...gridProps} technicians={[technicians[0]]} visits={visits} displayVisits={visits} />);
    assert.match(grid, /Flair ABC/);
    const month = renderToStaticMarkup(<MonthGrid {...monthProps} visits={visits} />);
    assert.match(month, /Flair ABC/);
    const drawer = wrap(<ScheduleDayDrawer {...drawerProps} visits={visits} />);
    assert.match(drawer, /Bookings &amp; activities \(2\)/);
  });
});

test('stale cache: activities missing fields (cached by a different build) do not crash the manager components', () => {
  const thin: any = { id: 'x', description: 'Thin', scheduledDate: DAY, technicianId: 'mo' }; // no times, order, done/cancelled, createdAt
  assert.doesNotThrow(() => {
    wrap(<DayBookingsList dayVisits={[]} dayActivities={[thin]} dateISO={DAY} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={noop} />);
    renderToStaticMarkup(<ScheduleTechnicianGrid {...gridProps} technicians={[technicians[0]]} activities={[thin]} />);
    renderToStaticMarkup(<MonthGrid {...monthProps} visits={[]} activities={[thin]} />);
    wrap(<ScheduleDayDrawer {...drawerProps} visits={[]} activities={[thin]} />);
  });
});
