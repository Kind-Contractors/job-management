// Tests for the REAL send-client-report Edge Function code, run in Node. Only its surroundings are faked: the Deno runtime
// (serve / env), the database (a small fake Supabase REST + auth server) and the email provider (a fake Resend). So what
// reaches the email provider - the subject, recipient, HTML, plain text and attachment - and what is written to the send
// history can be checked exactly, including for a custom message the manager wrote.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// ---- fake Deno runtime ----------------------------------------------------------------------
const ENV: Record<string, string | undefined> = {
  SUPABASE_URL: 'https://tests.invalid',
  SUPABASE_ANON_KEY: 'anon-test-key',
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM_EMAIL: 'Kind Contractors <reports@mail.test>',
};
let handler: (req: Request) => Promise<Response> = async () => new Response('handler not registered', { status: 500 });
(globalThis as any).Deno = { serve: (h: typeof handler) => { handler = h; }, env: { get: (k: string) => ENV[k] } };

// ---- fake database + email provider -------------------------------------------------------------
interface Logged { method: string; url: string; path: string; body: any }
const state = {
  log: [] as Logged[],
  role: 'manager' as string,
  isActive: true,
  reviewStatus: 'approved',
  jobSummary: 'Window Cleaning' as string | null,
  scheduledDate: '2026-09-15' as string | null,
  buildingName: 'Oak Court' as string | null,
  contact: { id: 'ct1', client_id: 'client-1', name: 'Sam Client', email: 'sam@client.test' } as null | { id: string; client_id: string; name: string; email: string | null },
  resend: { status: 200, body: { id: 'msg-123' } as unknown },
};
function reset() {
  state.log = [];
  state.role = 'manager';
  state.isActive = true;
  state.reviewStatus = 'approved';
  state.jobSummary = 'Window Cleaning';
  state.scheduledDate = '2026-09-15';
  state.buildingName = 'Oak Court';
  state.contact = { id: 'ct1', client_id: 'client-1', name: 'Sam Client', email: 'sam@client.test' };
  state.resend = { status: 200, body: { id: 'msg-123' } };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  const path = decodeURIComponent(url.pathname);
  state.log.push({ method, url: url.href, path, body });
  const wantsObject = (headers.get('accept') ?? '').includes('vnd.pgrst.object');
  const one = (row: unknown) => json(200, wantsObject ? row : [row]);

  if (url.host === 'api.resend.com') return json(state.resend.status, state.resend.body);
  if (path === '/auth/v1/user') return json(200, { id: 'user-1', aud: 'authenticated', email: 'luke@kindcontractors.co.uk', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  if (path === '/rest/v1/app_users') return one({ role: state.role, is_active: state.isActive });
  if (path === '/rest/v1/reports' && method === 'GET') {
    return one({
      id: 'r1', review_status: state.reviewStatus,
      visits: { id: 'v1', scheduled_date: state.scheduledDate, jobs: { id: 'j1', job_summary: state.jobSummary, buildings: { id: 'b1', name: state.buildingName, client_id: 'client-1' } } },
    });
  }
  if (path === '/rest/v1/contacts') return state.contact ? one(state.contact) : json(200, wantsObject ? null : []);
  if (path === '/rest/v1/report_client_sends' && method === 'POST') return wantsObject ? json(201, { id: 'send-1' }) : new Response(null, { status: 201 });
  if (method === 'PATCH') return new Response(null, { status: 204 });
  if (path === '/rest/v1/activity_events' && method === 'POST') return new Response(null, { status: 201 });
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;

// ---- capture console output so we can prove the message text is never logged -----------------------------------
const consoleLines: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  (console as any)[level] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
}

beforeEach(() => {
  reset();
  consoleLines.length = 0;
});

await import('../supabase/functions/send-client-report/index.ts'); // registers the real handler through the fake Deno.serve

// ---- helpers ------------------------------------------------------------------------------------------------------
const PDF = 'JVBERi0xLjQK'; // "%PDF-1.4" in base64 - passed straight through as the attachment
function call(body: Record<string, unknown>, opts: { auth?: boolean; method?: string } = {}) {
  return handler(new Request('https://fn.test/send-client-report', {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.auth === false ? {} : { Authorization: 'Bearer test-token' }) },
    body: opts.method === 'GET' ? undefined : JSON.stringify(body),
  }));
}
const base = { reportId: 'r1', contactId: 'ct1', pdfBase64: PDF };
const resendCalls = () => state.log.filter((l) => l.url.startsWith('https://api.resend.com/emails'));
const sendRows = () => state.log.filter((l) => l.path === '/rest/v1/report_client_sends');
const sentEmail = () => resendCalls()[0].body;

