// The waste upload queue's choice of the next file (src/waste/offline/wasteUploadScheduler.ts): photos first, reports take turns, a
// file waiting out a pause or already being worked on is skipped, and a started video carries on before a new one begins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEligible, laneOf, otherReportHasWaitingVideo, pickNext, reportOrder } from '../src/waste/offline/wasteUploadScheduler';
import type { WasteMedia } from '../src/waste/offline/wasteDb';

const NOW = Date.parse('2026-11-06T10:00:00Z');
let n = 0;
function file(reportId: string, kind: 'photo' | 'video', over: Partial<WasteMedia> = {}): WasteMedia {
  n += 1;
  return {
    id: `${reportId}-${kind}-${n}`, ownerId: 'u', reportId, kind, phase: 'before', blob: new Blob(['x']), fileName: 'f', mime: 'image/jpeg', ext: 'jpg', sizeBytes: 1,
    sourceKey: `k${n}`, durationSeconds: null, thumbnail: null, storagePath: 'p', thumbPath: null, fileUploaded: false, thumbUploaded: false, tusUrl: null,
    status: 'pending', progress: 0, lastError: null, permanentFailure: false, attempts: 0, nextAttemptAt: null, sortOrder: 0,
    createdAt: new Date(NOW - 100_000 + n * 1000).toISOString(), ...over,
  };
}
const none = new Set<string>();

test('LANES: photos go to the photo lane, videos to the video lane', () => {
  assert.equal(laneOf({ kind: 'photo' }), 'photo');
  assert.equal(laneOf({ kind: 'video' }), 'video');
});

test('ELIGIBLE: finished, stopped, pausing and claimed files are skipped', () => {
  assert.equal(isEligible(file('A', 'photo'), NOW, none), true);
  assert.equal(isEligible(file('A', 'photo', { status: 'ready' }), NOW, none), false);
  assert.equal(isEligible(file('A', 'photo', { status: 'failed', permanentFailure: true }), NOW, none), false);
  assert.equal(isEligible(file('A', 'photo', { nextAttemptAt: new Date(NOW + 5000).toISOString() }), NOW, none), false);
  assert.equal(isEligible(file('A', 'photo', { nextAttemptAt: new Date(NOW - 1).toISOString() }), NOW, none), true);
  const f = file('A', 'photo');
  assert.equal(isEligible(f, NOW, new Set([f.id])), false);
});

test('PHOTOS FIRST: no video starts while any photo (of any report) is waiting', () => {
  const media = [file('A', 'video'), file('B', 'photo')];
  assert.equal(pickNext('video', media, ['A', 'B'], null, NOW, none), null);
  assert.equal(pickNext('photo', media, ['A', 'B'], null, NOW, none)?.reportId, 'B');
  // a photo merely waiting out its retry pause does not hold the videos back
  const pausing = [file('A', 'video'), file('B', 'photo', { nextAttemptAt: new Date(NOW + 60_000).toISOString() })];
  assert.equal(pickNext('video', pausing, ['A', 'B'], null, NOW, none)?.kind, 'video');
});

test('FAIR TURNS: reports take turns (A, B, A, B...), oldest report first', () => {
  const media = [file('A', 'photo'), file('A', 'photo'), file('A', 'photo'), file('B', 'photo')];
  const order = ['A', 'B'];
  const first = pickNext('photo', media, order, null, NOW, none)!;
  assert.equal(first.reportId, 'A');
  const second = pickNext('photo', media, order, first.reportId, NOW, new Set([first.id]))!;
  assert.equal(second.reportId, 'B', 'B gets its turn although A has more photos');
  const third = pickNext('photo', media, order, second.reportId, NOW, new Set([first.id, second.id]))!;
  assert.equal(third.reportId, 'A');
});

test('FAIR TURNS: a report with nothing eligible is passed over; a report not in the drafts still gets a turn', () => {
  const media = [file('A', 'photo', { status: 'ready' }), file('C', 'photo')];
  assert.deepEqual(reportOrder(media, ['A', 'B']), ['A', 'B', 'C']);
  assert.equal(pickNext('photo', media, ['A', 'B'], 'A', NOW, none)?.reportId, 'C');
});

test('VIDEOS: a started video (resumable session, paused for a turn, or bytes confirmed) carries on before a new one in the same report', () => {
  const fresh = file('A', 'video');
  const started = file('A', 'video', { tusUrl: 'https://tus/1' });
  assert.equal(pickNext('video', [fresh, started], ['A'], null, NOW, none)?.id, started.id);
  const paused = file('A', 'video', { pausedForTurn: true });
  assert.equal(pickNext('video', [fresh, paused], ['A'], null, NOW, none)?.id, paused.id);
});

test('TURN: another report has a waiting video only if it is eligible and not this report', () => {
  const a = file('A', 'video');
  assert.equal(otherReportHasWaitingVideo([a], 'A', NOW, none), false);
  const b = file('B', 'video');
  assert.equal(otherReportHasWaitingVideo([a, b], 'A', NOW, none), true);
  assert.equal(otherReportHasWaitingVideo([a, b], 'A', NOW, new Set([b.id])), false, 'already being worked on');
  assert.equal(otherReportHasWaitingVideo([a, file('B', 'video', { status: 'ready' })], 'A', NOW, none), false);
  assert.equal(otherReportHasWaitingVideo([a, file('B', 'photo')], 'A', NOW, none), false, 'photos have their own lane');
});
