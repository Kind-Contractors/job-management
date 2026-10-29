import type { JobContactSummary } from '../domain/types';
import { isUsableRecipient } from './xeroLinkStatus';

/**
 * The confirm step of "Find a contact in Xero" (FindXeroContactPanel): which app contact the chosen Xero contact would be linked
 * to, and whether the link may be confirmed. Pure, so every rule is tested directly. Nothing here picks for the manager: the app
 * contact is the one they chose, or - only when they added it from the panel - the contact they just added.
 */
export interface XeroPanelLinkInput {
  contacts: JobContactSummary[];
  /** The chosen Xero contact's id, or null while none is chosen. */
  chosenXeroContactId: string | null;
  /** The app contact the manager picked in the confirm step ('' = none yet). */
  pickedLocalId: string;
  /** A contact the manager added through the panel's "+ Add a new contact", once known. */
  newContactId: string | null;
  buildingDefaultContactId: string | null;
  /** The "Replace that link" box. */
  replaceConfirmed: boolean;
}

export interface XeroPanelLinkState {
  /** Not linked (or not validly) first, then the linked ones. Nothing is preselected. */
  ordered: JobContactSummary[];
  localId: string;
  local: JobContactSummary | null;
  /** The added contact is not in the (reloading) list yet. */
  waitingForNewContact: boolean;
  /** The app contact is already linked to a DIFFERENT Xero contact: the replace box must be ticked. */
  replacing: boolean;
  /** The app contact is this building's default and its link would change: refused (the server refuses it too). */
  blockedAsDefault: boolean;
  /** Other contacts of this client already linked to the chosen Xero contact (shown as a notice; linking is still allowed). */
  alreadyLinkedHere: JobContactSummary[];
  canConfirm: boolean;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

export function xeroPanelLinkState(input: XeroPanelLinkInput): XeroPanelLinkState {
  const { contacts, chosenXeroContactId, pickedLocalId, newContactId, buildingDefaultContactId, replaceConfirmed } = input;
  const ordered = [...contacts.filter((c) => !isUsableRecipient(c)), ...contacts.filter(isUsableRecipient)];
  const newListed = newContactId !== null && contacts.some((c) => c.id === newContactId);
  const localId = pickedLocalId || (newListed ? newContactId! : '');
  const local = contacts.find((c) => c.id === localId) ?? null;
  const replacing = local !== null && chosenXeroContactId !== null && !!local.xeroContactId?.trim() && !same(local.xeroContactId, chosenXeroContactId);
  const blockedAsDefault = replacing && local !== null && local.id === buildingDefaultContactId;
  const alreadyLinkedHere =
    chosenXeroContactId === null ? [] : contacts.filter((c) => c.id !== localId && !!c.xeroContactId?.trim() && same(c.xeroContactId, chosenXeroContactId));
  const canConfirm = chosenXeroContactId !== null && local !== null && (!replacing || replaceConfirmed) && !blockedAsDefault;
  return { ordered, localId, local, waitingForNewContact: newContactId !== null && !newListed, replacing, blockedAsDefault, alreadyLinkedHere, canConfirm };
}
