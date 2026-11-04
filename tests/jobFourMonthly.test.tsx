// Four-monthly (stored as `four_monthly`): one visit every four calendar months, 3 visits a year - added for Luke. Covers the
// dropdowns, loading/display, pricing (£100 a visit -> £300 a year, £25 a month), the grid's frequency bands, the first-due schedule
// shortcut and the Monthly Plan / Month Matrix / next-date rules, and the enum migration - and that every existing frequency is unchanged.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import JobCreator from '../src/components/jobs/JobCreator';
import { FREQUENCY_TYPE_LABEL, VISITS_PER_YEAR_BY_TYPE, computeDerivedPricing, mapJobRow, type SupabaseJobRecord } from '../src/repository/mapJobRow';
import { buildGridBlocks } from '../src/lib/grouping';
import { buildFirstDueSchedule, isMonthBasedFrequency, isRecurringFrequency, isWeekBasedFrequency } from '../src/lib/firstDueSchedule';
import { describeSchedule, isMonthInCycle, monthsDueInYear, suggestDateInMonth, suggestNextDate } from '../src/lib/scheduleFormat';
import type { FrequencyType, JobRow, Schedule } from '../src/domain/types';
import type { ScheduleInput } from '../src/repository/schedulesRepository';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);

function record(frequency_type: FrequencyType | null, price: number | null = 100): SupabaseJobRecord {
  return {
    id: 'j1', building_id: 'b1', job_type: 'general', job_summary: 'Gutter clearance', job_notes: null, frequency_raw: 'Four-Monthly', frequency_type,
    pricing_type: price == null ? 'variable' : 'fixed', price_per_visit: price, source_job_id: null, default_technician_id: null, lifecycle_status: 'active',
    lost_reason: null, recontact_due_at: null, recontact_notes: null, recontact_interval_months: null, service_ends_on: null,
    buildings: null, technicians: null, schedules: null, visits: [],
  };
}

function asSchedule(input: ScheduleInput): Schedule {
  const i = input as Record<string, unknown>;
  return {
    jobId: 'j1', scheduleType: input.scheduleType, intervalUnit: (i.intervalUnit as Schedule['intervalUnit']) ?? null, intervalCount: (i.intervalCount as number) ?? null,
    weekday: (i.weekday as Schedule['weekday']) ?? null, weekOrdinal: (i.weekOrdinal as Schedule['weekOrdinal']) ?? null, dayOfMonth: (i.dayOfMonth as number) ?? null,
    rollForwardOnWeekend: (i.rollForwardOnWeekend as boolean) ?? true, dueMonth: (i.dueMonth as number) ?? null, anchorDate: (i.anchorDate as string) ?? null, notes: null,
  };
}

// ---- options, loading, database ------------------------------------------------------------------------------------------------------
test('OPTIONS: "Four-monthly" is offered right after Bi-monthly in the job creator; the editor and the grid use the same list', () => {
  const entries = Object.entries(FREQUENCY_TYPE_LABEL);
  const at = entries.findIndex(([k]) => k === 'four_monthly');
  assert.deepEqual(entries[at], ['four_monthly', 'Four-monthly']);
  assert.deepEqual([entries[at - 1][0], entries[at + 1][0]], ['bimonthly', 'quarterly']);
  const html = wrap(<JobCreator onCreated={() => {}} onCancel={() => {}} />);
  const select = html.slice(html.indexOf('Frequency (for pricing)'), html.indexOf('</select>', html.indexOf('Frequency (for pricing)')));
  assert.match(select, /<option value="bimonthly">Bi-monthly<\/option><option value="four_monthly">Four-monthly<\/option><option value="quarterly">Quarterly<\/option>/);
  for (const file of ['JobEditor.tsx', 'JobsGrid.tsx']) assert.match(src('src', 'components', 'jobs', file), /Object\.keys\(FREQUENCY_TYPE_LABEL\) as FrequencyType\[\]/);
});

test('LOAD/DISPLAY: a job saved as four_monthly loads as "Four-monthly" everywhere; an untyped legacy "Four-Monthly" job is left as it was', () => {
  const j = mapJobRow(record('four_monthly'));
  assert.deepEqual([j.frequencyType, j.frequency, j.frequencyRaw], ['four_monthly', 'Four-monthly', 'Four-monthly']);
  const legacy = mapJobRow(record(null));
  assert.deepEqual([legacy.frequencyType, legacy.frequency, legacy.frequencyRaw, legacy.yearlyValue], [null, 'Unknown', 'Four-Monthly', null], 'no automatic reclassification');
});

