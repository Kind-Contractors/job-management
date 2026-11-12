// Manager-only linking of EXISTING Xero contacts to local contacts, and the saved default recipient of a building.
// POST only, body: { action, ... }. Every action first requires an active manager (see ../_shared/auth.ts): this is the
// permission check, whatever the screen shows or hides.
//
//   findByEmail          { localContactId }                         read-only: Xero contacts whose email is EXACTLY the contact's
//   search               { term }                                  read-only candidates by name or email text (the fallback)
//   verify               { localContactId } | { buildingId }        is the stored link / default still good in Xero?
//   link                 { localContactId, xeroContactId, expectedName, replace? }
//   unlink               { localContactId }
//   setBuildingDefault   { buildingId, localContactId }
//   clearBuildingDefault { buildingId }
//
// A building's own invoice recipient (the Xero contact named on its invoices - not a person; see migration 20261110100000):
//   searchRecipients       { term }                                read-only candidates by name, with full email and address
//   getRecipient           { xeroContactId }                       read-only: that contact's current details and whether it can be used
//   setBuildingRecipient   { buildingId, xeroContactId, expectedName, expectedCurrentXeroContactId, expectedCurrentXeroOrgId }
//   clearBuildingRecipient { buildingId, expectedCurrentXeroContactId, expectedCurrentXeroOrgId }
// The expected-current pair is the recipient the manager saw (both null = none). Both must still be what the building has, or
// nothing is changed and the manager is asked to reload: this is how a replacement is confirmed, and how a change made meanwhile
// by someone else is never overwritten. The recipient is the exact ContactID the manager picked, re-read in the connected
// organisation at that moment; it is never chosen from an email, a name, or a person's Xero link. The save itself goes through
// the database functions set_/clear_building_invoice_recipient, which only the server (service role) may call; the service role
// is used for nothing else here.
//
// What this function NEVER does: create, update, merge, archive or email a Xero contact (it only reads: a search and a read
// by id); link or choose a contact because a name or email looks alike (a link is made only for the exact ContactID a manager
// picked and confirmed); pick one of several candidates; or substitute a different contact for one that is missing, archived,
// merged, changed or in another organisation: those are refused with an explanation.
//
// Every action that touches Xero first checks that XERO_EXPECTED_ORG_ID is configured and that the connected organisation is
// that organisation, exactly as xero-create-invoice does. A link is recorded WITH the organisation it was made in, and is only
// ever used against that organisation. It does not depend on XERO_CREATION_ENABLED or XERO_SENDING_ENABLED: linking writes
// nothing to Xero (it only reads) and sends nothing.
//
// Never logs or returns XERO_CLIENT_ID, XERO_CLIENT_SECRET, the service role key or a token. A full contact email address is
// returned only by the building-recipient actions, to the manager choosing a recipient (decided 2026-11-10); the actions for
// linking people still return a masked hint.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { assertManager, UnauthorizedError } from '../_shared/auth.ts';
import { boundedSearchTerm, getContactById, getXeroAccessToken, isXeroId, searchContacts, XERO_SEARCH_TERM_MAX, XeroHttpError } from '../_shared/xeroClient.ts';
import {
  assertConnectedToExpectedOrganisation,
  assertExpectedOrganisationConfigured,
  requireLinkInOrganisation,
  requireVerifiedContactLink,
  XeroSafeguardError,
} from '../_shared/xeroSafeguards.ts';
import { recipientCandidates, recipientDetails, summariseAndFlag, summariseContact } from '../_shared/xeroContactSummary.ts';

class LinkError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = 'LinkError';
    this.code = code;
    this.status = status;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : 'Unknown error.');
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

interface LocalContact {
  id: string;
  client_id: string;
  xero_contact_id: string | null;
  xero_org_id: string | null;
  xero_contact_name: string | null;
  xero_linked_at: string | null;
}

