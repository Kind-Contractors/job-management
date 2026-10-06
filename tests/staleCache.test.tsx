// Regression tests for the 7af7739 production incident: a browser that cached query data
// in the PRE-multi-technician shape (no additionalTechnicianIds / sortOrder / createdAt on
// visits, no additionalTechnicians on job visits) restored it into the new code, which then
// threw "Cannot read properties of undefined (reading includes)" and blanked the Schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, dehydrate } from '@tanstack/react-query';
import { persistQueryClientRestore } from '@tanstack/react-query-persist-client';
import type { ReactElement } from 'react';

import { compareVisitsInDay, isVisitParticipant, visitTechnicianLabel, visitTechnicianNames } from '../src/lib/visitTechnicians';
import ScheduleTechnicianGrid from '../src/components/calendar/ScheduleTechnicianGrid';
import DayBookingsList from '../src/components/calendar/DayBookingsList';
import VisitRow from '../src/components/jobs/VisitRow';
import {
  QUERY_CACHE_MAX_AGE_MS,
  QUERY_CACHE_SCHEMA_VERSION,
  createUserQueryPersister,
  queryCacheBuster,
} from '../src/lib/userQueryCache';

// ---- fixtures -------------------------------------------------------------------------
const technicians: any[] = [
  { id: 'mo', name: 'Mo', isActive: true, notes: null, appUserId: null },
  { id: 't1', name: 'Tech 1', isActive: true, notes: null, appUserId: null },
];
const technicianById = new Map<string, any>(technicians.map((t) => [t.id, t]));
const jobById = new Map<string, any>([
  ['ja', { id: 'ja', buildingName: 'Flair', jobSummary: 'Window Cleaning', pricePerVisit: 100 }],
  ['jb', { id: 'jb', buildingName: 'Oak Court', jobSummary: 'Gutters', pricePerVisit: 50 }],
]);
const statusStyle: any = { due: '', booked: '', completed: '', missed: '', cancelled: '' };

/** EXACTLY what the 0a6f50e bundle produced and persisted for a visit on the Schedule. */
function oldWeekVisit(id: string, jobId: string, technicianId: string | null): any {
  return { id, jobId, technicianId, scheduledDate: '2026-10-01', status: 'booked' };
}
/** What the 7af7739 code produces from a fresh fetch. */
function freshWeekVisit(id: string, jobId: string, technicianId: string | null, extra: string[], sortOrder: number | null, createdAt: string): any {
  return { ...oldWeekVisit(id, jobId, technicianId), additionalTechnicianIds: extra, sortOrder, createdAt };
}
/** The pre-multi-technician JobVisitSummary (no additionalTechnicians / reportHasContributions / primaryContribution). */
const oldJobVisit: any = {
  id: 'v1', scheduledDate: '2026-10-01', status: 'booked', technicianId: 'mo', technicianName: 'Mo', priceCharged: null, completedAt: null,
  reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, invoiceId: null, invoiceStatus: null,
};

const wrap = (el: ReactElement) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);

// ---- helpers: old shape never throws; fresh shape behaviour unchanged ---------------------
test('helpers do not throw on the OLD cached visit shape', () => {
  const v = oldWeekVisit('a', 'ja', 'mo');
  assert.equal(isVisitParticipant(v, 'mo'), true);
  assert.equal(isVisitParticipant(v, 't1'), false); // the exact call that crashed production
  assert.deepEqual(visitTechnicianNames(v, technicianById), ['Mo']);
  assert.equal(visitTechnicianLabel(v, technicianById), 'Mo');
  const list = [oldWeekVisit('b', 'jb', 'mo'), oldWeekVisit('a', 'ja', 'mo')];
  assert.doesNotThrow(() => list.sort(compareVisitsInDay));
  assert.deepEqual(list.map((x) => x.id), ['a', 'b']); // deterministic by id when nothing else orders them
});

test('helpers behave exactly as designed on FRESH data', () => {
  const shared = freshWeekVisit('s', 'ja', 'mo', ['t1'], null, '2026-10-01T08:00:00Z');
  assert.equal(isVisitParticipant(shared, 't1'), true);
  assert.equal(isVisitParticipant(shared, 'nobody'), false);
  assert.deepEqual(visitTechnicianNames(shared, technicianById), ['Mo', 'Tech 1']);
  assert.equal(visitTechnicianLabel(shared, technicianById), 'Mo +1');
  const ordered = freshWeekVisit('o', 'ja', 'mo', [], 1, '2026-10-01T09:00:00Z');
  const early = freshWeekVisit('e', 'jb', 'mo', [], null, '2026-10-01T07:00:00Z');
  const late = freshWeekVisit('l', 'jb', 'mo', [], null, '2026-10-01T10:00:00Z');
  assert.deepEqual([late, early, ordered].sort(compareVisitsInDay).map((x) => x.id), ['o', 'e', 'l']); // ordered first, then created_at
});

