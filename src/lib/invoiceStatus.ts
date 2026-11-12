import type { LocalInvoiceStatus } from '../domain/types';

/**
 * The statuses of an invoice that exists in Xero, authorised: 'sent' (created and emailed) or 'in_xero_not_emailed' (created
 * while invoice emailing was off). Either way the accounts handoff is done; only 'sent' means an email went out. The one list
 * both sides read: Ready for accounts keeps every other invoice, Records lists only these - so an invoice is always in exactly one.
 */
export const IN_XERO_INVOICE_STATUSES = ['sent', 'in_xero_not_emailed'] as const satisfies readonly LocalInvoiceStatus[];

/** True once an invoice exists in Xero (see IN_XERO_INVOICE_STATUSES). */
export function isInvoiceInXero(status: LocalInvoiceStatus | null | undefined): boolean {
  return (IN_XERO_INVOICE_STATUSES as readonly (LocalInvoiceStatus | null | undefined)[]).includes(status);
}
