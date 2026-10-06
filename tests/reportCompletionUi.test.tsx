// Rendering tests for report completion, on the REAL components: the Ready for client page (queue, tabs, badges, the
// Completed / Reopen actions, the already-sent guard) and the "reopen first" notices. The page is server-rendered to
// static markup from a seeded query cache (no DOM library in this repo), so these check what is shown; the writes behind
// the buttons are covered at the data layer (reportCompletionData.test.ts) and the rules by the logic tests.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import ReadyForClientPage, { SendConfirmDialog } from '../src/pages/ReadyForClientPage';
import ReportPanel from '../src/components/jobs/ReportPanel';
import ReportContributionsSection from '../src/components/jobs/ReportContributionsSection';
import { AuthContext } from '../src/auth/AuthProvider';
import {
  CompleteButton,
  CompleteConfirm,
  CompletedBanner,
  ReadyForClientTabs,
  ReopenFirstNotice,
  SentBadge,
} from '../src/components/reports/ReportCompletionControls';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};

// ---- fixtures -------------------------------------------------------------------------
const SENT = '2026-10-02T09:00:00Z';
const DONE = '2026-10-03T09:00:00Z';

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-01', status: 'completed', technicianId: 'mo', technicianName: 'Mo', additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'submitted',
    priceCharged: 100, completedAt: '2026-10-01T10:00:00Z', reportId: `rep-${id}`, reportReviewStatus: 'approved', sentToClientAt: null, sentToAccountsAt: null,
    reportCompletedAt: null, reportCompletedBy: null, invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, buildingName: string, visits: any[]): any {
  return {
    id, buildingId: `b-${id}`, buildingName, clientId: 'c1', clientName: 'Acme Ltd', jobSummary: `${buildingName} cleaning`, division: 'General', visits,
    clientContacts: [{ id: 'ct1', name: 'Sam Client', email: 'sam@acme.test', phoneNumber: null, isPrimary: true, isAccountsContact: false }],
  };
}
function reportFor(visitId: string, over: Record<string, unknown> = {}): any {
  return {
    id: `rep-${visitId}`, visitId, submittedBy: 'Mo', submittedAt: '2026-10-01T11:00:00Z', onSiteStart: null, onSiteEnd: null, workCarriedOut: 'Cleaned the windows', technicianNotes: null, issues: null,
    specMet: true, reviewStatus: 'approved', reviewedBy: 'luke', reviewedAt: '2026-10-01T12:00:00Z', returnReason: null, includePhotos: true, includeNotes: true, includeIssues: true, includePrice: false,
    sentToClientAt: null, sentToClientBy: null, sentToAccountsAt: null, sentToAccountsBy: null, completedAt: null, completedBy: null, ...over,
  };
}

// A: approved, never emailed.  B: approved and emailed through the system, not completed.  C: emailed, then completed.
// D: awaiting review.  E: completed by hand (never emailed).
const vA = visit('va');
const vB = visit('vb', { sentToClientAt: SENT });
const vC = visit('vc', { sentToClientAt: SENT, reportCompletedAt: DONE, reportCompletedBy: 'luke@kindcontractors.co.uk' });
const vD = visit('vd', { reportReviewStatus: 'awaiting_review' });
const vE = visit('ve', { reportCompletedAt: '2026-10-04T09:00:00Z', reportCompletedBy: 'office@kindcontractors.co.uk' });
const jobs = [job('ja', 'Alpha Court', [vA]), job('jb', 'Bravo House', [vB]), job('jc', 'Charlie Mews', [vC]), job('jd', 'Delta Plaza', [vD]), job('je', 'Echo Tower', [vE])];

function page(opts: { jobRows?: any[]; initialView?: 'awaiting' | 'completed'; selected?: string | null; reports?: Record<string, any>; lastSend?: Record<string, any> } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['jobRows'], opts.jobRows ?? jobs);
  for (const [visitId, rep] of Object.entries(opts.reports ?? {})) {
    qc.setQueryData(['report', `rep-${visitId}`], rep);
    qc.setQueryData(['reportPhotos', `rep-${visitId}`], []);
    qc.setQueryData(['clientSend', `rep-${visitId}`], opts.lastSend?.[visitId] ?? null);
  }
  const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <ReadyForClientPage initialView={opts.initialView} initialSelectedVisitId={opts.selected ?? null} />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
const at = (html: string, text: string) => {
  const i = html.indexOf(text);
  assert.ok(i >= 0, `expected the markup to contain "${text}"`);
  return i;
};
const has = (html: string, text: string) => html.includes(text);