const CONTACT_COLUMNS = 'id, client_id, xero_contact_id, xero_org_id, xero_contact_name, xero_linked_at';

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isXeroId(value)) throw new LinkError('BAD_REQUEST', `${what} is missing or not valid.`, 400);
  return value;
}

async function loadContact(db: SupabaseClient, id: string): Promise<LocalContact> {
  const { data, error } = await db.from('contacts').select(CONTACT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not read the contact: ${error.message}`);
  if (!data) throw new LinkError('CONTACT_NOT_FOUND', 'That contact could not be found.', 404);
  return data as LocalContact;
}

interface BuildingRecipientRow {
  id: string;
  client_id: string;
  default_invoice_contact_id: string | null;
  default_invoice_xero_contact_id: string | null;
  default_invoice_xero_org_id: string | null;
  default_invoice_xero_contact_name: string | null;
  default_invoice_xero_contact_email: string | null;
}

async function loadBuilding(db: SupabaseClient, id: string): Promise<BuildingRecipientRow> {
  const { data, error } = await db
    .from('buildings')
    .select(
      'id, client_id, default_invoice_contact_id, default_invoice_xero_contact_id, default_invoice_xero_org_id, default_invoice_xero_contact_name, default_invoice_xero_contact_email',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the building: ${error.message}`);
  if (!data) throw new LinkError('BUILDING_NOT_FOUND', 'That building could not be found.', 404);
  return data as BuildingRecipientRow;
}

/** A recipient chosen in the building's invoice recipient panel (its own Xero contact, no person attached). */
const hasOwnRecipient = (b: BuildingRecipientRow) => !b.default_invoice_contact_id && !!b.default_invoice_xero_contact_id;

/**
 * The service-role client - used ONLY to call set_/clear_building_invoice_recipient, which nobody else may call, after this
 * function has checked the manager (and, to set, verified the contact in Xero). Every read still goes through the manager's own
 * client and its row-level security.
 */
let serviceDb: SupabaseClient | null = null;
function serviceClient(): SupabaseClient {
  if (serviceDb) return serviceDb;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Edge Function runtime is missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.');
  serviceDb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return serviceDb;
}

/** How many buildings use this local contact as their default invoice recipient. */
async function countBuildingDefaults(db: SupabaseClient, contactId: string): Promise<number> {
  const { count, error } = await db.from('buildings').select('id', { count: 'exact', head: true }).eq('default_invoice_contact_id', contactId);
  if (error) throw new Error(`Could not check the building defaults: ${error.message}`);
  return count ?? 0;
}

/** Other local contacts already linked to the same Xero contact (informational: one Xero contact may legitimately serve several people). */
async function countOtherLinks(db: SupabaseClient, localContactId: string, xeroContactId: string): Promise<number> {
  const { data, error } = await db.from('contacts').select('id').eq('xero_contact_id', xeroContactId).neq('id', localContactId);
  if (error) throw new Error(`Could not check existing links: ${error.message}`);
  return (data ?? []).length;
}

/** The organisation gate every Xero-touching action passes first. */
async function connect(): Promise<{ accessToken: string; orgId: string }> {
  assertExpectedOrganisationConfigured();
  let accessToken: string;
  try {
    accessToken = await getXeroAccessToken();
  } catch (err) {
    throw new LinkError('XERO_AUTH_FAILED', errorMessage(err), 502);
  }
  const orgId = await assertConnectedToExpectedOrganisation(accessToken);
  return { accessToken, orgId };
}

function normaliseTerm(value: unknown): string {
  if (typeof value !== 'string') throw new LinkError('BAD_REQUEST', 'Enter something to search for.', 400);
  const term = value.replace(/\s+/g, ' ').trim();
  if (term.length < 2) throw new LinkError('TERM_TOO_SHORT', 'Enter at least 2 characters to search for.', 400);
  if (term.length > XERO_SEARCH_TERM_MAX) {
    throw new LinkError('TERM_TOO_LONG', `That search is too long: Xero accepts ${XERO_SEARCH_TERM_MAX} characters at most. Try part of the name or the email.`, 400);
  }
  if (/[\u0000-\u001f\u007f]/.test(term)) throw new LinkError('BAD_REQUEST', 'The search contains characters that are not allowed.', 400);
  return term;
}

