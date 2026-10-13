// The manager's Photos section in Report Review (src/components/reports/ReportPhotos.tsx), rendered to static markup like the video
// section's tests. Interaction (clicking, uploading) is checked in the browser test against DEV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import ReportPhotos, { ReportPhotosView, type ReportPhotosViewProps } from '../src/components/reports/ReportPhotos';
import { HISTORY_EVENT_LABEL, historyEventDetail } from '../src/lib/historyEventLabels';
import type { ReportPhoto } from '../src/repository/reportsRepository';

const noop = () => {};
const photo = (id: string, phase: ReportPhoto['phase'], over: Partial<ReportPhoto> = {}): ReportPhoto => ({ id, phase, storagePath: `v/${phase}/${id}.jpg`, uploadStatus: 'uploaded', includeInClientReport: true, ...over });

function view(over: Partial<ReportPhotosViewProps> = {}) {
  const props: ReportPhotosViewProps = {
    photos: [], urls: {}, completed: false, adding: null, phaseError: null, notice: null, rowError: null, includePendingId: null, movePendingId: null,
    onPick: noop, onToggleInclude: noop, onMove: noop, onDelete: async () => {}, onDeleteError: noop, inputRef: noop, onAddClick: noop, ...over,
  };
  return renderToStaticMarkup(<ReportPhotosView {...props} />);
}
const phaseBlock = (html: string, phase: string) => {
  const start = html.indexOf(`data-testid="photo-phase-${phase}"`);
  assert.ok(start >= 0, `phase ${phase} is shown`);
  const next = ['before', 'during', 'after'].map((p) => html.indexOf(`data-testid="photo-phase-${p}"`, start + 10)).filter((i) => i > start);
  return html.slice(start, next.length ? Math.min(...next) : html.length);
};
const addButton = (block: string) => block.match(/<button[^>]*>\s*\+ Add photo\s*<\/button>/)?.[0] ?? '';

test('EVERY section is always shown with its own "+ Add photo" button and a file chooser, even with no photos', () => {
  const html = view();
  for (const phase of ['before', 'during', 'after']) {
    const block = phaseBlock(html, phase);
    assert.match(block, /\(0\)/);
    assert.match(block, />None</);
    assert.match(addButton(block), /\+ Add photo/);
    assert.doesNotMatch(addButton(block), /\sdisabled=""/);
  }
  assert.equal((html.match(/type="file"/g) ?? []).length, 3);
  assert.match(html, /accept="image\/\*"/);
  assert.match(html, /multiple/);
  assert.match(html, /aria-label="Choose photos for the Before section"/);
});

test('PHOTOS appear under their own section with a count, a "Include for client" tick that is ticked by default, and a delete button', () => {
  const html = view({ photos: [photo('a', 'before'), photo('b', 'before', { includeInClientReport: false }), photo('c', 'after')], urls: { a: 'https://x/a.jpg', b: 'https://x/b.jpg', c: 'https://x/c.jpg' } });
  assert.match(phaseBlock(html, 'before'), /Before \(2\)/);
  assert.match(phaseBlock(html, 'after'), /After \(1\)/);
  assert.match(phaseBlock(html, 'during'), /During \(0\)/);
  const tiles = html.split('data-testid="report-photo"').slice(1);
  assert.equal(tiles.length, 3);
  assert.match(tiles[0], /<input type="checkbox"[^>]*aria-label="Include before photo in the client report"[^>]*\schecked=""/);
  assert.doesNotMatch(tiles[1], /<input type="checkbox"[^>]*\schecked=""/, 'an unticked photo is shown unticked');
  assert.match(tiles[1], /opacity-40/, 'and dimmed');
  assert.match(tiles[0], /Include for client/);
  assert.match(tiles[0], /aria-label="Delete before photo"/);
  assert.match(tiles[0], /href="https:\/\/x\/a\.jpg"/, 'the thumbnail opens the full photo');
});

test('DELETE opens no popup until pressed (the same popup component as the technician view is used when it is)', () => {
  const html = view({ photos: [photo('a', 'before')], urls: { a: 'https://x/a.jpg' } });
  assert.doesNotMatch(html, /role="alertdialog"/);
});

test('A photo whose link is not ready yet shows a placeholder, not a broken image', () => {
  const html = view({ photos: [photo('a', 'before')], urls: {} });
  assert.match(html, /animate-shimmer/);
  assert.doesNotMatch(html, /<img/);
});

test('PROGRESS, REFUSALS and NOTES are shown where they belong; adding disables every Add button (one batch at a time)', () => {
  const html = view({
    adding: { phase: 'during', done: 1, total: 3 },
    phaseError: { phase: 'after', message: '“plan.pdf” is not a photo. Choose an image file.' },
    notice: 'A photo was removed from the report, but its file could not be deleted from storage.',
  });
  assert.match(phaseBlock(html, 'during'), /Adding photo 2 of 3…/);
  assert.match(phaseBlock(html, 'after'), /role="alert"[^>]*>“plan\.pdf” is not a photo/);
  assert.match(html, /role="status"[^>]*>A photo was removed from the report/);
  for (const p of ['before', 'during', 'after']) assert.match(addButton(phaseBlock(html, p)), /\sdisabled=""/);
});