// ---- the queue: approved until completed - however it was delivered ----------------------------------------------
test('QUEUE: an approved report that was emailed through the system STAYS in Ready for client (with a Sent badge); a never-sent one is there too', () => {
  const html = page();
  assert.ok(has(html, 'Alpha Court'), 'approved, never sent');
  assert.ok(has(html, 'Bravo House'), 'approved and emailed: still awaiting completion');
  assert.equal((html.match(/✓ Sent to client/g) ?? []).length, 1, 'only the emailed report carries the Sent badge');
});

test('QUEUE: completed reports, reports awaiting review and others are not in the queue', () => {
  const html = page();
  assert.ok(!has(html, 'Charlie Mews'), 'completed after emailing');
  assert.ok(!has(html, 'Echo Tower'), 'completed by hand');
  assert.ok(!has(html, 'Delta Plaza'), 'still awaiting review');
});

test('the header and tabs say "awaiting completion", with live counts for both lists', () => {
  const html = page();
  assert.match(html, /2 awaiting completion/);
  assert.match(html, /Awaiting completion \(2\)/);
  assert.match(html, /Completed \(2\)/);
  assert.doesNotMatch(html, /awaiting send/);
});

test('the Completed list shows completed reports, most recent first, with who and when', () => {
  const html = page({ initialView: 'completed' });
  assert.ok(has(html, 'Charlie Mews') && has(html, 'Echo Tower'));
  assert.ok(!has(html, 'Alpha Court') && !has(html, 'Bravo House'), 'the queue reports are not in this list');
  assert.ok(at(html, 'Echo Tower') < at(html, 'Charlie Mews'), 'completed 4 Oct before completed 3 Oct');
  assert.match(html, /Completed by office@kindcontractors\.co\.uk/);
  assert.match(html, /Completed by luke@kindcontractors\.co\.uk/);
});

test('empty states explain themselves', () => {
  const none = page({ jobRows: [job('jd', 'Delta Plaza', [vD])] });
  assert.match(none, /No approved reports are waiting to be completed/);
  const noneCompleted = page({ jobRows: [job('ja', 'Alpha Court', [vA])], initialView: 'completed' });
  assert.match(noneCompleted, /No reports have been marked completed yet/);
});

// ---- the action bar: Download PDF, Send to client and Completed side by side ------------------------------------------
test('ACTIONS: an approved report shows Download PDF, Send to client and Completed together, in that order', () => {
  const html = page({ selected: 'va', reports: { va: reportFor('va') } });
  const download = at(html, 'Download PDF');
  const send = at(html, 'Send to client');
  const completed = at(html, 'Mark this report as fully dealt with');
  assert.ok(download < send && send < completed, 'Completed sits beside the two existing actions');
  assert.ok(!has(html, 'Reopen'), 'nothing to reopen on a report that is not completed');
});

test('ACTIONS: an emailed-but-not-completed report keeps Send to client, and says it is still waiting to be completed', () => {
  const html = page({ selected: 'vb', reports: { vb: reportFor('vb', { sentToClientAt: SENT, sentToClientBy: 'luke@x' }) }, lastSend: { vb: { id: 's1', status: 'sent', recipientEmail: 'sam@acme.test', sentBy: 'luke@x', errorMessage: null, createdAt: SENT, resendMessageId: 'm1' } } });
  assert.ok(has(html, 'Send to client'));
  assert.ok(has(html, 'Mark this report as fully dealt with'));
  assert.match(html, /Sent to client<\/span> on /);
  assert.match(html, /stays in the queue until you mark it Completed/);
});

