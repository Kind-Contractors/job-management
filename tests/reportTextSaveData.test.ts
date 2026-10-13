// The conditional save behind Report Review's autosave (saveReportText in src/repository/reportsRepository.ts): the real code against a fake
// Supabase REST server behind fetch. It must write only the fields given, only when the stored text is still what the manager started from,
// and never on an approved / Completed / sent report. Mocked, not live - the live check against DEV is a separate browser test.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { ReportTextChangedError, saveReportText } from '../src/repository/reportsRepository';

interface Logged { method: string; path: string; search: string; body: any }
const server = { log: [] as Logged[], rows: [{ id: 'r1' }] as unknown[], status: 200, error: null as unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  server.log.push({ method, path: decodeURIComponent(url.pathname), search: decodeURIComponent(url.search), body: init?.body ? JSON.parse(init.body) : undefined });
  if (server.status !== 200) return json(server.status, server.error);
  return json(200, server.rows);
}) as typeof fetch;

beforeEach(() => {
  server.log = [];
  server.rows = [{ id: 'r1' }];
  server.status = 200;
  server.error = null;
});

test('SAVE TEXT: sends only the fields given, as database columns, with no other column', async () => {
  await saveReportText('r1', { issues: 'Leak' }, { issues: 'Old' });
  assert.equal(server.log.length, 1);
  assert.equal(server.log[0].method, 'PATCH');
  assert.deepEqual(server.log[0].body, { issues: 'Leak' }, 'no work_carried_out / technician_notes keys, no undefined keys');
  await saveReportText('r1', { workCarriedOut: 'A', technicianNotes: 'B' }, { workCarriedOut: 'x', technicianNotes: 'y' });
  assert.deepEqual(server.log[1].body, { work_carried_out: 'A', technician_notes: 'B' });
});

test('SAVE TEXT: the update is CONDITIONAL on the stored text still being what the manager started from (null is matched as null)', async () => {
  await saveReportText('r1', { issues: 'Leak', workCarriedOut: 'Done' }, { issues: null, workCarriedOut: 'Cleaned' });
  const q = server.log[0].search;
  assert.match(q, /id=eq\.r1/);
  assert.match(q, /issues=is\.null/);
  assert.match(q, /work_carried_out=eq\.Cleaned/);
});

test('SAVE TEXT: an empty stored text (not null) is matched as empty', async () => {
  await saveReportText('r1', { issues: 'Leak' }, { issues: '' });
  assert.match(server.log[0].search, /issues=eq\.(&|$)/);
});

test('SAVE TEXT: never changes a report that is approved, Completed or sent to the client (the database has no such rule for text, this guard is it)', async () => {
  await saveReportText('r1', { issues: 'Leak' }, { issues: null });
  const q = server.log[0].search;
  assert.match(q, /review_status=neq\.approved/);
  assert.match(q, /completed_at=is\.null/);
  assert.match(q, /sent_to_client_at=is\.null/);
});

test('SAVE TEXT: when nothing matched (someone saved first, or the report was approved) it throws a clear "changed elsewhere" error and writes nothing', async () => {
  server.rows = [];
  await assert.rejects(saveReportText('r1', { issues: 'Leak' }, { issues: null }), (e) => e instanceof ReportTextChangedError && /changed elsewhere, so your version was not saved/.test(e.message));
});

test('SAVE TEXT: a database error is reported with its reason; an empty patch sends nothing', async () => {
  server.status = 500;
  server.error = { message: 'boom' };
  await assert.rejects(saveReportText('r1', { issues: 'x' }, { issues: null }), /Failed to update report: boom/);
  server.log = [];
  await saveReportText('r1', {}, {});
  assert.equal(server.log.length, 0);
});