test('DATABASE: the migration only adds four_monthly after bimonthly to the enum - additive and safely re-runnable', () => {
  const sql = src('supabase', 'migrations', '20261104100000_job_frequency_four_monthly.sql');
  const code = sql.replace(/^--.*$/gm, '').trim();
  assert.equal(code, "alter type public.job_frequency_type add value if not exists 'four_monthly' after 'bimonthly';");
});

// ---- pricing -------------------------------------------------------------------------------------------------------------------------
test('PRICING: 3 visits a year - £100 a visit is £300 a year and £25 a month; to the penny; variable pricing still has no totals', () => {
  assert.equal(VISITS_PER_YEAR_BY_TYPE.four_monthly, 3);
  assert.deepEqual(computeDerivedPricing('fixed', 'four_monthly', 100), { yearlyValue: 300, monthlyValue: 25 });
  assert.equal(computeDerivedPricing('fixed', 'four_monthly', 33.33).yearlyValue, 99.99);
  assert.equal(computeDerivedPricing('fixed', 'four_monthly', 12.35).yearlyValue, 37.05);
  assert.deepEqual(computeDerivedPricing('variable', 'four_monthly', null), { yearlyValue: null, monthlyValue: null });
  assert.deepEqual(computeDerivedPricing('variable', 'four_monthly', 100), { yearlyValue: null, monthlyValue: null }, 'variable even with a price');
  const j = mapJobRow(record('four_monthly', 100));
  assert.deepEqual([j.yearlyValue, j.monthlyValue], [300, 25]);
});

test('PRICING REGRESSION: every existing frequency gives exactly what it gave before (visits a year and totals)', () => {
  const visits: Record<string, number> = { weekly: 52, fortnightly: 26, six_weekly: 52 / 6, monthly: 12, bimonthly: 6, quarterly: 4, biannual: 2, annual: 1, ask_adhoc: 0, one_off: 0 };
  for (const [f, n] of Object.entries(visits)) assert.equal(VISITS_PER_YEAR_BY_TYPE[f as FrequencyType], n, f);
  const yearlyAt100: Record<string, number | null> = { weekly: 5200, fortnightly: 2600, six_weekly: 866.67, monthly: 1200, bimonthly: 600, quarterly: 400, biannual: 200, annual: 100, ask_adhoc: null, one_off: null };
  for (const [f, y] of Object.entries(yearlyAt100)) assert.equal(computeDerivedPricing('fixed', f as FrequencyType, 100).yearlyValue, y, f);
  assert.deepEqual(computeDerivedPricing('fixed', null, 100), { yearlyValue: null, monthlyValue: null }, 'no frequency, no total');
});

// ---- grouping ------------------------------------------------------------------------------------------------------------------------
test('GRID: the "By frequency" band reads "3 visits a year per job", between Bi-monthly and Quarterly; other bands unchanged', () => {
  const job = (id: string, frequency: JobRow['frequency']) => ({ ...mapJobRow(record(null)), id, frequency }) as JobRow;
  const bands = buildGridBlocks(
    [job('a', 'Quarterly'), job('b', 'Four-monthly'), job('c', 'Bi-monthly'), job('d', 'Monthly'), job('e', 'Four-monthly'), job('f', 'Annual')],
    'frequency',
  ).filter((b) => b.kind === 'band') as { title: string; subtitle: string; rowCount: number }[];
  assert.deepEqual(bands.map((b) => [b.title, b.subtitle, b.rowCount]), [
    ['Monthly', '12 visits a year per job', 1],
    ['Bi-monthly', '6 visits a year per job', 1],
    ['Four-monthly', '3 visits a year per job', 2],
    ['Quarterly', '4 visits a year per job', 1],
    ['Annual', '1 visit a year per job', 1],
  ]);
});

// ---- scheduling ----------------------------------------------------------------------------------------------------------------------
test('SCHEDULE: every 4 calendar months from the first due date (Nov 2026) -> due in March, July and November, every year', () => {
  assert.equal(isMonthBasedFrequency('four_monthly'), true);
  assert.equal(isWeekBasedFrequency('four_monthly'), false);
  assert.equal(isRecurringFrequency('four_monthly'), true, 'it still warns when it has no schedule');
  const s = asSchedule(buildFirstDueSchedule({ frequencyType: 'four_monthly', firstDueISO: '2026-11-18', pattern: 'fixed_date', rollForwardOnWeekend: false })!);
  assert.deepEqual([s.intervalUnit, s.intervalCount, s.anchorDate], ['month', 4, '2026-11-18']);
  assert.equal(describeSchedule(s), 'Every 4 months, on the 18th (counted from Nov 2026)');
  for (const year of [2027, 2028, 2031]) assert.deepEqual([...monthsDueInYear(s, year)!], [3, 7, 11], `Month Matrix ${year}`);
  assert.deepEqual([...monthsDueInYear(s)!], [3, 7, 11], 'the same three months without naming a year (4 divides 12)');
  assert.deepEqual([...monthsDueInYear(s, 2026)!], [3, 7, 11], 'the anchor sets the phase, not a start: earlier months follow the same cycle');
  assert.deepEqual([3, 7, 11].map((m) => suggestDateInMonth(s, 2027, m)), ['2027-03-18', '2027-07-18', '2027-11-18']);
  assert.equal(isMonthInCycle(s, 2027, 5), false);
});

