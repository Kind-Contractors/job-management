// Rendering tests for the manager's video controls in Report review, on the REAL components. The page is server-rendered to static
// markup from a seeded query cache (there is no DOM library in this repo), so these check WHAT IS SHOWN for each report state:
// the three sections, counts and limits, the inclusion ticks, the Completed lock, the remove confirmation, upload progress and
// failures. The behaviour behind the buttons is tested without a DOM in videoUploadController.test.ts (the upload flow) and
// reportVideosData.test.ts (what is sent to the database), and against DEV (see the live manager test).
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import ReportVideos, { UploadProgress, VideoCard, type VideoCardProps } from '../src/components/reports/ReportVideos';
import ReportPanel from '../src/components/jobs/ReportPanel';
import type { ReportVideo } from '../src/repository/reportVideosRepository';
import type { UploadState } from '../src/lib/videoUploadController';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const VISIT = 'visit-1';

function video(id: string, phase: 'before' | 'during' | 'after', over: Partial<ReportVideo> = {}): ReportVideo {
  return {
    id, visitId: VISIT, phase, storagePath: `${VISIT}/${phase}/${id}.mp4`, thumbnailPath: `${VISIT}/${phase}/${id}.jpg`, mimeType: 'video/mp4', sizeBytes: 5 * 1024 * 1024,
    durationSeconds: 42, source: 'technician', uploadedByName: 'Mo', includeInClientReport: true, createdAt: '2026-10-12T10:00:00Z', ...over,
  };
}

function section(opts: { videos?: ReportVideo[]; completed?: boolean; reviewStatus?: any; reviewedAt?: string | null } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['reportVideos', VISIT], opts.videos ?? []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReportVideos
        reportId="r1"
        visitId={VISIT}
        reviewStatus={opts.reviewStatus ?? 'awaiting_review'}
        reviewedAt={opts.reviewedAt ?? null}
        completed={opts.completed ?? false}
        actor="luke@x"
      />
    </QueryClientProvider>,
  );
}
const phaseHtml = (html: string, phase: string) => {
  const start = html.indexOf(`data-testid="video-phase-${phase}"`);
  assert.ok(start >= 0, `phase ${phase} is shown`);
  const next = ['before', 'during', 'after'].map((p) => html.indexOf(`data-testid="video-phase-${p}"`, start + 10)).filter((i) => i > start);
  return html.slice(start, next.length ? Math.min(...next) : undefined);
};
const addButton = (h: string) => /<button[^>]*>\s*\+ Add video\s*<\/button>/.exec(h)![0];

// ---- the three sections ------------------------------------------------------------------------------------------------
test('SECTIONS: Before, During and After are always shown, each with its own count out of 3 and its own Add video button', () => {
  const html = section({ videos: [video('a', 'before'), video('b', 'before'), video('c', 'after')] });
  assert.match(phaseHtml(html, 'before'), /Before \(2\/3\)/);
  assert.match(phaseHtml(html, 'during'), /During \(0\/3\)/);
  assert.match(phaseHtml(html, 'after'), /After \(1\/3\)/);
  for (const p of ['before', 'during', 'after']) assert.match(phaseHtml(html, p), /\+ Add video/);
  assert.equal((html.match(/data-testid="video-card"/g) ?? []).length, 3, 'multiple videos per section');
});

test('LIMITS: a full section (3) disables only that section\'s Add button, with the reason; the others stay usable', () => {
  const html = section({ videos: [video('a', 'before'), video('b', 'before'), video('c', 'before')] });
  assert.match(addButton(phaseHtml(html, 'before')), /\sdisabled=""/);
  assert.match(addButton(phaseHtml(html, 'before')), /At most 3 videos per section/);
  assert.doesNotMatch(addButton(phaseHtml(html, 'during')), /\sdisabled=""/);
  assert.doesNotMatch(addButton(phaseHtml(html, 'after')), /\sdisabled=""/);
});

test('LIMITS: a full report (8) disables every Add button', () => {
  const videos = ['before', 'before', 'before', 'during', 'during', 'during', 'after', 'after'].map((p, i) => video(`v${i}`, p as any));
  const html = section({ videos });
  for (const p of ['before', 'during', 'after']) {
    assert.match(addButton(phaseHtml(html, p)), /\sdisabled=""/, p);
  }
  assert.match(phaseHtml(html, 'after'), /At most 8 videos per report/);
});

