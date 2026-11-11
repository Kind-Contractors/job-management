// Who an invoice goes to, decided on the server and never guessed.
//
// FIRST SEND (no Xero invoice yet): the recipient is
//   - the Xero contact the manager chose for THIS invoice only (a one-off override, confirmed by its name), if one was sent;
//     it is never saved on the building; otherwise
//   - the local contact the manager explicitly chose for this invoice (legacy, person-based) - refused when the building has
//     its own Xero recipient, so a person's Xero link can never take that recipient's place; otherwise
//   - the building's own invoice recipient (a Xero contact chosen for the building, migration 20261110100000); otherwise
//   - the building's contact-based default recipient (legacy, unchanged); otherwise
//   - nothing: the send is refused with an explanation. A recipient is never guessed (not the primary contact, not the
//     only contact, not a name or email match), and an unusable one is never replaced by another (no fallback).
//   A Xero contact is always re-read by id in the CONNECTED Xero organisation and must exist there, be active, not merged, and
//   have an email. A person-based recipient must also belong to the invoice's client and be linked to a Xero contact recorded
//   for the connected organisation; a contact that is not linked is refused (NOT_LINKED): nothing is searched for, matched by
//   email or created in Xero.
//
// ONCE XERO HOLDS THE INVOICE the recipient is locked: a retry can only ever go to the Xero contact the invoice was created
// for. A request that names a different contact is refused (this is enforced here, so it holds for a direct call to the Edge
// Function, and again by a database trigger). The invoice's recorded organisation must also be the connected one.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getContactById, type XeroContact, type XeroInvoiceSummary } from './xeroClient.ts';
import { requireLinkInOrganisation, requireVerifiedContactLink, XeroSafeguardError } from './xeroSafeguards.ts';

/**
 * selected_xero = a Xero contact chosen for this invoice only; selected = a person chosen for this invoice (legacy);
 * building_recipient = the building's own Xero recipient; building_default = its contact-based default (legacy);
 * locked = the contact Xero already holds the invoice for.
 */
export type RecipientSource = 'selected_xero' | 'selected' | 'building_recipient' | 'building_default' | 'locked';

/** A Xero contact chosen for one invoice: its ContactID and the name the manager saw when choosing it. */
export interface RequestedXeroContact {
  xeroContactId: string;
  expectedName: string;
}

export interface ResolvedRecipient {
  xeroContactId: string;
  source: RecipientSource;
  /** The Xero contact's name and email as Xero holds them now (read while verifying it): what the invoice is sent to. */
  xeroContactName: string | null;
  xeroContactEmail: string | null;
}

export interface RecipientContactRow {
  id: string;
  client_id: string;
  name: string;
  email: string | null;
  xero_contact_id: string | null;
  xero_org_id: string | null;
}

const CONTACT_COLUMNS = 'id, client_id, name, email, xero_contact_id, xero_org_id';
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** Loads a contact and checks it belongs to the invoice's client; never trusts the request body for that. */
export async function loadContactForClient(db: SupabaseClient, contactId: string, expectedClientId: string): Promise<RecipientContactRow> {
  const { data, error } = await db.from('contacts').select(CONTACT_COLUMNS).eq('id', contactId).maybeSingle();
  if (error) throw new Error(`Failed to load the selected recipient: ${error.message}`);
  const contact = data as RecipientContactRow | null;
  if (!contact || contact.client_id !== expectedClientId) {
    throw new Error("The selected recipient does not belong to this invoice's client.");
  }
  return contact;
}

interface ResolveContext {
  db: SupabaseClient;
  accessToken: string;
  /** The Xero organisation the connection is bound to (already verified equal to the expected one). */
  connectedOrgId: string;
  clientId: string;
}

async function verifiedLinkOf(ctx: ResolveContext, contact: RecipientContactRow): Promise<{ xeroContactId: string; xeroContactName: string | null; xeroContactEmail: string | null }> {
  requireLinkInOrganisation(contact, ctx.connectedOrgId);
  const verified = await requireVerifiedContactLink(ctx.accessToken, contact);
  return { xeroContactId: contact.xero_contact_id!.trim(), ...detailsOf(verified) };
}

function detailsOf(c: { Name?: string; EmailAddress?: string }): { xeroContactName: string | null; xeroContactEmail: string | null } {
  return { xeroContactName: c.Name?.trim() || null, xeroContactEmail: c.EmailAddress?.trim() || null };
}

/**
 * A Xero contact named directly (a one-off choice, or a building's own recipient), re-read by id in the connected organisation.
 * Missing / other-organisation, archived or not active, merged and email-less contacts are refused - never replaced by another.
 */
