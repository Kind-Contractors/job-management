// Server-side safeguards for anything that writes to Xero. Each one FAILS CLOSED: a missing setting, a failed lookup or
// an unexpected answer stops the operation before a single Xero write is attempted.
//
//   XERO_SENDING_ENABLED      kill switch; sending happens only when this is exactly "true" (unset = disabled)
//   XERO_EXPECTED_ORG_ID      the Xero organisation id this environment is allowed to write to
//
// A Custom Connection's credentials do not say which organisation they belong to, so the connected organisation's id is
// read from Xero (GET /Organisation) and compared with the expected one on every send. Swapping the Xero secret to a
// different organisation therefore cannot silently redirect invoices: the ids differ and the send is refused.
//
// Error messages never include organisation ids, contact ids or any credential.

import {
  getConnectedOrganisationId,
  getContactById,
  getInvoiceById,
  type XeroContact,
  type XeroInvoiceSummary,
  XeroHttpError,
} from './xeroClient.ts';

export type SafeguardCode =
  | 'SENDING_DISABLED'
  | 'ORG_NOT_CONFIGURED'
  | 'ORG_LOOKUP_FAILED'
  | 'ORG_MISMATCH'
  | 'NOT_LINKED'
  | 'LINK_NOT_IN_ORGANISATION'
  | 'CONTACT_NOT_ACTIVE'
  | 'CONTACT_NO_EMAIL'
  | 'INVOICE_NOT_IN_ORGANISATION'
  | 'LINK_UNTAGGED'
  | 'LINK_WRONG_ORGANISATION'
  | 'NO_RECIPIENT'
  | 'DEFAULT_STALE'
  | 'DEFAULT_WRONG_ORGANISATION'
  | 'RECIPIENT_LOCKED'
  | 'INVOICE_ORG_MISMATCH';

export class XeroSafeguardError extends Error {
  readonly code: SafeguardCode;
  constructor(code: SafeguardCode, message: string) {
    super(message);
    this.name = 'XeroSafeguardError';
    this.code = code;
  }
}

/** The kill switch. Anything other than the exact string "true" - unset, empty, "TRUE", "1", "yes" - means disabled. */
export function isSendingEnabled(): boolean {
  return Deno.env.get('XERO_SENDING_ENABLED') === 'true';
}

function normaliseOrganisationId(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  return v === '' ? null : v;
}

/** The configured expected organisation id, or null when it is missing or blank. */
export function expectedOrganisationId(): string | null {
  return normaliseOrganisationId(Deno.env.get('XERO_EXPECTED_ORG_ID'));
}

/** Refuses unless an expected organisation id is configured. Needs no Xero call, so it can run before an invoice is touched. */
export function assertExpectedOrganisationConfigured(): void {
  if (!expectedOrganisationId()) {
    throw new XeroSafeguardError(
      'ORG_NOT_CONFIGURED',
      'Xero sending is blocked: XERO_EXPECTED_ORG_ID is not configured, so the connected Xero organisation cannot be verified.',
    );
  }
}

/**
 * Reads the organisation this connection is bound to and requires it to equal the expected one. Refuses when the
 * expected id is missing, when the lookup fails or returns nothing usable, and when the ids differ.
 */
export async function assertConnectedToExpectedOrganisation(accessToken: string): Promise<string> {
  assertExpectedOrganisationConfigured();
  const expected = expectedOrganisationId()!;

  let connected: string;
  try {
    connected = (await getConnectedOrganisationId(accessToken)).toLowerCase();
  } catch (err) {
    // Only the HTTP status is passed on (for example 401/403 points at a missing scope). The underlying message may
    // carry Xero's response body, which is deliberately left out.
    const status = err instanceof XeroHttpError ? ` (Xero returned HTTP ${err.status})` : '';
    throw new XeroSafeguardError(
      'ORG_LOOKUP_FAILED',
      `Xero sending is blocked: could not confirm which Xero organisation this connection belongs to${status}.`,
    );
  }

  if (connected !== expected) {
    throw new XeroSafeguardError(
      'ORG_MISMATCH',
      'Xero sending is blocked: the connected Xero organisation is not the one this environment is configured for.',
    );
  }
  // Equal to the expected id, so this is the organisation every Xero reference written from here on belongs to.
  return connected;
}

