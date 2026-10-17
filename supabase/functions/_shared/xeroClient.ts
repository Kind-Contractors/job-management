// Minimal Xero Custom Connection client (OAuth2 client_credentials grant).
//
// Request shape confirmed directly from the official xero-node SDK's own
// source (XeroClient.ts: getClientCredentialsToken -> tokenRequest) rather
// than assumed: POST https://identity.xero.com/connect/token, HTTP Basic
// auth (base64 client_id:client_secret), body `grant_type=client_credentials`,
// application/x-www-form-urlencoded. A Custom Connection is bound to exactly
// one Xero organisation, so — unlike the standard OAuth2 authorization-code
// flow — no Xero-tenant-id header and no /connections lookup is needed.
//
// XERO_CLIENT_ID / XERO_CLIENT_SECRET are read ONLY from this Edge
// Function's own environment (Supabase Edge Function secrets). Never log,
// return, or otherwise surface either value, or the raw access token, from
// any function that imports this module.

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

interface XeroTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Exchanges the Edge Function's own client_id/secret for an access token.
 * Throws a plain Error with only the HTTP status and Xero's own (non-secret)
 * error payload — never the credentials themselves — if the exchange fails.
 */
export async function getXeroAccessToken(): Promise<string> {
  const clientId = Deno.env.get('XERO_CLIENT_ID');
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('XERO_CLIENT_ID/XERO_CLIENT_SECRET are not configured in this Edge Function\'s secrets.');
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    // Xero's own token-error body is a standard OAuth2 error shape (e.g.
    // {"error":"invalid_client"}) — safe to relay, it never echoes the
    // secret back.
    const body = await response.text();
    throw new Error(`Xero token request failed (HTTP ${response.status}): ${body}`);
  }

  const token = (await response.json()) as XeroTokenResponse;
  return token.access_token;
}

/**
 * A Xero Accounting API request that came back non-2xx. Carries the HTTP status so a caller can tell "not found" (404)
 * apart from every other failure without parsing the message. The message text is unchanged from before.
 */
export class XeroHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'XeroHttpError';
    this.status = status;
  }
}

