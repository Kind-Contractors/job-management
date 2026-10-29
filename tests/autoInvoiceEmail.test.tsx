// The "Automatic Invoice Emails" setting: the confirm-before-change flow, the toggle UI (real components rendered to static
// markup, handlers invoked from the element tree; there is no DOM library in this repo), the data layer against a tiny fake
// Supabase REST server (no network), and the migration that stores it. The server-side enforcement is covered against the
// REAL xero-create-invoice code in xeroCreateInvoiceFunction.test.ts (AUTO-EMAIL 1-11), and the database policies by the
// local PostgreSQL rehearsal (rehearse-auto-email).
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSourceFile } from './helpers/sourceCode';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

import {
  autoEmailToggleReducer,
  confirmationFor,
  INITIAL_TOGGLE_STATE,
  TURN_OFF_COPY,
  TURN_ON_COPY,
  type AutoEmailToggleState,
} from '../src/lib/autoInvoiceEmailToggle';
import { AutoInvoiceEmailSettingView, type AutoInvoiceEmailSettingViewProps } from '../src/components/settings/AutoInvoiceEmailSetting';
import { getAutoInvoiceEmailSetting, setAutoInvoiceEmailSetting } from '../src/repository/appSettingsRepository';
import { isInvoiceInXero } from '../src/lib/invoiceStatus';
import { hasOpenAccountsWork } from '../src/lib/queueJobs';

// ---- fake Supabase REST ----------------------------------------------------------------------------------------------------------------
interface Logged { method: string; path: string; search: string; body: any }
const server = { log: [] as Logged[], getStatus: 200, row: { auto_invoice_emails_enabled: false, updated_at: '2026-10-18T09:00:00Z' } as any, patchReturnsNoRow: false, patchStatus: 200 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = decodeURIComponent(url.pathname);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  server.log.push({ method, path, search: decodeURIComponent(url.search), body });
  const wantsObject = (new Headers(init?.headers).get('accept') ?? '').includes('vnd.pgrst.object');
  if (path === '/rest/v1/app_settings' && method === 'GET') {
    if (server.getStatus !== 200) return json(server.getStatus, { message: 'denied' });
    return json(200, wantsObject ? server.row : server.row ? [server.row] : []);
  }
  if (path === '/rest/v1/app_settings' && method === 'PATCH') {
    if (server.patchStatus !== 200) return json(server.patchStatus, { message: 'refused' });
    if (server.patchReturnsNoRow) return json(200, wantsObject ? null : []); // what RLS does for a non-manager: matches nothing
    server.row = { ...server.row, ...body, updated_at: '2026-10-18T10:00:00Z' };
    return json(200, wantsObject ? server.row : [server.row]);
  }
  return json(404, { message: `unexpected request ${method} ${path}` });
}) as typeof fetch;
beforeEach(() => {
  server.log = []; server.getStatus = 200; server.patchReturnsNoRow = false; server.patchStatus = 200;
  server.row = { auto_invoice_emails_enabled: false, updated_at: '2026-10-18T09:00:00Z' };
});

const src = (...p: string[]) => readSourceFile(...p);
const code = (...p: string[]) => src(...p).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- 1. defaults to OFF ------------------------------------------------------------------------------------------------------------------
test('1. the stored setting defaults to OFF, for existing and new databases alike', () => {
  const m = code('supabase', 'migrations', '20261018100000_invoice_auto_email_setting.sql');
  assert.match(m, /auto_invoice_emails_enabled boolean\s+not null default false/);
  assert.match(m, /insert into public\.app_settings \(id\) values \(true\) on conflict \(id\) do nothing;/, 'the one row is created with the default (off)');
  assert.doesNotMatch(m, /auto_invoice_emails_enabled\s*=\s*true|values \(true, true\)/, 'nothing turns it on');
});

