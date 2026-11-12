// A building's OWN Xero invoice recipient, from its row: present only when it was chosen for the building itself (a Xero contact
// and organisation, and NO person contact). A contact-based default is mapped separately (defaultRecipient), never as this.
import type { BuildingInvoiceRecipient } from '../domain/types';

export interface OwnInvoiceRecipientColumns {
  default_invoice_contact_id?: string | null;
  default_invoice_xero_contact_id?: string | null;
  default_invoice_xero_org_id?: string | null;
  default_invoice_xero_contact_name?: string | null;
  default_invoice_xero_contact_email?: string | null;
}

export function ownInvoiceRecipient(row: OwnInvoiceRecipientColumns): BuildingInvoiceRecipient | null {
  const xeroContactId = row.default_invoice_xero_contact_id?.trim();
  const xeroOrgId = row.default_invoice_xero_org_id?.trim();
  if (row.default_invoice_contact_id || !xeroContactId || !xeroOrgId) return null;
  return {
    xeroContactId,
    xeroOrgId,
    name: row.default_invoice_xero_contact_name?.trim() || 'Xero contact',
    email: row.default_invoice_xero_contact_email?.trim() || null,
  };
}
