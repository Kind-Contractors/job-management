// What the technician sees for videos, on the REAL components, server-rendered to static markup (there is no DOM library here): the "+ Video"
// action under each section, the limits, the tiles for videos already with the office and for videos still on the device (waiting, offline,
// uploading with progress, failed, refused), and the confirmations. The queue/engine behaviour behind the buttons is tested without a
// DOM in technicianVideoQueue.test.ts (mocked network).
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import PhotoDeleteButton from '../src/technician/PhotoDeleteButton';
import ConfirmDeleteDialog from '../src/technician/ConfirmDeleteDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import TechnicianVideos, { QueuedVideoTile, ServerVideoTile } from '../src/technician/TechnicianVideos';
import { technicianKeys } from '../src/technician/queryKeys';
import { videoDisplay } from '../src/technician/offline/videoQueueLogic';
import type { TechnicianOwnVideo } from '../src/technician/videoApi';
import type { QueuedVideo } from '../src/technician/offline/videoDb';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const USER = 'tech-1';
const VISIT = 'visit-1';

function server(id: string, phase: 'before' | 'during' | 'after', over: Partial<TechnicianOwnVideo> = {}): TechnicianOwnVideo {
  return { id, phase, storagePath: `${VISIT}/${phase}/${id}.mp4`, thumbnailPath: null, mimeType: 'video/mp4', sizeBytes: 5 * 1024 * 1024, durationSeconds: 42, createdAt: '2026-10-12T10:00:00Z', canDelete: true, ...over };
}
function queued(over: Partial<QueuedVideo> = {}): QueuedVideo {
  return {
    id: 'q1', ownerId: USER, visitId: VISIT, phase: 'before', blob: new Blob(['x']), fileName: 'site.mp4', mime: 'video/mp4', ext: 'mp4', sizeBytes: 12 * 1024 * 1024, sourceKey: 'k',
    durationSeconds: 30, thumbnail: null, status: 'pending', videoPath: 'p', thumbPath: null, videoUploaded: false, thumbUploaded: false, tusUrl: null, lastError: null,
    permanentFailure: false, attempts: 0, nextAttemptAt: null, leaseUntil: null, createdAt: '2026-10-12T10:00:00Z', ...over,
  };
}

function section(videos: TechnicianOwnVideo[] | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  if (videos) qc.setQueryData(technicianKeys.myVideos(USER, VISIT), videos);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TechnicianVideos visitId={VISIT} userId={USER} />
    </QueryClientProvider>,
  );
}
const phaseBlock = (html: string, phase: string) => {
  const start = html.indexOf(`data-testid="tech-video-phase-${phase}"`);
  assert.ok(start >= 0);
  const rest = ['before', 'during', 'after'].map((p) => html.indexOf(`data-testid="tech-video-phase-${p}"`, start + 10)).filter((i) => i > start);
  return html.slice(start, rest.length ? Math.min(...rest) : undefined);
};
const plusVideo = (h: string) => /<button[^>]*>\s*\+ Video\s*<\/button>/.exec(h)![0];
const disabled = /\sdisabled=""/;

test('SECTIONS: Before, During and After each have a clear "+ Video" action, a count, and the limits are stated', () => {
  const html = section([]);
  for (const p of ['before', 'during', 'after']) assert.match(plusVideo(phaseBlock(html, p)), /\+ Video/);
  assert.match(phaseBlock(html, 'before'), /Before \(0\)/);
  assert.match(html, /Videos \(optional\)/);
  assert.match(html, /MP4, MOV or WebM · up to 150 MB and 1:00 each · 3 per section/);
  assert.match(html, /type="file"[^>]*accept="video\/mp4,video\/quicktime,video\/webm,\.mp4,\.mov,\.webm"/, 'the picker offers only the accepted video types');
  assert.match(html, /multiple/, 'several videos can be chosen at once');
});

test('HONEST WORDING: videos upload while the app is open and online, carry on next time it is opened, never block "Complete job" and do not replace the photo', () => {
  const html = section([]);
  assert.match(html, /saved on this device and upload while the app is open and online; if you close the app they carry on next time you open it/);
  assert.match(html, /never stops you completing the job, and does not replace the required photo/);
  assert.doesNotMatch(html, /in the background|even when the app is closed/i);
});