test('1b. the server treats anything other than an explicit TRUE as off (missing row, error, null, a string)', () => {
  const s = code('supabase', 'functions', '_shared', 'invoiceEmailSetting.ts');
  assert.match(s, /if \(value === true\) return \{ send: true \};/);
  assert.match(s, /if \(error \|\| !data\) return \{ send: false, reason: 'unreadable' \};/);
  assert.match(s, /catch \{\s*return \{ send: false, reason: 'unreadable' \};/);
});

// ---- 2/3. who can change it ---------------------------------------------------------------------------------------------------------------
test('2. a change is saved and the confirmed value returned (what the database now holds)', async () => {
  const saved = await setAutoInvoiceEmailSetting(true);
  assert.deepEqual(saved, { enabled: true, updatedAt: '2026-10-18T10:00:00Z' });
  const patch = server.log.find((r) => r.method === 'PATCH')!;
  assert.deepEqual(patch.body, { auto_invoice_emails_enabled: true }, 'only the setting is sent: who and when are stamped by the database');
  assert.match(patch.search, /id=eq\.true/);
});

test('3. a user the database refuses (RLS: not an active manager) gets an error, and nothing is reported as changed', async () => {
  server.patchReturnsNoRow = true;
  await assert.rejects(setAutoInvoiceEmailSetting(true), /only an active manager can change it/);
  server.patchReturnsNoRow = false;
  server.patchStatus = 403;
  await assert.rejects(setAutoInvoiceEmailSetting(false), /The setting was not changed/);
});

test('3b. permission is enforced by the DATABASE: manager-only select/update policies, no insert/delete policy, RLS on', () => {
  const m = code('supabase', 'migrations', '20261018100000_invoice_auto_email_setting.sql');
  assert.match(m, /alter table public\.app_settings enable row level security;/);
  assert.match(m, /create policy manager_select on public\.app_settings\s+for select using \(private\.current_app_role\(\) = 'manager'\);/);
  assert.match(m, /create policy manager_update on public\.app_settings\s+for update using \(private\.current_app_role\(\) = 'manager'\) with check \(private\.current_app_role\(\) = 'manager'\);/);
  assert.doesNotMatch(m, /for (insert|delete|all)\b/, 'no way to add or remove the row through the API');
});

test('3c. loading reports a failure instead of guessing a value', async () => {
  server.getStatus = 500;
  await assert.rejects(getAutoInvoiceEmailSetting(), /Could not load the automatic invoice email setting/);
  server.getStatus = 200;
  server.row = null;
  await assert.rejects(getAutoInvoiceEmailSetting(), /could not be loaded/);
});

// ---- 4/5/6. the confirm-before-change flow -----------------------------------------------------------------------------------------------
test('4. clicking the switch only asks for confirmation; CANCEL (either dialog) leaves the setting exactly as it was', () => {
  for (const next of [false, true]) {
    let s = autoEmailToggleReducer(INITIAL_TOGGLE_STATE, { type: 'request', next });
    assert.equal(s.pending, next);
    assert.equal(s.saving, false, 'requesting saves nothing');
    s = autoEmailToggleReducer(s, { type: 'cancel' });
    assert.deepEqual(s, { pending: null, saving: false, message: null });
  }
});

test('5/6. CONFIRM starts exactly one save; a second confirm (double click) or a new request while saving is ignored', () => {
  let s: AutoEmailToggleState = autoEmailToggleReducer(INITIAL_TOGGLE_STATE, { type: 'request', next: false });
  s = autoEmailToggleReducer(s, { type: 'saveStart' });
  assert.equal(s.saving, true);
  assert.equal(autoEmailToggleReducer(s, { type: 'saveStart' }), s, 'a duplicate confirm changes nothing');
  assert.equal(autoEmailToggleReducer(s, { type: 'request', next: true }), s, 'no new request while saving');
  assert.equal(autoEmailToggleReducer(s, { type: 'cancel' }), s, 'cannot cancel a save in flight');
  assert.equal(autoEmailToggleReducer(INITIAL_TOGGLE_STATE, { type: 'saveStart' }), INITIAL_TOGGLE_STATE, 'nothing to save without a pending change');
});

test('5/6. success and failure each give a clear message and close the dialog', () => {
  const pending = autoEmailToggleReducer(autoEmailToggleReducer(INITIAL_TOGGLE_STATE, { type: 'request', next: true }), { type: 'saveStart' });
  const ok = autoEmailToggleReducer(pending, { type: 'saveSuccess', enabled: true });
  assert.deepEqual([ok.pending, ok.saving, ok.message?.ok], [null, false, true]);
  assert.match(ok.message!.text, /Automatic invoice emails are on/);
  const off = autoEmailToggleReducer(pending, { type: 'saveSuccess', enabled: false });
  assert.match(off.message!.text, /created in Xero but not emailed/);
  const err = autoEmailToggleReducer(pending, { type: 'saveError', error: 'The setting was not changed: only an active manager can change it.' });
  assert.deepEqual([err.pending, err.saving, err.message?.ok], [null, false, false]);
});

test('the dialogs say exactly what was specified', () => {
  assert.deepEqual(TURN_OFF_COPY, {
    title: 'Turn off automatic invoice emails?',
    message: 'New invoices will continue to be created in Xero, but the app will not email them automatically. You can review and send them manually from Xero.',
    confirmLabel: 'Turn off',
  });
  assert.deepEqual(TURN_ON_COPY, {
    title: 'Enable automatic invoice emails?',
    message: 'The app may automatically email newly created invoices to clients. Please confirm that the invoice recipients and details are correct before enabling this feature.',
    confirmLabel: 'Enable automatic sending',
  });
  assert.equal(confirmationFor(false), TURN_OFF_COPY);
  assert.equal(confirmationFor(true), TURN_ON_COPY);
});

// ---- the toggle UI ------------------------------------------------------------------------------------------------------------------------
const noop = () => {};
const view = (over: Partial<AutoInvoiceEmailSettingViewProps> = {}) => {
  const props: AutoInvoiceEmailSettingViewProps = { enabled: false, loading: false, loadError: null, state: INITIAL_TOGGLE_STATE, onRequest: noop, onCancel: noop, onConfirm: noop, ...over };
  return { props, tree: AutoInvoiceEmailSettingView(props), html: renderToStaticMarkup(<AutoInvoiceEmailSettingView {...props} />) };
};
function buttonsIn(node: ReactNode): ReactElement<any>[] {
  const out: ReactElement<any>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<any>;
    if (el.type === 'button') out.push(el);
    walk(el.props?.children);
  };
  walk(node);
  return out;
}