// ---- the real Schedule components on old-shaped data -----------------------------------
test('ScheduleTechnicianGrid renders OLD-shaped visits (the production crash path)', () => {
  const visits = [oldWeekVisit('a', 'ja', 'mo'), oldWeekVisit('b', 'jb', 'mo')]; // second technician row exercises isVisitParticipant(v, t1)
  let html = '';
  assert.doesNotThrow(() => {
    html = renderToStaticMarkup(
      <ScheduleTechnicianGrid
        days={[new Date(2026, 9, 1)]} technicians={technicians} visits={visits} displayVisits={visits} jobById={jobById} visitStatusStyle={statusStyle}
        todayISO="2026-10-01" selectedDateISO={null} onSelectDay={() => {}} onSelectVisit={() => {}} onDrop={() => () => {}} onToggleTechnicianActive={() => {}}
      />,
    );
  });
  assert.match(html, /Flair/);
  assert.match(html, /Oak Court/);
});

test('DayBookingsList renders OLD-shaped visits', () => {
  const visits = [oldWeekVisit('a', 'ja', 'mo'), oldWeekVisit('b', 'jb', 'mo')];
  let html = '';
  assert.doesNotThrow(() => {
    html = wrap(<DayBookingsList dayVisits={visits} jobById={jobById} technicianById={technicianById} visitStatusStyle={statusStyle} onSelectVisit={() => {}} />);
  });
  assert.match(html, /Flair/);
  assert.match(html, /Oak Court/);
});

test('VisitRow renders an OLD-shaped job visit (no additionalTechnicians)', () => {
  let html = '';
  assert.doesNotThrow(() => {
    html = wrap(<VisitRow job={jobById.get('ja')} visit={oldJobVisit} actor="tester" technicians={technicians} />);
  });
  assert.match(html, /Mo/);
});

// ---- the persisted-cache fix itself ---------------------------------------------------
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  has(k: string) { return this.m.has(k); }
}
const KEY = (userId: string) => `kind-contractors-query-cache:v2:${userId}`; // per-user key, see src/lib/userQueryCache.ts
const VISITS_KEY = ['visits', '2026-09-28', '2026-10-03'];

/** A persisted payload as an OLD bundle wrote it: stamped with the bare user id, old-shaped visits. */
function oldBundlePayload(userId: string) {
  const qc = new QueryClient();
  qc.setQueryData(VISITS_KEY, [oldWeekVisit('a', 'ja', 'mo')]);
  return JSON.stringify({ buster: userId, timestamp: Date.now(), clientState: dehydrate(qc) });
}

test('the cache buster carries the schema version and stays per user', () => {
  assert.equal(queryCacheBuster('user-1'), `user-1:${QUERY_CACHE_SCHEMA_VERSION}`);
  assert.notEqual(queryCacheBuster('user-1'), queryCacheBuster('user-2'));
  assert.notEqual(queryCacheBuster('user-1'), 'user-1', 'must no longer be the bare user id');
});

test('a cache persisted by the previous app version is discarded on restore, only for that user', async () => {
  const storage = new MemoryStorage();
  (globalThis as any).window = { localStorage: storage };
  storage.setItem(KEY('user-1'), oldBundlePayload('user-1'));
  storage.setItem(KEY('user-2'), oldBundlePayload('user-2'));

  const qc = new QueryClient();
  await persistQueryClientRestore({ queryClient: qc, persister: createUserQueryPersister('user-1'), maxAge: QUERY_CACHE_MAX_AGE_MS, buster: queryCacheBuster('user-1') });

  assert.equal(qc.getQueryData(VISITS_KEY), undefined, 'old-shaped visits must NOT be restored into the new code');
  assert.equal(storage.has(KEY('user-1')), false, 'the stale entry is removed');
  assert.equal(storage.has(KEY('user-2')), true, 'another user cache is untouched (isolation kept)');
});

test('CONTROL: with the previous user-id-only buster the old-shaped data WOULD have been restored (the incident)', async () => {
  const storage = new MemoryStorage();
  (globalThis as any).window = { localStorage: storage };
  storage.setItem(KEY('user-1'), oldBundlePayload('user-1'));
  const qc = new QueryClient();
  await persistQueryClientRestore({ queryClient: qc, persister: createUserQueryPersister('user-1'), maxAge: QUERY_CACHE_MAX_AGE_MS, buster: 'user-1' });
  const restored = qc.getQueryData<any[]>(VISITS_KEY);
  assert.ok(restored && restored.length === 1, 'the old code path restores it');
  assert.equal(restored![0].additionalTechnicianIds, undefined, 'and it has no additionalTechnicianIds, which is what crashed the Schedule');
});