test('The stated limits are on screen: types, size, length, per-section and per-report counts, and that videos are shown to the client unless unticked', () => {
  const html = section();
  assert.match(html, /MP4, MOV or WebM · up to 150 MB and 1:00 each · 3 per section, 8 per report/);
  assert.match(html, /Videos are shown to the client unless you untick them/);
  assert.doesNotMatch(html, /not shown to the client unless ticked/);
});

test('EMPTY: a report with no videos (every older report) shows empty sections, no error, nothing about the client', () => {
  const html = section();
  assert.doesNotMatch(html, /role="alert"/);
  assert.equal((html.match(/data-testid="video-card"/g) ?? []).length, 0);
});

// ---- inclusion --------------------------------------------------------------------------------------------------------------
test('INCLUDE FOR CLIENT: ticked by default (the manager unticks to keep a video from the client), one tick per video', () => {
  const html = section({ videos: [video('a', 'before'), video('b', 'before', { includeInClientReport: false })] });
  const [first, second] = html.split('data-testid="video-card"').slice(1);
  assert.match(first, /<input type="checkbox"[^>]*\schecked=""[^>]*\/>\s*Include for client/);
  assert.match(second, /<input type="checkbox"(?![^>]*\schecked)[^>]*\/>\s*Include for client/);
});

test('NO report-level switch: there is no "Include videos in the client report" checkbox and no "switched off" message, with or without videos', () => {
  for (const videos of [[], [video('a', 'before')], [video('a', 'before', { includeInClientReport: false })]]) {
    const html = section({ videos });
    assert.doesNotMatch(html, /Include videos in the client report/);
    assert.doesNotMatch(html, /switched off for the client report/);
  }
});

// ---- report states ------------------------------------------------------------------------------------------------------------
test('COMPLETED: add buttons and the inclusion ticks are locked, the reason is shown, and Remove is still offered', () => {
  const html = section({ videos: [video('a', 'before')], completed: true });
  assert.match(html, /This report is Completed, so videos can’t be added and the “Include” choices can’t be changed\. A video can still be removed\./);
  for (const p of ['before', 'during', 'after']) {
    assert.match(addButton(phaseHtml(html, p)), /\sdisabled=""/);
    assert.match(addButton(phaseHtml(html, p)), /This report is Completed/);
  }
  const card = html.split('data-testid="video-card"')[1];
  assert.match(card, /<input type="checkbox"[^>]*\sdisabled=""[^>]*\/>\s*Include for client/);
  assert.match(card, />\s*Remove\s*<\/button>/, 'removal is still allowed on a Completed report');
});

test('NOT COMPLETED: everything is enabled, and no Completed notice is shown (returned, awaiting review and approved all behave the same)', () => {
  for (const reviewStatus of ['awaiting_review', 'returned_for_correction', 'approved'] as const) {
    const html = section({ videos: [video('a', 'before')], reviewStatus });
    assert.doesNotMatch(html, /report is Completed/, reviewStatus);
    assert.doesNotMatch(addButton(phaseHtml(html, 'during')), /\sdisabled=""/, reviewStatus);
    assert.doesNotMatch(html.split('data-testid="video-card"')[1], /<input type="checkbox"[^>]*\sdisabled=""/, reviewStatus);
  }
});

test('ADDED AFTER APPROVAL: a video that arrived after the report was approved is flagged; one from before is not; only on an approved report', () => {
  const videos = [video('old', 'before', { createdAt: '2026-10-12T09:00:00Z' }), video('late', 'before', { createdAt: '2026-10-12T15:00:00Z' })];
  const html = section({ videos, reviewStatus: 'approved', reviewedAt: '2026-10-12T12:00:00Z' });
  const [old, late] = html.split('data-testid="video-card"').slice(1);
  assert.doesNotMatch(old, /Added after approval/);
  assert.match(late, /Added after approval/);
  assert.doesNotMatch(section({ videos, reviewStatus: 'awaiting_review', reviewedAt: null }), /Added after approval/);
});

// ---- a video card -------------------------------------------------------------------------------------------------------------
const cardProps = (over: Partial<VideoCardProps> = {}): VideoCardProps => ({
  video: video('a', 'before'), posterUrl: 'https://signed.example/poster.jpg', playUrl: null, playError: null, playLoading: false, canChange: true, includePending: false,
  confirmingRemove: false, removePending: false, removeError: null, addedAfterApproval: false,
  onPlay: noop, onPlayFailed: noop, onToggleInclude: noop, onAskRemove: noop, onConfirmRemove: noop, onCancelRemove: noop, ...over,
});