test('LIMITS: three in a section disables that section\'s button (with the reason); eight on the visit disables all of them', () => {
  const three = section([server('a', 'before'), server('b', 'before'), server('c', 'before')]);
  assert.match(plusVideo(phaseBlock(three, 'before')), disabled);
  assert.match(plusVideo(phaseBlock(three, 'before')), /At most 3 videos per section/);
  assert.doesNotMatch(plusVideo(phaseBlock(three, 'during')), disabled);
  const eight = section(['before', 'before', 'before', 'during', 'during', 'during', 'after', 'after'].map((p, i) => server(`v${i}`, p as any)));
  for (const p of ['before', 'during', 'after']) assert.match(plusVideo(phaseBlock(eight, p)), disabled, p);
  assert.match(phaseBlock(eight, 'after'), /At most 8 videos per job/);
});

test('VIDEOS ALREADY WITH THE OFFICE: shown under their section, with length, size, Play and Delete; after approval Delete is replaced by a note', () => {
  const html = section([server('a', 'during'), server('b', 'during', { canDelete: false })]);
  const during = phaseBlock(html, 'during');
  assert.match(during, /During \(2\)/);
  assert.equal((during.match(/data-testid="server-video"/g) ?? []).length, 2);
  assert.match(during, /0:42 · 5\.0 MB/);
  assert.match(during, /Uploaded · with the office/);
  assert.match(during, /aria-label="Play During video"/);
  assert.match(during, />\s*Delete\s*<\/button>/);
  assert.match(during, /The office has approved this report/);
});

test('A FAILED LIST LOAD does not hide the section: the technician can still add videos, and is told what is missing', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TechnicianVideos visitId={VISIT} userId={USER} />
    </QueryClientProvider>,
  );
  assert.match(plusVideo(phaseBlock(html, 'before')), /\+ Video/, 'still usable while the list is loading or unavailable');
});

// ---- tiles for videos still on the device ---------------------------------------------------------------------------------------
const tile = (v: QueuedVideo, over: Record<string, unknown> = {}, online = true, progress: number | null = null) =>
  renderToStaticMarkup(
    <QueuedVideoTile
      video={v}
      display={videoDisplay(v, online, progress)}
      progress={progress}
      posterUrl={null}
      playUrl={null}
      confirmingRemove={false}
      onPlay={noop}
      onRetry={noop}
      onAskRemove={noop}
      onConfirmRemove={noop}
      onKeep={noop}
      {...over}
    />,
  );

test('QUEUED TILE: waiting online, waiting OFFLINE, retrying - each says plainly where the video is', () => {
  assert.match(tile(queued()), /Saved on this device · waiting to upload/);
  assert.match(tile(queued(), {}, false), /Saved on this device · waiting for a connection/);
  assert.match(tile(queued({ attempts: 2 })), /Will retry shortly…/);
  assert.match(tile(queued()), /0:30 · 12 MB/);
});

test('QUEUED TILE: uploading shows a live percentage and progress bar, and offers Cancel (not Delete)', () => {
  const html = tile(queued({ status: 'uploading' }), {}, true, 0.42);
  assert.match(html, /Uploading… 42%/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="42"/);
  assert.match(html, /width:42%/);
  assert.match(html, />Cancel<\/button>/);
  assert.doesNotMatch(html, />Delete<\/button>/);
});

test('QUEUED TILE: a failed video shows why, with Try again and Delete; a refused one says it could not be sent', () => {
  const failed = tile(queued({ status: 'failed', attempts: 6, lastError: 'The upload was interrupted. Check your connection and try again.' }));
  assert.match(failed, /Failed — tap to retry/);
  assert.match(failed, /role="alert"[^>]*>The upload was interrupted/);
  assert.match(failed, />Try again<\/button>/);
  assert.match(failed, />Delete<\/button>/);
  const refused = tile(queued({ status: 'failed', permanentFailure: true, lastError: 'This report is marked Completed, so videos can’t be added or changed.' }));
  assert.match(refused, /Could not be sent/);
  assert.match(refused, /marked Completed/);
});

