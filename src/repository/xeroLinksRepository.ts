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

export async function clearBuildingDefaultRecipient(buildingId: string): Promise<void> {
  await invoke({ action: 'clearBuildingDefault', buildingId });
}