// ---- default message: exactly what was always sent --------------------------------------------------------------------
test('with NO message the email is exactly the standard one this function always sent (same wording, subject, attachment)', async () => {
  const res = await call(base);
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(out, { status: 'sent', messageUsed: 'default' });
  const email = sentEmail();
  assert.equal(email.html, '<p>Hello Sam Client,</p><p>Please find attached the service report for Oak Court, dated 15 September 2026. This report is for your records.</p><p>Kind regards,<br/>Kind Contractors</p>', 'identical to the previous hard-coded HTML');
  assert.equal(email.subject, 'Service report — Oak Court (Window Cleaning) — 15 September 2026');
  assert.equal(email.from, 'Kind Contractors <reports@mail.test>');
  assert.equal(email.to, 'sam@client.test');
  assert.deepEqual(email.attachments, [{ filename: 'service-report.pdf', content: PDF }]);
  assert.match(email.text, /^Hello Sam Client,\n\nPlease find attached the service report for Oak Court, dated 15 September 2026\./, 'a plain-text copy is sent too');
});

test('the subject without a job summary, and with no date, is generated as before', async () => {
  state.jobSummary = null;
  state.scheduledDate = null;
  await call(base);
  assert.equal(sentEmail().subject, 'Service report — Oak Court — date not set');
  assert.match(sentEmail().html, /dated date not set\./);
});

// ---- custom message ------------------------------------------------------------------------------------------------------
test('a custom message is what the client receives: HTML paragraphs and line breaks, plus the same text as plain text', async () => {
  const message = 'Hi Sam,\n\nThe windows are done. Everything went well.\nSee attached.\n\nThanks,\nLuke';
  const res = await call({ ...base, message });
  assert.deepEqual(await res.json(), { status: 'sent', messageUsed: 'custom' });
  const email = sentEmail();
  assert.equal(email.html, '<p>Hi Sam,</p><p>The windows are done. Everything went well.<br/>See attached.</p><p>Thanks,<br/>Luke</p>');
  assert.equal(email.text, message);
  assert.doesNotMatch(email.html, /Please find attached/, 'the standard wording is replaced, not appended to');
});

test('a custom message changes ONLY the message: subject, recipient, sender and the PDF attachment are the same', async () => {
  await call(base);
  const standard = sentEmail();
  reset();
  state.log = [];
  await call({ ...base, message: 'A completely different message.' });
  const custom = sentEmail();
  for (const field of ['subject', 'to', 'from', 'attachments']) assert.deepEqual(custom[field], standard[field], field);
});