const BLOCKED_CODE: Record<string, string> = {
  ARCHIVED: 'CONTACT_NOT_ACTIVE',
  NOT_ACTIVE: 'CONTACT_NOT_ACTIVE',
  MERGED: 'CONTACT_MERGED',
  NO_EMAIL: 'CONTACT_NO_EMAIL',
};
const BLOCKED_TEXT: Record<string, string> = {
  ARCHIVED: 'That Xero contact is archived, so it cannot be linked. Restore it in Xero, or choose another contact.',
  NOT_ACTIVE: 'That Xero contact is not active, so it cannot be linked.',
  MERGED: 'That Xero contact was merged into another contact. Link the surviving contact instead.',
  NO_EMAIL: 'That Xero contact has no email address, so an invoice could not be emailed to it. Add one in Xero, then try again.',
};

// ---- actions ----------------------------------------------------------------------------------------------------------------------

/** The term as typed and, if different, without accents; each contact once. Read-only. */
async function searchByText(accessToken: string, term: string) {
  const found = await searchContacts(accessToken, term, 25);
  let mayBeIncomplete = found.length >= 25;
  const folded = withoutAccents(term);
  if (folded !== term) {
    const more = await searchContacts(accessToken, folded, 25);
    mayBeIncomplete ||= more.length >= 25;
    for (const c of more) if (!found.some((f) => same(f.ContactID, c.ContactID))) found.push(c);
  }
  return { found, mayBeIncomplete };
}

async function search(body: Record<string, unknown>) {
  const term = normaliseTerm(body.term);
  const { accessToken } = await connect();
  const { found, mayBeIncomplete } = await searchByText(accessToken, term);
  return { ok: true, results: summariseAndFlag(found), mayBeIncomplete };
}

/** Name search fallback: a name typed with accents also finds a Xero contact saved without them ("José" finds "Jose"). */
function withoutAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_PAGE = 25;

/**
 * Email-first lookup for one local contact: the Xero contacts whose OWN email address is exactly the local contact's email
 * (trimmed, ignoring case). The email is read from the database, not taken from the request. Xero's search matches a term
 * contained in a name or email and accepts at most 50 characters, so a long email is searched by its first 50 characters and
 * every result is compared on its FULL email: a contained or shortened match is never treated as proof. Read-only; nothing is
 * chosen or linked here (the manager still confirms), and blocked contacts are returned marked so they can be shown, not chosen.
 */
async function findByEmail(db: SupabaseClient, body: Record<string, unknown>) {
  const localId = requireId(body.localContactId, 'The contact');
  const { data, error } = await db.from('contacts').select('id, email').eq('id', localId).maybeSingle();
  if (error) throw new Error(`Could not read the contact: ${error.message}`);
  if (!data) throw new LinkError('CONTACT_NOT_FOUND', 'That contact could not be found.', 404);
  const email = (typeof data.email === 'string' ? data.email : '').trim();
  if (!email) return { ok: true, outcome: 'no_local_email', results: [], mayBeIncomplete: false };
  if (!EMAIL_PATTERN.test(email) || /[\u0000-\u001f\u007f]/.test(email)) return { ok: true, outcome: 'invalid_local_email', results: [], mayBeIncomplete: false };

  const { accessToken } = await connect();
  const found = await searchContacts(accessToken, boundedSearchTerm(email), EMAIL_PAGE);
  const exact = found.filter((c) => same(c.EmailAddress, email));
  const results = summariseAndFlag(exact);
  const eligible = results.filter((r) => r.blockedReason === null).length;
  // A full page that held no exact match may have hidden one: say so instead of reporting "no match".
  const mayBeIncomplete = found.length >= EMAIL_PAGE;
  const outcome = eligible === 1 ? 'one' : eligible > 1 ? 'several' : results.length > 0 ? 'only_blocked' : 'none';
  return { ok: true, outcome, results, mayBeIncomplete };
}