async function requireUsableXeroContact(accessToken: string, xeroContactId: string, whose: string): Promise<XeroContact> {
  const lookup = await getContactById(accessToken, xeroContactId);
  if (lookup.outcome === 'not_found' || !same(lookup.value.ContactID, xeroContactId)) {
    throw new XeroSafeguardError(
      'CONTACT_NOT_IN_ORGANISATION',
      `${whose} does not exist in the connected Xero organisation (it may belong to a different organisation, or it was removed). Nothing was sent.`,
    );
  }
  const c = lookup.value;
  if (c.ContactStatus !== 'ACTIVE') {
    throw new XeroSafeguardError('CONTACT_NOT_ACTIVE', `${whose} is not active in Xero (it may be archived). Restore it in Xero, or choose another contact. Nothing was sent.`);
  }
  if (c.MergedToContactID?.trim()) {
    throw new XeroSafeguardError('CONTACT_MERGED', `${whose} was merged into another contact in Xero. Choose the surviving contact. Nothing was sent.`);
  }
  if (!c.EmailAddress?.trim()) {
    throw new XeroSafeguardError('CONTACT_NO_EMAIL', `${whose} has no email address in Xero, so the invoice can't be emailed. Add one in Xero, then try again. Nothing was sent.`);
  }
  return c;
}

export interface InvoiceBuildingRecipientRow {
  id: string;
  client_id: string;
  default_invoice_contact_id: string | null;
  default_invoice_xero_contact_id: string | null;
  default_invoice_xero_org_id: string | null;
}

/** The building's recipient columns (read through the caller's own row-level security). */
export async function loadInvoiceBuilding(db: SupabaseClient, buildingId: string): Promise<InvoiceBuildingRecipientRow | null> {
  const { data, error } = await db
    .from('buildings')
    .select('id, client_id, default_invoice_contact_id, default_invoice_xero_contact_id, default_invoice_xero_org_id')
    .eq('id', buildingId)
    .maybeSingle();
  if (error) throw new Error(`Could not read this building's invoice recipient: ${error.message}`);
  return data as InvoiceBuildingRecipientRow | null;
}

/** A recipient chosen for the building itself (a Xero contact, no person attached). */
export const hasOwnXeroRecipient = (b: InvoiceBuildingRecipientRow | null): boolean =>
  !!b && !b.default_invoice_contact_id && !!b.default_invoice_xero_contact_id?.trim();

export const PERSON_OVERRIDE_REFUSED_TEXT =
  "This building has its own Xero invoice recipient, so a person's Xero link can't be used instead. To invoice someone else this time, choose a Xero contact for this invoice. Nothing was sent.";

/**
 * The recipient of an invoice Xero does not hold yet: a Xero contact chosen for this invoice, else a person chosen for it (only
 * when the building has no recipient of its own), else the building's own recipient, else its contact-based default, else a refusal.
 */
export async function resolveFirstSendRecipient(
  ctx: ResolveContext & { buildingId: string; requestedContactId: string | undefined; requestedXeroContact?: RequestedXeroContact },
): Promise<ResolvedRecipient> {
  if (ctx.requestedXeroContact) {
    // A one-off choice for this invoice: the exact contact the manager confirmed, still under the name they saw. The building's
    // saved recipient is not read or written.
    const chosen = ctx.requestedXeroContact;
    const verified = await requireUsableXeroContact(ctx.accessToken, chosen.xeroContactId, 'The Xero contact chosen for this invoice');
    if ((verified.Name ?? '').trim() !== chosen.expectedName.trim()) {
      throw new XeroSafeguardError(
        'CONTACT_CHANGED',
        'The Xero contact chosen for this invoice has changed since you chose it (its name is different now). Choose it again. Nothing was sent.',
      );
    }
    return { xeroContactId: verified.ContactID.trim(), source: 'selected_xero', ...detailsOf(verified) };
  }

  const building = await loadInvoiceBuilding(ctx.db, ctx.buildingId);

  if (ctx.requestedContactId) {
    // A person's Xero link never takes the place of the building's own recipient.
    if (hasOwnXeroRecipient(building)) throw new XeroSafeguardError('USE_XERO_RECIPIENT', PERSON_OVERRIDE_REFUSED_TEXT);
    // Used only through its own link: an unlinked contact is refused (NOT_LINKED) and an unusable link is refused, never replaced.
    const contact = await loadContactForClient(ctx.db, ctx.requestedContactId, ctx.clientId);
    return { ...(await verifiedLinkOf(ctx, contact)), source: 'selected' };
  }

  if (!building || building.client_id !== ctx.clientId) {
    throw new Error("This invoice's building could not be matched to its client, so its default recipient cannot be used. Nothing was sent.");
  }

  if (hasOwnXeroRecipient(building)) {
    // The building's own recipient: its own Xero contact, never a person's link, never a fallback.
    if (!same(building.default_invoice_xero_org_id, ctx.connectedOrgId)) {
      throw new XeroSafeguardError(
        'DEFAULT_WRONG_ORGANISATION',
        "This building's invoice recipient was chosen in a different Xero organisation from the one now connected. Choose the building's invoice recipient again. Nothing was sent.",
      );
    }
    const verified = await requireUsableXeroContact(ctx.accessToken, building.default_invoice_xero_contact_id!.trim(), "This building's invoice recipient");
    return { xeroContactId: verified.ContactID.trim(), source: 'building_recipient', ...detailsOf(verified) };
  }

  if (!building.default_invoice_contact_id) {
    throw new XeroSafeguardError(
      'NO_RECIPIENT',
      "No recipient was chosen for this invoice and this building has no invoice recipient. Choose a Xero contact for this invoice, or set the building's invoice recipient first. Nothing was sent.",
    );
  }
  if (!same(building.default_invoice_xero_org_id, ctx.connectedOrgId)) {
    throw new XeroSafeguardError(
      'DEFAULT_WRONG_ORGANISATION',
      "This building's default recipient was chosen in a different Xero organisation from the one now connected. Choose the default recipient again. Nothing was sent.",
    );
  }

  let contact: RecipientContactRow;
  try {
    contact = await loadContactForClient(ctx.db, building.default_invoice_contact_id, ctx.clientId);
  } catch {
    throw new XeroSafeguardError(
      'DEFAULT_STALE',
      "This building's default recipient is no longer a contact of its client. Choose the default recipient again. Nothing was sent.",
    );
  }
  // The default remembers the Xero contact it was chosen with: if the contact's link has been changed since, it is stale.
  if (!same(contact.xero_contact_id, building.default_invoice_xero_contact_id) || !same(contact.xero_org_id, building.default_invoice_xero_org_id)) {
    throw new XeroSafeguardError(
      'DEFAULT_STALE',
      "This building's default recipient's Xero link has changed since it was chosen. Choose the default recipient again. Nothing was sent.",
    );
  }
  return { ...(await verifiedLinkOf(ctx, contact)), source: 'building_default' };
}

