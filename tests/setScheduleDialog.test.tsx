// The focused "Set a schedule" modal on the Monthly Plan
// (src/components/monthlyPlan/SetScheduleDialog.tsx).
//
// It owns no logic of its own: the form, its validation and its save are ScheduleEditor's, reached with
// `autoEdit`/`embedded`. So these tests check the three things the modal is actually responsible for — that it
// opens straight into the form for the right job, that it writes ONLY a schedule (never a job or a visit), and
// that saving refreshes the Monthly Plan — plus the row that opens it.
//
// There is no DOM library in this repo, so markup is server-rendered and the write path is exercised through the
// real repository against a fake Supabase behind fetch. Clicking through the whole thing is the DEV browser test.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import SetScheduleDialog from '../src/components/monthlyPlan/SetScheduleDialog';
import MonthlyPlanRow from '../src/components/monthlyPlan/MonthlyPlanRow';
import { upsertSchedule } from '../src/repository/schedulesRepository';
import type { MonthlyPlanEntry } from '../src/lib/monthlyPlan';
import type { JobRow, Schedule } from '../src/domain/types';

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>,
  );

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  jobId: 'j1', scheduleType: 'fixed_date', intervalUnit: 'quarter', intervalCount: 1, weekday: null,
  weekOrdinal: null, dayOfMonth: 18, rollForwardOnWeekend: true, dueMonth: null, anchorDate: '2026-11-18',
  notes: null, ...over,
});

const job = (over: Partial<JobRow> = {}): JobRow =>
  ({
    id: 'j1', buildingId: 'b1', buildingName: 'Flair House', clientId: 'c1', clientName: 'ABC Property',
    jobSummary: 'Communal cleaning', division: 'General', frequency: 'Monthly', frequencyRaw: 'Monthly',
    frequencyType: 'monthly', schedulePattern: 'Monthly', schedule: null, visits: [], serviceEndsOn: null,
    defaultTechnicianId: null, yearlyValue: 1200, ...over,
  }) as unknown as JobRow;

// ---- OPENING ---------------------------------------------------------------------------------------------------
test('OPEN: the modal names the job and opens STRAIGHT into the form — no "Add schedule" step', () => {
  const html = wrap(<SetScheduleDialog job={job()} onClose={() => {}} />);
  assert.match(html, /data-testid="set-schedule-dialog"/);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /aria-label="Set a schedule for Flair House"/);
  assert.match(html, /Flair House · ABC Property · Communal cleaning/);
  assert.match(html, /When is this job due\?/);
  // The form itself, not ScheduleEditor's view mode.
  assert.match(html, />Choose a type…</, 'the type picker is already on screen');
  assert.match(html, />Save schedule</);
  assert.doesNotMatch(html, />Add schedule</, 'autoEdit skips the extra click');
  assert.doesNotMatch(html, /No schedule set for this job\./, 'and skips the view-mode text');
});

test('OPEN: it says why the job is stuck, in its own words', () => {
  const html = wrap(<SetScheduleDialog job={job({ frequencyRaw: 'Quarterly' })} onClose={() => {}} />);
  assert.match(html, /Priced as quarterly work, but nothing says when it falls/);
});

test('OPEN on a job that already HAS a schedule describes it and pre-fills the form', () => {
  const html = wrap(<SetScheduleDialog job={job({ schedule: schedule() })} onClose={() => {}} />);
  assert.match(html, /Edit this job’s schedule/);
  assert.match(html, /Every quarter, on the 18th/, 'the existing rule is stated');
  assert.match(html, /value="2026-11-18"/, 'and its anchor is loaded into the form');
});

test('OPEN: it does not draw a second panel inside itself', () => {
  const html = wrap(<SetScheduleDialog job={job()} onClose={() => {}} />);
  // `embedded` drops ScheduleEditor's own border/heading; the modal supplies them once.
  assert.equal(html.split('Schedule').filter((s) => s.length).length > 0, true);
  assert.doesNotMatch(html, /m-3\.5 border border-neutral-300 p-3/);
});

// ---- VALIDATION -------------------------------------------------------------------------------------------------
test('VALIDATION: Save is disabled until the form is actually complete', () => {
  // A blank form has no schedule_type, so ScheduleEditor's toInput() returns null and Save cannot be pressed.
  const html = wrap(<SetScheduleDialog job={job()} onClose={() => {}} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Save schedule<\/button>/);
});

test('VALIDATION: a complete, pre-filled form enables Save', () => {
  const html = wrap(<SetScheduleDialog job={job({ schedule: schedule() })} onClose={() => {}} />);
  assert.match(html, />Save schedule</);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Save schedule<\/button>/);
});

test('VALIDATION lives in ScheduleEditor — the modal has no second copy of it', () => {
  const dialog = src('components/monthlyPlan/SetScheduleDialog.tsx');
  assert.match(dialog, /<ScheduleEditor/, 'it renders the real editor');
  // Checked on the CODE, not the prose: the header comment legitimately names upsertSchedule when explaining
  // whose save this is, and matching that would pass or fail on wording rather than on behaviour.
  const code = dialog.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /upsertSchedule|useMutation|ScheduleInput|schedulesRepository/, 'it never writes or validates itself');
  assert.doesNotMatch(code, /from '\.\.\/\.\.\/repository/, 'and reaches no repository directly');
});

