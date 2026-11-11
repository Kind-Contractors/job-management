// The rules of a building's invoice recipient panel, kept free of React and the data layer so they can be tested directly.
//
// A building's recipient is ONE of: its own Xero contact (chosen for this building, no person attached), a contact-based default
// (legacy: a person of the client and the Xero contact they were linked to), or none. Whatever it is, a change is saved with the
// Xero contact AND organisation the manager saw, so a change made meanwhile is never overwritten; replacing an existing recipient
// with a different contact needs an explicit confirmation; nothing is ever chosen for the manager.
import type { BuildingRow, Contact } from '../domain/types';
import type { XeroLinkState, XeroRecipientCandidate } from '../repository/xeroLinksRepository';

export type CurrentBuildingRecipient =
  | { kind: 'own'; xeroContactId: string; xeroOrgId: string; name: string; email: string | null }
  | { kind: 'contact'; xeroContactId: string; xeroOrgId: string; name: string; email: string | null; contactName: string | null }
  | { kind: 'none' };

/** What the building's recipient is now, from the stored data (the server re-checks it in Xero when it is used). */
export function currentBuildingRecipient(
  building: Pick<BuildingRow, 'invoiceRecipient' | 'defaultRecipient'>,
  contacts: Pick<Contact, 'id' | 'name' | 'xeroContactName'>[],
): CurrentBuildingRecipient {
  const own = building.invoiceRecipient;
  if (own) return { kind: 'own', xeroContactId: own.xeroContactId, xeroOrgId: own.xeroOrgId, name: own.name, email: own.email };
  const def = building.defaultRecipient;
  if (def) {
    const person = contacts.find((c) => c.id === def.contactId) ?? null;
    return {
      kind: 'contact',
      xeroContactId: def.xeroContactId,
      xeroOrgId: def.xeroOrgId,
      name: person?.xeroContactName ?? 'the Xero contact of a contact-based default',
      email: null,
      contactName: person?.name ?? null,
    };
  }
  return { kind: 'none' };
}

/** The recipient the manager is looking at, as the server expects it: both null for none. */
export function expectedRecipientOf(current: CurrentBuildingRecipient): { expectedCurrentXeroContactId: string | null; expectedCurrentXeroOrgId: string | null } {
  return current.kind === 'none'
    ? { expectedCurrentXeroContactId: null, expectedCurrentXeroOrgId: null }
    : { expectedCurrentXeroContactId: current.xeroContactId, expectedCurrentXeroOrgId: current.xeroOrgId };
}

/** True when saving the chosen contact would REPLACE a different existing recipient (it then needs an explicit confirmation). */
export function replacesAnotherRecipient(current: CurrentBuildingRecipient, chosen: Pick<XeroRecipientCandidate, 'contactId'>): boolean {
  return current.kind !== 'none' && current.xeroContactId.trim().toLowerCase() !== chosen.contactId.trim().toLowerCase();
}

/** Whether the chosen contact may be saved now: it can be used (not archived, merged, email-less) and a replacement is confirmed. */
export function canSaveChosenRecipient(input: {
  current: CurrentBuildingRecipient;
  chosen: Pick<XeroRecipientCandidate, 'contactId' | 'blockedReason'> | null;
  replaceConfirmed: boolean;
}): boolean {
  if (!input.chosen || input.chosen.blockedReason !== null) return false;
  return !replacesAnotherRecipient(input.current, input.chosen) || input.replaceConfirmed;
}

/** Where a search starts: the first line of the building's invoice details (the invoice contact name), shortened to Xero's limit. */
export function recipientSearchStartTerm(invoiceDetails: string | null | undefined): string {
  const first = (invoiceDetails ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? '';
  return first.slice(0, 50).trim();
}

/**
 * What a live check of the building's recipient means (xero-link-contact verify, buildingId) - its own recipient or an older
 * contact-based default; 'stale' only happens for the latter (the person's Xero link changed after the default was chosen).
 */
export const RECIPIENT_CHECK_TEXT: Partial<Record<XeroLinkState, { ok: boolean; text: string }>> = {
  stale: { ok: false, text: "This default's person has been linked to a different Xero contact since it was chosen, so it cannot be used. Choose the building's Xero contact, or clear it." },
  ok: { ok: true, text: 'Checked in Xero: the contact exists, is active and has an email address.' },
  wrong_organisation: { ok: false, text: 'This recipient was chosen in a different Xero organisation from the one now connected. Choose it again.' },
  not_found: { ok: false, text: 'This Xero contact no longer exists in the connected organisation. Choose the recipient again.' },
  not_active: { ok: false, text: 'This Xero contact is archived or inactive in Xero. Invoices for this building cannot be sent until it is restored or replaced.' },
  merged: { ok: false, text: 'This Xero contact was merged into another contact in Xero. Choose the surviving contact.' },
  no_email: { ok: false, text: 'This Xero contact has no email address in Xero. Add one in Xero, or choose another contact.' },
};