test('QUEUED TILE: deleting opens the same popup as a photo and warns the video has not reached the office; cancelling an upload says so', () => {
  const idle = tile(queued());
  assert.doesNotMatch(idle, /role="alertdialog"/, 'no popup until Delete is pressed');
  const open = tile(queued(), { confirmingRemove: true });
  assert.match(open, /role="alertdialog"[^>]*aria-modal="true"[^>]*aria-label="Delete this video"/);
  assert.match(open, /Are you sure you want to delete this video\? It has not reached the office yet, so it will be lost\./);
  assert.match(open, />Cancel<\/button>/);
  assert.match(open, />Delete<\/button>/);
  assert.match(open, /fixed inset-0/, 'a full-screen dimmed overlay, like the photo popup');
  assert.match(tile(queued({ status: 'uploading' }), { confirmingRemove: true }, true, 0.1), /Are you sure you want to cancel this upload and delete the video\?/);
});

test('POSTER FALLBACK: with no poster the tile still has a Play button on a plain placeholder; with a poster it is shown', () => {
  const bare = tile(queued());
  assert.match(bare, /aria-label="Play Before video"/);
  assert.match(bare, />▶</);
  assert.doesNotMatch(bare, /<img/);
  assert.match(tile(queued(), { posterUrl: 'blob:poster-1' }), /<img src="blob:poster-1"/);
});

test('PREVIEW: a queued video plays from the file on the device (no network); a server video plays from its signed link', () => {
  assert.match(tile(queued(), { playUrl: 'blob:local-1' }), /<video[^>]*controls=""[^>]*src="blob:local-1"/);
  const html = renderToStaticMarkup(
    <ServerVideoTile video={server('a', 'before')} posterUrl={null} playUrl="https://x.supabase.co/storage/v1/object/sign/report-videos/p.mp4?token=t" playError={null} confirmingRemove={false} removePending={false} removeError={null} onPlay={noop} onAskRemove={noop} onConfirmRemove={noop} onKeep={noop} />,
  );
  assert.match(html, /<video[^>]*controls=""[^>]*src="https:\/\/x\.supabase\.co\/storage\/v1\/object\/sign\/report-videos\/p\.mp4\?token=t"/);
});

test('SERVER TILE: deleting opens the same popup as a photo, shows its own progress and its own failure (for example after the office approved)', () => {
  const render = (over: Record<string, unknown>) =>
    renderToStaticMarkup(
      <ServerVideoTile video={server('a', 'before')} posterUrl={null} playUrl={null} playError={null} confirmingRemove={false} removePending={false} removeError={null} onPlay={noop} onAskRemove={noop} onConfirmRemove={noop} onKeep={noop} {...over} />,
    );
  assert.doesNotMatch(render({}), /role="alertdialog"/, 'no popup until Delete is pressed');
  const open = render({ confirmingRemove: true });
  assert.match(open, /role="alertdialog"[^>]*aria-modal="true"[^>]*aria-label="Delete this video"/);
  assert.match(open, /Are you sure you want to delete this video\?/);
  assert.match(open, /<button[^>]*autofocus=""[^>]*>Cancel<\/button>/, 'Cancel has focus, so a stray Enter does not delete');
  assert.match(open, />Delete<\/button>/);
  const busy = render({ confirmingRemove: true, removePending: true });
  assert.match(busy, />Deleting…<\/button>/, 'the popup stays up and shows progress while the delete runs');
  assert.equal((busy.match(/disabled=""/g) ?? []).length >= 2, true, 'both popup buttons are disabled while deleting');
  assert.match(render({ removeError: 'A video can only be removed before the office has approved the report. Please ask the office.' }), /role="alert"[^>]*>A video can only be removed before the office has approved/);
  assert.match(render({ playError: 'Connect to the internet to watch this video.' }), /Connect to the internet/);
});

test('POPUP PARITY: videos and photos use the same dialog component, so wording style, buttons and behaviour match', () => {
  const photo = renderToStaticMarkup(<PhotoDeleteButton needsConfirm ariaLabel="Delete before photo" onDelete={async () => {}} onError={() => {}} />);
  assert.doesNotMatch(photo, /role="alertdialog"/, 'idle photo button shows no popup');
  const dialog = (message: string) => renderToStaticMarkup(<ConfirmDeleteDialog ariaLabel="x" message={message} busy={false} onCancel={() => {}} onConfirm={() => {}} />);
  const photoPopup = dialog('Are you sure you want to delete this photo?');
  const videoPopup = dialog('Are you sure you want to delete this video?');
  assert.equal(photoPopup.replace('photo', 'video'), videoPopup, 'identical markup apart from the word');
});
