import type { JobContactSummary } from '../domain/types';

/**
 * Contacts are client-level only (contactsRepository.ts) — a client can
 * have several, and the schema has no per-job/per-building selection
 * concept, so "which contact does this job show" is a genuine, honest
 * ambiguity whenever more than one exists and none is marked primary. The
 * one shared resolution rule — reused by JobsGrid's Contact column and
 * ContactPopover's default selection — so the grid's display and the
 * popover's default-open contact never disagree.
 */
export type ContactDisplayState =
  | { kind: 'none' }
  | { kind: 'single'; contact: JobContactSummary }
  | { kind: 'primary'; contact: JobContactSummary }
  | { kind: 'ambiguous' };

export function resolveDisplayContact(contacts: JobContactSummary[]): ContactDisplayState {
  if (contacts.length === 0) return { kind: 'none' };
  if (contacts.length === 1) return { kind: 'single', contact: contacts[0] };
  const primary = contacts.find((c) => c.isPrimary);
  return primary ? { kind: 'primary', contact: primary } : { kind: 'ambiguous' };
}

/**
 * The recipient a JOB REPORT starts with (ReadyForClientPage). The same rule as resolveDisplayContact - the only contact, else the
 * primary - but applied to the client's ordinary contacts only: an accounts-only contact is never chosen automatically (it stays in
 * the list and can still be chosen deliberately). 'none_eligible' = the client has contacts but every one is accounts-only, so
 * nobody is preselected and the page says why. resolveDisplayContact itself is unchanged: the jobs grid and the contact popover
 * keep using it as before.
 */
export type ReportRecipientDefault = ContactDisplayState | { kind: 'none_eligible' };

export function resolveReportRecipientDefault(contacts: JobContactSummary[]): ReportRecipientDefault {
  if (contacts.length === 0) return { kind: 'none' };
  const ordinary = contacts.filter((c) => c.isAccountsContact !== true);
  if (ordinary.length === 0) return { kind: 'none_eligible' };
  return resolveDisplayContact(ordinary);
}
