// Schedule (Nov 2026): deactivated technicians are not technician rows any more, and Schedule no longer offers "Reactivate" - that is
// done on the Users screen. Display only: no technician, visit, activity or report is changed. A deactivated technician who still has
// work in the period on screen keeps a row (marked Inactive), because a visit or activity only ever appears in its technician's row.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScheduleActivity, Technician, WeekVisit } from '../src/domain/types';
import ScheduleTechnicianGrid from '../src/components/calendar/ScheduleTechnicianGrid';
import NavRail from '../src/components/shell/NavRail';
import { AuthContext } from '../src/auth/AuthProvider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');

const mo: Technician = { id: 'mo', name: 'Mo', isActive: true, notes: null, appUserId: null };
const sam: Technician = { id: 'sam', name: 'Sam', isActive: true, notes: null, appUserId: null };
const retired: Technician = { id: 'old', name: 'Retired Rob', isActive: false, notes: null, appUserId: null };
const DAY = '2026-10-06';
const jobById = new Map<string, any>([['j1', { id: 'j1', buildingName: 'Flair', jobSummary: 'Windows', division: 'General' }]]);
const wv = (id: string, over: Partial<WeekVisit> = {}): WeekVisit => ({
  id, jobId: 'j1', technicianId: 'mo', additionalTechnicianIds: [], sortOrder: null, createdAt: '2026-10-06T08:00:00Z', scheduledDate: DAY, status: 'booked', startTime: null, endTime: null, ...over,
});
const sa = (id: string, over: Partial<ScheduleActivity> = {}): ScheduleActivity => ({
  id, description: 'Pick up keys', scheduledDate: DAY, technicianId: 'old', location: null, notes: null, startTime: null, endTime: null, sortOrder: null, createdAt: '2026-10-06T08:00:00Z', doneAt: null, cancelledAt: null, ...over,
});
const grid = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <ScheduleTechnicianGrid
      days={[new Date(2026, 9, 6)]}
      technicians={[mo, sam, retired]}
      visits={[]}
      displayVisits={[]}
      activities={[]}
      jobById={jobById}
      visitStatusStyle={{ due: 'a', booked: 'b', completed: 'c', missed: 'd', cancelled: 'e' } as any}
      todayISO={DAY}
      selectedDateISO={null}
      onSelectDay={noop}
      onSelectVisit={noop}
      onDrop={() => () => {}}
      onToggleTechnicianActive={noop}
      {...over}
    />,
  );

test('ROWS: active technicians only - a deactivated technician with nothing in the period has no row', () => {
  const html = grid();
  assert.match(html, />Mo</);
  assert.match(html, />Sam</);
  assert.doesNotMatch(html, /Retired Rob/);
});

test('NO REACTIVATE on Schedule: active rows keep "Deactivate"; reactivation is on the Users screen', () => {
  const html = grid();
  assert.equal((html.match(/>Deactivate</g) ?? []).length, 2);
  assert.doesNotMatch(html, />Reactivate</);
  const code = src('src', 'components', 'calendar', 'ScheduleTechnicianGrid.tsx');
  assert.doesNotMatch(code.replace(/\/\/[^\n]*|\{\/\*[\s\S]*?\*\/\}/g, ''), />\s*Reactivate\s*</);
});

test('NOTHING DISAPPEARS: a deactivated technician who still has a visit (or an activity) in the period keeps a row, marked Inactive', () => {
  const withVisit = grid({ visits: [wv('v1', { technicianId: 'old' })], displayVisits: [wv('v1', { technicianId: 'old' })] });
  assert.match(withVisit, />Retired Rob</);
  assert.match(withVisit, /data-testid="inactive-technician-tag"[^>]*>Inactive</);
  assert.match(withVisit, /Flair/, 'the visit is still shown');
  assert.doesNotMatch(withVisit, />Reactivate</, 'no Reactivate button (the tag only points to the Users screen)');
  const asExtra = grid({ visits: [wv('v2', { additionalTechnicianIds: ['old'] })], displayVisits: [wv('v2', { additionalTechnicianIds: ['old'] })] });
  assert.match(asExtra, />Retired Rob</, 'also when only an additional technician on a visit');
  const withActivity = grid({ activities: [sa('a1')] });
  assert.match(withActivity, />Retired Rob</);
  assert.match(withActivity, /Pick up keys/);
  const cancelled = grid({ activities: [sa('a2', { cancelledAt: '2026-10-05T10:00:00Z' })] });
  assert.doesNotMatch(cancelled, /Retired Rob/, 'a cancelled activity does not keep the row');
  const otherDay = grid({ activities: [sa('a3', { scheduledDate: '2026-10-20' })] });
  assert.doesNotMatch(otherDay, /Retired Rob/, 'work outside the period on screen does not keep the row');
});

test('REACTIVATED (from Users): the technician is active again, so their row is back', () => {
  assert.match(grid({ technicians: [mo, sam, { ...retired, isActive: true }] }), />Retired Rob</);
});

test('DISPLAY ONLY: the page still passes every technician (shared-visit names, drop rules); nothing is written by hiding a row', () => {
  const page = src('src', 'pages', 'ThisWeekPage.tsx');
  assert.match(page, /<ScheduleTechnicianGrid[\s\S]*?technicians=\{technicians\}/);
  const code = src('src', 'components', 'calendar', 'ScheduleTechnicianGrid.tsx');
  assert.match(code, /const technicianById = new Map\(technicians\.map/, 'names still come from everyone');
  assert.match(code, /\{rowTechnicians\.map\(\(technician\) => \{/);
  assert.match(page, /\{activeTechnicians\.length\} technician\{activeTechnicians\.length === 1 \? '' : 's'\}/, 'the count is of active technicians');
});

test('RAIL: the Schedule badge counts active technicians only (the same number Schedule shows)', () => {
  const auth: any = { status: 'authorized', role: 'manager', session: { user: { id: 'u1', email: 'luke@kindcontractors.co.uk' } }, signOut: async () => {}, recheck: noop };
  const rail = (techs: Technician[]) => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    for (const k of ['jobRows', 'historicalJobRows', 'buildingRows', 'users']) qc.setQueryData([k], []);
    qc.setQueryData(['jobRows', 'openReportWork'], []);
    qc.setQueryData(['technicians'], techs);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <AuthContext.Provider value={auth}>
          <MemoryRouter><NavRail /></MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    return /title="Schedule"[^>]*>(?:<i[^>]*><\/i>)?Schedule<b[^>]*>([0-9]+)<\/b>/.exec(html)?.[1];
  };
  assert.equal(rail([mo, sam, retired]), '2', 'a deactivated technician is not counted');
  assert.equal(rail([mo, sam, { ...retired, isActive: true }]), '3', 'reactivated: counted again');
});