/** A read-only GET against the Xero Accounting API, using an already-obtained access token. */
export async function xeroGet<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      // No Xero-tenant-id header — a Custom Connection is scoped to one org.
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new XeroHttpError(response.status, `Xero API request to ${path} failed (HTTP ${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

/**
 * A write against the Xero Accounting API. `idempotencyKey`, when given, is
 * sent as Xero's own documented Idempotency-Key header — passing the SAME
 * key on a retry makes Xero return the original result instead of creating
 * a duplicate (confirmed via the Xero Node SDK's own createInvoices
 * signature, which accepts this same parameter).
 */
export async function xeroPost<T>(
  accessToken: string,
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new XeroHttpError(response.status, `Xero API request to ${path} failed (HTTP ${response.status}): ${responseBody}`);
  }

  // Some successful Xero responses (e.g. POST /Invoices/{id}/Email) return an
  // empty body — response.json() throws "Unexpected end of JSON input" on
  // that, even though the request genuinely succeeded. Callers that don't
  // need a return value (emailInvoice) never see this; callers that do
  // (createAuthorisedInvoice) already have their own check for a missing
  // expected field.
  const responseText = await response.text();
  return (responseText ? JSON.parse(responseText) : {}) as T;
}

// This module deliberately has NO way to create, update or search Xero contacts by name. A contact is only ever used by
// the ID a manager explicitly linked to it, and is then re-read by that ID (read-only) before any invoice is written.

const XERO_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a well-formed Xero GUID. Checked before an ID is placed in a URL path, so a stored value can never alter the request. */
export function isXeroId(value: unknown): value is string {
  return typeof value === 'string' && XERO_ID_PATTERN.test(value);
}

/**
 * The id of the Xero organisation this connection is actually bound to, read from Xero itself (GET /Organisation).
 * The credentials alone do not say which organisation they belong to, so the id is asked for rather than assumed.
 */
export async function getConnectedOrganisationId(accessToken: string): Promise<string> {
  const result = await xeroGet<{ Organisations?: { OrganisationID?: string }[] }>(accessToken, '/Organisation');
  const id = result.Organisations?.[0]?.OrganisationID;
  if (typeof id !== 'string' || id.trim() === '') throw new Error('Xero did not return an organisation id.');
  return id.trim();
}

export type XeroLookup<T> = { outcome: 'found'; value: T } | { outcome: 'not_found' };

async function lookupById<T>(accessToken: string, path: string, pick: (body: any) => T | undefined): Promise<XeroLookup<T>> {
  try {
    const found = pick(await xeroGet<unknown>(accessToken, path));
    return found === undefined ? { outcome: 'not_found' } : { outcome: 'found', value: found };
  } catch (err) {
    if (err instanceof XeroHttpError && err.status === 404) return { outcome: 'not_found' };
    throw err;
  }
}

/** Reads one contact BY ID in the connected organisation. An id that is malformed, or that does not exist in THIS organisation, is 'not_found' - no request is made for a malformed one. */
export async function getContactById(accessToken: string, contactId: string): Promise<XeroLookup<XeroContact>> {
  if (!isXeroId(contactId)) return { outcome: 'not_found' };
  return lookupById(accessToken, `/Contacts/${contactId}`, (body) => body?.Contacts?.[0]);
}

/**
 * A read-only text search of the connected organisation's contacts (archived included, so a manager can see them and be
 * told why they cannot be linked). Used ONLY by the manager-only link dialog, to show candidates a person then picks from.
 * Its result is never used to decide anything: nothing is linked, matched or created from it. The term travels as one
 * encoded query parameter, never inside a `where` expression.
 */
export async function searchContacts(accessToken: string, term: string, pageSize = 25): Promise<XeroContact[]> {
  const params = new URLSearchParams({ searchTerm: term, includeArchived: 'true', page: '1', pageSize: String(pageSize) });
  const result = await xeroGet<{ Contacts?: XeroContact[] }>(accessToken, `/Contacts?${params.toString()}`);
  return result.Contacts ?? [];
}

export interface XeroInvoiceSummary {
  InvoiceID: string;
  Contact?: { ContactID?: string };
}

/** Reads one invoice BY ID in the connected organisation; 'not_found' for a malformed id or one that does not exist in THIS organisation. */
export async function getInvoiceById(accessToken: string, invoiceId: string): Promise<XeroLookup<XeroInvoiceSummary>> {
  if (!isXeroId(invoiceId)) return { outcome: 'not_found' };
  return lookupById(accessToken, `/Invoices/${invoiceId}`, (body) => body?.Invoices?.[0]);
}

export interface XeroInvoiceLineItemInput {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode: string;
  TaxType: string;
}

export interface XeroCreatedInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
}

export interface XeroInvoiceRequest {
  contactId: string;
  reference: string | null;
  dueDate: string;
  lineItems: XeroInvoiceLineItemInput[];
}

/**
 * Derives the Xero Idempotency-Key from the actual request content — a
 * SHA-256 hash of every field that ends up in the invoice payload — rather
 * than a fixed value chosen once when the local draft was created.
 *
 * Xero associates an idempotency key with the literal request body it was
 * first used with, INCLUDING a request Xero went on to reject (a 400
 * validation error still "uses up" the key against that exact body — Xero
 * returns "Idempotency Key ... is used with a different request" if the
 * same key is retried with a different body, even though nothing was ever
 * actually created). A key generated once per invoice row and reused
 * across every retry breaks the moment the retried payload legitimately
 * changes (e.g. a missing required field gets fixed, or the manager edits
 * a price) — exactly the bug this fixes.
 *
 * Deriving the key from the payload itself keeps both properties Xero's
 * mechanism is meant to provide: a genuine retry of an UNCHANGED request
 * (e.g. after a network timeout where it's unknown whether Xero already
 * received it) hashes to the same key, so Xero's own dedup safely returns
 * the original result instead of creating a duplicate; a CHANGED request
 * (the actual fix-and-retry case) hashes to a different key, so Xero
 * correctly treats it as new rather than rejecting it.
 */
export async function computeInvoiceIdempotencyKey(request: XeroInvoiceRequest): Promise<string> {
  const canonical = JSON.stringify({
    contactId: request.contactId,
    reference: request.reference,
    dueDate: request.dueDate,
    lineItems: request.lineItems.map((li) => ({
      Description: li.Description,
      Quantity: li.Quantity,
      UnitAmount: li.UnitAmount,
      AccountCode: li.AccountCode,
      TaxType: li.TaxType,
    })),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Creates a sales invoice AUTHORISED immediately (never left as DRAFT) —
 * per Luke's explicit requirement that Send both creates/updates and sends
 * the invoice in one action, and because an invoice must be AUTHORISED
 * before it can be emailed at all. The idempotency key is always derived
 * from `input` itself (see computeInvoiceIdempotencyKey) — callers never
 * supply one, so it can't drift out of sync with the payload it's meant to
 * guard.
 *
 * `existingInvoiceId`, when given, UPDATES that specific Xero invoice
 * instead of creating a new one — this app's own Send action can be
 * clicked again on an invoice it already created (e.g. the email step
 * failed the first time, or Luke changed the amount/recipient before
 * retrying), and must never produce a second Xero invoice for the same
 * local draft.
 *
 * Verified directly against the official xero-node SDK's own source
 * (which exposes a distinct `updateInvoice(tenantId, invoiceId, ...)`
 * method, separate from bulk `createInvoices`/`updateOrCreateInvoices`)
 * rather than assumed: Xero's update path is `POST /Invoices/{InvoiceID}`
 * — the ID goes in the URL, not merely included in the body of a POST to
 * the bare `/Invoices` collection endpoint. Posting to the bare endpoint
 * always creates; only the ID-scoped path updates the specific invoice —
 * getting this wrong is exactly what would risk a duplicate invoice.
 */
export async function createOrUpdateAuthorisedInvoice(
  accessToken: string,
  input: XeroInvoiceRequest,
  existingInvoiceId?: string,
): Promise<XeroCreatedInvoice> {
  const idempotencyKey = await computeInvoiceIdempotencyKey(input);
  const path = existingInvoiceId ? `/Invoices/${existingInvoiceId}` : '/Invoices';
  const result = await xeroPost<{ Invoices: XeroCreatedInvoice[] }>(
    accessToken,
    path,
    {
      Invoices: [
        {
          Type: 'ACCREC',
          ...(existingInvoiceId ? { InvoiceID: existingInvoiceId } : {}),
          Contact: { ContactID: input.contactId },
          LineItems: input.lineItems,
          Status: 'AUTHORISED',
          DueDate: input.dueDate,
          ...(input.reference ? { Reference: input.reference } : {}),
        },
      ],
    },
    idempotencyKey,
  );
  const invoice = result.Invoices?.[0];
  if (!invoice) throw new Error(`Xero did not return the ${existingInvoiceId ? 'updated' : 'created'} invoice.`);
  return invoice;
}

/** Sends Xero's own templated email for an already-AUTHORISED invoice. */
export async function emailInvoice(accessToken: string, xeroInvoiceId: string): Promise<void> {
  await xeroPost(accessToken, `/Invoices/${xeroInvoiceId}/Email`, {});
}

export interface XeroAccount {
  AccountID: string;
  Code?: string;
  Name: string;
  Type: string;
  Status: string;
  Class?: string;
}

export interface XeroTaxRate {
  Name: string;
  TaxType: string;
  DisplayTaxRate: number;
  Status: string;
  CanApplyToRevenue?: boolean;
}

export interface XeroContact {
  ContactID: string;
  Name: string;
  EmailAddress?: string;
  ContactStatus: string;
  AccountNumber?: string;
  /** Present when this contact was merged into another: the surviving contact's id. */
  MergedToContactID?: string;
  Addresses?: { AddressType?: string; City?: string; PostalCode?: string }[];
  ContactPersons?: { IncludeInEmails?: boolean }[];
}

export type ResolvedAccount =
  | { outcome: 'found'; account: { accountId: string; code: string | null; name: string; type: string; status: string } }
  | { outcome: 'not_found' }
  | { outcome: 'multiple'; candidateCount: number };

/**
 * Finds the account named "Sales" — matched by name, not by a hardcoded
 * Code/Type, since Luke's requirement is the account named "Sales" and the
 * actual code is specific to this organisation's chart of accounts (must be
 * resolved live, never assumed — e.g. NOT hardcoded as "200"). Returns an
 * honest 'not_found'/'multiple' outcome rather than guessing when the match
 * isn't exactly one account.
 */
export function findSalesAccount(accounts: XeroAccount[]): ResolvedAccount {
  const matches = accounts.filter((a) => a.Status === 'ACTIVE' && a.Name.trim().toLowerCase() === 'sales');
  if (matches.length === 0) return { outcome: 'not_found' };
  if (matches.length > 1) return { outcome: 'multiple', candidateCount: matches.length };
  const a = matches[0];
  return { outcome: 'found', account: { accountId: a.AccountID, code: a.Code ?? null, name: a.Name, type: a.Type, status: a.Status } };
}

export type ResolvedTaxRate =
  | { outcome: 'found'; taxRate: { taxType: string; name: string; displayTaxRate: number; status: string } }
  | { outcome: 'not_found' }
  | { outcome: 'multiple'; candidateCount: number };

/**
 * Finds the 20% VAT-on-sales rate — matched by DisplayTaxRate = 20 AND
 * CanApplyToRevenue, never by a hardcoded TaxType string (e.g. NOT assumed
 * to be "OUTPUT2" — that's a common default in UK Xero organisations but is
 * genuinely configurable per org, so it must be resolved live). Excludes a
 * 20% rate that only applies to purchases (e.g. an "INPUT2" equivalent),
 * since this is specifically for sales invoices.
 */
export function find20PercentSalesTaxRate(taxRates: XeroTaxRate[]): ResolvedTaxRate {
  const matches = taxRates.filter(
    (t) => t.Status === 'ACTIVE' && t.CanApplyToRevenue !== false && Math.abs(t.DisplayTaxRate - 20) < 0.001,
  );
  if (matches.length === 0) return { outcome: 'not_found' };
  if (matches.length > 1) return { outcome: 'multiple', candidateCount: matches.length };
  const t = matches[0];
  return { outcome: 'found', taxRate: { taxType: t.TaxType, name: t.Name, displayTaxRate: t.DisplayTaxRate, status: t.Status } };
}
