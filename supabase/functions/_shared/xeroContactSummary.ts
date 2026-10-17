// What the Manager app shows about a Xero contact when a manager is choosing which one to link: enough to tell contacts
// apart (name, status, where it is, a hint of its email, how many people receive invoice emails), and no more. The full
// email address, phone numbers, bank and tax details never leave the Edge Function.
//
// Nothing here decides which contact is "the" match: it only describes candidates, flags look-alikes (the same name, the
// same email) so a manager is warned about them, and marks the ones that cannot be linked.

import type { XeroContact } from './xeroClient.ts';

export interface ContactSummary {
  contactId: string;
  name: string;
  status: string;
  accountNumber: string | null;
  /** First letter and domain only, for example "j***@example.com". null when the contact has no email. */
  emailHint: string | null;
  hasEmail: boolean;
  /** Postcode and town of the first address that has any, for example "SW1A 1AA, London". */
  location: string | null;
  /** How many contact persons on the contact are marked to receive invoice emails as well as the main address. */
  personsIncludedInEmails: number;
  /** Set when Xero says this contact was merged into another: link the surviving contact instead. */
  mergedToContactId: string | null;
  /** Why it cannot be linked, or null when it can. */
  blockedReason: 'ARCHIVED' | 'NOT_ACTIVE' | 'MERGED' | 'NO_EMAIL' | null;
}

export interface AnnotatedContactSummary extends ContactSummary {
  /** How many OTHER results have the same name (ignoring case). */
  sameNameAsOthers: number;
  /** How many OTHER results share this contact's email address. */
  sameEmailAsOthers: number;
}

export function maskEmail(email: string | undefined | null): string | null {
  const e = (email ?? '').trim();
  if (!e) return null;
  const at = e.lastIndexOf('@');
  if (at < 1) return `${e[0]}***`;
  return `${e[0]}***${e.slice(at)}`;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function locationOf(c: XeroContact): string | null {
  for (const a of c.Addresses ?? []) {
    const parts = [text(a.PostalCode), text(a.City)].filter(Boolean);
    if (parts.length > 0) return parts.join(', ');
  }
  return null;
}

export function summariseContact(c: XeroContact): ContactSummary {
  const status = c.ContactStatus ?? '';
  const hasEmail = text(c.EmailAddress) !== '';
  const merged = text(c.MergedToContactID);
  let blockedReason: ContactSummary['blockedReason'] = null;
  if (status === 'ARCHIVED') blockedReason = 'ARCHIVED';
  else if (status !== 'ACTIVE') blockedReason = 'NOT_ACTIVE';
  else if (merged) blockedReason = 'MERGED';
  else if (!hasEmail) blockedReason = 'NO_EMAIL';
  return {
    contactId: c.ContactID,
    name: text(c.Name),
    status,
    accountNumber: text(c.AccountNumber) || null,
    emailHint: maskEmail(c.EmailAddress),
    hasEmail,
    location: locationOf(c),
    personsIncludedInEmails: (c.ContactPersons ?? []).filter((p) => p.IncludeInEmails === true).length,
    mergedToContactId: merged || null,
    blockedReason,
  };
}

/** Summaries of a result list, each flagged with how many look-alikes sit beside it. Order is preserved; nothing is picked. */
export function summariseAndFlag(contacts: XeroContact[]): AnnotatedContactSummary[] {
  const names = new Map<string, number>();
  const emails = new Map<string, number>();
  for (const c of contacts) {
    const n = text(c.Name).toLowerCase();
    if (n) names.set(n, (names.get(n) ?? 0) + 1);
    const e = text(c.EmailAddress).toLowerCase();
    if (e) emails.set(e, (emails.get(e) ?? 0) + 1);
  }
  return contacts.map((c) => {
    const n = text(c.Name).toLowerCase();
    const e = text(c.EmailAddress).toLowerCase();
    return {
      ...summariseContact(c),
      sameNameAsOthers: n ? (names.get(n) ?? 1) - 1 : 0,
      sameEmailAsOthers: e ? (emails.get(e) ?? 1) - 1 : 0,
    };
  });
}
