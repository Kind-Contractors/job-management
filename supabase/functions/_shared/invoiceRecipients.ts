// Who an invoice goes to, decided on the server and never guessed.
//
// FIRST SEND (no Xero invoice yet): the recipient is
//   - the local contact the manager explicitly chose for this invoice, if one was sent (when it is not linked to Xero
//     yet, it is linked to an existing Xero contact with its email or a new one is created - see ./autoXeroContact.ts); otherwise
//   - the building's saved default recipient; otherwise
//   - nothing: the send is refused with an explanation. A default is never guessed (not the primary contact, not the
//     only contact, not a name or email match).
//   Either way the contact must belong to the invoice's client, be linked to a Xero contact, that link must be recorded
//   for the CONNECTED Xero organisation, and the Xero contact must still be active and have an email.
//
// ONCE XERO HOLDS THE INVOICE the recipient is locked: a retry can only ever go to the Xero contact the invoice was created
// for. A request that names a different contact is refused (this is enforced here, so it holds for a direct call to the Edge
// Function, and again by a database trigger). The invoice's recorded organisation must also be the connected one.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { XeroInvoiceSummary } from './xeroClient.ts';
import { requireLinkInOrganisation, requireVerifiedContactLink, XeroSafeguardError } from './xeroSafeguards.ts';

export type RecipientSource = 'selected' | 'building_default' | 'locked' | 'auto_linked' | 'auto_created';

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

/** Links (or creates) the Xero contact for an UNLINKED local contact the manager explicitly chose. See ./autoXeroContact.ts. */
export type AutoLinkContact = (contact: RecipientContactRow) => Promise<{ xeroContactId: string; outcome: 'reused' | 'created' }>;

async function verifiedLinkOf(ctx: ResolveContext, contact: RecipientContactRow): Promise<{ xeroContactId: string; xeroContactName: string | null; xeroContactEmail: string | null }> {
  requireLinkInOrganisation(contact, ctx.connectedOrgId);
  const verified = await requireVerifiedContactLink(ctx.accessToken, contact);
  return { xeroContactId: contact.xero_contact_id!.trim(), ...detailsOf(verified) };
}

function detailsOf(c: { Name?: string; EmailAddress?: string }): { xeroContactName: string | null; xeroContactEmail: string | null } {
  return { xeroContactName: c.Name?.trim() || null, xeroContactEmail: c.EmailAddress?.trim() || null };
}

/** The recipient of an invoice Xero does not hold yet: the manager's explicit choice, else the building's saved default, else a refusal. */
export async function resolveFirstSendRecipient(
  ctx: ResolveContext & { buildingId: string; requestedContactId: string | undefined; autoLink?: AutoLinkContact },
): Promise<ResolvedRecipient> {
  if (ctx.requestedContactId) {
    const contact = await loadContactForClient(ctx.db, ctx.requestedContactId, ctx.clientId);
    // Only a contact with NO link at all (NULL) is linked automatically. A link that exists (even a blank one, one without an
    // organisation recorded, or one from another organisation) is never replaced here: it is verified, and refused if unusable.
    if (contact.xero_contact_id === null && ctx.autoLink) {
      const auto = await ctx.autoLink(contact);
      const linked = { ...contact, xero_contact_id: auto.xeroContactId, xero_org_id: ctx.connectedOrgId };
      return { ...(await verifiedLinkOf(ctx, linked)), source: auto.outcome === 'created' ? 'auto_created' : 'auto_linked' };
    }
    return { ...(await verifiedLinkOf(ctx, contact)), source: 'selected' };
  }

  const { data, error } = await ctx.db
    .from('buildings')
    .select('id, client_id, default_invoice_contact_id, default_invoice_xero_contact_id, default_invoice_xero_org_id')
    .eq('id', ctx.buildingId)
    .maybeSingle();
  if (error) throw new Error(`Could not read this building's default recipient: ${error.message}`);
  const building = data as {
    id: string;
    client_id: string;
    default_invoice_contact_id: string | null;
    default_invoice_xero_contact_id: string | null;
    default_invoice_xero_org_id: string | null;
  } | null;
  if (!building || building.client_id !== ctx.clientId) {
    throw new Error("This invoice's building could not be matched to its client, so its default recipient cannot be used. Nothing was sent.");
  }
  if (!building.default_invoice_contact_id) {
    throw new XeroSafeguardError(
      'NO_RECIPIENT',
      "No recipient was chosen for this invoice and this building has no default recipient. Choose a Xero-linked contact for this invoice, or set the building's default recipient first. Nothing was sent.",
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
