// The checks a contact form runs before saving, shared by All Live Jobs' contact popover (ContactPopover) and the shared
// new-contact form (NewContactForm: the Building File's "Add contact" and the invoice screen's new recipient). Kept free of
// React so it can be tested directly. Saving itself is contactsRepository.ts's createContactForClient / updateContact in both
// places.

import type { ContactFieldsInput } from '../repository/contactsRepository';
import { isValidEmail } from './xeroLinkStatus';

export interface ContactFormFields {
  name: string;
  email: string;
  phoneNumber: string;
  isPrimary: boolean;
}

export const BLANK_CONTACT_FORM: ContactFormFields = { name: '', email: '', phoneNumber: '', isPrimary: false };

export const normalEmail = (email: string | null | undefined) => (email ?? '').trim().toLowerCase();

export type ContactFormCheck =
  | { ok: true; input: ContactFieldsInput }
  /** `duplicateOf`: the email already belongs to that contact of the client; saving needs `allowDuplicateEmail` (an explicit confirmation). */
  | { ok: false; error: string; duplicateOf?: { id: string; name: string } };

/** The warning shown before a second contact with the same email is saved; the manager must confirm it. */
export function duplicateEmailWarning(existingName: string): string {
  return `${existingName} already has this email address. Only add another contact with it when it must be linked to a DIFFERENT Xero contact - for example when separate buildings are invoiced to separate Xero contacts that share one accounts mailbox. ${existingName} is not changed.`;
}

/**
 * The input to save, or why the form cannot be saved:
 *   - a name is required (the only required field, as before);
 *   - an email, when given, must not already belong to ANOTHER contact of the same client (ignoring case and spaces) - unless
 *     `allowDuplicateEmail` is set, which the caller does only after the manager has explicitly confirmed it (one accounts
 *     mailbox can be shared by separate Xero contacts, one per building). The result names the existing contact so the warning
 *     can identify it. Nothing about the existing contact is changed either way.
 * `editingId` is the contact being edited (it may keep its own email); omit it when creating.
 * `requireEmail` (the invoice screen's new recipient): the email is required and must be a valid address.
 */
export function checkContactForm(
  form: ContactFormFields,
  clientContacts: { id: string; name: string; email: string | null }[],
  editingId?: string | null,
  options: { requireEmail?: boolean; allowDuplicateEmail?: boolean } = {},
): ContactFormCheck {
  const name = form.name.trim();
  if (!name) return { ok: false, error: 'Enter a name.' };
  const email = form.email.trim();
  if (options.requireEmail && !email) return { ok: false, error: 'Enter an email address.' };
  if (options.requireEmail && !isValidEmail(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (email && !options.allowDuplicateEmail) {
    const same = clientContacts.find((c) => c.id !== editingId && normalEmail(c.email) === normalEmail(email));
    if (same) {
      return {
        ok: false,
        error: `${same.name} already has this email address. Edit that contact instead of adding another.`,
        duplicateOf: { id: same.id, name: same.name },
      };
    }
  }
  return { ok: true, input: { name, email: email || null, phoneNumber: form.phoneNumber.trim() || null, isPrimary: form.isPrimary } };
}
