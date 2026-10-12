// The upload flow, driven exactly as the review screen drives it: pick a file, watch the states, cancel, retry. No network and no
// browser - the metadata reader and the uploader are replaced - so what is asserted is the behaviour that protects the manager:
// never two uploads at once, nothing starts on a Completed report, a bad file is refused before any upload, retry only when it
// can help, cancel really stops, and a failure always ends in a readable message.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VideoUploadController, type UploadState, type VideoUploadControllerOptions } from '../src/lib/videoUploadController';
import { UploadCancelledError, UploadError } from '../src/lib/reportVideoUpload';
import type { ReportVideo, UploadReportVideoInput } from '../src/repository/reportVideosRepository';
import type { VideoMetadata } from '../src/lib/videoMetadata';

const VIDEO = { id: 'v-new' } as ReportVideo;
const file = (name = 'site.mp4', type = 'video/mp4', size = 5 * 1024 * 1024) => ({ name, type, size }) as File;

function setup(over: Partial<VideoUploadControllerOptions> = {}, state: { videos?: { phase: 'before' | 'during' | 'after' }[]; completed?: boolean } = {}) {
  const states: (UploadState | null)[] = [];
  const pickErrors: (string | null)[] = [];
  const uploaded: ReportVideo[] = [];
  const uploads: UploadReportVideoInput[] = [];
  const ctl = new VideoUploadController({
    visitId: 'visit-1',
    context: () => ({ videos: state.videos ?? [], completed: state.completed ?? false }),
    readMetadata: async (): Promise<VideoMetadata> => ({ durationSeconds: 30, thumbnail: new Blob(['x']) }),
    upload: async (input) => {
      uploads.push(input);
      input.onProgress?.(50, 100);
      input.onSaving?.();
      return VIDEO;
    },
    onState: (s) => states.push(s),
    onPickError: (_p, m) => pickErrors.push(m),
    onUploaded: (v) => uploaded.push(v),
    ...over,
  });
  return { ctl, states, pickErrors, uploaded, uploads };
}

test('HAPPY PATH: checking -> uploading (with progress) -> saving -> cleared, and the screen is told the video is in', async () => {
  const { ctl, states, uploaded, uploads } = setup();
  await ctl.start(file(), 'before');
  assert.deepEqual(states.map((s) => s?.stage ?? null), ['reading', 'uploading', 'uploading', 'saving', null]);
  assert.equal(states[2]!.progress, 0.5);
  assert.equal(uploaded.length, 1);
  assert.equal(uploads[0].visitId, 'visit-1');
  assert.equal(uploads[0].phase, 'before');
  assert.equal(uploads[0].mime, 'video/mp4');
  assert.equal(uploads[0].ext, 'mp4');
  assert.equal(uploads[0].durationSeconds, 30);
  assert.ok(uploads[0].thumbnail);
  assert.equal(ctl.busy, false);
});

test('DUPLICATES: a second file picked (or a double click) while one is in progress is ignored, never queued or doubled', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: UploadReportVideoInput[] = [];
  const { ctl } = setup({ upload: async (i) => { seen.push(i); await gate; return VIDEO; } });
  const first = ctl.start(file('a.mp4'), 'before');
  assert.equal(ctl.busy, true, 'busy straight away, before anything has been awaited');
  await ctl.start(file('b.mp4'), 'during');
  void ctl.start(file('c.mp4'), 'after');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.length, 1, 'exactly one upload');
  release();
  await first;
  assert.equal(ctl.busy, false);
});

test('COMPLETED REPORT: nothing starts - not even a file read - and the manager is told why', async () => {
  let read = 0;
  const { ctl, pickErrors, states, uploads } = setup({ readMetadata: async () => { read += 1; return { durationSeconds: 1, thumbnail: null }; } }, { completed: true });
  await ctl.start(file(), 'before');
  assert.equal(read, 0);
  assert.equal(uploads.length, 0);
  assert.equal(states.length, 0);
  assert.match(pickErrors[0]!, /marked Completed[\s\S]*Reopen it first/);
  assert.equal(ctl.busy, false);
});

test('REFUSED BEFORE UPLOADING: wrong type, too big, section full, report full - each with its own message, nothing read or sent', async () => {
  const cases: [string, ReturnType<typeof file>, 'before' | 'during' | 'after', { phase: 'before' | 'during' | 'after' }[], RegExp][] = [
    ['wrong type', file('notes.txt', 'text/plain'), 'before', [], /MP4, MOV or WebM/],
    ['too big', file('big.mp4', 'video/mp4', 157_286_401), 'before', [], /150 MB/],
    ['section full', file(), 'before', [{ phase: 'before' }, { phase: 'before' }, { phase: 'before' }], /Before section already has 3 videos/],
    ['report full', file(), 'after', ['before', 'before', 'during', 'during', 'after', 'after', 'before', 'during'].map((phase) => ({ phase }) as { phase: 'before' | 'during' | 'after' }), /already has 8 videos/],
  ];
  for (const [name, f, phase, videos, message] of cases) {
    let read = 0;
    const { ctl, pickErrors, states, uploads } = setup({ readMetadata: async () => { read += 1; return { durationSeconds: 1, thumbnail: null }; } }, { videos });
    await ctl.start(f, phase);
    assert.match(pickErrors[pickErrors.length - 1]!, message, name);
    assert.equal(read + uploads.length + states.length, 0, `${name}: nothing was read, uploaded or shown as progress`);
    assert.equal(ctl.busy, false, name);
  }
});