async function verify(db: SupabaseClient, body: Record<string, unknown>) {
  if (body.buildingId !== undefined) {
    const building = await loadBuilding(db, requireId(body.buildingId, 'The building'));
    if (hasOwnRecipient(building)) return { ok: true, ...(await verifyOwnRecipient(building)) };
    if (!building.default_invoice_contact_id) return { ok: true, state: 'no_default' };
    const contact = await loadContact(db, building.default_invoice_contact_id);
    const { accessToken, orgId } = await connect();
    if (!same(building.default_invoice_xero_org_id, orgId)) return { ok: true, state: 'wrong_organisation' };
    if (!same(contact.xero_contact_id, building.default_invoice_xero_contact_id) || !same(contact.xero_org_id, building.default_invoice_xero_org_id)) {
      return { ok: true, state: 'stale' };
    }
    return { ok: true, ...(await liveState(accessToken, contact.xero_contact_id)) };
  }

  const contact = await loadContact(db, requireId(body.localContactId, 'The contact'));
  if (!contact.xero_contact_id?.trim()) return { ok: true, state: 'not_linked' };
  const { accessToken, orgId } = await connect();
  if (!(contact.xero_org_id ?? '').trim()) return { ok: true, state: 'untagged' };
  if (!same(contact.xero_org_id, orgId)) return { ok: true, state: 'wrong_organisation' };
  const live = await liveState(accessToken, contact.xero_contact_id);
  return { ok: true, ...live, nameChanged: live.currentName !== null && contact.xero_contact_name !== null && live.currentName !== contact.xero_contact_name };
}

/** Re-reads one linked contact by id in the connected organisation (read-only). */
async function liveState(accessToken: string, xeroContactId: string | null): Promise<{ state: string; currentName: string | null }> {
  if (!xeroContactId) return { state: 'not_linked', currentName: null };
  const lookup = await getContactById(accessToken, xeroContactId);
  if (lookup.outcome === 'not_found') return { state: 'not_found', currentName: null };
  const s = summariseContact(lookup.value);
  if (s.blockedReason === 'ARCHIVED' || s.blockedReason === 'NOT_ACTIVE') return { state: 'not_active', currentName: s.name };
  if (s.blockedReason === 'MERGED') return { state: 'merged', currentName: s.name };
  if (s.blockedReason === 'NO_EMAIL') return { state: 'no_email', currentName: s.name };
  return { state: 'ok', currentName: s.name };
}

// ---- a building's own invoice recipient -----------------------------------------------------------------------------------------

const RECIPIENT_BLOCKED_TEXT: Record<string, string> = {
  ARCHIVED: 'That Xero contact is archived, so it cannot be the invoice recipient. Restore it in Xero, or choose another contact. Nothing was changed.',
  NOT_ACTIVE: 'That Xero contact is not active, so it cannot be the invoice recipient. Nothing was changed.',
  MERGED: 'That Xero contact was merged into another contact. Choose the surviving contact instead. Nothing was changed.',
  NO_EMAIL: 'That Xero contact has no email address, so invoices could not be emailed to it. Add one in Xero, then try again. Nothing was changed.',
};

/** Search for a building's invoice recipient, by name (or any text Xero matches). Read-only; nothing is chosen. */
async function searchRecipients(body: Record<string, unknown>) {
  const term = normaliseTerm(body.term);
  const { accessToken } = await connect();
  const { found, mayBeIncomplete } = await searchByText(accessToken, term);
  return { ok: true, results: recipientCandidates(found), mayBeIncomplete };
}

/** The current details of one Xero contact, read by id in the connected organisation, and whether it can be a recipient. */
async function getRecipient(body: Record<string, unknown>) {
  const xeroId = requireId(body.xeroContactId, 'The Xero contact');
  const { accessToken } = await connect();
  const lookup = await getContactById(accessToken, xeroId);
  if (lookup.outcome === 'not_found') return { ok: true, state: 'not_found', contact: null };
  const contact = recipientDetails(lookup.value);
  return { ok: true, state: liveStateOf(contact.blockedReason), contact };
}

