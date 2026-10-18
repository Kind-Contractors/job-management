// Automatic Xero contact for a local contact that is not linked yet, used only on an invoice's FIRST send, after the
// connected organisation has been verified as the expected one and the invoice has been claimed.
//
//   1. The local contact must have a name and a valid email, and its client a name; otherwise the send is refused with
//      what to fix (nothing is searched or created).
//   2. An existing Xero contact is looked for by EMAIL (exact, ignoring case). Exactly one active match is reused. Several
//      matches, a match that is archived or merged, or a search that may have missed matches are refused: never guessed.
//   3. With no email match, the contact is created as "<person> (<client>)" (the app's earlier naming), unless a Xero contact
//      already has exactly that name: then it is refused (a contact is never linked by name alone, and Xero names are unique).
//      Xero accepts a search term of at most 50 characters, so both searches use a shortened term (boundedSearchTerm) and every
//      result is compared on its FULL email or name. If the name search cannot rule out a clash, Xero's own unique-name rule
//      refuses the create, and that refusal is reported the same way.
//   4. The create carries an Idempotency-Key derived from the organisation, the local contact and the details sent, so a
//      retry or timeout returns the same contact instead of a second one.
//   5. The link (ContactID + organisation) is saved on the local contact only if it is still unlinked; if another request
//      linked it meanwhile, the same Xero contact is accepted and anything else is refused.
// Nothing here sends an email or touches an invoice.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { boundedSearchTerm, createContact, searchContacts, XeroHttpError, type XeroContact } from './xeroClient.ts';
import { XeroSafeguardError } from './xeroSafeguards.ts';

export interface AutoContactInput {
  db: SupabaseClient;
  accessToken: string;
  connectedOrgId: string;
  clientName: string;
  contact: { id: string; name: string; email: string | null };
  /** Who caused the link, recorded on the contact (the signed-in manager's email). */
  linkedBy: string;
}

export interface AutoContactResult {
  xeroContactId: string;
  outcome: 'reused' | 'created';
}

const SEARCH_PAGE = 25;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lower = (v: string | undefined | null) => (v ?? '').trim().toLowerCase();

async function idempotencyKeyFor(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`xero-contact|${parts.join('|')}`));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function xeroNameFor(personName: string, clientName: string): string {
  return `${personName.trim()} (${clientName.trim()})`.slice(0, 255);
}

export async function linkOrCreateXeroContact(input: AutoContactInput): Promise<AutoContactResult> {
  const name = input.contact.name?.trim() ?? '';
  const email = input.contact.email?.trim() ?? '';
  const clientName = input.clientName?.trim() ?? '';
  if (!name || !clientName || !EMAIL_PATTERN.test(email)) {
    const missing = [!name && 'a name', !EMAIL_PATTERN.test(email) && 'a valid email address', !clientName && "the client's name"].filter(Boolean).join(', ');
    throw new XeroSafeguardError(
      'CONTACT_DETAILS_MISSING',
      `This recipient is not linked to Xero and cannot be created there automatically: it needs ${missing}. Add it to the contact in the app, or link the contact to an existing Xero contact. Nothing was sent.`,
    );
  }

  // ---- 2. an existing contact with the same email ------------------------------------------------------------------------
  const byEmail = await searchContacts(input.accessToken, boundedSearchTerm(email), SEARCH_PAGE);
  const sameEmail = byEmail.filter((c) => lower(c.EmailAddress) === lower(email));
  const usable = sameEmail.filter((c) => c.ContactStatus === 'ACTIVE' && !(c.MergedToContactID ?? '').trim());
  let chosen: XeroContact | null = null;
  if (usable.length > 1) {
    throw new XeroSafeguardError(
      'CONTACT_AMBIGUOUS',
      `${usable.length} Xero contacts already use this recipient's email address, so the app cannot tell which one to use. Link the right one from the contact's "Link to Xero contact" option, then send again. Nothing was sent.`,
    );
  }
  if (usable.length === 1) chosen = usable[0];
  else if (sameEmail.length > 0) {
    throw new XeroSafeguardError(
      'CONTACT_MATCH_NOT_ACTIVE',
      "A Xero contact with this recipient's email exists but is archived or merged. Restore it in Xero, or link the right contact manually, rather than creating a duplicate. Nothing was sent.",
    );
  } else if (byEmail.length >= SEARCH_PAGE) {
    throw new XeroSafeguardError(
      'CONTACT_SEARCH_INCOMPLETE',
      'Xero returned too many possible matches to be sure no contact already exists. Link the recipient manually from the contact. Nothing was sent.',
    );
  }

  let outcome: AutoContactResult['outcome'] = 'reused';
  if (!chosen) {
    // ---- 3. the name must be free: never link by name alone, never collide with an existing contact ----------------------
    const xeroName = xeroNameFor(name, clientName);
    const nameTaken = () =>
      new XeroSafeguardError(
        'CONTACT_NAME_TAKEN',
        `A Xero contact named "${xeroName}" already exists with a different email address. Link it manually if it is the same recipient, or correct the email in Xero or in the app. Nothing was sent.`,
      );
    // A shortened term finds every contact whose name contains it; only an EXACT full-name match counts as taken.
    const byName = await searchContacts(input.accessToken, boundedSearchTerm(xeroName), SEARCH_PAGE);
    if (byName.some((c) => lower(c.Name) === lower(xeroName))) throw nameTaken();
    // ---- 4. create, idempotently ------------------------------------------------------------------------------------------
    // If the name search could not see every candidate (a full page), Xero's own rule still refuses a duplicate name.
    const key = await idempotencyKeyFor([lower(input.connectedOrgId), input.contact.id, xeroName, lower(email)]);
    try {
      chosen = await createContact(input.accessToken, { Name: xeroName, EmailAddress: email }, key);
    } catch (err) {
      if (err instanceof XeroHttpError && err.status === 400 && /already (been )?assigned|must be unique|already exists/i.test(err.message)) throw nameTaken();
      throw err;
    }
    outcome = 'created';
  }

  // ---- 5. save the link, only onto a still-unlinked contact ------------------------------------------------------------------
  const { data, error } = await input.db
    .from('contacts')
    .update({
      xero_contact_id: chosen.ContactID,
      xero_org_id: input.connectedOrgId,
      xero_contact_name: chosen.Name,
      xero_linked_at: new Date().toISOString(),
      xero_linked_by: input.linkedBy,
    })
    .eq('id', input.contact.id)
    .is('xero_contact_id', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`The Xero contact was ${outcome === 'created' ? 'created' : 'found'} but could not be linked to the recipient: ${error.message}. Sending again will reuse it.`);
  if (!data) {
    // Linked by another request in the meantime: fine if it is the same Xero contact in the same organisation.
    const { data: now, error: readError } = await input.db.from('contacts').select('xero_contact_id, xero_org_id').eq('id', input.contact.id).maybeSingle();
    const current = now as { xero_contact_id: string | null; xero_org_id: string | null } | null;
    if (readError || !current || lower(current.xero_contact_id) !== lower(chosen.ContactID) || lower(current.xero_org_id) !== lower(input.connectedOrgId)) {
      throw new XeroSafeguardError(
        'CONTACT_LINK_CONFLICT',
        'This recipient was linked to a different Xero contact while the invoice was being prepared. Check the contact\'s Xero link, then send again. Nothing was invoiced.',
      );
    }
  }
  return { xeroContactId: chosen.ContactID, outcome };
}
