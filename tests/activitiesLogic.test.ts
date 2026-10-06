// Pure-logic tests for Activities: the day order shared by jobs and activities (and its independence from
// time), optional time ranges, form validation, and the technician's next-stop rule. No network, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ScheduleActivity, WeekVisit } from '../src/domain/types';
import { compareDayItems, isLiveDayItem, mergeDayItems, toDayOrderPayload } from '../src/lib/dayItems';
import { formatTimeRange, normalizeTime, timeRangeError, timeRangeForSave } from '../src/lib/timeRange';
import { validateActivityInput, type ActivityFormValues } from '../src/lib/activityInput';
import { dayItemKey, isDayItemDone, nextStopIndex, type TechnicianActivityItem, type TechnicianDayItem, type TechnicianVisitItem } from '../src/technician/api';

// ---- fixtures -------------------------------------------------------------------------
function visit(id: string, over: Partial<WeekVisit> = {}): WeekVisit {
  return {
    id, jobId: `job-${id}`, technicianId: 'mo', additionalTechnicianIds: [], sortOrder: null, createdAt: '2026-10-06T08:00:00Z',
    scheduledDate: '2026-10-06', status: 'booked', startTime: null, endTime: null, ...over,
  };
}
function activity(id: string, over: Partial<ScheduleActivity> = {}): ScheduleActivity {
  return {
    id, description: `Activity ${id}`, scheduledDate: '2026-10-06', technicianId: 'mo', location: null, notes: null, startTime: null, endTime: null,
    sortOrder: null, createdAt: '2026-10-06T08:00:00Z', doneAt: null, cancelledAt: null, ...over,
  };
}
const ids = (items: { id: string }[]) => items.map((i) => i.id);

// ---- one running order for jobs and activities ----------------------------------------------
test('jobs and activities share ONE sequence: ordered items first by number, whatever their kind', () => {
  const items = mergeDayItems(
    [visit('v-clean-abc', { sortOrder: 2 }), visit('v-clean-xyz', { sortOrder: 4 })],
    [activity('a-keys', { sortOrder: 1 }), activity('a-meeting', { sortOrder: 3 })],
  );
  // The example from the brief: keys, cleaning ABC, client meeting, cleaning XYZ.
  assert.deepEqual(ids(items), ['a-keys', 'v-clean-abc', 'a-meeting', 'v-clean-xyz']);
});

test('time NEVER orders anything: an item with an earlier time stays after one with a lower order number', () => {
  const items = mergeDayItems(
    [visit('v1', { sortOrder: 1, startTime: '14:30' }), visit('v3', { sortOrder: 3, startTime: '09:00', endTime: '11:00' })],
    [activity('a2', { sortOrder: 2, startTime: '07:00', endTime: '08:00' })],
  );
  assert.deepEqual(ids(items), ['v1', 'a2', 'v3'], 'order is by number: 14:30, then 07:00, then 09:00');
});

test('an item can have an order and no time, and a time and no order', () => {
  const items = mergeDayItems([visit('ordered-no-time', { sortOrder: 1 })], [activity('time-no-order', { startTime: '08:00' })]);
  assert.deepEqual(ids(items), ['ordered-no-time', 'time-no-order'], 'ordered first even though the other has a time');
});

test('unordered items come after every ordered one, oldest first, and a job precedes an activity on a complete tie', () => {
  const items = mergeDayItems(
    [visit('v-late', { createdAt: '2026-10-06T10:00:00Z' }), visit('v-tie', { createdAt: '2026-10-06T09:00:00Z' })],
    [activity('a-tie', { createdAt: '2026-10-06T09:00:00Z' }), activity('a-ordered', { sortOrder: 5 }), activity('a-early', { createdAt: '2026-10-06T07:00:00Z' })],
  );
  assert.deepEqual(ids(items), ['a-ordered', 'a-early', 'v-tie', 'a-tie', 'v-late']);
});

test('an equal order number falls back to created_at, then job-before-activity, then id (same as the database)', () => {
  const a = mergeDayItems([visit('v', { sortOrder: 2, createdAt: '2026-10-06T09:00:00Z' })], [activity('a', { sortOrder: 2, createdAt: '2026-10-06T08:00:00Z' })]);
  assert.deepEqual(ids(a), ['a', 'v'], 'older first');
  const b = mergeDayItems([visit('v', { sortOrder: 2, createdAt: 'T' })], [activity('a', { sortOrder: 2, createdAt: 'T' })]);
  assert.deepEqual(ids(b), ['v', 'a'], 'job first on a complete tie');
  const c = mergeDayItems([], [activity('b', { createdAt: 'T' }), activity('a', { createdAt: 'T' })]);
  assert.deepEqual(ids(c), ['a', 'b'], 'then id');
});

