// The checks a contact form runs before saving, shared by All Live Jobs' contact popover (ContactPopover) and the Building
// File's "Add contact" (BuildingAddContactForm), so both create contacts the same way. Kept free of React so it can be tested
// directly. Saving itself is contactsRepository.ts's createContactForClient / updateContact in both places.

import type { ContactFieldsInput } from '../repository/contactsRepository';
import { canLinkAutomatically } from './xeroLinkStatus';

export interface ContactFormFields {
  name: string;
  email: string;
  phoneNumber: string;
  isPrimary: boolean;
}

export const BLANK_CONTACT_FORM: ContactFormFields = { name: '', email: '', phoneNumber: '', isPrimary: false };

const normalEmail = (email: string | null | undefined) => (email ?? '').trim().toLowerCase();

/**
 * The input to save, or why the form cannot be saved:
 *   - a name is required (the only required field, as before);
 *   - an email, when given, must not already belong to ANOTHER contact of the same client (ignoring case and spaces). An email
 *     decides which Xero contact an invoice recipient is matched to, so two contacts sharing one would be ambiguous: the
 *     existing contact should be edited instead.
 * `editingId` is the contact being edited (it may keep its own email); omit it when creating.
 * `requireEmail` (the invoice screen's new recipient): the email is required and must be a valid address - it is what Xero emails
 * the invoice to, and how the server finds or creates the recipient's Xero contact when the invoice is first submitted.
 */
export function checkContactForm(
  form: ContactFormFields,
  clientContacts: { id: string; name: string; email: string | null }[],
  editingId?: string | null,
  options: { requireEmail?: boolean } = {},
): { ok: true; input: ContactFieldsInput } | { ok: false; error: string } {
  const name = form.name.trim();
  if (!name) return { ok: false, error: 'Enter a name.' };
  const email = form.email.trim();
  if (options.requireEmail && !email) return { ok: false, error: 'Enter an email address: the invoice is emailed to it, and its Xero contact is found by it.' };
  if (options.requireEmail && !canLinkAutomatically({ xeroContactId: null, email })) return { ok: false, error: 'Enter a valid email address.' };
  if (email) {
    const same = clientContacts.find((c) => c.id !== editingId && normalEmail(c.email) === normalEmail(email));
    if (same) return { ok: false, error: `${same.name} already has this email address. Edit that contact instead of adding another.` };
  }
  return { ok: true, input: { name, email: email || null, phoneNumber: form.phoneNumber.trim() || null, isPrimary: form.isPrimary } };
}
