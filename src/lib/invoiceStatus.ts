import type { LocalInvoiceStatus } from '../domain/types';

/**
 * True once an invoice exists in Xero, authorised: 'sent' (created and emailed) or 'in_xero_not_emailed' (created while
 * invoice emailing was off). Either way the accounts handoff is done; only 'sent' means an email went out.
 */
export function isInvoiceInXero(status: LocalInvoiceStatus | null | undefined): boolean {
  return status === 'sent' || status === 'in_xero_not_emailed';
}