test('A per-photo failure (for example the database refused a change) shows under that photo only', () => {
  const html = view({ photos: [photo('a', 'before'), photo('b', 'before')], rowError: { id: 'b', message: 'You don’t have permission to change photos on this report.' } });
  const [first, second] = html.split('data-testid="report-photo"').slice(1);
  assert.doesNotMatch(first, /role="alert"/);
  assert.match(second, /role="alert"[^>]*>You don’t have permission/);
});

test('COMPLETED: add, delete and the include ticks are all locked and the reason is shown', () => {
  const html = view({ photos: [photo('a', 'before')], urls: { a: 'https://x/a.jpg' }, completed: true });
  assert.match(html, /This report is Completed, so photos can’t be added, removed, moved or unticked\. Reopen it first/);
  for (const p of ['before', 'during', 'after']) {
    assert.match(addButton(phaseBlock(html, p)), /\sdisabled=""/);
    assert.match(addButton(phaseBlock(html, p)), /This report is Completed/);
  }
  const tile = html.split('data-testid="report-photo"')[1];
  assert.match(tile, /<input type="checkbox"[^>]*\sdisabled=""/);
  assert.doesNotMatch(tile, /aria-label="Delete before photo"/, 'no delete button on a Completed report');
  assert.doesNotMatch(tile, /<select/, 'and no "Move to" control either');
});

test('NOT COMPLETED: everything is enabled (awaiting review, returned and approved all behave the same here)', () => {
  const html = view({ photos: [photo('a', 'before')], urls: { a: 'https://x/a.jpg' } });
  assert.doesNotMatch(html, /report is Completed/);
  assert.doesNotMatch(html.split('data-testid="report-photo"')[1], /<input type="checkbox"[^>]*\sdisabled=""/);
  assert.match(html.split('data-testid="report-photo"')[1], /aria-label="Move before photo to another section"/);
});

test('MOVE: every photo offers the OTHER two sections only, never the one it is already in', () => {
  const html = view({ photos: [photo('a', 'before'), photo('c', 'after')], urls: { a: 'https://x/a.jpg', c: 'https://x/c.jpg' } });
  const [first, second] = html.split('data-testid="report-photo"').slice(1);
  assert.match(first, /aria-label="Move before photo to another section"/);
  assert.match(first, />Move to…</);
  assert.match(first, /<option value="during">During<\/option>/);
  assert.match(first, /<option value="after">After<\/option>/);
  assert.doesNotMatch(first, /<option value="before">/);
  assert.match(second, /<option value="before">Before<\/option>/);
  assert.match(second, /<option value="during">During<\/option>/);
  assert.doesNotMatch(second, /<option value="after">/);
});

test('MOVE: while a move is saving that photo is locked and says so; other photos stay movable', () => {
  const html = view({ photos: [photo('a', 'before'), photo('b', 'before')], urls: { a: 'https://x/a.jpg', b: 'https://x/b.jpg' }, movePendingId: 'a' });
  const [first, second] = html.split('data-testid="report-photo"').slice(1);
  assert.match(first, /<select[^>]*\sdisabled=""/);
  assert.match(first, />Moving…</);
  assert.doesNotMatch(second, /<select[^>]*\sdisabled=""/);
  assert.match(second, />Move to…</);
});

test('The footnote says photos are shown unless unticked, and that deleting is permanent', () => {
  assert.match(view(), /Photos are shown to the client unless you untick them\. “Move to” puts a photo in a different section\. Deleting a photo removes it permanently\./);
});

test('The connected section loads this report\'s photos from the cache the Ready for client page shares (same query key)', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['reportPhotos', 'rp'], [photo('a', 'during')]);
  qc.setQueryData(['reportPhotoUrls', 'rp', 'a'], { a: 'https://x/a.jpg' });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ReportPhotos reportId="rp" visitId="v" completed={false} actor="luke@x" />
    </QueryClientProvider>,
  );
  assert.match(phaseBlock(html, 'during'), /During \(1\)/);
  assert.match(html, /href="https:\/\/x\/a\.jpg"/);
});

test('HISTORY: photo added / removed have friendly titles and show the section', () => {
  assert.equal(HISTORY_EVENT_LABEL.report_photo_added, 'Photo added');
  assert.equal(HISTORY_EVENT_LABEL.report_photo_removed, 'Photo removed');
  assert.equal(historyEventDetail('report_photo_added', 'before'), 'Before section');
  assert.equal(historyEventDetail('report_photo_removed', 'after'), 'After section');
  assert.equal(historyEventDetail('report_photo_removed', null), null, 'a technician\'s removal has no detail');
  assert.equal(HISTORY_EVENT_LABEL.report_photo_moved, 'Photo moved');
  assert.equal(historyEventDetail('report_photo_moved', 'before:during'), 'Before section → During section');
  assert.equal(historyEventDetail('report_photo_moved', 'after:before'), 'After section → Before section');
  assert.equal(historyEventDetail('report_photo_moved', 'nonsense'), 'nonsense', 'an unknown detail is shown as it is');
});