test('the manager\'s message is ESCAPED: markup and scripts become plain text', async () => {
  await call({ ...base, message: 'Click <a href="https://evil.test">here</a> & <script>alert(1)</script> "quoted" it\'s' });
  const html = sentEmail().html;
  assert.doesNotMatch(html, /<script|<a href|<\/a>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;a href=&quot;https:\/\/evil\.test&quot;&gt;here&lt;\/a&gt; &amp; /);
  assert.match(html, /it&#39;s/);
});

test('the contact\'s and building\'s names are escaped in the standard message too', async () => {
  state.contact = { id: 'ct1', client_id: 'client-1', name: 'Sam <b>Evil</b> & Co', email: 'sam@client.test' };
  state.buildingName = 'Oak <i>Court</i>';
  await call(base);
  const html = sentEmail().html;
  assert.doesNotMatch(html, /<b>|<i>/);
  assert.match(html, /Hello Sam &lt;b&gt;Evil&lt;\/b&gt; &amp; Co,/);
  assert.match(html, /for Oak &lt;i&gt;Court&lt;\/i&gt;, dated/);
  assert.match(sentEmail().text, /Hello Sam <b>Evil<\/b> & Co,/, 'the plain-text copy is not HTML, so it stays literal');
});

test('windows line endings and control characters in the message are cleaned', async () => {
  await call({ ...base, message: 'Line one\r\nLine two\u0000\u0007\r\n\r\nLine three' });
  assert.equal(sentEmail().html, '<p>Line one<br/>Line two</p><p>Line three</p>');
});

// ---- the server validates the message on its own -------------------------------------------------------------------------------
test('the server refuses an empty or whitespace-only message: nothing is sent and no history row is written', async () => {
  for (const message of ['', '   ', '\n\n  \t\n']) {
    const res = await call({ ...base, message });
    assert.equal(res.status, 400, JSON.stringify(message));
    assert.match((await res.json()).error, /message cannot be empty/);
  }
  assert.equal(resendCalls().length, 0);
  assert.equal(sendRows().length, 0);
});

test('the server refuses a message over 2,000 characters, and accepts exactly 2,000', async () => {
  const tooLong = await call({ ...base, message: 'x'.repeat(2001) });
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json()).error, /2001 characters; the maximum is 2000/);
  assert.equal(resendCalls().length, 0);
  assert.equal(sendRows().length, 0);

  const exactly = await call({ ...base, message: 'x'.repeat(2000) });
  assert.equal(exactly.status, 200);
  assert.equal(resendCalls().length, 1);
});

test('the limit counts characters, not bytes: 2,000 emoji are allowed, 2,001 are not', async () => {
  assert.equal((await call({ ...base, message: '😀'.repeat(2000) })).status, 200);
  reset();
  assert.equal((await call({ ...base, message: '😀'.repeat(2001) })).status, 400);
});

test('a message that is not text is refused', async () => {
  for (const message of [123, true, { text: 'hi' }, ['hi']]) {
    const res = await call({ ...base, message });
    assert.equal(res.status, 400, JSON.stringify(message));
  }
  assert.equal(resendCalls().length, 0);
});

test('an explicit null message means "no custom message": the standard one is used', async () => {
  const res = await call({ ...base, message: null });
  assert.deepEqual(await res.json(), { status: 'sent', messageUsed: 'default' });
});

// ---- everything else is unchanged ----------------------------------------------------------------------------------------------
test('only an active MANAGER can send: anyone else is refused before anything happens', async () => {
  state.role = 'technician';
  const res = await call({ ...base, message: 'hello' });
  assert.equal(res.status, 403);
  assert.equal(resendCalls().length, 0);
  assert.equal(sendRows().length, 0);
  reset();
  state.isActive = false;
  assert.equal((await call(base)).status, 403);
  reset();
  assert.equal((await call(base, { auth: false })).status, 403, 'no Authorization header at all');
});

test('only POST is accepted', async () => {
  const res = await call(base, { method: 'GET' });
  assert.equal(res.status, 405);
});