function liveStateOf(blocked: string | null): string {
  if (blocked === 'ARCHIVED' || blocked === 'NOT_ACTIVE') return 'not_active';
  if (blocked === 'MERGED') return 'merged';
  if (blocked === 'NO_EMAIL') return 'no_email';
  return 'ok';
}

/** Is the building's own recipient still good in the connected organisation? Read-only. */
async function verifyOwnRecipient(building: BuildingRecipientRow) {
  const { accessToken, orgId } = await connect();
  const saved = { xeroContactId: building.default_invoice_xero_contact_id, xeroOrgId: building.default_invoice_xero_org_id };
  if (!same(building.default_invoice_xero_org_id, orgId)) return { state: 'wrong_organisation', recipientSource: 'building', saved, current: null };
  const lookup = await getContactById(accessToken, building.default_invoice_xero_contact_id ?? '');
  if (lookup.outcome === 'not_found') return { state: 'not_found', recipientSource: 'building', saved, current: null, currentName: null };
  const current = recipientDetails(lookup.value);
  return {
    state: liveStateOf(current.blockedReason),
    recipientSource: 'building',
    saved,
    current,
    currentName: current.name,
    nameChanged: building.default_invoice_xero_contact_name !== null && current.name !== building.default_invoice_xero_contact_name,
    emailChanged: (building.default_invoice_xero_contact_email ?? null) !== current.email,
  };
}

/**
 * The recipient the manager saw: { id, org } or none. Both fields are required in the request (null for "none"), so a write can
 * never silently assume there was nothing there.
 */
function expectedCurrent(body: Record<string, unknown>): { id: string | null; org: string | null } {
  if (!('expectedCurrentXeroContactId' in body) || !('expectedCurrentXeroOrgId' in body)) {
    throw new LinkError('BAD_REQUEST', "Say which recipient you saw on the building (none or its Xero contact and organisation), so a change made meanwhile isn't overwritten.", 400);
  }
  const id = body.expectedCurrentXeroContactId;
  const org = body.expectedCurrentXeroOrgId;
  if (id === null && org === null) return { id: null, org: null };
  if (typeof id !== 'string' || !isXeroId(id) || typeof org !== 'string' || !isXeroId(org)) {
    throw new LinkError('BAD_REQUEST', 'The recipient you saw must be given as both its Xero contact and its organisation, or as none.', 400);
  }
  return { id: id.trim(), org: org.trim() };
}

const RECIPIENT_CHANGED_TEXT = "This building's invoice recipient has changed since you loaded the page. Reload it and try again. Nothing was changed.";

function requireUnchanged(building: BuildingRecipientRow, expected: { id: string | null; org: string | null }) {
  const id = building.default_invoice_xero_contact_id?.trim() || null;
  const org = building.default_invoice_xero_org_id?.trim() || null;
  if (id !== expected.id || org !== expected.org) throw new LinkError('RECIPIENT_CHANGED', RECIPIENT_CHANGED_TEXT, 409);
}

/** The database function's refusals, in the same words as the checks made here first. */
function recipientWriteError(message: string): Error {
  if (message.includes('building_invoice_recipient_changed')) return new LinkError('RECIPIENT_CHANGED', RECIPIENT_CHANGED_TEXT, 409);
  if (message.includes('building_not_found')) return new LinkError('BUILDING_NOT_FOUND', 'That building could not be found.', 404);
  if (message.includes('building_invoice_recipient_incomplete') || message.includes('building_invoice_recipient_actor_required')) {
    return new LinkError('RECIPIENT_INCOMPLETE', 'The recipient could not be saved because some of its details were missing. Nothing was changed.');
  }
  return new Error(`Could not save the invoice recipient: ${message}`);
}

