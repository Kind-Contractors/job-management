// The two frequencies added for Luke: Bi-monthly (every two calendar months, stored as `bimonthly`) and 6 weekly (every six
// weeks, stored as `six_weekly`). Covers the dropdowns, saving/loading/display, pricing, the grid's frequency bands, the first-due
// schedule shortcut, the Monthly Plan rules, and the enum migration - and that every existing frequency is unchanged.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import JobCreator from '../src/components/jobs/JobCreator';
import { FREQUENCY_TYPE_LABEL, VISITS_PER_YEAR_BY_TYPE, computeDerivedPricing, mapJobRow, type SupabaseJobRecord } from '../src/repository/mapJobRow';
import { buildGridBlocks, visitsPerYearLabel } from '../src/lib/grouping';
import { buildFirstDueSchedule, isMonthBasedFrequency, isRecurringFrequency, isWeekBasedFrequency } from '../src/lib/firstDueSchedule';
import { describeSchedule, monthsDueInYear, suggestDateInMonth } from '../src/lib/scheduleFormat';
import type { FrequencyType, JobRow, Schedule } from '../src/domain/types';
import type { ScheduleInput } from '../src/repository/schedulesRepository';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);

// ---- the options ---------------------------------------------------------------------------------------------------------------------
test('OPTIONS: both new frequencies are offered with their labels, beside their neighbours; every existing option is kept', () => {
  assert.deepEqual(Object.entries(FREQUENCY_TYPE_LABEL), [
    ['weekly', 'Weekly'],
    ['fortnightly', 'Fortnightly'],
    ['six_weekly', '6 weekly'],
    ['monthly', 'Monthly'],
    ['bimonthly', 'Bi-monthly'],
    ['quarterly', 'Quarterly'],
    ['biannual', 'Biannual'],
    ['annual', 'Annual'],
    ['ask_adhoc', 'Ask / ad-hoc'],
    ['one_off', 'One-off'],
  ]);
  const html = wrap(<JobCreator onCreated={() => {}} onCancel={() => {}} />);
  const select = html.slice(html.indexOf('Frequency (for pricing)'), html.indexOf('</select>', html.indexOf('Frequency (for pricing)')));
  assert.match(select, /<option value="six_weekly">6 weekly<\/option>/);
  assert.match(select, /<option value="bimonthly">Bi-monthly<\/option>/);
  assert.equal((select.match(/<option /g) ?? []).length, 11, 'Not set + 10 frequencies');
  // The job editor and the grid's inline editor build their options from the same list.
  for (const file of ['JobEditor.tsx', 'JobsGrid.tsx']) assert.match(src('src', 'components', 'jobs', file), /Object\.keys\(FREQUENCY_TYPE_LABEL\) as FrequencyType\[\]/);
});

// ---- saving and loading ------------------------------------------------------------------------------------------------------------
function record(frequency_type: FrequencyType | null, price: number | null = 100): SupabaseJobRecord {
  return {
    id: 'j1', building_id: 'b1', job_type: 'general', job_summary: 'Window cleaning', job_notes: null, frequency_raw: 'legacy text', frequency_type,
    pricing_type: price == null ? 'variable' : 'fixed', price_per_visit: price, source_job_id: null, default_technician_id: null, lifecycle_status: 'active',
    lost_reason: null, recontact_due_at: null, recontact_notes: null, recontact_interval_months: null, service_ends_on: null,
    buildings: null, technicians: null, schedules: null, visits: [],
  };
}

test('LOAD/DISPLAY: a job saved as six_weekly or bimonthly loads with its label everywhere the frequency is shown', () => {
  const six = mapJobRow(record('six_weekly'));
  assert.deepEqual([six.frequencyType, six.frequency, six.frequencyRaw], ['six_weekly', '6 weekly', '6 weekly']);
  const bi = mapJobRow(record('bimonthly'));
  assert.deepEqual([bi.frequencyType, bi.frequency, bi.frequencyRaw], ['bimonthly', 'Bi-monthly', 'Bi-monthly']);
});

