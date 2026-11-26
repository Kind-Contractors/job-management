import type { LocalInvoiceStatus } from '../domain/types';

/**
 * The statuses of an invoice whose accounts handoff is done - it is in Xero: 'sent' (created by JMS and emailed),
 * 'in_xero_not_emailed' (created by JMS while invoice emailing was off) or 'invoiced_manually' (invoiced by hand in Xero, outside
 * JMS, and marked so - JMS created and sent nothing). Only 'sent' means JMS emailed it. The one list both sides read: Ready for
 * accounts keeps every other invoice, Records lists only these - so an invoice is always in exactly one.
 */
export const IN_XERO_INVOICE_STATUSES = ['sent', 'in_xero_not_emailed', 'invoiced_manually'] as const satisfies readonly LocalInvoiceStatus[];

/** True once an invoice exists in Xero (see IN_XERO_INVOICE_STATUSES). */
export function isInvoiceInXero(status: LocalInvoiceStatus | null | undefined): boolean {
  return (IN_XERO_INVOICE_STATUSES as readonly (LocalInvoiceStatus | null | undefined)[]).includes(status);
}