test('UI: title, explanation, status label and switch reflect the confirmed value', () => {
  const off = view({ enabled: false }).html;
  assert.match(off, /Automatic Invoice Emails/);
  assert.match(off, /does not stop invoices being created/);
  assert.match(off, />Disabled</);
  assert.match(off, /role="switch" aria-checked="false"/);
  const on = view({ enabled: true }).html;
  assert.match(on, />Enabled</);
  assert.match(on, /role="switch" aria-checked="true"/);
});

test('UI: loading and error states disable the switch and explain the effect', () => {
  const loading = view({ enabled: undefined, loading: true }).html;
  assert.match(loading, /Loading…/);
  assert.match(loading, /role="switch"[^>]*disabled=""/);
  const error = view({ enabled: undefined, loadError: 'Could not load the automatic invoice email setting: denied' }).html;
  assert.match(error, />Unavailable</);
  assert.match(error, /Invoices are not emailed while the setting cannot be read\./);
  assert.match(error, /role="switch"[^>]*disabled=""/);
});

test('UI: clicking the switch REQUESTS the opposite value (no save); the dialog buttons call cancel / confirm', () => {
  const requested: boolean[] = [];
  const sw = buttonsIn(view({ enabled: true, onRequest: (n) => requested.push(n) }).tree).find((b) => b.props.role === 'switch')!;
  sw.props.onClick();
  assert.deepEqual(requested, [false]);

  const calls: string[] = [];
  const { tree, html } = view({ enabled: true, state: { pending: false, saving: false, message: null }, onCancel: () => calls.push('cancel'), onConfirm: () => calls.push('confirm') });
  assert.match(html, /Turn off automatic invoice emails\?/);
  const [cancel, confirm] = buttonsIn(tree).filter((b) => b.props.role !== 'switch' && b.props.children !== 'Try again');
  assert.equal(cancel.props.children, 'Cancel');
  assert.equal(confirm.props.children, 'Turn off');
  cancel.props.onClick();
  confirm.props.onClick();
  assert.deepEqual(calls, ['cancel', 'confirm']);
  assert.match(view({ enabled: false, state: { pending: true, saving: false, message: null } }).html, /Enable automatic invoice emails\?[\s\S]*Enable automatic sending/);
});