test('SAVE/EDIT: the chosen value is written to jobs.frequency_type as is, on create and on edit (no mapping to get wrong)', () => {
  const repo = src('src', 'repository', 'jobsRepository.ts');
  assert.match(repo, /frequency_type: input\.frequencyType,/);
  assert.match(repo, /if \('frequencyType' in input\) patch\.frequency_type = input\.frequencyType;/);
  assert.match(repo, /FREQUENCY_TYPE_LABEL\[f as FrequencyType\] \?\? f/, 'the change history shows the label too');
});

test('DATABASE: the migration adds both values to the job_frequency_type enum, additively and safely re-runnable', () => {
  const sql = src('supabase', 'migrations', '20261022100000_job_frequency_bimonthly_six_weekly.sql');
  assert.match(sql, /alter type public\.job_frequency_type add value if not exists 'six_weekly' after 'fortnightly';/);
  assert.match(sql, /alter type public\.job_frequency_type add value if not exists 'bimonthly' after 'monthly';/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\b(drop|delete|update|rename)\b/i, 'nothing removed or rewritten');
});

// ---- pricing -------------------------------------------------------------------------------------------------------------------------
test('PRICING: Bi-monthly is 6 visits a year; 6 weekly is 52 / 6 a year (the 52-week convention of weekly and fortnightly), to the penny', () => {
  assert.equal(VISITS_PER_YEAR_BY_TYPE.bimonthly, 6);
  assert.equal(VISITS_PER_YEAR_BY_TYPE.six_weekly, 52 / 6);
  assert.deepEqual(computeDerivedPricing('fixed', 'bimonthly', 100), { yearlyValue: 600, monthlyValue: 50 });
  const six = computeDerivedPricing('fixed', 'six_weekly', 100);
  assert.equal(six.yearlyValue, 866.67);
  assert.ok(Math.abs(six.monthlyValue! - 866.67 / 12) < 1e-9);
  assert.equal(computeDerivedPricing('fixed', 'six_weekly', 60).yearlyValue, 520, '60 x 52 / 6 is exactly 520');
  assert.deepEqual(computeDerivedPricing('variable', 'six_weekly', null), { yearlyValue: null, monthlyValue: null }, 'variable pricing still has no total');
  assert.deepEqual(mapJobRow(record('six_weekly', 120)).yearlyValue, 1040);
});

test('PRICING: every existing frequency gives exactly what it gave before', () => {
  const before: Record<string, number | null> = { weekly: 5200, fortnightly: 2600, monthly: 1200, quarterly: 400, biannual: 200, annual: 100, ask_adhoc: null, one_off: null };
  for (const [f, yearly] of Object.entries(before)) assert.equal(computeDerivedPricing('fixed', f as FrequencyType, 100).yearlyValue, yearly, f);
  assert.equal(computeDerivedPricing('fixed', 'weekly', 12.35).yearlyValue, 642.2);
  assert.equal(computeDerivedPricing('fixed', 'monthly', 33.33).monthlyValue, 33.33);
});

test('GRID: "By frequency" has a band for each, in order, with honest visit counts', () => {
  const job = (id: string, frequency: JobRow['frequency']) => ({ ...mapJobRow(record(null)), id, frequency }) as JobRow;
  const bands = buildGridBlocks([job('a', 'Bi-monthly'), job('b', '6 weekly'), job('c', 'Monthly'), job('d', 'Fortnightly')], 'frequency').filter((b) => b.kind === 'band') as {
    title: string;
    subtitle: string;
  }[];
  assert.deepEqual(bands.map((b) => [b.title, b.subtitle]), [
    ['Fortnightly', '26 visits a year per job'],
    ['6 weekly', 'about 8.7 visits a year per job'],
    ['Monthly', '12 visits a year per job'],
    ['Bi-monthly', '6 visits a year per job'],
  ]);
  assert.equal(visitsPerYearLabel(1), '1 visit a year per job');
});