async function setBuildingRecipient(db: SupabaseClient, body: Record<string, unknown>) {
  const buildingId = requireId(body.buildingId, 'The building');
  const xeroId = requireId(body.xeroContactId, 'The Xero contact');
  if (typeof body.expectedName !== 'string' || body.expectedName.trim() === '') {
    throw new LinkError('BAD_REQUEST', 'The name of the Xero contact you chose must be sent so the choice can be confirmed.', 400);
  }
  const expected = expectedCurrent(body);

  // A change made meanwhile is reported before Xero is asked anything (the database checks again, atomically, when saving).
  const building = await loadBuilding(db, buildingId);
  requireUnchanged(building, expected);

  const { accessToken, orgId } = await connect();
  const lookup = await getContactById(accessToken, xeroId);
  if (lookup.outcome === 'not_found' || !same(lookup.value.ContactID, xeroId)) {
    throw new LinkError(
      'CONTACT_NOT_IN_ORGANISATION',
      'That Xero contact does not exist in the connected Xero organisation (it may belong to a different organisation, or it was removed). Nothing was changed.',
    );
  }
  const contact = recipientDetails(lookup.value);
  if (contact.blockedReason) throw new LinkError(BLOCKED_CODE[contact.blockedReason], RECIPIENT_BLOCKED_TEXT[contact.blockedReason]);
  if (contact.name !== body.expectedName.trim()) {
    throw new LinkError(
      'CONTACT_CHANGED',
      'That Xero contact has changed since you looked at it (its name is different now). Search again and confirm the contact you intend. Nothing was changed.',
      409,
    );
  }

  const { data: user } = await db.auth.getUser();
  const actor = user.user?.email?.trim();
  if (!actor) throw new LinkError('ACTOR_UNKNOWN', 'Your account has no email address to record who chose the recipient. Nothing was changed.');

  const { error } = await serviceClient().rpc('set_building_invoice_recipient', {
    p_building_id: buildingId,
    p_xero_contact_id: contact.contactId,
    p_xero_org_id: orgId,
    p_xero_contact_name: contact.name,
    p_xero_contact_email: contact.email,
    p_actor: actor,
    p_expected_current_xero_contact_id: expected.id,
    p_expected_current_xero_org_id: expected.org,
  });
  if (error) throw recipientWriteError(error.message);

  return {
    ok: true,
    recipient: { ...contact, xeroOrgId: orgId },
    previous: expected.id ? { xeroContactId: expected.id, xeroOrgId: expected.org } : null,
    unchanged: same(expected.id, contact.contactId) && same(expected.org, orgId),
  };
}

async function clearBuildingRecipient(db: SupabaseClient, body: Record<string, unknown>) {
  const buildingId = requireId(body.buildingId, 'The building');
  const expected = expectedCurrent(body);
  const building = await loadBuilding(db, buildingId);
  requireUnchanged(building, expected);
  if (expected.id === null) return { ok: true, cleared: false };

  const { error } = await serviceClient().rpc('clear_building_invoice_recipient', {
    p_building_id: buildingId,
    p_expected_current_xero_contact_id: expected.id,
    p_expected_current_xero_org_id: expected.org,
  });
  if (error) throw recipientWriteError(error.message);
  return { ok: true, cleared: true };
}

const OWN_RECIPIENT_TEXT =
  "This building's invoice recipient was chosen in its invoice recipient panel, not through a contact. Change or clear it there. Nothing was changed.";