test('CARD: shows the poster behind a Play button, the length and size, and who added it', () => {
  const html = renderToStaticMarkup(<VideoCard {...cardProps()} />);
  assert.match(html, /<img src="https:\/\/signed\.example\/poster\.jpg"/);
  assert.match(html, /aria-label="Play Before video"/);
  assert.match(html, /0:42 · 5\.0 MB/);
  assert.match(html, /· Mo/);
  assert.match(renderToStaticMarkup(<VideoCard {...cardProps({ video: video('a', 'before', { source: 'manager', uploadedByName: null }) })} />), /Added by the office/);
  assert.doesNotMatch(html, /<video/, 'nothing loads until Play is pressed');
});

test('CARD: while playing it shows a streaming player on the short-lived link, with controls (the browser sends Range requests itself)', () => {
  const html = renderToStaticMarkup(<VideoCard {...cardProps({ playUrl: 'https://x.supabase.co/storage/v1/object/sign/report-videos/p.mp4?token=t' })} />);
  assert.match(html, /<video[^>]*controls=""[^>]*src="https:\/\/x\.supabase\.co\/storage\/v1\/object\/sign\/report-videos\/p\.mp4\?token=t"/);
  assert.match(html, /preload="metadata"/);
});

test('CARD: a playback failure says so and offers Reload; a video with no poster still has a Play button', () => {
  const failed = renderToStaticMarkup(<VideoCard {...cardProps({ playError: 'This video couldn’t be played here.' })} />);
  assert.match(failed, /role="alert"[^>]*>This video couldn’t be played here\.[\s\S]*Reload/);
  const bare = renderToStaticMarkup(<VideoCard {...cardProps({ posterUrl: null })} />);
  assert.match(bare, /aria-label="Play Before video"/);
  assert.doesNotMatch(bare, /<img/);
});

test('REMOVE asks in the same centred popup as the technician view (not inline), says what it does, and shows its own failure', () => {
  const idle = renderToStaticMarkup(<VideoCard {...cardProps()} />);
  assert.doesNotMatch(idle, /alertdialog/);
  assert.match(idle, />Remove<\/button>/);
  const asking = renderToStaticMarkup(<VideoCard {...cardProps({ confirmingRemove: true })} />);
  assert.match(asking, /class="fixed inset-0 z-50[^"]*"/, 'a popup over a dimmed page');
  assert.match(asking, /role="alertdialog" aria-modal="true" aria-label="Delete Before video"/);
  assert.match(asking, /Are you sure you want to delete this video\? The client will no longer be able to open it and any links already sent stop working\. The file is kept\./);
  assert.match(asking, />Cancel<\/button>/);
  assert.match(asking, />Delete<\/button>/);
  assert.doesNotMatch(asking, />Keep<\/button>|>Remove video<\/button>/, 'the old inline box is gone');
  const busy = renderToStaticMarkup(<VideoCard {...cardProps({ confirmingRemove: true, removePending: true })} />);
  assert.match(busy, /Deleting…/);
  assert.equal((busy.match(/<button[^>]*disabled=""[^>]*>(Cancel|Deleting…)<\/button>/g) ?? []).length, 2, 'both popup buttons are disabled while it runs');
  assert.match(renderToStaticMarkup(<VideoCard {...cardProps({ removeError: 'You don’t have permission to do that.' })} />), /role="alert"[^>]*>You don’t have permission/);
});

// ---- upload progress --------------------------------------------------------------------------------------------------
const up = (over: Partial<UploadState> = {}): UploadState => ({ phase: 'during', fileName: 'site-visit.mp4', fileSize: 30 * 1024 * 1024, stage: 'uploading', progress: 0.42, ...over });

test('UPLOAD: shows the file, a live percentage and progress bar, and a Cancel button', () => {
  const html = renderToStaticMarkup(<UploadProgress upload={up()} onCancel={noop} onRetry={noop} onDismiss={noop} />);
  assert.match(html, /site-visit\.mp4/);
  assert.match(html, /30 MB/);
  assert.match(html, /Uploading… 42%/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="42"/);
  assert.match(html, /width:42%/);
  assert.match(html, />Cancel<\/button>/);
});

