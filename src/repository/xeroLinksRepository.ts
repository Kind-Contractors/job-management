// Client for the manager-only `xero-link-contact` Edge Function: finding an EXISTING Xero contact, linking it to a local
// contact, verifying / unlinking the link, and the building's default invoice recipient. The permission check is on the server
// (the function refuses anyone who is not an active manager); nothing here creates or changes a contact in Xero, and nothing
// is linked or chosen automatically: a link is made only for the exact Xero contact the manager picked and confirmed.

import { supabase } from '../lib/supabaseClient';
import { describeInvokeError } from './invoicesRepository';

export type XeroBlockedReason = 'ARCHIVED' | 'NOT_ACTIVE' | 'MERGED' | 'NO_EMAIL';

/** What the manager sees about a candidate Xero contact. The email is masked (first letter and domain); nothing else personal is returned. */
export interface XeroContactCandidate {
  contactId: string;
  name: string;
  status: string;
  accountNumber: string | null;
  emailHint: string | null;
  hasEmail: boolean;
  location: string | null;
  personsIncludedInEmails: number;
  mergedToContactId: string | null;
  blockedReason: XeroBlockedReason | null;
  sameNameAsOthers: number;
  sameEmailAsOthers: number;
}

export interface XeroSearchResult {
  results: XeroContactCandidate[];
  mayBeIncomplete: boolean;
}

export type XeroLinkState =
  | 'not_linked'
  | 'untagged'
  | 'wrong_organisation'
  | 'not_found'
  | 'not_active'
  | 'merged'
  | 'no_email'
  | 'ok'
  | 'no_default'
  | 'stale';

export interface XeroLinkVerification {
  state: XeroLinkState;
  currentName?: string | null;
  nameChanged?: boolean;
  /** 'building' when the building's OWN Xero recipient was checked (then `current` holds its live details when found). */
  recipientSource?: 'building';
  /** The building's own recipient as Xero holds it now: full name, email and billing address. */
  current?: XeroRecipientCandidate | null;
  emailChanged?: boolean;
}

export interface LinkContactInput {
  localContactId: string;
  xeroContactId: string;
  /** The name of the candidate as the manager saw it; the server refuses the link if the contact has changed since. */
  expectedName: string;
  /** True only when the manager has confirmed replacing an existing link to a different Xero contact. */
  replace?: boolean;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('xero-link-contact', { body });
  if (error) throw new Error(await describeInvokeError(error));
  if (!data) throw new Error('No response from xero-link-contact.');
  return data;
}

export async function searchXeroContacts(term: string): Promise<XeroSearchResult> {
  return invoke<XeroSearchResult>({ action: 'search', term });
}

/**
 * What the email-first lookup found: `one` / `several` usable contacts with EXACTLY this contact's email, `only_blocked` (exact
 * matches exist but are archived or merged), `none`, or no usable email on the local contact. Never a decision: the manager
 * still chooses and confirms.
 */
export type XeroEmailMatchOutcome = 'one' | 'several' | 'only_blocked' | 'none' | 'no_local_email' | 'invalid_local_email';

export interface XeroEmailMatchResult extends XeroSearchResult {
  outcome: XeroEmailMatchOutcome;
}

export async function findXeroContactsByEmail(localContactId: string): Promise<XeroEmailMatchResult> {
  return invoke<XeroEmailMatchResult>({ action: 'findByEmail', localContactId });
}

export async function verifyContactLink(localContactId: string): Promise<XeroLinkVerification> {
  return invoke<XeroLinkVerification>({ action: 'verify', localContactId });
}

export async function verifyBuildingDefault(buildingId: string): Promise<XeroLinkVerification> {
  return invoke<XeroLinkVerification>({ action: 'verify', buildingId });
}

export async function linkContact(input: LinkContactInput): Promise<{ alsoLinkedToOtherContacts: number }> {
  return invoke<{ alsoLinkedToOtherContacts: number }>({ action: 'link', ...input });
}

export async function unlinkContact(localContactId: string): Promise<void> {
  await invoke({ action: 'unlink', localContactId });
}

export async function setBuildingDefaultRecipient(buildingId: string, localContactId: string): Promise<void> {
  await invoke({ action: 'setBuildingDefault', buildingId, localContactId });
}

/** A candidate for a building's (or one invoice's) Xero recipient: the full email and address, for managers (decided 2026-11-10). */
export interface XeroRecipientCandidate extends Omit<XeroContactCandidate, 'emailHint'> {
  emailHint: string | null;
  email: string | null;
  address: string | null;
}

export interface XeroRecipientSearchResult {
  results: XeroRecipientCandidate[];
  mayBeIncomplete: boolean;
}

/** Read-only search of the connected Xero organisation for an invoice recipient (by name, or any text Xero matches). Nothing is chosen. */
export async function searchXeroRecipients(term: string): Promise<XeroRecipientSearchResult> {
  const out = await invoke<{ results: XeroRecipientCandidate[]; mayBeIncomplete?: boolean }>({ action: 'searchRecipients', term });
  return { results: out.results ?? [], mayBeIncomplete: out.mayBeIncomplete === true };
}

export type XeroRecipientState = 'ok' | 'not_found' | 'not_active' | 'merged' | 'no_email';

/** One Xero contact's current details, read by id in the connected organisation (read-only). */
export async function getXeroRecipient(xeroContactId: string): Promise<{ state: XeroRecipientState; contact: XeroRecipientCandidate | null }> {
  return invoke({ action: 'getRecipient', xeroContactId });
}

/** The building's recipient the manager saw: both null = none. A save is refused (reload) if either has changed since. */
export interface ExpectedBuildingRecipient {
  expectedCurrentXeroContactId: string | null;
  expectedCurrentXeroOrgId: string | null;
}

export interface SetBuildingRecipientResult {
  recipient: XeroRecipientCandidate & { xeroOrgId: string };
  previous: { xeroContactId: string; xeroOrgId: string } | null;
  /** True when the same Xero contact was confirmed again (its details refreshed). */
  unchanged: boolean;
}

/**
 * Makes the exact Xero contact the manager confirmed THIS building's invoice recipient (no other building, contact or invoice is
 * changed). The server re-reads it in the connected organisation, refuses it if blocked or renamed (expectedName), and refuses
 * the save if the building's recipient is no longer the one the manager saw.
 */
export async function setBuildingRecipient(
  input: { buildingId: string; xeroContactId: string; expectedName: string } & ExpectedBuildingRecipient,
): Promise<SetBuildingRecipientResult> {
  return invoke<SetBuildingRecipientResult>({ action: 'setBuildingRecipient', ...input });
}

/** Clears THIS building's invoice recipient - only if it is still the one the manager saw. */
export async function clearBuildingRecipient(input: { buildingId: string } & ExpectedBuildingRecipient): Promise<{ cleared: boolean }> {
  return invoke<{ cleared: boolean }>({ action: 'clearBuildingRecipient', ...input });
}

export async function clearBuildingDefaultRecipient(buildingId: string): Promise<void> {
  await invoke({ action: 'clearBuildingDefault', buildingId });
}
