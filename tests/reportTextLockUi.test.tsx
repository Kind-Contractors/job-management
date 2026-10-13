// Report Review's text fields (src/components/jobs/ReportPanel.tsx) rendered to static markup: editable while a report is awaiting review or
// returned, read-only once it is approved, Completed or sent to the client. Interaction (typing, autosave, leaving the page) is checked in the
// browser test against DEV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import ReportPanel from '../src/components/jobs/ReportPanel';

const VISIT = '0b7a2f4e-1111-4222-8333-444455556666';
function panel(reviewStatus: 'awaiting_review' | 'approved' | 'returned_for_correction', over: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['report', 'rp'], {
    id: 'rp', visitId: VISIT, submittedBy: 'Mo', submittedAt: '2026-10-01T11:00:00Z', onSiteStart: null, onSiteEnd: null, workCarriedOut: 'Cleaned lobby', technicianNotes: null, issues: 'Cracked tile', specMet: true,
    reviewStatus, reviewedBy: null, reviewedAt: null, returnReason: null, includePhotos: true, includeNotes: true, includeIssues: true, includePrice: false, includeVideos: true,
    sentToClientAt: null, sentToClientBy: null, sentToAccountsAt: null, sentToAccountsBy: null, completedAt: null, completedBy: null, ...over,
  });
  qc.setQueryData(['reportContributions', 'rp'], { contributionMode: false, participants: [], managerEditedAt: null });
  qc.setQueryData(['reportPhotos', 'rp'], []);
  qc.setQueryData(['reportVideos', VISIT], []);
  const el: ReactElement = <ReportPanel reportId="rp" reviewStatus={reviewStatus} actor="luke@x" readyForAccounts={reviewStatus === 'approved'} />;
  return renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);
}
const textareas = (html: string) => html.match(/<textarea[^>]*>[^<]*<\/textarea>/g) ?? [];

test('AWAITING REVIEW and RETURNED: the three text boxes are editable, show the stored text, and there is no lock note', () => {
  for (const status of ['awaiting_review', 'returned_for_correction'] as const) {
    const html = panel(status);
    const boxes = textareas(html);
    assert.equal(boxes.length, 3, status);
    assert.ok(boxes.every((b) => !/readonly/i.test(b)), `${status}: editable`);
    assert.match(boxes[0], />Cleaned lobby</);
    assert.match(boxes[1], />Cracked tile</);
    assert.doesNotMatch(html, /data-testid="text-locked-note"/);
  }
});

test('APPROVED: the three text boxes are read-only and say why', () => {
  const html = panel('approved', { reviewedBy: 'luke@x', reviewedAt: '2026-10-02T09:00:00Z' });
  const boxes = textareas(html);
  assert.equal(boxes.length, 3);
  assert.ok(boxes.every((b) => /readonly/i.test(b)));
  assert.match(html, /data-testid="text-locked-note"[^>]*>This report is approved, so its text is locked\./);
  assert.match(boxes[0], />Cleaned lobby</, 'the text is still shown');
});

test('COMPLETED: read-only, and the reason names Completed', () => {
  const html = panel('approved', { completedAt: '2026-10-03T09:00:00Z', completedBy: 'luke@x' });
  assert.ok(textareas(html).every((b) => /readonly/i.test(b)));
  assert.match(html, /This report is Completed, so its text is locked\./);
});

test('SENT TO THE CLIENT: read-only, and the reason says it was sent', () => {
  const html = panel('approved', { sentToClientAt: '2026-10-03T09:00:00Z', sentToClientBy: 'luke@x' });
  assert.ok(textareas(html).every((b) => /readonly/i.test(b)));
  assert.match(html, /This report has been sent to the client, so its text is locked\./);
});

test('SENT but not formally approved status (defensive): still locked', () => {
  const html = panel('awaiting_review', { sentToClientAt: '2026-10-03T09:00:00Z' });
  assert.ok(textareas(html).every((b) => /readonly/i.test(b)));
});

test('there is no "Save changes" button, and no conflict / changed-elsewhere notice on a freshly loaded report', () => {
  const html = panel('awaiting_review');
  assert.doesNotMatch(html, /Save changes/);
  assert.doesNotMatch(html, /text-changed-elsewhere|text-conflict-/);
  assert.match(html, /data-testid="autosave-status"/);
});