test('UPLOAD: checking and saving stages say so; Cancel is not offered while saving (the file is already up)', () => {
  assert.match(renderToStaticMarkup(<UploadProgress upload={up({ stage: 'reading', progress: 0 })} onCancel={noop} onRetry={noop} onDismiss={noop} />), /Checking the video…/);
  const saving = renderToStaticMarkup(<UploadProgress upload={up({ stage: 'saving', progress: 1 })} onCancel={noop} onRetry={noop} onDismiss={noop} />);
  assert.match(saving, /Saving…/);
  assert.doesNotMatch(saving, />Cancel<\/button>/);
});

test('UPLOAD FAILURE: the reason is shown with Try again and Dismiss; a failure that cannot succeed on retry offers only Dismiss', () => {
  const retryable = renderToStaticMarkup(<UploadProgress upload={up({ stage: 'failed', error: 'The upload was interrupted. Check your connection and try again.', retryable: true })} onCancel={noop} onRetry={noop} onDismiss={noop} />);
  assert.match(retryable, /role="alert"[^>]*>The upload was interrupted/);
  assert.match(retryable, />Try again<\/button>/);
  assert.match(retryable, />Dismiss<\/button>/);
  const hopeless = renderToStaticMarkup(<UploadProgress upload={up({ stage: 'failed', error: 'That video is 1:35 long. The limit is 1:00.', retryable: false })} onCancel={noop} onRetry={noop} onDismiss={noop} />);
  assert.doesNotMatch(hopeless, />Try again<\/button>/);
  assert.match(hopeless, />Dismiss<\/button>/);
});

// ---- inside the real report panel; photos unchanged ------------------------------------------------------------------------------
const wrapPanel = (el: ReactElement, over: Record<string, unknown> = {}, videos: ReportVideo[] = []) => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['report', 'rp'], {
    id: 'rp', visitId: VISIT, submittedBy: 'Mo', submittedAt: '2026-10-01T11:00:00Z', onSiteStart: null, onSiteEnd: null, workCarriedOut: 'Cleaned', technicianNotes: null, issues: null, specMet: true,
    reviewStatus: 'awaiting_review', reviewedBy: null, reviewedAt: null, returnReason: null, includePhotos: true, includeNotes: true, includeIssues: true, includePrice: false, includeVideos: true,
    sentToClientAt: null, sentToClientBy: null, sentToAccountsAt: null, sentToAccountsBy: null, completedAt: null, completedBy: null, ...over,
  });
  qc.setQueryData(['reportContributions', 'rp'], { contributionMode: false, participants: [], managerEditedAt: null });
  qc.setQueryData(['reportPhotos', 'rp'], []);
  qc.setQueryData(['reportVideos', VISIT], videos);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);
};

test('REPORT PANEL: the Videos block sits right after Photos, then the text fields; photos have their own add controls', () => {
  const html = wrapPanel(<ReportPanel reportId="rp" reviewStatus="awaiting_review" actor="luke@x" readyForAccounts={false} />, {}, [video('a', 'before')]);
  assert.match(html, /data-testid="report-photos"/);
  assert.match(html, /\+ Add photo/);
  assert.doesNotMatch(html, /Save changes/);
  const photos = html.indexOf('>Photos<');
  const videos = html.indexOf('>Videos<');
  const work = html.indexOf('Work carried out');
  assert.ok(photos > 0 && videos > photos && work > videos, 'Photos, then Videos, then the text fields');
  assert.match(html, /data-testid="report-videos"/);
});

test('REPORT PANEL: a Completed report passes its state down - videos locked, Remove still available', () => {
  const html = wrapPanel(<ReportPanel reportId="rp" reviewStatus="approved" actor="luke@x" readyForAccounts />, { completedAt: '2026-10-03T09:00:00Z', completedBy: 'luke@x', reviewStatus: 'approved' }, [video('a', 'before')]);
  assert.match(html, /This report is Completed, so videos can’t be added/);
  assert.match(addButton(phaseHtml(html, 'before')), /\sdisabled=""/);
});

test('REPORT PANEL: no "Include videos" switch and no "Save changes" button, whatever the cached report looks like (including an older one with no includeVideos field)', () => {
  for (const over of [{}, { includeVideos: undefined }, { includeVideos: false }]) {
    const html = wrapPanel(<ReportPanel reportId="rp" reviewStatus="awaiting_review" actor="luke@x" readyForAccounts={false} />, over, [video('a', 'before')]);
    assert.doesNotMatch(html, /Include videos in the client report/);
    assert.doesNotMatch(html, /Save changes/);
  }
});