test('ACTIONS: a completed report shows who/when and Reopen, keeps Download PDF, and no longer offers Send or Completed', () => {
  const html = page({ selected: 'vc', initialView: 'completed', reports: { vc: reportFor('vc', { sentToClientAt: SENT, completedAt: DONE, completedBy: 'luke@kindcontractors.co.uk' }) } });
  assert.match(html, /Completed<\/span>\s*<span>by luke@kindcontractors\.co\.uk on /);
  assert.match(html, /emailed to the client/);
  assert.ok(has(html, '>Reopen<'));
  assert.match(html, /can&#x27;t be returned for correction, or have a technician&#x27;s section sent back, until you reopen it|can’t be returned for correction, or have a technician’s section sent back, until you reopen it/, 'the rule is stated on the banner itself');
  assert.ok(has(html, 'Download PDF'), 'Download PDF is unchanged and still available');
  assert.ok(!has(html, 'Send to client'));
  assert.ok(!has(html, 'Mark this report as fully dealt with'));
});

test('ACTIONS: a report completed by hand says it was delivered by hand', () => {
  const html = page({ selected: 've', initialView: 'completed', reports: { ve: reportFor('ve', { completedAt: '2026-10-04T09:00:00Z', completedBy: 'office@kindcontractors.co.uk' }) } });
  assert.match(html, /delivered by hand \(not emailed through the system\)/);
  assert.ok(has(html, '>Reopen<'));
});

// ---- the already-sent guard ---------------------------------------------------------------------------------------------
const model: any = { buildingName: 'Bravo House', clientName: 'Acme Ltd', jobSummary: 'cleaning', visitDateLabel: '1 Oct', workCarriedOut: 'x', notes: null, issues: null, specMet: true, photos: [] };
const contact: any = { id: 'ct1', name: 'Sam Client', email: 'sam@acme.test', phoneNumber: null, isPrimary: true, isAccountsContact: false };

const STD = 'Hello Sam Client,\n\nPlease find attached the service report.';
const msg = (message = STD) => ({ message, onMessageChange: noop, onResetMessage: noop });
const dialog = (message: string, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<SendConfirmDialog model={model} contact={contact} isSending={false} alreadySent={null} {...msg(message)} onCancel={noop} onConfirm={noop} {...extra} />);

test('GUARD: sending a report that was already emailed warns first, names when and to whom, and offers "Send again"', () => {
  const html = renderToStaticMarkup(<SendConfirmDialog model={model} contact={contact} isSending={false} alreadySent={{ at: SENT, to: 'sam@acme.test' }} {...msg()} onCancel={noop} onConfirm={noop} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /Already sent\./);
  assert.match(html, /sam@acme\.test/);
  assert.match(html, /second copy/);
  assert.match(html, /use Completed instead/);
  assert.match(html, />Send again</);
  assert.doesNotMatch(html, /Confirm and send/);
});

test('GUARD: a first send is the same confirmation as before - no warning', () => {
  const html = renderToStaticMarkup(<SendConfirmDialog model={model} contact={contact} isSending={false} alreadySent={null} {...msg()} onCancel={noop} onConfirm={noop} />);
  assert.doesNotMatch(html, /Already sent/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, />Confirm and send</);
  assert.match(html, /Sending to/);
});

// ---- the editable email message -------------------------------------------------------------------------------------------
test('MESSAGE: the dialog shows the message in an editable box with a counter, a reset link and an enabled send button', () => {
  const html = dialog(STD);
  assert.match(html, /<textarea[^>]*id="client-email-message"/);
  assert.match(html, /Hello Sam Client,/);
  assert.match(html, /Reset to standard message/);
  assert.match(html, new RegExp(`>${[...STD].length} / 2000<`));
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Confirm and send/);
  assert.match(html, /subject line is set by the system/);
});

test('MESSAGE: an empty or whitespace-only message blocks sending and says why', () => {
  for (const m of ['', '   \n\t ']) {
    const html = dialog(m);
    assert.match(html, /The message cannot be empty\./);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm and send/);
  }
});

test('MESSAGE: 2,000 characters is accepted, 2,001 is blocked', () => {
  const ok = dialog('a'.repeat(2000));
  assert.match(ok, />2000 \/ 2000</);
  assert.doesNotMatch(ok, /<button[^>]*disabled=""[^>]*>Confirm and send/);
  const tooLong = dialog('a'.repeat(2001));
  assert.match(tooLong, /too long/);
  assert.match(tooLong, /<button[^>]*disabled=""[^>]*>Confirm and send/);
});

test('MESSAGE: the already-sent guard still shows, with "Send again", alongside the message box', () => {
  const html = dialog(STD, { alreadySent: { at: SENT, to: 'sam@acme.test' } });
  assert.match(html, /Already sent\./);
  assert.match(html, />Send again</);
  assert.match(html, /<textarea/);
});

test('MESSAGE: while sending, the box, reset link and send button are locked', () => {
  const html = dialog(STD, { isSending: true });
  assert.match(html, /<textarea[^>]*disabled=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Sending/);
});

// ---- the controls ----------------------------------------------------------------------------------------------------------
test('tabs mark the active list and show both counts', () => {
  const html = renderToStaticMarkup(<ReadyForClientTabs view="completed" awaitingCount={3} completedCount={7} onChange={noop} />);
  assert.match(html, /aria-pressed="false"[^>]*>Awaiting completion \(3\)/);
  assert.match(html, /aria-pressed="true"[^>]*>Completed \(7\)/);
});

test('the Completed confirmation tells the manager what will happen and whether it was emailed', () => {
  const byHand = renderToStaticMarkup(<CompleteConfirm sentAt={null} pending={false} onConfirm={noop} onCancel={noop} />);
  assert.match(byHand, /leave the Ready for client queue/);
  assert.match(byHand, /delivered it by hand/);
  assert.match(byHand, />Mark completed</);
  const emailed = renderToStaticMarkup(<CompleteConfirm sentAt={SENT} pending={false} onConfirm={noop} onCancel={noop} />);
  assert.match(emailed, /emailed to the client on/);
  const saving = renderToStaticMarkup(<CompleteConfirm sentAt={null} pending onConfirm={noop} onCancel={noop} />);
  assert.match(saving, /Saving…/);
  assert.match(saving, /disabled/);
});

