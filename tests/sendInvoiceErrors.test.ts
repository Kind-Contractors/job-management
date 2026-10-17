// sendInvoice (src/repository/invoicesRepository.ts) calls the xero-create-invoice Edge Function. supabase-js turns any
// non-2xx answer into the generic "Edge Function returned a non-2xx status code", which would hide WHY a send was
// refused (sending disabled, the wrong Xero organisation, a recipient that is not linked, Xero failing...). The function
// always explains itself in the JSON body's `error`; these tests pin that this explanation reaches the screen, and
// that nothing else from the response does.
//
// Everything is faked: the function endpoint is a fake `fetch`, so no request leaves the machine.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sendInvoice } from '../src/repository/invoicesRepository';

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let respond: () => Response | Promise<Response> = () => new Response('{}', { status: 200 });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body });
  return respond();
}) as typeof fetch;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  respond = () => json(200, {});
});

test('a successful send returns the function\'s answer, posted to xero-create-invoice with the invoice and the chosen recipient', async () => {
  respond = () => json(200, { status: 'sent', xeroInvoiceId: 'x-1', xeroInvoiceNumber: 'INV-001' });
  const result = await sendInvoice('inv-1', 'ct-1');
  assert.deepEqual(result, { status: 'sent', xeroInvoiceId: 'x-1', xeroInvoiceNumber: 'INV-001' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/functions\/v1\/xero-create-invoice$/);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].body)), { invoiceId: 'inv-1', contactId: 'ct-1' });
});

test('a refusal shows the server\'s own explanation, not the generic non-2xx text', async () => {
  const cases: Array<[number, Record<string, unknown>]> = [
    [503, { status: 'blocked', code: 'CREATION_DISABLED', error: 'Creating invoices in Xero is disabled for this environment (neither XERO_CREATION_ENABLED nor XERO_SENDING_ENABLED is "true"). Nothing was sent.' }],
    [503, { status: 'blocked', code: 'ORG_MISMATCH', error: 'Xero sending is blocked: the connected Xero organisation is not the one this environment is configured for.' }],
    [502, { status: 'failed', code: 'NOT_LINKED', error: 'This recipient is not linked to a Xero contact. Link it to an existing Xero contact before sending; the app never creates or guesses one.' }],
    [502, { status: 'blocked', code: 'XERO_AUTH_FAILED', error: 'Xero token request failed (HTTP 401): {"error":"invalid_client"}' }],
    [409, { status: 'failed', error: 'This invoice is already being sent, or has already been sent.' }],
    [403, { error: 'Not an active manager.' }],
  ];
  for (const [status, body] of cases) {
    respond = () => json(status, body);
    await assert.rejects(() => sendInvoice('inv-1', 'ct-1'), (e: any) => e.message === body.error, `HTTP ${status}`);
  }
});

test('only the `error` text is shown: other fields in the response body never reach the message', async () => {
  respond = () => json(502, { status: 'failed', code: 'LINK_NOT_IN_ORGANISATION', error: 'Re-link the recipient.', detail: 'INTERNAL-DETAIL-9', xeroInvoiceId: 'SHOULD-NOT-APPEAR' });
  try {
    await sendInvoice('inv-1', 'ct-1');
    assert.ok(false, 'should have failed');
  } catch (e: any) {
    assert.equal(e.message, 'Re-link the recipient.');
    assert.doesNotMatch(e.message, /INTERNAL-DETAIL|SHOULD-NOT-APPEAR/);
  }
});

test('an answer with no usable explanation falls back to the generic message (never to a raw body)', async () => {
  for (const make of [
    () => new Response('<html>Bad gateway: INTERNAL-PAGE</html>', { status: 502 }),
    () => json(500, { message: 'something else' }),
    () => json(500, { error: '' }),
    () => json(500, { error: 42 }),
    () => json(500, null),
  ]) {
    respond = make;
    await assert.rejects(() => sendInvoice('inv-1', 'ct-1'), (e: any) => /non-2xx/.test(e.message) && !/INTERNAL-PAGE|something else/.test(e.message));
  }
});

test('a network failure is reported, not swallowed', async () => {
  respond = () => {
    throw new TypeError('network down');
  };
  await assert.rejects(() => sendInvoice('inv-1', 'ct-1'), (e: any) => typeof e.message === 'string' && e.message.length > 0);
});

test('the invoice editor shows that message and also reloads the invoice, so the reason stored on a failed invoice appears', () => {
  const editor = readFileSync(join(process.cwd(), 'src', 'components', 'jobs', 'InvoiceEditor.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(editor, /onError: \(err\) => \{\s*invalidate\(\);\s*setSendResult\(\{ ok: false, message: err instanceof Error \? err\.message : 'Failed to send\.' \}\);\s*\},/);
});