async function link(db: SupabaseClient, body: Record<string, unknown>) {
  const localId = requireId(body.localContactId, 'The contact');
  const xeroId = requireId(body.xeroContactId, 'The Xero contact');
  if (typeof body.expectedName !== 'string' || body.expectedName.trim() === '') {
    throw new LinkError('BAD_REQUEST', 'The name of the Xero contact you chose must be sent so the link can be confirmed.', 400);
  }
  const { accessToken, orgId } = await connect();
  const contact = await loadContact(db, localId);

  const lookup = await getContactById(accessToken, xeroId);
  if (lookup.outcome === 'not_found') {
    throw new LinkError(
      'LINK_NOT_IN_ORGANISATION',
      'That Xero contact does not exist in the connected Xero organisation (it may belong to a different organisation, or it was removed). Nothing was linked.',
    );
  }
  const summary = summariseContact(lookup.value);
  if (summary.blockedReason) throw new LinkError(BLOCKED_CODE[summary.blockedReason], BLOCKED_TEXT[summary.blockedReason]);
  if (summary.name !== body.expectedName.trim()) {
    throw new LinkError(
      'CONTACT_CHANGED',
      'That Xero contact has changed since you looked at it (its name is different now). Search again and confirm the contact you intend. Nothing was linked.',
      409,
    );
  }

  const alreadyLinked = contact.xero_contact_id?.trim() || null;
  const idChanges = alreadyLinked !== null && !same(alreadyLinked, summary.contactId);
  if (idChanges && body.replace !== true) {
    throw new LinkError(
      'ALREADY_LINKED',
      'This contact is already linked to a different Xero contact. Confirm that you want to replace the link, or unlink it first. Nothing was changed.',
      409,
    );
  }
  if ((idChanges || !same(contact.xero_org_id, orgId)) && (await countBuildingDefaults(db, localId)) > 0) {
    throw new LinkError(
      'DEFAULT_IN_USE',
      "This contact is a building's default invoice recipient. Clear that default before changing the contact's Xero link. Nothing was changed.",
      409,
    );
  }

  const { data: user } = await db.auth.getUser();
  const { data: updated, error } = await db
    .from('contacts')
    .update({
      xero_contact_id: summary.contactId,
      xero_org_id: orgId,
      xero_contact_name: summary.name,
      xero_linked_at: new Date().toISOString(),
      xero_linked_by: user.user?.email ?? 'unknown',
    })
    .eq('id', localId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`Could not save the link: ${error.message}`);
  if (!updated) throw new LinkError('CONTACT_NOT_FOUND', 'That contact could not be found.', 404);

  return {
    ok: true,
    linked: { xeroContactId: summary.contactId, name: summary.name, location: summary.location },
    alsoLinkedToOtherContacts: await countOtherLinks(db, localId, summary.contactId),
  };
}

async function unlink(db: SupabaseClient, body: Record<string, unknown>) {
  const localId = requireId(body.localContactId, 'The contact');
  const contact = await loadContact(db, localId);
  if (!contact.xero_contact_id) return { ok: true, unlinked: false };
  if ((await countBuildingDefaults(db, localId)) > 0) {
    throw new LinkError(
      'DEFAULT_IN_USE',
      "This contact is a building's default invoice recipient. Clear that default before unlinking the contact. Nothing was changed.",
      409,
    );
  }
  const { data: updated, error } = await db
    .from('contacts')
    .update({ xero_contact_id: null, xero_org_id: null, xero_contact_name: null, xero_linked_at: null, xero_linked_by: null })
    .eq('id', localId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`Could not remove the link: ${error.message}`);
  if (!updated) throw new LinkError('CONTACT_NOT_FOUND', 'That contact could not be found.', 404);
  return { ok: true, unlinked: true };
}