test('the Completed button explains itself, and the sent badge says when', () => {
  assert.match(renderToStaticMarkup(<CompleteButton onClick={noop} />), /Completed/);
  assert.match(renderToStaticMarkup(<SentBadge sentAt={SENT} />), /✓ Sent to client/);
  assert.match(renderToStaticMarkup(<CompletedBanner completedAt={DONE} completedBy={null} sentAt={null} pending onReopen={noop} />), /by unknown[\s\S]*Reopening…/);
});

// ---- "reopen it first" where a manager would otherwise try to return it ------------------------------------------------------
const wrapPanel = (el: ReactElement) => renderToStaticMarkup(<QueryClientProvider client={panelClient()}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);
function panelClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['report', 'r-done'], reportFor('v', { id: 'r-done', completedAt: DONE, completedBy: 'luke@kindcontractors.co.uk' }));
  qc.setQueryData(['report', 'r-open'], reportFor('v', { id: 'r-open' }));
  qc.setQueryData(['reportContributions', 'r-done'], { contributionMode: false, participants: [], managerEditedAt: null });
  qc.setQueryData(['reportContributions', 'r-open'], { contributionMode: false, participants: [], managerEditedAt: null });
  return qc;
}

test('NOTICE: a completed report tells the manager to reopen it before returning it or sending a technician\'s section back', () => {
  const html = wrapPanel(<ReportPanel reportId="r-done" reviewStatus="approved" actor="luke@x" readyForAccounts />);
  assert.match(html, /role="note"/);
  assert.match(html, /Completed<\/span> by luke@kindcontractors\.co\.uk/);
  assert.match(html, /reopen it first/);
  assert.match(html, /Ready for client[\s\S]*Completed[\s\S]*Reopen/);
  assert.match(html, /return this report for correction/);
});

test('NOTICE: a report that is not completed shows no such notice', () => {
  const html = wrapPanel(<ReportPanel reportId="r-open" reviewStatus="approved" actor="luke@x" readyForAccounts />);
  assert.doesNotMatch(html, /reopen it first/);
});

const overview: any = {
  contributionMode: true, managerEditedAt: null,
  participants: [{ technicianId: 't1', name: 'Tech 1', isPrimary: true, isActive: true, status: 'submitted', needsCorrection: false, submittedAt: DONE, specMet: true, workCarriedOut: 'Done', issues: null, technicianNotes: null, onSiteStart: null, onSiteEnd: null, correctionReason: null, waivedAt: null, waivedBy: null }],
};
test('NOTICE: the per-technician section explains why a technician cannot be sent back on a completed report', () => {
  const done = wrapPanel(<ReportContributionsSection reportId="r-done" reviewStatus="approved" completed actor="luke@x" overview={overview} />);
  assert.match(done, /This report is Completed, so a technician&#x27;s section can&#x27;t be sent back|This report is Completed, so a technician’s section can’t be sent back/);
  assert.match(done, /Reopen it first/);
  assert.doesNotMatch(done, /Return Tech 1 for correction/, 'the return button is not offered on an approved report');
  const open = wrapPanel(<ReportContributionsSection reportId="r-open" reviewStatus="awaiting_review" actor="luke@x" overview={overview} />);
  assert.doesNotMatch(open, /This report is Completed/);
  assert.match(open, /Return Tech 1 for correction/, 'while the report is under review the manager can still send a section back');
});

test('the reopen-first notice names the way back', () => {
  const html = renderToStaticMarkup(<ReopenFirstNotice completedBy="luke@x" completedAt={DONE} />);
  assert.match(html, /Ready for client[\s\S]*Completed[\s\S]*Reopen/);
});

// ---- stale cache: job rows persisted before completion existed ---------------------------------------------------------------------
test('STALE CACHE: the page renders job rows cached before completion existed (no completed fields) without crashing, as not completed', () => {
  const oldVisit = visit('vo');
  delete oldVisit.reportCompletedAt;
  delete oldVisit.reportCompletedBy;
  const old = [job('jo', 'Old Cache House', [oldVisit])];
  let html = '';
  assert.doesNotThrow(() => {
    html = page({ jobRows: old });
  });
  assert.ok(has(html, 'Old Cache House'), 'an approved, not-completed report is in the queue');
  assert.match(html, /1 awaiting completion/);
  assert.match(html, /Completed \(0\)/);
});
