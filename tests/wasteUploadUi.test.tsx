// What the waste reporter sees while files upload (src/waste/wasteMediaStatus.ts, WasteMediaSection, WasteShell), the screen
// wake lock's fallbacks (src/waste/wakeLock.ts), and guards: the Job Reports uploader is untouched, the waste uploader only ever
// PAUSES (never deletes) a resumable upload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeWasteMedia, formatMb } from '../src/waste/wasteMediaStatus';
import WasteMediaSection from '../src/waste/WasteMediaSection';
import { KeepOpenNotice } from '../src/waste/WasteShell';
import type { WasteMedia } from '../src/waste/offline/wasteDb';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const MB = 1024 * 1024;
function media(over: Partial<WasteMedia> = {}): WasteMedia {
  return {
    id: 'm1', ownerId: 'u', reportId: 'r', kind: 'photo', phase: 'before', blob: new Blob(['x']), fileName: 'a.jpg', mime: 'image/jpeg', ext: 'jpg', sizeBytes: 48 * MB,
    sourceKey: 'k', durationSeconds: null, thumbnail: null, storagePath: 'p', thumbPath: null, fileUploaded: false, thumbUploaded: false, tusUrl: null, status: 'pending',
    progress: 0, lastError: null, permanentFailure: false, attempts: 0, nextAttemptAt: null, sortOrder: 0, createdAt: '2026-11-06T10:00:00Z', ...over,
  };
}
const live = (over: Partial<Parameters<typeof describeWasteMedia>[1]> = {}) => ({ fraction: null, bytes: null, online: true, ...over });

test('TILE: a video uploading shows real MB sent; a photo shows a percentage', () => {
  assert.equal(describeWasteMedia(media({ kind: 'video', status: 'uploading' }), live({ fraction: 0.25, bytes: { sent: 12.4 * MB, total: 48 * MB } })).label, 'Uploading 12.4 of 48.0 MB');
  assert.equal(describeWasteMedia(media({ status: 'uploading' }), live({ fraction: 0.42 })).label, 'Uploading 42%');
  assert.equal(formatMb(150 * MB), '150.0');
});

test('TILE: waiting to retry says which attempt, the last reason and when; offline says waiting for signal; Try now is offered', () => {
  const m = media({ attempts: 3, lastError: 'The connection stopped responding. It will carry on by itself.', lastErrorAt: '2026-11-06T12:04:00Z', nextAttemptAt: '2026-11-06T12:05:00Z' });
  const online = describeWasteMedia(m, live());
  assert.equal(online.label, 'Waiting to retry · attempt 3');
  assert.match(online.detail!, /stopped responding.*at 12:04/);
  assert.equal(online.canRetry, true);
  assert.equal(describeWasteMedia(m, live({ online: false })).label, 'Waiting for signal · attempt 3');
});

test('TILE: a video paused for another report says so, with what the server already has - and it is not a failure', () => {
  const d = describeWasteMedia(media({ kind: 'video', pausedForTurn: true, bytesConfirmed: 24 * MB }), live());
  assert.equal(d.label, 'Paused');
  assert.match(d.detail!, /Another report’s video is uploading.*24\.0 of 48\.0 MB sent/);
  assert.equal(d.tone, 'wait');
  assert.equal(d.canRetry, false);
});

test('TILE: an unreadable file says exactly what to do; a refused one says why; neither offers Try again', () => {
  const unreadable = describeWasteMedia(media({ status: 'failed', permanentFailure: true, failureKind: 'unreadable', lastError: 'This file can’t be read from your phone. Remove it and add it again.' }), live());
  assert.equal(unreadable.label, 'Can’t be read');
  assert.equal(unreadable.detail, 'This file can’t be read from your phone. Remove it and add it again.');
  assert.equal(unreadable.canRetry, false);
  const refused = describeWasteMedia(media({ status: 'failed', permanentFailure: true, failureKind: 'refused', lastError: 'That video is 61.00 seconds long. The limit is 60 seconds.' }), live());
  assert.equal(refused.label, 'Not accepted');
  assert.match(refused.detail!, /61\.00 seconds.*Remove it to send the report\./);
});

