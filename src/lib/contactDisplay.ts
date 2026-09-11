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