/** The recipient of an invoice Xero already holds. It can only be the Xero contact the invoice was created for. */
export async function resolveLockedRecipient(
  ctx: ResolveContext & {
    invoice: { xero_contact_id: string | null; xero_org_id: string | null };
    existingXeroInvoice: XeroInvoiceSummary;
    requestedContactId: string | undefined;
    requestedXeroContact?: RequestedXeroContact;
  },
): Promise<ResolvedRecipient> {
  // An invoice created in one Xero organisation is never updated through another.
  if (ctx.invoice.xero_org_id && !same(ctx.invoice.xero_org_id, ctx.connectedOrgId)) {
    throw new XeroSafeguardError(
      'INVOICE_ORG_MISMATCH',
      'This invoice was created in a different Xero organisation from the one now connected. It will not be updated or re-sent.',
    );
  }

  const inXero = ctx.existingXeroInvoice.Contact?.ContactID?.trim() || null;
  const recorded = ctx.invoice.xero_contact_id?.trim() || null;
  if (recorded && inXero && !same(recorded, inXero)) {
    throw new XeroSafeguardError(
      'RECIPIENT_LOCKED',
      "This invoice's recorded recipient does not match the recipient on the invoice in Xero, so it will not be updated. Check the invoice in Xero. Nothing was changed.",
    );
  }
  const locked = recorded ?? inXero;
  if (!locked) {
    throw new Error('This invoice already has a Xero invoice, but its recipient could not be read back from Xero — check the invoice directly in Xero.');
  }

  // A Xero contact named for this invoice must BE the locked one: an invoice Xero holds is never reassigned.
  if (ctx.requestedXeroContact && !same(ctx.requestedXeroContact.xeroContactId, locked)) {
    throw new XeroSafeguardError(
      'RECIPIENT_LOCKED',
      'This invoice already exists in Xero, so its recipient cannot be changed. Retry with the same recipient (or without choosing one); if the recipient is wrong, correct it in Xero. Nothing was changed.',
    );
  }

  if (ctx.requestedContactId) {
    const requested = await loadContactForClient(ctx.db, ctx.requestedContactId, ctx.clientId);
    requireLinkInOrganisation(requested, ctx.connectedOrgId);
    if (!same(requested.xero_contact_id, locked)) {
      throw new XeroSafeguardError(
        'RECIPIENT_LOCKED',
        'This invoice already exists in Xero, so its recipient cannot be changed. Retry with the same recipient (or without choosing one); if the recipient is wrong, correct it in Xero. Nothing was changed.',
      );
    }
  }

  // The locked contact must still be a usable one: active, with an email.
  const verified = await requireVerifiedContactLink(ctx.accessToken, { xero_contact_id: locked });
  return { xeroContactId: locked, source: 'locked', ...detailsOf(verified) };
}