test('compareDayItems is a consistent total order (sorting twice or reversed gives the same result)', () => {
  const items = mergeDayItems(
    [visit('v1', { sortOrder: 1 }), visit('v2'), visit('v3', { createdAt: '2026-10-06T07:00:00Z' })],
    [activity('a1', { sortOrder: 2 }), activity('a2'), activity('a3', { createdAt: '2026-10-06T06:00:00Z' })],
  );
  const once = ids(items);
  assert.deepEqual(ids([...items].reverse().sort(compareDayItems)), once);
  assert.deepEqual(ids([...items].sort(compareDayItems)), once);
});

test('a cancelled visit or cancelled activity is not part of the day; a done activity still is', () => {
  const items = mergeDayItems(
    [visit('v-live'), visit('v-cancelled', { status: 'cancelled' })],
    [activity('a-live'), activity('a-done', { doneAt: '2026-10-06T09:00:00Z' }), activity('a-cancelled', { cancelledAt: '2026-10-06T09:00:00Z' })],
  );
  assert.deepEqual(ids(items.filter(isLiveDayItem)).sort(), ['a-done', 'a-live', 'v-live']);
  assert.deepEqual(ids(items.filter((i) => !isLiveDayItem(i))).sort(), ['a-cancelled', 'v-cancelled']);
});

test('the order saved to the database is exactly the live items, by kind and id, in order', () => {
  const live = mergeDayItems([visit('v1', { sortOrder: 2 })], [activity('a1', { sortOrder: 1 })]).filter(isLiveDayItem);
  assert.deepEqual(toDayOrderPayload(live), [{ kind: 'activity', id: 'a1' }, { kind: 'visit', id: 'v1' }]);
});

test('items cached before times / activities existed (missing fields) sort without throwing', () => {
  const old: any = { id: 'old', jobId: 'j', technicianId: 'mo', scheduledDate: '2026-10-06', status: 'booked' }; // no sortOrder / createdAt / startTime
  assert.doesNotThrow(() => mergeDayItems([old, visit('v')], []));
  assert.equal(formatTimeRange(old.startTime ?? null, old.endTime ?? null), '');
});

// ---- optional time ranges -------------------------------------------------------------
test('no time, a start only, and a start + end are all valid; the label is shown separately from the order', () => {
  assert.equal(timeRangeError('', ''), null, 'no time is perfectly valid');
  assert.equal(timeRangeError('09:00', ''), null, 'a start only is valid');
  assert.equal(timeRangeError('09:00', '11:00'), null);
  assert.equal(formatTimeRange(null, null), '');
  assert.equal(formatTimeRange('09:00', null), 'from 09:00');
  assert.equal(formatTimeRange('09:00:00', '11:00:00'), '09:00–11:00');
});

test('an end without a start, or an end that is not after the start, is refused', () => {
  assert.match(timeRangeError('', '11:00') ?? '', /start time before an end/);
  assert.match(timeRangeError('11:00', '11:00') ?? '', /after the start/);
  assert.match(timeRangeError('11:00', '09:00') ?? '', /after the start/);
  assert.match(timeRangeError('25:00', '') ?? '', /not a valid time/);
});

test('times from the database or the browser normalise to HH:MM; junk becomes "no time" instead of throwing', () => {
  assert.equal(normalizeTime('09:05:00'), '09:05');
  assert.equal(normalizeTime('09:05'), '09:05');
  assert.equal(normalizeTime(''), null);
  assert.equal(normalizeTime(null), null);
  assert.equal(normalizeTime(undefined), null);
  assert.equal(normalizeTime('not a time'), null);
});

test('what is saved: an end without a start is never stored, and a cleared time is stored as null/null', () => {
  assert.deepEqual(timeRangeForSave('', '11:00'), { startTime: null, endTime: null });
  assert.deepEqual(timeRangeForSave('09:00', ''), { startTime: '09:00', endTime: null });
  assert.deepEqual(timeRangeForSave('09:00:00', '10:30:00'), { startTime: '09:00', endTime: '10:30' });
  assert.deepEqual(timeRangeForSave(null, null), { startTime: null, endTime: null });
});

