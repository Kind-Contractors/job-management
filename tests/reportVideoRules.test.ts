// The pure rules for report videos: what a file may be, the counts, the messages. These mirror the database limits (the database
// enforces them regardless; see the DEV security suite) so a manager hears about a problem before a 150 MB upload starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPLETED_VIDEOS_MESSAGE,
  REPORT_VIDEO_LIMITS,
  checkVideoDuration,
  checkVideoSelection,
  countVideos,
  explainVideoError,
  formatBytes,
  formatDuration,
  resolveVideoType,
} from '../src/lib/reportVideoRules';
import { UploadError, resumableEndpoint } from '../src/lib/reportVideoUpload';

const file = (name: string, type: string, size = 5 * 1024 * 1024) => ({ name, type, size });
const none = { inPhase: 0, inVisit: 0 };

test('the limits are the agreed ones (and match the database: 150 MiB, 60 s, 3 per section, 8 per report, 1 MiB thumbnail)', () => {
  assert.deepEqual({ ...REPORT_VIDEO_LIMITS }, { maxBytes: 157_286_400, maxSeconds: 60, maxPerPhase: 3, maxPerVisit: 8, maxThumbnailBytes: 1_048_576 });
});

test('TYPE: MP4, MOV and WebM are accepted, by reported type or by extension', () => {
  assert.deepEqual(resolveVideoType(file('a.mp4', 'video/mp4')), { mime: 'video/mp4', ext: 'mp4' });
  assert.deepEqual(resolveVideoType(file('a.mov', 'video/quicktime')), { mime: 'video/quicktime', ext: 'mov' });
  assert.deepEqual(resolveVideoType(file('a.webm', 'video/webm')), { mime: 'video/webm', ext: 'webm' });
  // Windows often reports no type for .mov
  assert.deepEqual(resolveVideoType(file('IMG_0001.MOV', '')), { mime: 'video/quicktime', ext: 'mov' });
  assert.deepEqual(resolveVideoType(file('clip.MP4', '')), { mime: 'video/mp4', ext: 'mp4' });
});

test('TYPE: everything else is refused, including a renamed non-video and a disguised extension', () => {
  for (const f of [file('a.avi', 'video/x-msvideo'), file('a.mkv', ''), file('notes.txt', 'text/plain'), file('doc.pdf', 'application/pdf'), file('photo.jpg', 'image/jpeg'), file('noextension', ''), file('a.mp4.exe', '')]) {
    assert.equal(resolveVideoType(f), null, f.name);
  }
  const r = checkVideoSelection(file('a.avi', 'video/x-msvideo'), 'before', none);
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /MP4, MOV or WebM/);
});

test('SIZE: exactly 150 MiB is fine, one byte more is refused with the size in the message, and an empty file is refused', () => {
  assert.equal(checkVideoSelection(file('a.mp4', 'video/mp4', 157_286_400), 'before', none).ok, true);
  const over = checkVideoSelection(file('a.mp4', 'video/mp4', 157_286_401), 'before', none);
  assert.equal(over.ok, false);
  assert.match((over as { message: string }).message, /150 MB/);
  assert.equal(checkVideoSelection(file('a.mp4', 'video/mp4', 0), 'before', none).ok, false);
});

test('COUNTS: a section holds 3 and a report holds 8; the message names the section', () => {
  const phaseFull = checkVideoSelection(file('a.mp4', 'video/mp4'), 'during', { inPhase: 3, inVisit: 3 });
  assert.equal(phaseFull.ok, false);
  assert.match((phaseFull as { message: string }).message, /During section already has 3 videos/);
  assert.equal(checkVideoSelection(file('a.mp4', 'video/mp4'), 'during', { inPhase: 2, inVisit: 7 }).ok, true);
  const visitFull = checkVideoSelection(file('a.mp4', 'video/mp4'), 'before', { inPhase: 2, inVisit: 8 });
  assert.equal(visitFull.ok, false);
  assert.match((visitFull as { message: string }).message, /already has 8 videos/);
  assert.deepEqual(countVideos([{ phase: 'before' }, { phase: 'before' }, { phase: 'after' }], 'before'), { inPhase: 2, inVisit: 3 });
});

test('DURATION: 60 s is fine, a 1 s rounding allowance, then refused; unreadable is left to the server', () => {
  assert.equal(checkVideoDuration(60), null);
  assert.equal(checkVideoDuration(61), null);
  assert.match(checkVideoDuration(61.5)!, /1:02 long\. The limit is 1:00/);
  assert.equal(checkVideoDuration(null), null);
});

test('FORMAT: sizes and lengths read naturally', () => {
  assert.equal(formatBytes(15_433), '15 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(157_286_400), '150 MB');
  assert.equal(formatDuration(42), '0:42');
  assert.equal(formatDuration(75.4), '1:15');
  assert.equal(formatDuration(null), '');
});

test('ERRORS: Storage and database failures become plain sentences; the database\'s own readable refusals pass through', () => {
  assert.match(explainVideoError(new UploadError('The object exceeded the maximum allowed size', 413)), /larger than the 150 MB limit/);
  assert.match(explainVideoError(new UploadError('mime type text/plain is not supported', 415)), /MP4, MOV or WebM/);
  assert.match(explainVideoError(new Error('new row violates row-level security policy for table "objects"')), /permission[\s\S]*Completed, reopen it first/);
  assert.match(explainVideoError(new UploadError('Forbidden', 403)), /permission/);
  assert.equal(explainVideoError(new Error('This report has been marked Completed, so videos can no longer be added. Ask the office to reopen it.')), COMPLETED_VIDEOS_MESSAGE);
  assert.match(explainVideoError(new Error('Failed to fetch')), /interrupted[\s\S]*try again/);
  // readable messages the trigger raised on purpose are kept verbatim
  assert.equal(explainVideoError(new Error('Only 3 videos can be added to each section (Before / During / After).')), 'Only 3 videos can be added to each section (Before / During / After).');
  assert.equal(explainVideoError(new Error('The video is too long (the limit is 60 seconds).')), 'The video is too long (the limit is 60 seconds).');
  assert.match(explainVideoError(undefined), /Something went wrong/);
});

test('ENDPOINT: hosted projects use the dedicated storage host; anything else uses its own host', () => {
  assert.equal(resumableEndpoint('https://abcdefghijklmnop.supabase.co'), 'https://abcdefghijklmnop.storage.supabase.co/storage/v1/upload/resumable');
  assert.equal(resumableEndpoint('http://127.0.0.1:54321'), 'http://127.0.0.1:54321/storage/v1/upload/resumable');
  assert.equal(resumableEndpoint('https://tests.invalid'), 'https://tests.invalid/storage/v1/upload/resumable');
});