test('UI: while saving, the switch and both dialog buttons are disabled (no duplicate submissions)', () => {
  const { tree } = view({ enabled: true, state: { pending: false, saving: true, message: null } });
  for (const b of buttonsIn(tree)) assert.equal(b.props.disabled, true, String(b.props.children));
});

test('UI: the switch shows the value the SERVER confirmed - the container updates it only on a successful save', () => {
  const c = code('src', 'components', 'settings', 'AutoInvoiceEmailSetting.tsx');
  assert.match(c, /enabled=\{query\.data\?\.enabled\}/);
  assert.match(c, /onSuccess: \(saved: Setting\) => \{\s*queryClient\.setQueryData\(AUTO_INVOICE_EMAIL_QUERY_KEY, saved\);/);
  assert.match(c, /if \(state\.saving \|\| state\.pending === null \|\| save\.isPending\) return;/, 'the confirm handler guards against double submission');
  assert.doesNotMatch(c, /setQueryData\([^)]*pending/, 'never shows the requested value before the server confirms it');
});

test('UI: the setting is on the Ready for accounts page, where invoices are sent', () => {
  assert.match(code('src', 'pages', 'ReadyForAccountsPage.tsx'), /<AutoInvoiceEmailSetting \/>/);
});

// ---- 7/11. status semantics ----------------------------------------------------------------------------------------------------------------
test('7. an invoice created in Xero without an email is "in Xero" (accounts work done) but never "sent"', () => {
  assert.equal(isInvoiceInXero('in_xero_not_emailed'), true);
  assert.equal(isInvoiceInXero('sent'), true);
  for (const s of ['draft', 'sending', 'failed', null, undefined] as const) assert.equal(isInvoiceInXero(s), false);
  const visit = (invoiceStatus: any) => ({ reportReviewStatus: 'approved', invoiceId: 'inv-1', invoiceStatus }) as any;
  assert.equal(hasOpenAccountsWork(visit('in_xero_not_emailed')), false);
  assert.equal(hasOpenAccountsWork(visit('failed')), true);
  // The status itself comes from 20261018090000 (already applied); the settings migration must not redefine it.
  const m = code('supabase', 'migrations', '20261018090000_invoice_status_in_xero_not_emailed.sql');
  assert.match(m, /check \(status in \('draft', 'sending', 'sent', 'failed', 'in_xero_not_emailed'\)\)/);
  assert.doesNotMatch(code('supabase', 'migrations', '20261018100000_invoice_auto_email_setting.sql'), /invoices_status_check|jobs_with_open_report_work/);
  assert.match(m, /i\.status in \('sent', 'in_xero_not_emailed'\)/, 'closed jobs: accounts work is done once the invoice is in Xero');
});

test('11. the invoice editor cannot re-send an invoice that is in Xero without an email (only draft/failed are editable)', () => {
  const e = code('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  assert.match(e, /const editable = invoice\?\.status === 'draft' \|\| invoice\?\.status === 'failed';/);
  assert.match(e, /invoice\.status === 'in_xero_not_emailed'/);
  assert.match(e, /\{deliveryLine\(invoice, clientContacts\)\}/, 'the delivery line (recipient and why it was or was not emailed) comes from src/lib/invoiceDelivery.ts');
});

test('the setting cannot be changed from anywhere but the settings repository, and the only email call is in the invoice function', () => {
  assert.doesNotMatch(code('supabase', 'functions', 'xero-create-invoice', 'index.ts'), /from\('app_settings'\)\.update|\.from\('app_settings'\)\s*\.update/);
  assert.match(code('supabase', 'functions', 'xero-create-invoice', 'index.ts'), /const emailDecision[\s\S]*?= isSendingEnabled\(\)\s*\?\s*await decideAutoInvoiceEmail\(callerClient\)[\s\S]*await emailInvoiceOrExplain\(/);
});