test('TILE: a stale "uploading" with nothing running is never shown as a live upload with a number', () => {
  assert.equal(describeWasteMedia(media({ status: 'uploading' }), live()).label, 'Uploading…');
  assert.equal(describeWasteMedia(media({ status: 'checking' }), live()).label, 'Checking…');
});

test('SECTION: every stuck or waiting file is explained under the tiles (not only refused ones)', () => {
  const props = { phase: 'before' as const, progressOf: () => null, previewUrl: () => 'blob:x', addError: null, onAdd: () => {}, onRemove: () => {}, onRetry: () => {}, locked: false };
  const html = renderToStaticMarkup(
    <WasteMediaSection
      {...props}
      media={[
        media({ id: 'w', attempts: 2, lastError: 'The upload was interrupted. It will carry on by itself.' }),
        media({ id: 'u', sortOrder: 1, status: 'failed', permanentFailure: true, failureKind: 'unreadable', lastError: 'This file can’t be read from your phone. Remove it and add it again.' }),
      ]}
    />,
  );
  assert.match(html, /Photo 1:<\/span> The upload was interrupted/);
  assert.match(html, /Photo 2:<\/span> This file can’t be read from your phone\. Remove it and add it again\./);
  assert.match(html, /Waiting to retry · attempt 2/);
});

test('KEEP OPEN: while uploading he is told to keep the screen open; the wording depends on whether the screen can be kept on', () => {
  assert.match(renderToStaticMarkup(<KeepOpenNotice wakeLock="on" />), /keep this screen open.*The screen will stay on meanwhile\./);
  for (const state of ['unsupported', 'refused', 'off'] as const) assert.match(renderToStaticMarkup(<KeepOpenNotice wakeLock={state} />), /Turn off Auto-Lock/);
});

test('WAKE LOCK: unsupported or refused never throws and never blocks anything', async () => {
  const wake = await import('../src/waste/wakeLock');
  const nav = globalThis.navigator as any;
  const had = nav && 'wakeLock' in nav;
  try {
    if (nav) Object.defineProperty(nav, 'wakeLock', { value: undefined, configurable: true });
    wake.keepScreenAwake(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(wake.getWakeLockState(), 'unsupported');
    if (nav) Object.defineProperty(nav, 'wakeLock', { value: { request: async () => { throw new Error('NotAllowedError'); } }, configurable: true });
    wake.keepScreenAwake(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(['refused', 'unsupported'].includes(wake.getWakeLockState()));
    wake.keepScreenAwake(false);
  } finally {
    if (nav && !had) delete nav.wakeLock;
  }
});

// ---- guards --------------------------------------------------------------------------------------------------------------------------
test('GUARD: the waste uploader only PAUSES a resumable upload (abort(false)) - it never deletes it from the server', () => {
  const tus = src('src', 'waste', 'wasteTus.ts');
  assert.match(tus, /upload\.abort\(false\)/);
  assert.doesNotMatch(tus, /upload\.abort\(true\)/);
  assert.match(tus, /onChunkComplete:[\s\S]*pauseAtChunkBoundary/, 'a turn ends only at a server-confirmed chunk');
});

test('GUARD: Job Reports keep their own uploader, unchanged; the waste code does not use it', () => {
  const shared = src('src', 'lib', 'reportVideoUpload.ts');
  assert.match(shared, /void upload\.abort\(true\)\.finally\(\(\) => reject\(new UploadCancelledError\(\)\)\)/, 'Job Reports cancel behaviour as before');
  for (const f of ['wasteApi.ts', 'offline/wasteSyncEngine.ts']) assert.doesNotMatch(src('src', 'waste', f), /resumableUpload\(/, f);
  const tech = src('src', 'technician', 'offline', 'videoSyncEngine.ts');
  assert.doesNotMatch(tech, /waste/i);
});

test('GUARD: the 60-second and 150 MB limits are unchanged', () => {
  const rules = src('src', 'waste', 'wasteRules.ts');
  assert.match(rules, /maxVideoBytes: 157_286_400/);
  assert.match(rules, /maxVideoSeconds: 60,/);
});