test('a report that is not approved is not sent, with or without a custom message, and the failure is recorded', async () => {
  state.reviewStatus = 'awaiting_review';
  const res = await call({ ...base, message: 'sneaky' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not approved/);
  assert.equal(resendCalls().length, 0);
  const [row] = sendRows();
  assert.equal(row.body.status, 'failed');
});

test('a recipient who does not belong to the report\'s client is refused, even with a custom message', async () => {
  state.contact = { id: 'ct1', client_id: 'SOMEONE-ELSE', name: 'Other', email: 'other@else.test' };
  const res = await call({ ...base, message: 'hello' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /does not belong to this report/);
  assert.equal(resendCalls().length, 0);
});

test('a contact with no email address is refused', async () => {
  state.contact = { id: 'ct1', client_id: 'client-1', name: 'Sam', email: '  ' };
  const res = await call({ ...base, message: 'hello' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no email address on file/);
  assert.equal(resendCalls().length, 0);
});

test('the recipient is always the contact\'s own address - a message or body field can never redirect it', async () => {
  await call({ ...base, message: 'hello', to: 'attacker@evil.test', recipient: 'attacker@evil.test', subject: 'Hijacked', html: '<p>x</p>' });
  const email = sentEmail();
  assert.equal(email.to, 'sam@client.test');
  assert.equal(email.subject, 'Service report — Oak Court (Window Cleaning) — 15 September 2026');
  assert.doesNotMatch(email.html, /Hijacked|<p>x<\/p>/);
});

// ---- send history and audit ----------------------------------------------------------------------------------------------------
test('a successful send keeps the same history: a "sending" row, then "sent" with the provider id, the report marked sent, and the audit event', async () => {
  await call({ ...base, message: 'Custom hello' });
  const insert = sendRows().find((l) => l.method === 'POST')!;
  assert.deepEqual(insert.body, { report_id: 'r1', recipient_contact_id: 'ct1', recipient_email: 'sam@client.test', sent_by: 'luke@kindcontractors.co.uk', status: 'sending' });
  const sentUpdate = sendRows().find((l) => l.method === 'PATCH' && l.body.status === 'sent')!;
  assert.equal(sentUpdate.body.resend_message_id, 'msg-123');
  const reportUpdate = state.log.find((l) => l.path === '/rest/v1/reports' && l.method === 'PATCH')!;
  assert.equal(reportUpdate.body.sent_to_client_by, 'luke@kindcontractors.co.uk');
  assert.ok(reportUpdate.body.sent_to_client_at);
  const event = state.log.find((l) => l.path === '/rest/v1/activity_events')!;
  assert.equal(event.body.event_type, 'report_sent_to_client');
  assert.equal(event.body.entity_type, 'report');
  assert.equal(event.body.entity_id, 'r1');
  assert.equal(event.body.actor, 'luke@kindcontractors.co.uk');
});

test('the message text is NOT stored in the history or the audit event (no new data is kept)', async () => {
  await call({ ...base, message: 'TOP-SECRET-WORDING 4711' });
  const stored = JSON.stringify(state.log.filter((l) => l.path.startsWith('/rest/v1/') && l.method !== 'GET').map((l) => l.body));
  assert.doesNotMatch(stored, /TOP-SECRET-WORDING/);
});

test('when the email provider fails, the attempt is recorded as failed, the report is NOT marked sent, and it can be retried', async () => {
  state.resend = { status: 422, body: { message: 'invalid recipient' } };
  const res = await call({ ...base, message: 'hello' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).status, 'failed');
  const failed = sendRows().find((l) => l.method === 'PATCH' && l.body.status === 'failed')!;
  assert.match(failed.body.error_message, /Email provider returned HTTP 422/);
  assert.equal(state.log.filter((l) => l.path === '/rest/v1/reports' && l.method === 'PATCH').length, 0, 'sent_to_client_* is never written on failure');
  assert.equal(state.log.filter((l) => l.path === '/rest/v1/activity_events').length, 0);
});

// ---- privacy -----------------------------------------------------------------------------------------------------------------------
test('the message text is never written to the server logs (on success or on any failure)', async () => {
  const marker = 'PRIVATE-CLIENT-NOTE-98765';
  await call({ ...base, message: `${marker} and the rest` });
  state.resend = { status: 500, body: { message: 'provider down' } };
  await call({ ...base, message: `${marker} again` });
  reset();
  state.reviewStatus = 'awaiting_review';
  await call({ ...base, message: `${marker} unapproved` });
  reset();
  await call({ ...base, message: marker + 'x'.repeat(2000) }); // refused for length
  assert.ok(consoleLines.every((line) => !line.includes(marker)), `a log line contained the message: ${consoleLines.find((l) => l.includes(marker))}`);
});
