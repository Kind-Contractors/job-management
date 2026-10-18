// How a local contact's Xero link is described in the UI. This is only what the browser can know from the stored columns:
// whether a link exists and records its Xero organisation. Whether that organisation is the CONNECTED one, and whether the
// Xero contact is still active, can only be checked on the server (xero-link-contact "verify", and again at send time).

import type { BuildingDefaultRecipient, JobContactSummary } from '../domain/types';
import type { XeroLinkState } from '../repository/xeroLinksRepository';

export type LocalLinkStatus = 'linked' | 'needs_relink' | 'not_linked';

export function localLinkStatus(c: Pick<JobContactSummary, 'xeroContactId' | 'xeroOrgId'>): LocalLinkStatus {
  if (!c.xeroContactId?.trim()) return 'not_linked';
  // A link that does not record its organisation (made before organisations were recorded) is never used: it must be re-linked.
  return c.xeroOrgId?.trim() ? 'linked' : 'needs_relink';
}

/** True when an invoice could be addressed to this contact as far as the stored data shows (the server still re-verifies). */
export const isUsableRecipient = (c: Pick<JobContactSummary, 'xeroContactId' | 'xeroOrgId'>): boolean => localLinkStatus(c) === 'linked';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A contact with NO Xero link at all but a valid email: on a first send the server links it to its one existing Xero contact
 * with that email, or creates it in Xero (supabase/functions/_shared/autoXeroContact.ts), and refuses when that is ambiguous.
 */
export const canLinkAutomatically = (c: Pick<JobContactSummary, 'xeroContactId' | 'email'>): boolean =>
  // `== null`: no link at all, whether the field is null or missing (a contact cached before the field existed). A blank or
  // whitespace link is NOT treated as unlinked: the server refuses it rather than replacing it.
  c.xeroContactId == null && EMAIL_PATTERN.test((c.email ?? '').trim());

/** Can an invoice be sent to this contact (the server still verifies everything)? Linked, or linkable automatically. */
export const canSendInvoiceTo = (c: Pick<JobContactSummary, 'xeroContactId' | 'xeroOrgId' | 'email'>): boolean =>
  isUsableRecipient(c) || canLinkAutomatically(c);

export function linkStatusLabel(c: Pick<JobContactSummary, 'xeroContactId' | 'xeroOrgId' | 'xeroContactName'>): string {
  switch (localLinkStatus(c)) {
    case 'linked':
      return c.xeroContactName ? `Linked to Xero: ${c.xeroContactName}` : 'Linked to a Xero contact';
    case 'needs_relink':
      return 'Linked before Xero organisations were recorded: link it again to use it';
    default:
      return 'Not linked to a Xero contact';
  }
}

export const VERIFY_STATE_TEXT: Record<XeroLinkState, { ok: boolean; text: string }> = {
  ok: { ok: true, text: 'Verified: the Xero contact exists, is active and has an email address.' },
  not_linked: { ok: false, text: 'Not linked to a Xero contact.' },
  untagged: { ok: false, text: 'This link does not record its Xero organisation. Link the contact again.' },
  wrong_organisation: { ok: false, text: 'This link was made in a different Xero organisation from the one now connected. Link the contact again.' },
  not_found: { ok: false, text: 'The linked Xero contact no longer exists in the connected organisation. Link the contact again.' },
  not_active: { ok: false, text: 'The linked Xero contact is archived or inactive in Xero.' },
  merged: { ok: false, text: 'The linked Xero contact was merged into another contact in Xero. Link the surviving contact instead.' },
  no_email: { ok: false, text: 'The linked Xero contact has no email address in Xero. Add one in Xero.' },
  no_default: { ok: false, text: 'No default recipient is set.' },
  stale: { ok: false, text: "The default recipient's Xero link has changed since it was chosen. Choose the default recipient again." },
};

/**
 * Why a building's saved default cannot be used right now, judged from stored data alone, or null when it looks usable. It is
 * stale when the contact is gone, moved, or its link no longer matches the Xero contact the default was chosen with.
 */
export function defaultRecipientProblem(
  def: BuildingDefaultRecipient | null,
  contacts: Array<Pick<JobContactSummary, 'id' | 'xeroContactId' | 'xeroOrgId'>>,
): string | null {
  if (!def) return null;
  const c = contacts.find((x) => x.id === def.contactId);
  if (!c) return "The default recipient is no longer a contact of this client. Choose the default recipient again.";
  const same = (a: string | null, b: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
  if (!same(c.xeroContactId, def.xeroContactId) || !same(c.xeroOrgId, def.xeroOrgId)) return VERIFY_STATE_TEXT.stale.text;
  return null;
}