export interface TaggedLink {
  xero_contact_id: string | null;
  xero_org_id: string | null;
}

/**
 * A stored Xero link only means something in the organisation it was made in. A link with no recorded organisation (made
 * before organisations were recorded) or one recorded for ANOTHER organisation is refused before Xero is even asked, so a
 * Test-organisation id can never be used against a different organisation. Re-linking the contact records its organisation.
 */
export function requireLinkInOrganisation(contact: TaggedLink, connectedOrgId: string): void {
  if (!contact.xero_contact_id?.trim()) return; // "not linked" is reported by requireVerifiedContactLink
  const tag = (contact.xero_org_id ?? '').trim().toLowerCase();
  if (!tag) {
    throw new XeroSafeguardError(
      'LINK_UNTAGGED',
      "This recipient's Xero link has no Xero organisation recorded, so it cannot be trusted for this organisation. Link the contact to its Xero contact again to verify it. Nothing was sent.",
    );
  }
  if (tag !== connectedOrgId.trim().toLowerCase()) {
    throw new XeroSafeguardError(
      'LINK_WRONG_ORGANISATION',
      "This recipient's Xero link was made in a different Xero organisation from the one now connected. Link the contact to its Xero contact in this organisation. Nothing was sent.",
    );
  }
}

export interface LocalContactLink {
  xero_contact_id: string | null;
}

/**
 * The recipient must already be linked to a Xero contact, and that link must still be good in the CONNECTED
 * organisation: re-read by id (read-only), it must exist here, be ACTIVE and have an email address. Nothing is searched
 * for and nothing is created. An id that belongs to another organisation (for example one stored while connected to a
 * test organisation) does not exist here, so it is refused as not found.
 */
export async function requireVerifiedContactLink(accessToken: string, contact: LocalContactLink): Promise<XeroContact> {
  const linkedId = contact.xero_contact_id?.trim();
  if (!linkedId) {
    throw new XeroSafeguardError(
      'NOT_LINKED',
      'This recipient is not linked to a Xero contact. Link it to an existing Xero contact before sending; the app never creates or guesses one.',
    );
  }

  const lookup = await getContactById(accessToken, linkedId);
  if (lookup.outcome === 'not_found') {
    throw new XeroSafeguardError(
      'LINK_NOT_IN_ORGANISATION',
      "This recipient's Xero link does not exist in the connected Xero organisation (it may belong to a different organisation, or the contact was removed). Re-link the recipient before sending.",
    );
  }
  if (lookup.value.ContactStatus !== 'ACTIVE') {
    throw new XeroSafeguardError(
      'CONTACT_NOT_ACTIVE',
      "This recipient's Xero contact is not active (it may be archived in Xero). Re-link the recipient, or restore the contact in Xero, before sending.",
    );
  }
  if (!lookup.value.EmailAddress?.trim()) {
    throw new XeroSafeguardError(
      'CONTACT_NO_EMAIL',
      "This recipient's Xero contact has no email address on file, so the invoice email can't be sent. Add an email to the contact in Xero, then retry.",
    );
  }
  return lookup.value;
}

/** An invoice id already stored locally must exist in the connected organisation before it is ever updated. */
export async function requireInvoiceInConnectedOrganisation(accessToken: string, xeroInvoiceId: string): Promise<XeroInvoiceSummary> {
  const lookup = await getInvoiceById(accessToken, xeroInvoiceId);
  if (lookup.outcome === 'not_found') {
    throw new XeroSafeguardError(
      'INVOICE_NOT_IN_ORGANISATION',
      "This invoice's Xero invoice does not exist in the connected Xero organisation (it may belong to a different organisation). It will not be updated or re-sent.",
    );
  }
  return lookup.value;
}