test('NEXT DATE: the suggestion steps 4 months at a time', () => {
  const s = asSchedule(buildFirstDueSchedule({ frequencyType: 'four_monthly', firstDueISO: '2026-11-18', pattern: 'fixed_date', rollForwardOnWeekend: false })!);
  assert.equal(suggestNextDate(s, '2026-11-01'), '2026-11-18');
  assert.equal(suggestNextDate(s, '2026-11-19'), '2027-03-18');
  assert.equal(suggestNextDate(s, '2027-03-19'), '2027-07-18');
  assert.equal(suggestNextDate(s, '2027-07-19'), '2027-11-18');
});

test('OTHER PATTERNS: 3rd Wednesday and due-month readings of the same date keep the 4-month cycle (Mar / Jul / Nov)', () => {
  const weekday = asSchedule(buildFirstDueSchedule({ frequencyType: 'four_monthly', firstDueISO: '2026-11-18', pattern: 'fixed_weekday', rollForwardOnWeekend: false })!);
  assert.deepEqual([...monthsDueInYear(weekday, 2027)!], [3, 7, 11]);
  assert.deepEqual([3, 7, 11].map((m) => suggestDateInMonth(weekday, 2027, m)), ['2027-03-17', '2027-07-21', '2027-11-17'], 'the 3rd Wednesday of each');
  const dueMonth = asSchedule(buildFirstDueSchedule({ frequencyType: 'four_monthly', firstDueISO: '2026-11-18', pattern: 'due_month', rollForwardOnWeekend: false })!);
  assert.deepEqual([...monthsDueInYear(dueMonth, 2027)!], [3, 7, 11]);
  // A due-month schedule set by hand WITHOUT an anchor still answers, because 4 divides 12 (as quarterly and bi-monthly do).
  const unanchored: Schedule = { jobId: 'j1', scheduleType: 'due_month', intervalUnit: 'month', intervalCount: 4, weekday: null, weekOrdinal: null, dayOfMonth: null, rollForwardOnWeekend: false, dueMonth: 11, anchorDate: null, notes: null };
  assert.deepEqual([...monthsDueInYear(unanchored)!], [3, 7, 11]);
});

test('JOB CREATOR: Four-monthly offers the first-due shortcut (Monthly Plan can place it) and shows no week-based note', () => {
  const html = wrap(<JobCreator defaultFrequencyType="four_monthly" onCreated={() => {}} onCancel={() => {}} />);
  assert.match(html, /data-testid="recurrence-section"/);
  assert.doesNotMatch(html, /data-testid="week-based-note"/);
});

test('SCHEDULE REGRESSION: existing frequencies keep their cadence and their Monthly Plan behaviour', () => {
  const cadence: [FrequencyType, string, number][] = [
    ['monthly', 'month', 1],
    ['bimonthly', 'month', 2],
    ['quarterly', 'quarter', 1],
    ['biannual', 'month', 6],
    ['annual', 'year', 1],
  ];
  for (const [f, unit, count] of cadence) {
    const s = asSchedule(buildFirstDueSchedule({ frequencyType: f, firstDueISO: '2026-11-18', pattern: 'fixed_date', rollForwardOnWeekend: false })!);
    assert.deepEqual([s.intervalUnit, s.intervalCount], [unit, count], f);
  }
  for (const f of ['weekly', 'fortnightly', 'six_weekly'] as FrequencyType[]) {
    assert.equal(isWeekBasedFrequency(f), true, f);
    assert.equal(buildFirstDueSchedule({ frequencyType: f, firstDueISO: '2026-11-18', pattern: 'fixed_date', rollForwardOnWeekend: false }), null, f);
  }
  for (const f of ['ask_adhoc', 'one_off'] as FrequencyType[]) assert.equal(isRecurringFrequency(f), false, f);
});