// ---- CANCELLING -------------------------------------------------------------------------------------------------
test('CANCEL: the modal offers Cancel, and dismisses on the backdrop', () => {
  const html = wrap(<SetScheduleDialog job={job()} onClose={() => {}} />);
  assert.match(html, />Cancel</);
  const dialog = src('components/monthlyPlan/SetScheduleDialog.tsx');
  assert.match(dialog, /onCancel=\{onClose\}/, 'Cancel closes the modal');
  assert.match(dialog, /onClick=\{onClose\}[\s\S]*onClick=\{\(e\) => e\.stopPropagation\(\)\}/, 'backdrop closes, panel does not');
});

test('CANCEL writes nothing — only Save ever calls upsertSchedule', () => {
  const editor = src('components/jobs/ScheduleEditor.tsx');
  assert.match(editor, /onClick=\{\(\) => \(autoEdit \? onCancel\?\.\(\) : setMode\('view'\)\)\}/);
  assert.match(editor, /mutationFn: \(input: ScheduleInput\) => upsertSchedule\(jobId, input\)/);
});

// ---- SAVING + REFRESHING ----------------------------------------------------------------------------------------
test('SAVE closes the modal and refreshes the Monthly Plan', () => {
  const editor = src('components/jobs/ScheduleEditor.tsx');
  // The plan derives every row from this one cached query, so invalidating it IS the refresh.
  assert.match(editor, /invalidateQueries\(\{ queryKey: \['jobRows'\] \}\)/);
  assert.match(editor, /onSuccess: \(\) => \{[\s\S]*invalidate\(\);[\s\S]*onSaved\?\.\(\);/);
  assert.match(src('components/monthlyPlan/SetScheduleDialog.tsx'), /onSaved=\{onClose\}/);
});

// The real repository write, against a fake Supabase behind fetch.
interface Logged { method: string; path: string; body: any }
const log: Logged[] = [];
beforeEach(() => { log.length = 0; });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  log.push({ method, path: decodeURIComponent(url.pathname), body: init?.body ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

test('SAVE writes ONE schedules row for the job that already exists — no job, no visit', async () => {
  await upsertSchedule('j1', {
    scheduleType: 'fixed_weekday', intervalUnit: 'quarter', intervalCount: 1,
    weekday: 'wed', weekOrdinal: '3rd', anchorDate: '2026-11-18', notes: null,
  });

  assert.equal(log.length, 1, 'exactly one request');
  assert.equal(log[0].path, '/rest/v1/schedules');
  assert.equal(log[0].method, 'POST', 'an upsert on the schedules table');
  assert.equal(log[0].body.job_id, 'j1', 'against the EXISTING job');
  assert.equal(log[0].body.schedule_type, 'fixed_weekday');
  assert.equal(log[0].body.anchor_date, '2026-11-18');
  // The full-row invariant: every non-applicable column is sent explicitly null.
  assert.equal(log[0].body.day_of_month, null);
  assert.equal(log[0].body.due_month, null);
  assert.equal(log.some((r) => /\/jobs|\/visits/.test(r.path)), false, 'nothing created a job or a visit');
});

// ---- THE ROW THAT OPENS IT ---------------------------------------------------------------------------------------
const entry = (over: Partial<MonthlyPlanEntry> = {}): MonthlyPlanEntry => ({
  job: job(), kind: 'no_schedule', visitsInMonth: [], dueFromMonth: null, suggestedDate: null,
  label: 'No schedule set', needsSchedule: true, ...over,
});

test('ROW: a needs-a-schedule job offers "Set a schedule"', () => {
  const html = wrap(<MonthlyPlanRow entry={entry()} technicians={[]} onOpenJob={() => {}} onSetSchedule={() => {}} />);
  assert.match(html, /data-testid="no-schedule-explainer"/);
  assert.match(html, />Set a schedule</);
});

test('ROW: "Set a schedule" opens the MODAL, while everything else still opens the drawer', () => {
  const row = src('components/monthlyPlan/MonthlyPlanRow.tsx');
  assert.match(row, /'Set a schedule', \(\) => onSetSchedule\(job\.id\)\)/);
  // A can't-tell job already HAS a schedule and is only missing its anchor, so it keeps going to the drawer.
  assert.match(row, /'Set it on the job', \(\) => onOpenJob\(job\.id\)\)/);
  const page = src('pages/MonthlyPlanPage.tsx');
  assert.match(page, /onSetSchedule=\{setSchedulingJobId\}/);
  assert.match(page, /\{schedulingJob && <SetScheduleDialog job=\{schedulingJob\} onClose=\{\(\) => setSchedulingJobId\(null\)\} \/>\}/);
});

test('THE DRAWER IS UNCHANGED: it still renders ScheduleEditor in its ordinary, non-modal form', () => {
  const drawer = src('components/jobs/JobInspectorDrawer.tsx');
  assert.match(drawer, /<ScheduleEditor jobId=\{job\.id\} schedule=\{job\.schedule\} frequencyType=\{job\.frequencyType\} \/>/);
  assert.doesNotMatch(drawer, /autoEdit|embedded|SetScheduleDialog/);
});
