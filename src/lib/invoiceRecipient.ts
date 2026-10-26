// Who an invoice may be sent to. Kept free of React and the data layer so the rule can be tested directly.
//
// An invoice goes to a contact that is linked to a Xero contact, or to an unlinked contact with a valid email: on the first send
// the server matches that one to its Xero contact by email, or creates it (autoXeroContact.ts). A NEW contact is first saved on
// its own ("+ Add another email address" opens the contact form); it is never created as part of sending.

export const UNLINKED_NEW_CONTACT_MESSAGE =
  'Save the new contact first (Create contact), then send. Nothing was saved or sent. Or choose an existing recipient.';

export const NO_USABLE_DEFAULT_MESSAGE =
  "No recipient is chosen for this invoice, and this building has no usable default recipient. Choose a contact that is linked to Xero, or set the building's default recipient on the building page.";
export const NOT_LINKED_RECIPIENT_MESSAGE =
  'That contact is not linked to a Xero contact, so an invoice cannot be sent to it. Link it first (Contacts), or choose a linked contact.';
export const RECIPIENT_UNAVAILABLE_MESSAGE =
  'The recipient list could not be refreshed, so the contact you chose is not in it yet. Nothing has been saved or sent. Reload the recipients and try again.';
export const LOCKED_RECIPIENT_MESSAGE =
  'This invoice already exists in Xero, so its recipient is locked and cannot be changed. A retry goes to the same Xero contact. If the recipient is wrong, correct it in Xero.';

export interface RecipientChoice {
  /** True while the "+ Add another email address" option is selected. */
  addingNewContact: boolean;
  /** The chosen existing contact's id ('' = the building's default recipient, when there is a usable one). */
  selectedContactId: string;
  /** The building's default recipient contact id when it is usable; null when there is none or it is unusable; leave undefined when defaults are not in play. */
  usableDefaultContactId?: string | null;
  /** Whether the chosen contact is linked to Xero (as far as the stored data shows; the server re-verifies). Defaults to true. */
  selectedIsLinked?: boolean;
  /** True once Xero already holds the invoice: its recipient is locked and the server decides it. */
  recipientLocked?: boolean;
  /**
   * Whether the chosen contact is in the recipient list the screen shows. False when a contact was chosen (for example one just
   * added) but the list has not reloaded with it: nothing is sent, and never to a different recipient. Defaults to true.
   */
  selectedIsAvailable?: boolean;
}

export type RecipientSelectionState = 'default' | 'adding' | 'available' | 'missing';

/**
 * What the recipient selection currently is: nothing chosen (the building default, if any, applies), the new-contact form, a
 * contact that is in `contacts`, or a chosen contact id that is NOT in `contacts` (the list has not reloaded with it).
 */
export function recipientSelectionState(selectedContactId: string, addingNewContact: boolean, contacts: { id: string }[]): RecipientSelectionState {
  if (addingNewContact) return 'adding';
  if (!selectedContactId) return 'default';
  return contacts.some((c) => c.id === selectedContactId) ? 'available' : 'missing';
}

/**
 * What to send as `contactId`, or undefined when the server should use the invoice's locked recipient or the building's default.
 * Throws, before anything is saved or created, when the choice is a brand-new (therefore unlinkable) contact, an unlinked
 * contact, or nothing at all and no usable default exists. A recipient is never guessed here: not the primary contact, not the
 * only contact.
 */
export function resolveSendRecipientId(choice: RecipientChoice): string | undefined {
  if (choice.recipientLocked) return undefined;
  if (choice.addingNewContact) throw new Error(UNLINKED_NEW_CONTACT_MESSAGE);
  if (choice.selectedContactId && choice.selectedIsAvailable === false) throw new Error(RECIPIENT_UNAVAILABLE_MESSAGE);
  if (!choice.selectedContactId) {
    if (choice.usableDefaultContactId) return undefined;
    throw new Error(choice.usableDefaultContactId === undefined ? 'Choose a recipient before sending.' : NO_USABLE_DEFAULT_MESSAGE);
  }
  if (choice.selectedIsLinked === false) throw new Error(NOT_LINKED_RECIPIENT_MESSAGE);
  return choice.selectedContactId === choice.usableDefaultContactId ? undefined : choice.selectedContactId;
}