async function setBuildingDefault(db: SupabaseClient, body: Record<string, unknown>) {
  const buildingId = requireId(body.buildingId, 'The building');
  const localId = requireId(body.localContactId, 'The contact');
  const { accessToken, orgId } = await connect();
  const building = await loadBuilding(db, buildingId);
  const contact = await loadContact(db, localId);

  if (hasOwnRecipient(building)) throw new LinkError('RECIPIENT_SET_IN_PANEL', OWN_RECIPIENT_TEXT, 409);
  if (contact.client_id !== building.client_id) {
    throw new LinkError('WRONG_CLIENT', "That contact belongs to a different client from this building, so it cannot be the building's default recipient. Nothing was changed.");
  }
  if (!contact.xero_contact_id?.trim()) {
    throw new LinkError('NOT_LINKED', 'That contact is not linked to a Xero contact yet. Link it first. Nothing was changed.');
  }
  requireLinkInOrganisation(contact, orgId);
  await requireVerifiedContactLink(accessToken, contact);

  const { data: updated, error } = await db
    .from('buildings')
    .update({
      default_invoice_contact_id: contact.id,
      default_invoice_xero_contact_id: contact.xero_contact_id.trim(),
      default_invoice_xero_org_id: orgId,
    })
    .eq('id', buildingId)
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.message.includes('building_invoice_recipient_server_only')) throw new LinkError('RECIPIENT_SET_IN_PANEL', OWN_RECIPIENT_TEXT, 409);
    throw new Error(`Could not save the default recipient: ${error.message}`);
  }
  if (!updated) throw new LinkError('BUILDING_NOT_FOUND', 'That building could not be found.', 404);
  return { ok: true };
}

async function clearBuildingDefault(db: SupabaseClient, body: Record<string, unknown>) {
  const buildingId = requireId(body.buildingId, 'The building');
  if (hasOwnRecipient(await loadBuilding(db, buildingId))) throw new LinkError('RECIPIENT_SET_IN_PANEL', OWN_RECIPIENT_TEXT, 409);
  const { data: updated, error } = await db
    .from('buildings')
    .update({ default_invoice_contact_id: null, default_invoice_xero_contact_id: null, default_invoice_xero_org_id: null })
    .eq('id', buildingId)
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.message.includes('building_invoice_recipient_server_only')) throw new LinkError('RECIPIENT_SET_IN_PANEL', OWN_RECIPIENT_TEXT, 409);
    throw new Error(`Could not clear the default recipient: ${error.message}`);
  }
  if (!updated) throw new LinkError('BUILDING_NOT_FOUND', 'That building could not be found.', 404);
  return { ok: true };
}

// ---- entry ------------------------------------------------------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed. Use POST.' }, 405);

  let db: SupabaseClient;
  try {
    db = await assertManager(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return json({ ok: false, error: err.message }, 403);
    return json({ ok: false, error: errorMessage(err) }, 500);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, code: 'BAD_REQUEST', error: 'The request body must be a JSON object.' }, 400);
  }

  try {
    switch (body.action) {
      case 'findByEmail':
        return json(await findByEmail(db, body), 200);
      case 'search':
        return json(await search(body), 200);
      case 'verify':
        return json(await verify(db, body), 200);
      case 'link':
        return json(await link(db, body), 200);
      case 'unlink':
        return json(await unlink(db, body), 200);
      case 'setBuildingDefault':
        return json(await setBuildingDefault(db, body), 200);
      case 'clearBuildingDefault':
        return json(await clearBuildingDefault(db, body), 200);
      case 'searchRecipients':
        return json(await searchRecipients(body), 200);
      case 'getRecipient':
        return json(await getRecipient(body), 200);
      case 'setBuildingRecipient':
        return json(await setBuildingRecipient(db, body), 200);
      case 'clearBuildingRecipient':
        return json(await clearBuildingRecipient(db, body), 200);
      default:
        return json({ ok: false, code: 'BAD_REQUEST', error: 'Unknown action.' }, 400);
    }
  } catch (err) {
    if (err instanceof LinkError) return json({ ok: false, code: err.code, error: err.message }, err.status);
    if (err instanceof XeroSafeguardError) {
      const gate = err.code === 'ORG_NOT_CONFIGURED' || err.code === 'ORG_LOOKUP_FAILED' || err.code === 'ORG_MISMATCH';
      return json({ ok: false, code: err.code, error: err.message }, gate ? 503 : 422);
    }
    if (err instanceof XeroHttpError) return json({ ok: false, code: 'XERO_ERROR', error: `Xero returned HTTP ${err.status}. Nothing was changed.` }, 502);
    return json({ ok: false, error: errorMessage(err) }, 500);
  }
});