// ---- scheduling ----------------------------------------------------------------------------------------------------------------------
function asSchedule(input: ScheduleInput): Schedule {
  const i = input as Record<string, unknown>;
  return {
    jobId: 'j1', scheduleType: input.scheduleType, intervalUnit: (i.intervalUnit as Schedule['intervalUnit']) ?? null, intervalCount: (i.intervalCount as number) ?? null,
    weekday: (i.weekday as Schedule['weekday']) ?? null, weekOrdinal: (i.weekOrdinal as Schedule['weekOrdinal']) ?? null, dayOfMonth: (i.dayOfMonth as number) ?? null,
    rollForwardOnWeekend: (i.rollForwardOnWeekend as boolean) ?? true, dueMonth: (i.dueMonth as number) ?? null, anchorDate: (i.anchorDate as string) ?? null, notes: null,
  };
}

test('BI-MONTHLY schedules every two calendar months from the first due date, and the Monthly Plan can place it', () => {
  assert.equal(isMonthBasedFrequency('bimonthly'), true);
  const input = buildFirstDueSchedule({ frequencyType: 'bimonthly', firstDueISO: '2026-11-18', pattern: 'fixed_date', rollForwardOnWeekend: false })!;
  assert.ok(input);
  const s = asSchedule(input);
  assert.deepEqual([s.intervalUnit, s.intervalCount], ['month', 2]);
  assert.equal(describeSchedule(s), 'Every 2 months, on the 18th (counted from Nov 2026)');
  const months = [...monthsDueInYear(s, 2027)!];
  assert.deepEqual(months, [1, 3, 5, 7, 9, 11], 'Nov 2026, then Jan, Mar, May, Jul, Sep, Nov');
  assert.deepEqual(months.map((m) => suggestDateInMonth(s, 2027, m)), ['2027-01-18', '2027-03-18', '2027-05-18', '2027-07-18', '2027-09-18', '2027-11-18']);
  const html = wrap(<JobCreator defaultFrequencyType="bimonthly" onCreated={() => {}} onCancel={() => {}} />);
  assert.match(html, /data-testid="recurrence-section"/, 'the first-due shortcut is offered');
  assert.doesNotMatch(html, /data-testid="week-based-note"/);
});

test('6 WEEKLY is a week cadence (every 42 days): treated exactly like weekly and fortnightly - recurring, but not placed on the Monthly Plan', () => {
  assert.equal(isWeekBasedFrequency('six_weekly'), true);
  assert.equal(isMonthBasedFrequency('six_weekly'), false);
  assert.equal(isRecurringFrequency('six_weekly'), true, 'it still warns when it has no schedule');
  assert.equal(buildFirstDueSchedule({ frequencyType: 'six_weekly', firstDueISO: '2026-11-18', pattern: 'fixed_date', rollForwardOnWeekend: false }), null, 'no month schedule is invented for it');
  const html = wrap(<JobCreator defaultFrequencyType="six_weekly" onCreated={() => {}} onCancel={() => {}} />);
  assert.doesNotMatch(html, /data-testid="recurrence-section"/);
  assert.match(html, /data-testid="week-based-note"[^>]*>6 weekly work can’t be placed on the Monthly Plan yet — it\s+repeats on a cycle of weeks, not calendar months\./);
  // A schedule the manager sets by hand stores it exactly: every 6 weeks = 6 x 7 = 42 days.
  const manual: Schedule = { jobId: 'j1', scheduleType: 'fixed_weekday', intervalUnit: 'week', intervalCount: 6, weekday: 'wed', weekOrdinal: '1st', dayOfMonth: null, rollForwardOnWeekend: false, dueMonth: null, anchorDate: '2026-11-18', notes: null };
  assert.match(describeSchedule(manual), /^Every 6 weeks/);
});

test('existing frequencies keep their schedule behaviour', () => {
  for (const f of ['monthly', 'quarterly', 'biannual', 'annual'] as FrequencyType[]) assert.equal(isMonthBasedFrequency(f), true, f);
  for (const f of ['weekly', 'fortnightly'] as FrequencyType[]) assert.equal(isWeekBasedFrequency(f), true, f);
  for (const f of ['ask_adhoc', 'one_off'] as FrequencyType[]) assert.equal(isRecurringFrequency(f), false, f);
});
