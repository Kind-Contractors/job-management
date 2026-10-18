// What the app tells the manager about where an invoice went. Pure (no React, no data layer) so the wording can be tested.
// It only ever claims an email was sent when the invoice's status says so ('sent'), and it says why one was not.

import type { InvoiceDetail, JobContactSummary } from '../domain/types';

export type NotEmailedReason = 'environment' | 'app_setting_off';

export const NOT_EMAILED_REASON_TEXT: Record<NotEmailedReason, string> = {
  environment: 'invoice email sending is not enabled for this system (an administrator setting)',
  app_setting_off: 'Automatic Invoice Emails is turned off in the app',
};

/** "Name (email)", or whichever part is known; null when nothing is known. */
export function formatRecipient(name: string | null | undefined, email: string | null | undefined): string | null {
  const n = name?.trim() || '';
  const e = email?.trim() || '';
  if (n && e) return `${n} (${e})`;
  return n || e || null;
}

/**
 * The recipient as recorded with the invoice; for an invoice sent before that was recorded, the local contact linked to the
 * same Xero contact (when exactly one is); otherwise null.
 */
export function recipientOf(
  invoice: Pick<InvoiceDetail, 'xeroRecipientName' | 'xeroRecipientEmail' | 'xeroContactId'>,
  clientContacts: Array<Pick<JobContactSummary, 'name' | 'email' | 'xeroContactId'>>,
): string | null {
  const recorded = formatRecipient(invoice.xeroRecipientName, invoice.xeroRecipientEmail);
  if (recorded) return recorded;
  if (!invoice.xeroContactId) return null;
  const matches = clientContacts.filter((c) => c.xeroContactId && c.xeroContactId.toLowerCase() === invoice.xeroContactId!.toLowerCase());
  return matches.length === 1 ? formatRecipient(matches[0].name, matches[0].email) : null;
}

/** The delivery line for an invoice that is in Xero, or null when there is nothing to say yet. */
export function deliveryLine(
  invoice: Pick<InvoiceDetail, 'status' | 'xeroInvoiceNumber' | 'xeroRecipientName' | 'xeroRecipientEmail' | 'xeroContactId' | 'notEmailedReason'>,
  clientContacts: Array<Pick<JobContactSummary, 'name' | 'email' | 'xeroContactId'>>,
): string | null {
  const who = recipientOf(invoice, clientContacts);
  const number = invoice.xeroInvoiceNumber ? `Xero invoice ${invoice.xeroInvoiceNumber}` : 'Xero invoice';
  if (invoice.status === 'sent') {
    return who ? `${number}: emailed to ${who}.` : `${number}: emailed (recipient not recorded for this older invoice).`;
  }
  if (invoice.status === 'in_xero_not_emailed') {
    const reason = invoice.notEmailedReason ? ` Not emailed because ${NOT_EMAILED_REASON_TEXT[invoice.notEmailedReason]}.` : '';
    const base = who ? `${number}: created in Xero — not emailed to ${who}.` : `${number}: created in Xero — not emailed.`;
    return `${base}${reason} Review and send it from Xero.`;
  }
  return null;
}

/** The message shown right after a send, from what the SERVER returned (never from what the screen assumed). */
export function sendResultMessage(result: {
  status: string;
  xeroInvoiceNumber?: string;
  code?: string;
  recipientName?: string | null;
  recipientEmail?: string | null;
  error?: string;
}): { ok: boolean; message: string } {
  const who = formatRecipient(result.recipientName, result.recipientEmail);
  if (result.status === 'sent') {
    return { ok: true, message: `Xero invoice ${result.xeroInvoiceNumber}: emailed${who ? ` to ${who}` : ''}.` };
  }
  if (result.status === 'in_xero_not_emailed') {
    const reason =
      result.code === 'EMAIL_DISABLED' ? NOT_EMAILED_REASON_TEXT.environment : result.code === 'AUTO_EMAIL_OFF' ? NOT_EMAILED_REASON_TEXT.app_setting_off : null;
    return {
      ok: true,
      message: `Xero invoice ${result.xeroInvoiceNumber}: created in Xero — not emailed${who ? ` to ${who}` : ''}.${reason ? ` Not emailed because ${reason}.` : ''} Review and send it from Xero.`,
    };
  }
  return { ok: false, message: result.error ?? 'Failed to send.' };
}
