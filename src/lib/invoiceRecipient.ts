// Who an invoice may be sent to. Kept free of React and the data layer so the rule can be tested directly.
//
// An invoice goes to a contact that is LINKED to an existing Xero contact. The server (xero-create-invoice) never
// creates or guesses a Xero contact, so a contact created on the spot, with no link, can never be sent to. Creating
// it anyway would only leave an unlinked local contact behind every time the send is refused.

export const UNLINKED_NEW_CONTACT_MESSAGE =
  "A recipient must be linked to an existing Xero contact before an invoice can be sent. A new email address can't be linked from here yet, so nothing was saved or sent. Choose an existing recipient, or ask for the contact to be linked.";

export const NO_USABLE_DEFAULT_MESSAGE =
  "No recipient is chosen for this invoice, and this building has no usable default recipient. Choose a contact that is linked to Xero, or set the building's default recipient on the building page.";
export const NOT_LINKED_RECIPIENT_MESSAGE =
  'That contact is not linked to a Xero contact, so an invoice cannot be sent to it. Link it first (Contacts), or choose a linked contact.';
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
  if (!choice.selectedContactId) {
    if (choice.usableDefaultContactId) return undefined;
    throw new Error(choice.usableDefaultContactId === undefined ? 'Choose a recipient before sending.' : NO_USABLE_DEFAULT_MESSAGE);
  }
  if (choice.selectedIsLinked === false) throw new Error(NOT_LINKED_RECIPIENT_MESSAGE);
  return choice.selectedContactId === choice.usableDefaultContactId ? undefined : choice.selectedContactId;
}