// ---- the Activity form's validation -----------------------------------------------------
const goodForm: ActivityFormValues = { description: 'Pick up keys', scheduledDate: '2026-10-06', technicianId: '', location: '', notes: '', startTime: '', endTime: '' };

test('an activity needs only a description and a date: unassigned, no time, no location, no notes is fine', () => {
  assert.equal(validateActivityInput(goodForm), null);
});

test('the description is required, trimmed, and at most 120 characters', () => {
  assert.match(validateActivityInput({ ...goodForm, description: '   ' }) ?? '', /Describe/);
  assert.match(validateActivityInput({ ...goodForm, description: 'x'.repeat(121) }) ?? '', /120/);
  assert.equal(validateActivityInput({ ...goodForm, description: ' ' + 'x'.repeat(120) + ' ' }), null, 'trimmed length counts');
});

test('location and notes have the database limits; the date is required; the time range is checked', () => {
  assert.match(validateActivityInput({ ...goodForm, location: 'x'.repeat(201) }) ?? '', /200/);
  assert.match(validateActivityInput({ ...goodForm, notes: 'x'.repeat(2001) }) ?? '', /2000/);
  assert.match(validateActivityInput({ ...goodForm, scheduledDate: '' }) ?? '', /date/);
  assert.match(validateActivityInput({ ...goodForm, endTime: '10:00' }) ?? '', /start time before/);
  assert.equal(validateActivityInput({ ...goodForm, startTime: '08:30', endTime: '09:00', location: 'Office', notes: 'Ask for Sam' }), null);
});

// ---- the technician's day: done state and the next stop ---------------------------------------
function jobItem(id: string, over: Partial<TechnicianVisitItem> = {}): TechnicianVisitItem {
  return {
    kind: 'visit', visitId: id, scheduledDate: '2026-10-06', status: 'booked', jobId: `job-${id}`, jobSummary: 'Clean', jobType: 'general', buildingName: 'Oak Court',
    buildingAddress: '1 High St', buildingPostcode: null, reportSubmitted: false, assignedCount: 1, startTime: null, endTime: null, ...over,
  };
}
function actItem(id: string, over: Partial<TechnicianActivityItem> = {}): TechnicianActivityItem {
  return { kind: 'activity', activityId: id, scheduledDate: '2026-10-06', startTime: null, endTime: null, description: 'Pick up keys', location: null, notes: null, done: false, ...over };
}

test('NEXT STOP skips completed activities and lands on the first incomplete item, job or activity', () => {
  const day: TechnicianDayItem[] = [actItem('keys', { done: true }), jobItem('abc', { reportSubmitted: true }), actItem('meeting'), jobItem('xyz')];
  assert.equal(nextStopIndex(day), 2, 'the done activity and the done job are skipped; the incomplete activity is next');
});

test('an incomplete activity CAN be the next stop, including first in the day', () => {
  assert.equal(nextStopIndex([actItem('keys'), jobItem('abc')]), 0);
});

test('a job is next when the activities before it are done; when everything is done there is no next stop', () => {
  assert.equal(nextStopIndex([actItem('keys', { done: true }), jobItem('abc')]), 1);
  assert.equal(nextStopIndex([actItem('keys', { done: true }), jobItem('abc', { reportSubmitted: true })]), -1);
  assert.equal(nextStopIndex([]), -1);
});

test('undoing a done activity makes it eligible to be the next stop again', () => {
  const done = [actItem('keys', { done: true }), jobItem('abc')];
  assert.equal(nextStopIndex(done), 1);
  const undone = [{ ...done[0], done: false } as TechnicianDayItem, done[1]];
  assert.equal(nextStopIndex(undone), 0);
});

test('a job keeps its existing "done" rule (submitted, or completed and not shared); an activity uses its own flag', () => {
  assert.equal(isDayItemDone(jobItem('a', { reportSubmitted: true })), true);
  assert.equal(isDayItemDone(jobItem('b', { status: 'completed' })), true);
  assert.equal(isDayItemDone(jobItem('c', { status: 'completed', assignedCount: 2 })), false, 'a colleague completing a shared job does not finish it for me');
  assert.equal(isDayItemDone(actItem('d', { done: true })), true);
  assert.equal(isDayItemDone(actItem('e')), false);
});

test('a job id and an activity id never collide as list keys', () => {
  assert.notEqual(dayItemKey(jobItem('same')), dayItemKey(actItem('same')));
});