test('a cache written by the CURRENT version is restored normally', async () => {
  const storage = new MemoryStorage();
  (globalThis as any).window = { localStorage: storage };
  const qc0 = new QueryClient();
  qc0.setQueryData(VISITS_KEY, [freshWeekVisit('a', 'ja', 'mo', [], null, '2026-10-01T08:00:00Z')]);
  storage.setItem(KEY('user-1'), JSON.stringify({ buster: queryCacheBuster('user-1'), timestamp: Date.now(), clientState: dehydrate(qc0) }));

  const qc = new QueryClient();
  await persistQueryClientRestore({ queryClient: qc, persister: createUserQueryPersister('user-1'), maxAge: QUERY_CACHE_MAX_AGE_MS, buster: queryCacheBuster('user-1') });
  const restored = qc.getQueryData<any[]>(VISITS_KEY);
  assert.ok(restored && restored.length === 1 && Array.isArray(restored[0].additionalTechnicianIds));
});

// ---- the Activities release (2026-10-06): a cache from the multi-technician release must not be restored ----------------------
const PREVIOUS_RELEASE_VERSION = '2026-10-01-multi-technician';

test('the cache version was bumped for Activities, so the previous release\'s buster no longer matches', () => {
  assert.notEqual(QUERY_CACHE_SCHEMA_VERSION, PREVIOUS_RELEASE_VERSION);
  assert.notEqual(queryCacheBuster('user-1'), `user-1:${PREVIOUS_RELEASE_VERSION}`);
});

test('a cache persisted by the multi-technician release (visits without times, no activities, jobs-only technician list) is discarded on restore', async () => {
  const storage = new MemoryStorage();
  (globalThis as any).window = { localStorage: storage };
  const qc0 = new QueryClient();
  // Exactly the shapes that release cached: visits with no startTime/endTime, and the jobs-only technician list.
  qc0.setQueryData(VISITS_KEY, [freshWeekVisit('a', 'ja', 'mo', [], null, '2026-10-01T08:00:00Z')]);
  qc0.setQueryData(['technician', 'user-1', 'todayVisits'], [{ visitId: 'v1', scheduledDate: '2026-10-01', status: 'booked' }]);
  storage.setItem(KEY('user-1'), JSON.stringify({ buster: `user-1:${PREVIOUS_RELEASE_VERSION}`, timestamp: Date.now(), clientState: dehydrate(qc0) }));
  storage.setItem(KEY('user-2'), JSON.stringify({ buster: `user-2:${PREVIOUS_RELEASE_VERSION}`, timestamp: Date.now(), clientState: dehydrate(qc0) }));

  const qc = new QueryClient();
  await persistQueryClientRestore({ queryClient: qc, persister: createUserQueryPersister('user-1'), maxAge: QUERY_CACHE_MAX_AGE_MS, buster: queryCacheBuster('user-1') });

  assert.equal(qc.getQueryData(VISITS_KEY), undefined, 'the previous release\'s visits are not restored into the new code');
  assert.equal(qc.getQueryData(['technician', 'user-1', 'todayVisits']), undefined);
  assert.equal(storage.has(KEY('user-1')), false, 'the stale entry is removed');
  assert.equal(storage.has(KEY('user-2')), true, 'another user\'s cache is untouched (isolation kept)');
});

test('CONTROL: with the previous release\'s version string the old data WOULD have been restored (why the bump matters)', async () => {
  const storage = new MemoryStorage();
  (globalThis as any).window = { localStorage: storage };
  const qc0 = new QueryClient();
  qc0.setQueryData(VISITS_KEY, [freshWeekVisit('a', 'ja', 'mo', [], null, '2026-10-01T08:00:00Z')]);
  storage.setItem(KEY('user-1'), JSON.stringify({ buster: `user-1:${PREVIOUS_RELEASE_VERSION}`, timestamp: Date.now(), clientState: dehydrate(qc0) }));
  const qc = new QueryClient();
  await persistQueryClientRestore({ queryClient: qc, persister: createUserQueryPersister('user-1'), maxAge: QUERY_CACHE_MAX_AGE_MS, buster: `user-1:${PREVIOUS_RELEASE_VERSION}` });
  const restored = qc.getQueryData<any[]>(VISITS_KEY);
  assert.ok(restored && restored.length === 1, 'without the bump the old shape is restored');
  assert.equal(restored![0].startTime, undefined, 'and it has no startTime - the new code must therefore not depend on it (it reads ?? null)');
});
