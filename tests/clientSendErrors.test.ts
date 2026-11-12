// Send to client: the manager sees the REAL reason a send failed - the reason the send-client-report function returns - not
// supabase-js's generic "Edge Function returned a non-2xx status code".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendClientReport } from '../src/repository/reportsRepository';

const input = { reportId: 'r1', contactId: 'c1', pdfBase64: 'JVBERi0=' } as Parameters<typeof sendClientReport>[0];

async function withFunctionAnswer<T>(status: number, body: string, work: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    return await work();
  } finally {
    globalThis.fetch = real;
  }
}

test('ERRORS: a provider failure (502) shows the provider\'s reason, as a failed send - not the generic non-2xx text', async () => {
  const r = await withFunctionAnswer(502, JSON.stringify({ status: 'failed', error: 'Email provider returned HTTP 422: invalid recipient' }), () => sendClientReport(input));
  assert.deepEqual(r, { status: 'failed', error: 'Email provider returned HTTP 422: invalid recipient' });
});

test('ERRORS: a refusal before sending (400, e.g. report not approved / recipient not the client\'s) shows that reason', async () => {
  const r = await withFunctionAnswer(400, JSON.stringify({ status: 'failed', error: 'This report is not approved — only approved reports can be sent to a client.' }), () => sendClientReport(input));
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /not approved/);
});

test('ERRORS: an error with only a reason (403 not authorised, 400 invalid request) throws THAT reason', async () => {
  await assert.rejects(withFunctionAnswer(403, JSON.stringify({ error: 'Not authorized.' }), () => sendClientReport(input)), /^Error: Not authorized\.$/);
  await assert.rejects(withFunctionAnswer(400, JSON.stringify({ error: 'Invalid request body: Missing pdfBase64.' }), () => sendClientReport(input)), /Missing pdfBase64/);
});

test('ERRORS: an answer that is not JSON, or has no reason, still falls back to a message (never a crash)', async () => {
  await assert.rejects(withFunctionAnswer(500, 'gateway timeout', () => sendClientReport(input)), /non-2xx/);
  await assert.rejects(withFunctionAnswer(500, JSON.stringify({ error: '  ' }), () => sendClientReport(input)), /non-2xx/);
});

test('ERRORS: a successful send is unchanged', async () => {
  assert.deepEqual(await withFunctionAnswer(200, JSON.stringify({ status: 'sent', messageUsed: 'custom' }), () => sendClientReport(input)), { status: 'sent', messageUsed: 'custom' });
});

test('ERRORS: the page shows a failed result\'s reason (its existing branch), and a thrown reason through its error handler', () => {
  const page = readFileSync(join(process.cwd(), 'src', 'pages', 'ReadyForClientPage.tsx'), 'utf8');
  assert.match(page, /setSendError\(result\.error \?\? "Failed to send\."\)/);
  assert.match(page, /setSendError\(err instanceof Error \? err\.message : "Failed to send\."\)/);
});

test('ERRORS: only the browser side changed - the send function is untouched by this fix', () => {
  const fn = readFileSync(join(process.cwd(), 'supabase', 'functions', 'send-client-report', 'index.ts'), 'utf8');
  assert.doesNotMatch(fn, /Idempotency-Key|OUTCOME_UNKNOWN/, 'no Bug 3 change is included');
});
