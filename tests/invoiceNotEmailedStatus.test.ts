// The 'in_xero_not_emailed' invoice status (created in Xero while invoice emailing is off): it counts as "in Xero" for the
// accounts work, is never shown or treated as sent, cannot be re-sent through the app, and is allowed by the database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isInvoiceInXero } from '../src/lib/invoiceStatus';
import { hasOpenAccountsWork } from '../src/lib/queueJobs';

const code = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('an invoice in Xero without an email is "in Xero" (accounts work done) but is not "sent"', () => {
  assert.equal(isInvoiceInXero('in_xero_not_emailed'), true);
  assert.equal(isInvoiceInXero('sent'), true);
  for (const s of ['draft', 'sending', 'failed', null, undefined] as const) assert.equal(isInvoiceInXero(s), false);
  const visit = (invoiceStatus: any) => ({ reportReviewStatus: 'approved', invoiceId: 'inv-1', invoiceStatus }) as any;
  assert.equal(hasOpenAccountsWork(visit('in_xero_not_emailed')), false);
  assert.equal(hasOpenAccountsWork(visit('failed')), true);
});

test('the database allows the status, and closed jobs count it as invoiced', () => {
  const m = code('supabase', 'migrations', '20261018090000_invoice_status_in_xero_not_emailed.sql');
  assert.match(m, /check \(status in \('draft', 'sending', 'sent', 'failed', 'in_xero_not_emailed'\)\)/);
  assert.match(m, /i\.status in \('sent', 'in_xero_not_emailed'\)/);
});

test('the invoice editor shows it honestly and cannot re-send it (only draft and failed are editable)', () => {
  const e = code('src', 'components', 'jobs', 'InvoiceEditor.tsx');
  assert.match(e, /const editable = invoice\?\.status === 'draft' \|\| invoice\?\.status === 'failed';/);
  assert.match(e, /invoice\.status === 'in_xero_not_emailed'/);
  assert.match(e, /but not emailed: invoice emailing was turned off/);
  assert.match(e, /result\.status === 'in_xero_not_emailed'/);
  assert.match(code('src', 'pages', 'ReadyForAccountsPage.tsx'), /case 'in_xero_not_emailed':\s*return \{ label: 'In Xero · not emailed'/);
  assert.match(code('src', 'components', 'jobs', 'JobLifecycleDialog.tsx'), /!isInvoiceInXero\(visit\.invoiceStatus\)/);
});