test('TOO LONG: refused after reading its length, with no upload and no "Try again" (the same file cannot succeed)', async () => {
  const { ctl, states, uploads } = setup({ readMetadata: async () => ({ durationSeconds: 95, thumbnail: null }) });
  await ctl.start(file(), 'before');
  const last = states[states.length - 1]!;
  assert.equal(last.stage, 'failed');
  assert.equal(last.retryable, false);
  assert.match(last.error!, /1:35 long\. The limit is 1:00/);
  assert.equal(uploads.length, 0);
  await ctl.retry();
  assert.equal(uploads.length, 0, 'retry does nothing');
});

test('A VIDEO THE BROWSER CANNOT READ still uploads: its length and poster are simply left empty (the server still checks it)', async () => {
  const { ctl, uploads } = setup({ readMetadata: async () => ({ durationSeconds: null, thumbnail: null }) });
  await ctl.start(file('iphone.mov', ''), 'during');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].durationSeconds, null);
  assert.equal(uploads[0].thumbnail, null);
  assert.equal(uploads[0].mime, 'video/quicktime');
  assert.equal(uploads[0].ext, 'mov');
});

test('FAILURE then RETRY: a plain message with "Try again"; retry sends the SAME file again from the start and succeeds', async () => {
  let attempt = 0;
  const seen: UploadReportVideoInput[] = [];
  const { ctl, states, uploaded } = setup({
    upload: async (i) => {
      seen.push(i);
      attempt += 1;
      if (attempt === 1) throw new Error('Failed to fetch');
      return VIDEO;
    },
  });
  const f = file('site.mp4');
  await ctl.start(f, 'during');
  const failed = states[states.length - 1]!;
  assert.equal(failed.stage, 'failed');
  assert.equal(failed.retryable, true);
  assert.match(failed.error!, /interrupted[\s\S]*try again/i);
  assert.equal(ctl.busy, false, 'free to retry');
  await ctl.retry();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].file, f, 'the same file');
  assert.equal(seen[1].phase, 'during');
  assert.equal(uploaded.length, 1, 'recorded once');
  assert.equal(states[states.length - 1], null);
});

test('FAILURE messages are readable: Storage size refusal, permission refusal, the database\'s own limit message', async () => {
  const cases: [unknown, RegExp][] = [
    [new UploadError('The object exceeded the maximum allowed size', 413), /larger than the 150 MB limit/],
    [new UploadError('new row violates row-level security policy', 403), /permission[\s\S]*reopen it first/],
    [new Error('Only 3 videos can be added to each section (Before / During / After).'), /Only 3 videos can be added to each section/],
  ];
  for (const [err, re] of cases) {
    const { ctl, states } = setup({ upload: async () => { throw err; } });
    await ctl.start(file(), 'before');
    assert.match(states[states.length - 1]!.error!, re);
  }
});

test('CANCEL stops the upload for real, shows no failure, and leaves the screen free to upload again', async () => {
  let sawSignal: AbortSignal | undefined;
  const { ctl, states, uploaded } = setup({
    upload: (i) =>
      new Promise((_resolve, reject) => {
        sawSignal = i.signal;
        i.signal!.addEventListener('abort', () => reject(new UploadCancelledError()));
      }),
  });
  const run = ctl.start(file(), 'before');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ctl.busy, true);
  ctl.cancel();
  await run;
  assert.equal(sawSignal!.aborted, true);
  assert.equal(states[states.length - 1], null, 'cleared, not "failed"');
  assert.equal(uploaded.length, 0);
  assert.equal(ctl.busy, false);
});

test('CANCEL while still checking the file never starts the upload', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { ctl, uploads, states } = setup({ readMetadata: async () => { await gate; return { durationSeconds: 5, thumbnail: null }; } });
  const run = ctl.start(file(), 'before');
  ctl.cancel();
  release();
  await run;
  assert.equal(uploads.length, 0);
  assert.equal(states[states.length - 1], null);
});

test('DISMISS clears a failure and forgets the file (retry then does nothing); it never interrupts a running upload', async () => {
  const { ctl, states, uploads } = setup({ upload: async () => { throw new Error('nope'); } });
  await ctl.start(file(), 'before');
  assert.equal(states[states.length - 1]!.stage, 'failed');
  ctl.dismiss();
  assert.equal(states[states.length - 1], null);
  const before = uploads.length;
  await ctl.retry();
  assert.equal(uploads.length, before);

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const running = setup({ upload: async () => { await gate; return VIDEO; } });
  const run = running.ctl.start(file(), 'before');
  await new Promise((r) => setTimeout(r, 5));
  const n = running.states.length;
  running.ctl.dismiss();
  assert.equal(running.states.length, n, 'dismiss is ignored while uploading');
  release();
  await run;
});
