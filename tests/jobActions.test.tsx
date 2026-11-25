// All live jobs - Actions column (Nov 2026): "Edit" and "Complete & report" on every job row, each opening its existing form in a
// dialog (FormDialog) instead of the job panel. The forms themselves are unchanged (their own checks, saving, automatic approval and
// attribution are covered in officeReports.test.tsx); the job panel no longer offers "Complete & write report" / "Record work already
// done". These tests cover the column, the dialogs and which visits "Complete & report" offers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import { actionsColumn, COLUMN_IDS } from '../src/components/jobs/JobsGrid';
import JobEditDialog from '../src/components/jobs/JobEditDialog';
import OfficeReportDialog, { NEW_VISIT, mediaSummary, officeReportTargets } from '../src/components/jobs/OfficeReportDialog';
import OfficeReportMedia from '../src/components/jobs/OfficeReportMedia';
import { moveTargets, pendingMedia, stagedVideoProblem, uploadStagedMedia, type MediaUploadDeps, type StagedMedia } from '../src/lib/officeReportMedia';
import { AuthContext } from '../src/auth/AuthProvider';

const noop = () => {};
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (code: string) => code.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-11-20', status: 'booked', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(visits: any[], over: Record<string, unknown> = {}): any {
  return {
    id: 'job-1', buildingId: 'b1', buildingName: 'Acme House', clientId: 'c1', clientName: 'Acme Ltd', jobSummary: 'Window cleaning', division: 'General', lifecycleStatus: 'active',
    serviceEndsOn: null, frequency: 'Monthly', frequencyRaw: 'Monthly', frequencyType: 'monthly', pricePerVisit: 55, yearlyValue: null, monthlyValue: null, nextDueLabel: '',
    status: 'booked', technician: 'Unassigned', defaultTechnicianId: null, schedulePattern: 'Monthly', schedule: null, visits, lostReason: null, recontactDueAt: null,
    recontactNotes: null, recontactIntervalMonths: null, street: '', postcode: 'AB1', buildingInternalAccessNote: '', clientInvoiceAddress: '', jobNotes: 'Use ladder', clientContacts: [],
    ...over,
  };
}
const auth: any = { status: 'authorized', role: 'manager', session: { user: { email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
function wrap(el: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>{el}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

// ---- the Actions column ----------------------------------------------------------------------------------------------------------
test('ACTIONS COLUMN: two compact buttons on a job row, nothing on a band row; pinned right, fixed narrow width, not hideable or sortable', () => {
  const col = actionsColumn(noop);
  assert.equal(col.colId, 'actions');
  assert.equal(col.pinned, 'right', 'stays in reach when the table is scrolled sideways');
  assert.equal(col.width, 168);
  assert.equal(col.maxWidth, 168);
  assert.equal(col.sortable, false);
  assert.equal(col.resizable, false);
  assert.ok(!(COLUMN_IDS as readonly string[]).includes('actions'), 'not in the Columns menu');
  const render = col.cellRenderer as (p: unknown) => ReactElement | null;
  const html = renderToStaticMarkup(render({ data: { kind: 'row', id: 'job-1', job: job([]) } })!);
  assert.match(html, /<button type="button"[^>]*aria-label="Edit Acme House · Window cleaning"[^>]*>Edit<\/button>/);
  assert.match(html, /aria-label="Complete &amp; report: Acme House · Window cleaning"[^>]*>Complete &amp; report<\/button>/);
  assert.equal(render({ data: { kind: 'band', id: 'band-1' } }), null);
});

test('ACTIONS COLUMN: a button says which job and action, and stops the click reaching the row (so the job panel does not open)', () => {
  const calls: unknown[] = [];
  const render = actionsColumn((id, action) => calls.push([id, action])).cellRenderer as (p: unknown) => ReactElement;
  const el = render({ data: { kind: 'row', id: 'job-1', job: job([]) } });
  const [edit, report] = (el.props as { children: ReactElement<{ onClick: (e: unknown) => void }>[] }).children;
  let stopped = 0;
  const ev = { stopPropagation: () => stopped++ };
  edit.props.onClick(ev);
  report.props.onClick(ev);
  assert.deepEqual(calls, [['job-1', 'edit'], ['job-1', 'report']]);
  assert.equal(stopped, 2);
});

test('ACTIONS COLUMN keyboard: Tab enters the cell\'s buttons and moves between them; Enter/Space on a button is left to the button', () => {
  const col = actionsColumn(noop);
  const suppress = col.suppressKeyboardEvent as (p: any) => boolean;
  const b1 = { focus() { (globalThis as any).document.activeElement = b1; } };
  const b2 = { focus() { (globalThis as any).document.activeElement = b2; } };
  const cell = { querySelectorAll: () => [b1, b2] };
  const target = { closest: () => cell };
  (globalThis as any).document = { activeElement: cell };
  let prevented = 0;
  const key = (k: string, shiftKey = false) => ({ event: { key: k, shiftKey, type: 'keydown', target, preventDefault: () => prevented++ } });
  assert.equal(suppress(key('Tab')), true, 'cell focused: Tab goes to the first button');
  assert.equal((globalThis as any).document.activeElement, b1);
  assert.equal(prevented, 1);
  assert.equal(suppress(key('Tab')), true, 'first button: the browser moves on to the second');
  (globalThis as any).document.activeElement = b2;
  assert.equal(suppress(key('Tab')), false, 'last button: the grid moves to the next cell');
  assert.equal(suppress(key('Tab', true)), true, 'Shift+Tab from the second goes back to the first');
  assert.equal(suppress(key('Enter')), true, 'Enter presses the focused button, not a grid action');
  (globalThis as any).document.activeElement = cell;
  assert.equal(suppress(key('Enter')), false, 'on the cell itself the grid keeps its keys');
  delete (globalThis as any).document;
});

test('GRID wiring: a click in the Actions cell never opens the drawer; it is a Tab stop; the page opens the dialogs from it, separate from the drawer', () => {
  const grid = noComments(src('src', 'components', 'jobs', 'JobsGrid.tsx'));
  assert.match(grid, /onCellClicked=\{\(event\) => \{[\s\S]*?getColId\(\) === 'actions'\) return;[\s\S]*?onSelectJob\(/);
  assert.match(grid, /if \(candidate\.column\.getColId\(\) === 'actions'\) return candidate;/);
  assert.match(grid, /\.\.\.\(onJobAction \? \[actionsColumn\(onJobAction\)\] : \[\]\)/);
  const page = noComments(src('src', 'pages', 'AllLiveJobsPage.tsx'));
  assert.match(page, /onJobAction=\{onJobAction\}/);
  assert.match(page, /useCallback\(\(jobId: string, action: JobAction\) => setJobAction\(\{ jobId, action \}\), \[\]\)/);
  assert.match(page, /jobAction\?\.action === 'edit' && actionJob && <JobEditDialog/);
  assert.match(page, /jobAction\?\.action === 'report' && actionJob && \(\s*<OfficeReportDialog/);
  assert.doesNotMatch(page.match(/const onJobAction[^\n]*/)![0], /setSelectedJobId/, 'opening a dialog does not select a row');
});

test('DRAWER: "Record work already done" and the office report form are gone; Edit job, visits, scheduling and the rest stay', () => {
  const drawer = noComments(src('src', 'components', 'jobs', 'JobInspectorDrawer.tsx'));
  assert.doesNotMatch(drawer, /OfficeReportForm|record-work-done|Record work already done|recordingDone/);
  assert.match(drawer, /<JobEditor job=\{job\}/);
  assert.match(drawer, /<ScheduleEditor/);
  assert.match(drawer, /<VisitRow key=\{v\.id\}/);
  const row = noComments(src('src', 'components', 'jobs', 'VisitRow.tsx'));
  assert.doesNotMatch(row, /OfficeReportForm|Complete &amp; write report|setMode\('office'\)/);
  assert.match(row, /<CompleteVisitForm/);
});

// ---- the dialogs -----------------------------------------------------------------------------------------------------------------
test('DIALOG shell: a modal dialog with a label, a title, a Close button, its own scrolling body, never closed by the backdrop', () => {
  const html = wrap(<JobEditDialog job={job([])} onClose={noop} />);
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Edit job: Acme House · Window cleaning"/);
  assert.match(html, /aria-label="Close"/);
  assert.match(html, /max-h-\[90vh\]/);
  assert.match(html, /overflow-y-auto/);
  const shell = noComments(src('src', 'components', 'ui', 'FormDialog.tsx'));
  assert.match(shell, /e\.key === 'Escape'/);
  assert.match(shell, /if \(e\.target === e\.currentTarget\) e\.preventDefault\(\);/, 'backdrop press does nothing');
  assert.doesNotMatch(shell, /onClick=\{onClose\}[^>]*bg-ink\/30|bg-ink\/30[^>]*onClick/, 'backdrop click does not close');
  assert.match(shell, /opener\.focus\(\)/, 'focus goes back to the button that opened it');
});

test('EDIT dialog: the existing job editor with its fields, Save and Cancel - no second "Edit job" box inside the dialog', () => {
  const html = wrap(<JobEditDialog job={job([])} onClose={noop} />);
  assert.match(html, /data-testid="job-edit-dialog"/);
  assert.match(html, /Job summary/);
  assert.match(html, /value="Window cleaning"/);
  assert.match(html, />Use ladder<\/textarea>/);
  assert.match(html, /Default technician \(optional\)/);
  assert.match(html, />Save<\/button>/);
  assert.match(html, />Cancel<\/button>/);
  assert.doesNotMatch(html, /m-3\.5 border border-neutral-300 p-3/);
});

test('REPORT dialog: ONE continuous form - 1 Visit (which visit + date, time, price), 2 Report, 3 Photos and videos - and one main button', () => {
  const html = wrap(<OfficeReportDialog job={job([visit('v1', { scheduledDate: '2026-11-01' })])} actor="luke@x" onClose={noop} onCompleted={noop} />);
  assert.match(html, /aria-label="Complete &amp; write report: Acme House · Window cleaning"/);
  const order = ['office-report-section-visit', 'Which visit?', 'Finished at', 'Price charged', 'office-report-section-report', 'Work carried out',
    'Specification', 'On site from', 'office-report-section-media', 'media-phase-before', 'media-phase-during', 'media-phase-after'];
  let at = -1;
  for (const marker of order) {
    const next = html.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} in order`);
    at = next;
  }
  assert.match(html, /<input type="radio" name="[^"]+" checked=""\/>1 Nov 2026 · Booked · Unassigned/);
  assert.match(html, /Work already done — not in JMS yet/);
  assert.match(html, /aria-label="Add photos to the Before section"/);
  assert.match(html, /aria-label="Add a video to the After section"/);
  // The footer (outside the scrolling body) has Cancel and the one main action, which submits the form by its id.
  assert.match(html, /<button type="button"[^>]*>Cancel<\/button><button type="submit" form="office-report-[^"]+"[^>]*>Complete &amp; save report<\/button>/);
  assert.doesNotMatch(html, />Done<\/button>/, 'no separate Done step');
  assert.doesNotMatch(html, /office-report-saved/, 'no separate post-save screen');
});

test('REPORT dialog: a completed visit with no report keeps its recorded time and price, and the button says Save report', () => {
  const v = visit('v2', { status: 'completed', scheduledDate: '2026-11-02', priceCharged: 30, completedAt: '2026-11-02T10:00:00Z' });
  const html = wrap(<OfficeReportDialog job={job([v], { lifecycleStatus: 'completed' })} actor="luke@x" onClose={noop} onCompleted={noop} />);
  assert.match(html, /£30 — kept as recorded/);
  assert.match(html, /type="submit"[^>]*>Save report<\/button>/);
});

test('REPORT dialog: nothing to report on (a closed job whose only visit has two technicians) says so, with the reason, and only Close', () => {
  const j = job([visit('v1', { additionalTechnicians: [{ technicianId: 't2', name: 'B', contribution: 'pending' }] })], { lifecycleStatus: 'completed' });
  const html = wrap(<OfficeReportDialog job={j} actor="luke@x" onClose={noop} onCompleted={noop} />);
  assert.match(html, /data-testid="office-report-nothing"/);
  assert.match(html, /Visits with more than one technician/);
  assert.doesNotMatch(html, /office-report-form/);
});

test('WHICH VISITS: open ones and completed-without-report ones; blocked ones listed with the reason; "new" only for an active/on-hold job', () => {
  const v = [
    visit('later', { scheduledDate: '2026-12-20' }),
    visit('due', { status: 'due', scheduledDate: '2026-11-10' }),
    visit('done-no-report', { status: 'completed', scheduledDate: '2026-10-01', priceCharged: 30, completedAt: '2026-10-01T10:00:00Z' }),
    visit('done-reported', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved' }),
    visit('cancelled', { status: 'cancelled' }),
    visit('missed', { status: 'missed' }),
    visit('multi', { scheduledDate: '2026-11-05', additionalTechnicians: [{ technicianId: 't2', name: 'B', contribution: 'pending' }] }),
  ];
  const t = officeReportTargets(job(v), '2026-11-24');
  assert.deepEqual(t.available.map((x) => x.id), ['done-no-report', 'due', 'later']);
  assert.deepEqual(t.blocked.map((x) => x.visit.id), ['multi']);
  assert.match(t.blocked[0].reason, /more than one technician/);
  assert.equal(t.initial, 'due', 'the earliest open visit due by today is preselected');
  assert.equal(t.canRecordNew, true);
  assert.equal(officeReportTargets(job([]), '2026-11-24').initial, NEW_VISIT, 'no visit: "work already done"');
  const closed = officeReportTargets(job([], { lifecycleStatus: 'lost' }), '2026-11-24');
  assert.equal(closed.canRecordNew, false);
  assert.equal(closed.initial, null);
});

// ---- photos and videos chosen before saving ------------------------------------------------------------------------------------
const file = (name: string, type = 'image/jpeg', size = 1000) => ({ name, type, size }) as unknown as File;
function staged(id: string, over: Partial<StagedMedia> = {}): StagedMedia {
  return { id, kind: 'photo', phase: 'before', file: file(`${id}.jpg`), previewUrl: null, include: true, status: 'ready', ...over };
}
const vid = (id: string, phase: StagedMedia['phase'], over: Partial<StagedMedia> = {}) =>
  staged(id, { kind: 'video', phase, file: file(`${id}.mp4`, 'video/mp4'), video: { mime: 'video/mp4', ext: 'mp4', durationSeconds: 10, thumbnail: null }, ...over });

function fakeDeps(fail: { photo?: Set<string>; video?: Set<string> } = {}) {
  const calls: string[] = [];
  let n = 0;
  const deps: MediaUploadDeps = {
    addPhoto: async (i) => {
      calls.push(`addPhoto ${i.file.name} ${i.phase} included=${i.includeInClientReport} report=${i.reportId} visit=${i.visitId}`);
      if (fail.photo?.has(i.file.name)) throw new Error('Failed to fetch');
      return { id: `p${++n}` };
    },
    addVideo: async (i) => {
      calls.push(`addVideo ${i.file.name} ${i.phase} included=${i.includeInClientReport} visit=${i.visitId}`);
      i.onProgress?.(50, 100);
      if (fail.video?.has(i.file.name)) throw new Error('Failed to fetch');
      return { id: `v${++n}` };
    },
    explainPhotoError: (e) => `photo: ${(e as Error).message}`,
    explainVideoError: (e) => `video: ${(e as Error).message}`,
  };
  return { deps, calls };
}
const TARGET = { reportId: 'r-1', visitId: 'visit-1', actor: 'luke@x' };

test('MEDIA after saving: every chosen file is added with its "Include for client" choice IN the insert - there is no later untick call', async () => {
  const { deps, calls } = fakeDeps();
  const items = [vid('clip', 'during', { include: false }), staged('a'), staged('b', { phase: 'after', include: false }), vid('clip2', 'after')];
  const final = await uploadStagedMedia(items, TARGET, deps, noop);
  assert.deepEqual(calls, [
    'addPhoto a.jpg before included=true report=r-1 visit=visit-1',
    'addPhoto b.jpg after included=false report=r-1 visit=visit-1',
    'addVideo clip.mp4 during included=false visit=visit-1',
    'addVideo clip2.mp4 after included=true visit=visit-1',
  ]);
  assert.ok(final.every((m) => m.status === 'added' && m.savedId));
  assert.equal(pendingMedia(final).length, 0);
  assert.equal(mediaSummary(final), '2 photos and 2 videos');
});

test('MEDIA failure: the others still go; a retry sends ONLY what failed, with the SAME inclusion choice - nothing added twice', async () => {
  const fail = { photo: new Set(['b.jpg']) };
  const { deps, calls } = fakeDeps(fail);
  let items = [staged('a'), staged('b', { include: false }), vid('clip', 'after')];
  items = await uploadStagedMedia(items, TARGET, deps, noop);
  const b = items.find((m) => m.id === 'b')!;
  assert.equal(b.status, 'failed');
  assert.equal(b.error, 'photo: Failed to fetch');
  assert.equal(b.savedId, undefined);
  assert.deepEqual(pendingMedia(items).map((m) => m.id), ['b']);
  assert.equal(items.find((m) => m.id === 'clip')!.status, 'added', 'a later file still went');
  calls.length = 0;
  fail.photo.clear();
  items = await uploadStagedMedia(items, TARGET, deps, noop);
  assert.deepEqual(calls, ['addPhoto b.jpg before included=false report=r-1 visit=visit-1'], 'only the failed photo, still excluded');
  assert.equal(pendingMedia(items).length, 0);
});

test('MEDIA: a failed video is never on the report; a retry adds it once, still with its choice; added files are never sent again', async () => {
  const fail = { video: new Set(['clip.mp4']) };
  const { deps, calls } = fakeDeps(fail);
  let items = await uploadStagedMedia([vid('clip', 'before', { include: false }), staged('a')], TARGET, deps, noop);
  const clip = items.find((m) => m.id === 'clip')!;
  assert.deepEqual([clip.status, clip.savedId], ['failed', undefined]);
  calls.length = 0;
  fail.video.clear();
  items = await uploadStagedMedia(items, TARGET, deps, noop);
  assert.deepEqual(calls, ['addVideo clip.mp4 before included=false visit=visit-1']);
  calls.length = 0;
  await uploadStagedMedia(items, TARGET, deps, noop);
  assert.deepEqual(calls, [], 'nothing left to send');
});

test('MEDIA: video progress is reported while it is sent', async () => {
  const { deps } = fakeDeps();
  const seen: Partial<StagedMedia>[] = [];
  await uploadStagedMedia([vid('clip', 'before')], TARGET, deps, (_id, p) => seen.push(p));
  assert.ok(seen.some((p) => p.progress === 0.5));
});

test('VIDEO LIMITS before saving: 3 per section and 8 per report, counting videos already on the chosen visit; moves only to a section with room', () => {
  const three = [vid('1', 'before'), vid('2', 'before'), vid('3', 'before')];
  assert.equal(stagedVideoProblem(three, []), null);
  assert.match(stagedVideoProblem(three, [{ phase: 'before' }])!, /Before section can have at most 3 videos \(counting the ones already on this visit\)/);
  const eight = [...three, vid('4', 'during'), vid('5', 'during'), vid('6', 'during'), vid('7', 'after'), vid('8', 'after')];
  assert.equal(stagedVideoProblem(eight, []), null);
  assert.match(stagedVideoProblem(eight, [{ phase: 'after' }])!, /at most 8 videos \(this visit already has 1\)/);
  assert.deepEqual(moveTargets(vid('x', 'after'), three, []), ['during'], 'Before is full');
  assert.deepEqual(moveTargets(staged('p'), three, []), ['during', 'after'], 'photos have no such limit');
});

test('MEDIA SECTION: before saving each file has its preview, Remove, Include for client and Move to; after saving only failed ones can change', () => {
  const items = [staged('a', { previewUrl: 'blob:a' }), vid('clip', 'during', { previewUrl: 'blob:poster' })];
  const props = { existingVideoCount: 1, pickError: null, moveTargets: () => ['after' as const], onPickPhotos: noop, onPickVideo: noop, onRemove: noop, onToggleInclude: noop, onMove: noop };
  const before = renderToStaticMarkup(<OfficeReportMedia items={items} editable {...props} />);
  assert.match(before, /<img src="blob:a"/);
  assert.match(before, /<img src="blob:poster"/);
  assert.match(before, /aria-label="Remove before photo"/);
  assert.match(before, /aria-label="Include during video in the client report"/);
  assert.match(before, /aria-label="Move before photo to another section"/);
  assert.match(before, /This visit already has 1 video; they stay on it and count towards the limits/);
  assert.match(before, /3 per section, 8 per report \(2 now\)/);
  const after = renderToStaticMarkup(
    <OfficeReportMedia items={[{ ...items[0], status: 'added', savedId: 'p1' }, { ...items[1], status: 'failed', error: 'video: Failed to fetch' }]} editable={false} {...props} />,
  );
  assert.doesNotMatch(after, /aria-label="Remove before photo"/, 'an added photo is not removed from here');
  assert.match(after, /✓ Added/);
  assert.match(after, /aria-label="Remove during video"/, 'a failed one can be taken out');
  assert.match(after, /data-testid="media-failed">Not added. (<!-- -->)?video: Failed to fetch/);
  assert.doesNotMatch(after, /Add photos to the/, 'no new files once the report is saved');
});

test('SOURCE: the dialog saves once (one call site) and adds media with the existing functions; closing is guarded', () => {
  const dlg = noComments(src('src', 'components', 'jobs', 'OfficeReportDialog.tsx'));
  assert.match(dlg, /addPhoto: \(input\) => addReportPhoto\(input\)/);
  assert.match(dlg, /addVideo: \(input\) => uploadReportVideo\(input\)/);
  assert.doesNotMatch(dlg, /updatePhotoClientInclusion|setVideoClientInclusion/, 'no separate untick step');
  assert.doesNotMatch(dlg, /supabase\./, 'no database access of its own');
  // The save: one call site, always with the submission's request id.
  assert.equal((dlg.match(/completeVisitWithOfficeReport\(/g) ?? []).length, 1);
  assert.match(dlg, /completeVisitWithOfficeReport\(\{ \.\.\.input, requestId \}\)/);
  // One request id per submission: made once, replaced ONLY by the id of an unfinished submission taken over from this device.
  assert.match(dlg, /const \[requestId, setRequestId\] = useState<string>\(\(\) => crypto\.randomUUID\(\)\);/);
  assert.equal((dlg.match(/setRequestId\(/g) ?? []).length, 1);
  assert.match(dlg, /setRequestId\(r\.requestId\);/);
  // Written to the device BEFORE it is sent; an unknown outcome keeps it; a definite refusal clears it; Try again re-sends exactly what was sent.
  const send = dlg.slice(dlg.indexOf('const send = async'), dlg.indexOf('const requestClose'));
  assert.ok(send.indexOf('savePendingSubmission(') > 0 && send.indexOf('savePendingSubmission(') < send.indexOf('completeVisitWithOfficeReport('), 'kept first, then sent');
  assert.match(send, /err instanceof OfficeReportOutcomeUnknownError\) \{[\s\S]*?setStage\('uncertain'\);[\s\S]*?return;/);
  assert.match(send, /await clearPending\(\);/, 'definite refusal: nothing saved, the device copy goes');
  assert.ok(send.indexOf("updatePendingSubmission(requestId, { stage: 'saved', result })") < send.indexOf('addMedia(result'), 'recorded as saved before any file is sent');
  assert.match(dlg, /onClick=\{\(\) => sentInput && void send\(sentInput, false\)\}/, 'Try again = the same input, the same id');
  assert.match(dlg, /if \(stage === 'saving' \|\| stage === 'uploading'\) \{\s*setWaitNote\(true\);\s*return;/, 'no closing mid-save');
  assert.match(dlg, /stage === 'editing' && \(touched \|\| items\.length > 0\)\) \{\s*setConfirmClose\('discard'\)/, 'asks before discarding');
  assert.match(dlg, /setConfirmClose\('leaveFailed'\)/, 'asks before leaving files that failed');
  assert.match(dlg, /else setConfirmClose\('leaveUncertain'\);/, 'not kept on the device: warn before closing');
  assert.match(dlg, /setConfirmClose\('discardPending'\)/, 'giving up an unconfirmed one is a deliberate, confirmed step');
  const form = noComments(src('src', 'components', 'jobs', 'OfficeReportForm.tsx'));
  assert.doesNotMatch(form, /completeVisitWithOfficeReport|useMutation|requestId:|requestId,/, 'the form only checks and hands over what to send (no request id of its own)');
  assert.match(form, /if \(locked\) return;/);
  assert.match(form, /officeReportFormError\(\{/, 'the existing checks, incl. the future-time rule');
  assert.doesNotMatch(form, /ReportPhotos|ReportVideos|office-report-saved/, 'no separate post-save screen');
  const page = noComments(src('src', 'pages', 'AllLiveJobsPage.tsx'));
  assert.match(page, /onCompleted=\{\(message\) => \{\s*setJobAction\(null\);\s*setCompletedNotice\(message\);/);
  assert.match(page, /queryFn: \(\) => listPendingSubmissions\(userId!\)/, 'the notice lists only this manager\'s unfinished submissions');
  assert.match(page, /userId=\{userId\}/);
});
