// The Schedule's "Add booking" form (ScheduleDayDrawer): its Client and Building choices come from the BUILDINGS list, merged with
// the live jobs, so a building with no live job yet (a new building) can be chosen and get its first job from "+ Add new job for
// this building". Before, both lists came from the live jobs only, so a new building never appeared (DEV, 2026-11-11: "Acme
// Property - Build-1" and "Build 2" under Acme Property (Test Client)). The Job choice stays the building's live jobs, and booking
// still goes through the same createVisit call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readSourceFile } from './helpers/sourceCode';
import { bookingBuildings, bookingBuildingSublabel, bookingClients } from '../src/lib/scheduleBookingOptions';
import ScheduleDayDrawer from '../src/components/calendar/ScheduleDayDrawer';

const ACME = 'c-acme', OTHER = 'c-other', BARE = 'c-bare';
const building = (id: string, clientId: string, clientName: string, buildingName: string, over: Record<string, unknown> = {}) => ({
  id, clientId, clientName, address: 'test adress', name: buildingName, buildingName, postcode: '', invoiceDetails: '', siteInstructions: '', access: null, defaultRecipient: null, ...over,
});
const BUILDINGS = [
  building('b-test', ACME, 'Acme Property (Test Client)', 'Acme Property (Test Building)', { address: 'London, England', postcode: 'W1 1AA' }),
  building('b-1', ACME, 'Acme Property (Test Client)', 'Acme Property - Build-1', { siteInstructions: 'Ring the concierge' }),
  building('b-2', ACME, 'Acme Property (Test Client)', 'Acme Property - Build 2'),
  building('b-other', OTHER, 'Other Client', 'Other Court'),
  building('b-bare', BARE, 'Bare Client (no jobs)', 'Bare House'),
];
const job = (id: string, clientId: string, clientName: string, buildingId: string, buildingName: string) =>
  ({ id, clientId, clientName, buildingId, buildingName, jobSummary: 'Window cleaning', frequencyRaw: 'Weekly', visits: [] }) as any;
const JOBS = [job('j-1', ACME, 'Acme Property (Test Client)', 'b-test', 'Acme Property (Test Building)'), job('j-2', OTHER, 'Other Client', 'b-other', 'Other Court')];

// ---- the choices -------------------------------------------------------------------------------------------------------------------
test('BUILDINGS: a new building with no jobs appears beside the one with a live job, marked as having none', () => {
  const acme = bookingBuildings(BUILDINGS, JOBS, ACME);
  assert.deepEqual(acme.map((b) => [b.name, b.hasLiveJobs]), [
    ['Acme Property - Build 2', false],
    ['Acme Property - Build-1', false],
    ['Acme Property (Test Building)', true],
  ]);
  assert.ok(!acme.some((b) => b.id === 'b-other'), "another client's building is never offered");
});

test('CLIENTS: a client with buildings but no live jobs appears; every client once, by name', () => {
  assert.deepEqual(bookingClients(BUILDINGS, JOBS).map((c) => c.name), ['Acme Property (Test Client)', 'Bare Client (no jobs)', 'Other Client']);
  assert.deepEqual(bookingBuildings(BUILDINGS, JOBS, BARE).map((b) => [b.name, b.hasLiveJobs]), [['Bare House', false]]);
});

test('BEFORE THE BUILDINGS LOAD: exactly what was offered before (from the live jobs) - nothing disappears', () => {
  assert.deepEqual(bookingClients([], JOBS).map((c) => c.name), ['Acme Property (Test Client)', 'Other Client']);
  assert.deepEqual(bookingBuildings([], JOBS, ACME), [{ id: 'b-test', name: 'Acme Property (Test Building)', postcode: '', hasLiveJobs: true }]);
  assert.deepEqual(bookingBuildings(BUILDINGS, JOBS, ''), [], 'no client chosen: no buildings');
});

test('SUBLABEL: the postcode, and "no live jobs yet" for a building without one', () => {
  const [b2, b1, test1] = bookingBuildings(BUILDINGS, JOBS, ACME);
  assert.equal(bookingBuildingSublabel(test1), 'W1 1AA');
  assert.equal(bookingBuildingSublabel(b1), 'no live jobs yet');
  assert.equal(bookingBuildingSublabel({ ...b2, postcode: 'NW1' }), 'NW1 · no live jobs yet');
  assert.equal(bookingBuildingSublabel({ ...test1, postcode: '' }), undefined);
});

// ---- the form, rendered ------------------------------------------------------------------------------------------------------------
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function drawer(clientId: string, buildingId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['buildingRows'], BUILDINGS);
  return decode(renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ScheduleDayDrawer
        dateISO="2026-11-12" visits={[]} jobRows={JOBS} technicians={[]} visitStatusStyle={{} as any} onClose={() => {}} onSelectVisit={() => {}}
        initialClientId={clientId} initialBuildingId={buildingId}
      />
    </QueryClientProvider>,
  ));
}

test('FORM: a new building can be selected - its address and site instructions show, the Job list is empty, and its first job can be added', () => {
  const html = drawer(ACME, 'b-1');
  assert.match(html, /Acme Property - Build-1 · no live jobs yet/, 'the chosen building, marked as having no live jobs');
  assert.match(html, />test adress</);
  assert.match(html, /Ring the concierge/);
  assert.match(html, /data-testid="no-live-jobs-hint"/);
  assert.match(html, />Select a job…<\/option><\/select>/, 'only the placeholder: no jobs offered');
  assert.doesNotMatch(html, /<option value="j-/, 'no job of another building is offered');
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>\+ Add new job for this building/, '"+ Add new job for this building" is available');
});

test('FORM: a building with a live job works as before - its job is offered, no hint', () => {
  const html = drawer(ACME, 'b-test');
  assert.match(html, /Acme Property \(Test Building\) · W1 1AA/);
  assert.match(html, />London, England, W1 1AA</);
  assert.match(html, /<option value="j-1">Window cleaning · Weekly<\/option>/);
  assert.doesNotMatch(html, /data-testid="no-live-jobs-hint"/);
});

test('FORM: with nothing chosen (as the app opens it) the Building choice waits for a client, as before', () => {
  const html = drawer('', '');
  assert.match(html, /Select a client first|disabled/);
  assert.doesNotMatch(html, /data-testid="no-live-jobs-hint"/);
});

// ---- wiring --------------------------------------------------------------------------------------------------------------------------
test('WIRING: the choices come from the buildings list; jobs and booking are unchanged', () => {
  const code = readSourceFile('src', 'components', 'calendar', 'ScheduleDayDrawer.tsx');
  assert.match(code, /const clients = useMemo\(\(\) => bookingClients\(buildingRows, jobRows\), \[buildingRows, jobRows\]\);/);
  assert.match(code, /const buildingsForClient = useMemo\(\(\) => bookingBuildings\(buildingRows, jobRows, clientId\), \[buildingRows, jobRows, clientId\]\);/);
  assert.match(code, /\(\) => jobRows\.filter\(\(j\) => j\.buildingId === buildingId\)/, 'the Job choice is still the building\'s live jobs');
  assert.match(code, /const selectedBuilding = buildingId \? buildingById\.get\(buildingId\) : undefined;/, 'address and site instructions still come from the buildings list');
  assert.match(code, /createVisit\(/, 'booking still goes through createVisit');
  assert.match(code, /useState\(initialClientId\)/);
  assert.match(code, /initialClientId = '',\s+initialBuildingId = '',/, 'the app opens with nothing chosen');
});
