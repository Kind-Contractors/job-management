// Creates OR updates and sends a Xero sales invoice for an existing local
// draft invoice — the only place this app ever writes to Xero. POST only,
// manager-gated (see ../_shared/auth.ts), body:
// { invoiceId: string; contactId?: string }. contactId is the LOCAL
// contacts.id the manager selected as this invoice's recipient — always
// honoured, whether this is the first send or a subsequent send/retry of
// an invoice Xero already has (falls back to that invoice's currently-
// assigned Xero Contact only if contactId is omitted entirely).
//
// A Send action always reflects whatever is CURRENTLY saved on the local
// invoice row at the moment this runs (description/works_order_number/
// due_date/line items) — the frontend persists the editor's current state
// before ever calling this function (see invoicesRepository.sendInvoice's
// caller), so this never needs to guess between "current" and "saved".
//
// Never creates a second Xero invoice for the same draft on retry: the
// draft is atomically claimed (status draft/failed -> sending) before any
// Xero call, and once a xero_invoice_id already exists, every subsequent
// Send UPDATES that exact Xero invoice (POST /Invoices/{InvoiceID} — see
// createOrUpdateAuthorisedInvoice in xeroClient.ts) rather than creating a
// new one. The Idempotency-Key sent to Xero is derived from the actual
// request content (see ../_shared/xeroClient.ts's
// computeInvoiceIdempotencyKey) — stable across a retry of an unchanged
// request (so a retry after a timeout returns Xero's original result
// instead of creating a duplicate), but different whenever the request
// genuinely changes (e.g. a field is fixed after a 400), since Xero
// rejects reusing a key against a different body.
//
// Never fabricates a Sales AccountCode or VAT TaxType — both are resolved
// live against the connected organisation, exactly like xero-test does. If
// the org has no active 20% sales VAT rate (as is currently true of the
// Demo Company), sending correctly and honestly fails rather than
// guessing a TaxType.
//
// KNOWN ENVIRONMENT LIMITATION (confirmed 2026-09-11 — see CLAUDE.md's
// "Known operational limitations" section for the full write-up): the
// currently-connected organisation is Xero's own "Demo Company (Global)".
// Demo Company organisations have a documented invoice-email limit of
// ZERO — invoice creation (POST /Invoices, AUTHORISED) succeeds normally,
// but POST /Invoices/{id}/Email always fails with a generic HTTP 500
// ("An error occurred in Xero..."), confirmed via Xero's own UI showing
// "Email limit reached" for an invoice that was otherwise correctly
// authorised with a valid contact/email. This is NOT a bug in this
// integration, NOT a missing/invalid contact email, and NOT fixable by
// retrying — see emailInvoiceOrExplain() below, which explains this
// clearly rather than guessing/retrying. Resolved only by connecting a
// real Xero trial or paid organisation instead of the Demo Company.
//
// Never logs or returns XERO_CLIENT_ID, XERO_CLIENT_SECRET, or the raw
// access token.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { assertManager, UnauthorizedError } from '../_shared/auth.ts';
import {
  createOrUpdateAuthorisedInvoice,
  createContact,
  emailInvoice,
  find20PercentSalesTaxRate,
  findContactByName,
  findSalesAccount,
  getXeroAccessToken,
  xeroGet,
  type XeroAccount,
  type XeroContact,
  type XeroInvoiceLineItemInput,
  type XeroTaxRate,
} from '../_shared/xeroClient.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

interface InvoiceRow {
  id: string;
  description: string | null;
  works_order_number: string | null;
  due_date: string;
  xero_invoice_id: string | null;
  xero_invoice_number: string | null;
  invoice_line_items: { id: string; description: string; quantity: number; unit_amount: number }[];
  jobs: {
    id: string;
    buildings: {
      client_id: string;
      clients: {
        id: string;
        company_name: string;
      } | null;
    } | null;
  } | null;
}

interface ContactRow {
  id: string;
  client_id: string;
  name: string;
  email: string | null;
  xero_contact_id: string | null;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** Best-effort — a failed status update should not itself throw and hide the real error that caused it. */
async function markFailed(client: SupabaseClient, invoiceId: string, message: string): Promise<void> {
  const { error } = await client.from('invoices').update({ status: 'failed', last_error: message }).eq('id', invoiceId);
  if (error) console.error('Failed to record invoice failure:', error.message);
}

/**
 * Updates the invoice row and verifies a row was actually affected. A plain
 * `.update(...).eq('id', invoiceId)` with no `.select()` does NOT error when
 * it matches zero rows — so if the local invoice row were deleted (e.g. a
 * Discard racing this same request) while Xero was already being called,
 * the write would silently appear to succeed even though nothing was saved.
 * `contextMessage` describes which step this write follows, for a clear
 * error either way.
 */
async function updateInvoiceRow(
  client: SupabaseClient,
  invoiceId: string,
  patch: Record<string, unknown>,
  contextMessage: string,
): Promise<void> {
  const { data, error } = await client.from('invoices').update(patch).eq('id', invoiceId).select('id').maybeSingle();
  if (error) throw new Error(`${contextMessage}: ${error.message}`);
  if (!data) {
    throw new Error(`${contextMessage}: the local invoice record no longer exists (it may have been discarded while this was in progress).`);
  }
}

/**
 * Resolves (and, if needed, creates) the Xero Contact for one specific
 * LOCAL contact — never the client as a whole — so an invoice's Xero
 * Contact, and therefore Xero's own automatic invoice email, targets
 * exactly the person the manager selected.
 *
 * `contact.xero_contact_id` is authoritative once set: reused directly,
 * never re-searched. Only a contact with no Xero Contact yet reaches the
 * search/create step below.
 *
 * The search/create name is deliberately qualified as
 * "<contact name> (<client company name>)", NOT the bare contact name.
 * Xero's contact search matches by exact Name across the WHOLE connected
 * organisation, with no per-client scoping of its own — two different
 * local clients each having a contact named e.g. "Jane Smith" would
 * otherwise resolve to (and forever after reuse) the SAME Xero Contact,
 * silently sending one client's invoices to the other's Jane Smith.
 * Qualifying the name with the client's own company name keeps the
 * existing search-then-create shape (still guards against creating a
 * duplicate Xero contact if a previous attempt created one but failed to
 * persist the id locally) while making that specific collision
 * effectively impossible — the only residual case (two clients sharing
 * both an identical company name AND an identically-named contact) is
 * negligible for this organisation's real client roster.
 */
async function resolveXeroContactId(
  client: SupabaseClient,
  accessToken: string,
  contact: ContactRow,
  clientCompanyName: string,
): Promise<string> {
  if (contact.xero_contact_id) return contact.xero_contact_id;

  const qualifiedName = `${contact.name} (${clientCompanyName})`;
  const existing = await findContactByName(accessToken, qualifiedName);
  const xeroContactId = existing ? existing.ContactID : (await createContact(accessToken, qualifiedName, contact.email)).ContactID;

  const { error } = await client.from('contacts').update({ xero_contact_id: xeroContactId }).eq('id', contact.id);
  if (error) throw new Error(`Resolved Xero contact but failed to save it on the contact: ${error.message}`);

  return xeroContactId;
}

/**
 * Fetches the given contact by id and verifies it genuinely belongs to
 * this invoice's client — never trusts the request body alone for that,
 * same defensive pattern as send-client-report's contact/client check.
 */
async function loadInvoiceRecipientContact(client: SupabaseClient, contactId: string, expectedClientId: string): Promise<ContactRow> {
  const { data, error } = await client
    .from('contacts')
    .select('id, client_id, name, email, xero_contact_id')
    .eq('id', contactId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load the selected recipient: ${error.message}`);
  const contact = data as ContactRow | null;
  if (!contact || contact.client_id !== expectedClientId) {
    throw new Error('The selected recipient does not belong to this invoice\'s client.');
  }
  return contact;
}

/**
 * Xero's own `/Invoices/{id}/Email` call sends to whatever `EmailAddress` is
 * already on the Contact record — this app never passes an address on that
 * call itself (see emailInvoice in xeroClient.ts). Checking here, before
 * calling it, turns an opaque Xero-side failure (a generic HTTP 500, "An
 * error occurred in Xero...") into a specific, actionable local error —
 * without changing what /Email itself does, and without guessing that a
 * missing email is the ONLY thing that endpoint can fail on (a genuinely
 * blank email is simply the one specific, checkable precondition worth
 * failing fast on).
 */
async function assertXeroContactHasEmail(accessToken: string, xeroContactId: string): Promise<void> {
  const result = await xeroGet<{ Contacts: XeroContact[] }>(accessToken, `/Contacts/${xeroContactId}`);
  const email = result.Contacts?.[0]?.EmailAddress?.trim();
  if (!email) {
    throw new Error(
      "This client's Xero contact has no email address on file, so the invoice email can't be sent. Add an email to the client's contact (All Live Jobs' Contact column, or Xero directly), then retry sending this invoice.",
    );
  }
}

/**
 * Wraps emailInvoice() only to turn a failure AT THIS SPECIFIC STEP into a
 * clear explanation — never to change the request itself, guess Xero's
 * exact cause from its error text, or retry automatically. By the time
 * this runs (both the fresh-create and the retry-of-an-existing-invoice
 * path), the invoice already exists and is AUTHORISED in Xero — so a
 * failure here means "created fine, only the email step failed", which is
 * worth explaining as a distinct outcome rather than a generic invoice
 * failure. Demo Company's own zero invoice-email limit (see this file's
 * header comment) is the confirmed, common cause of exactly this failure
 * shape, so it's named as the likely explanation — alongside Xero's own
 * raw error text, never hiding it — rather than asserted as the only
 * possible cause.
 */
async function emailInvoiceOrExplain(accessToken: string, xeroInvoiceId: string): Promise<void> {
  try {
    await emailInvoice(accessToken, xeroInvoiceId);
  } catch (err) {
    throw new Error(
      `The invoice was created and authorised in Xero, but Xero could not send the email (${errorMessage(err)}). ` +
        "A confirmed common cause is Xero's own Demo Company organisation, which has a zero invoice-email limit and can never send real emails — connect a Xero trial or paid organisation to test actual email delivery. " +
        "If this is a live (non-demo) organisation and the problem persists, check status.developer.xero.com or this organisation's email/branding settings in Xero.",
    );
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed. Use POST.' }, 405);
  }

  let callerClient: SupabaseClient;
  try {
    callerClient = await assertManager(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return json({ error: err.message }, 403);
    return json({ error: errorMessage(err) }, 500);
  }

  let invoiceId: string;
  let contactId: string | undefined;
  try {
    const body = await req.json();
    invoiceId = body.invoiceId;
    if (!invoiceId || typeof invoiceId !== 'string') throw new Error('Missing invoiceId.');
    // Optional in the body's shape, but effectively always required in
    // practice — the frontend always supplies it. If genuinely omitted and
    // this invoice already has a Xero invoice, the currently-assigned Xero
    // Contact is reused as a fallback rather than failing outright.
    if (body.contactId !== undefined && typeof body.contactId !== 'string') throw new Error('contactId must be a string.');
    contactId = body.contactId || undefined;
  } catch (err) {
    return json({ error: `Invalid request body: ${errorMessage(err)}` }, 400);
  }

  // Atomic claim — the actual double-click/concurrent-send guard. Only a
  // 'draft' or 'failed' (retry) invoice can be claimed; a 'sending' or
  // 'sent' invoice is left completely untouched by this request.
  const { data: claimed, error: claimError } = await callerClient
    .from('invoices')
    .update({ status: 'sending', last_error: null })
    .eq('id', invoiceId)
    .in('status', ['draft', 'failed'])
    .select('id')
    .maybeSingle();

  if (claimError) return json({ error: `Failed to claim invoice: ${claimError.message}` }, 500);
  if (!claimed) {
    return json({ status: 'failed', error: 'This invoice is already being sent, or has already been sent.' }, 409);
  }

  try {
    const { data: invoice, error: fetchError } = await callerClient
      .from('invoices')
      .select(
        `id, description, works_order_number, due_date, xero_invoice_id, xero_invoice_number,
         invoice_line_items ( id, description, quantity, unit_amount ),
         jobs ( id, buildings ( client_id, clients ( id, company_name ) ) )`,
      )
      .eq('id', invoiceId)
      .single();

    if (fetchError || !invoice) throw new Error(fetchError?.message ?? 'Invoice not found.');
    const row = invoice as unknown as InvoiceRow;

    if (row.invoice_line_items.length === 0) throw new Error('This invoice has no line items.');

    const accessToken = await getXeroAccessToken();

    const job = one(row.jobs);
    const building = job ? one(job.buildings) : null;
    const client = building ? one(building.clients) : null;
    if (!client) throw new Error('Could not resolve the client for this invoice.');

    // Resolve the Xero Contact for the SPECIFIC recipient the manager
    // currently has selected — on a first send AND on a subsequent send/
    // retry alike, so a reselected recipient is always respected, never
    // silently ignored in favour of whatever Xero already has on file.
    // contactId is a local contacts.id, verified to actually belong to
    // this invoice's client before it's ever passed to Xero. Falls back to
    // the invoice's already-assigned Xero Contact only if contactId was
    // omitted entirely (defensive — the UI always supplies one).
    let xeroContactId: string;
    if (contactId) {
      const recipientContact = await loadInvoiceRecipientContact(callerClient, contactId, client.id);
      xeroContactId = await resolveXeroContactId(callerClient, accessToken, recipientContact, client.company_name);
    } else if (row.xero_invoice_id) {
      const existingInvoice = await xeroGet<{ Invoices: { Contact?: { ContactID: string } }[] }>(
        accessToken,
        `/Invoices/${row.xero_invoice_id}`,
      );
      const existingContactId = existingInvoice.Invoices?.[0]?.Contact?.ContactID;
      if (!existingContactId) {
        throw new Error(
          "This invoice already has a Xero invoice, but its Xero Contact could not be read back from Xero — check the invoice directly in Xero.",
        );
      }
      xeroContactId = existingContactId;
    } else {
      throw new Error('Select a recipient contact before sending this invoice.');
    }

    // Resolve Sales AccountCode / 20% VAT TaxType live — never hardcoded,
    // never assumed from a previous run. Re-resolved on every send
    // (including an update of an already-created invoice) since it's cheap
    // and keeps this correct even if the connected organisation's chart of
    // accounts/tax rates changed between attempts.
    const [accountsResult, taxRatesResult] = await Promise.all([
      xeroGet<{ Accounts: XeroAccount[] }>(accessToken, '/Accounts'),
      xeroGet<{ TaxRates: XeroTaxRate[] }>(accessToken, '/TaxRates'),
    ]);
    const resolvedAccount = findSalesAccount(accountsResult.Accounts ?? []);
    const resolvedTaxRate = find20PercentSalesTaxRate(taxRatesResult.TaxRates ?? []);

    if (resolvedAccount.outcome !== 'found') {
      throw new Error(
        resolvedAccount.outcome === 'multiple'
          ? `${resolvedAccount.candidateCount} active accounts named "Sales" found in Xero — this needs to be resolved in Xero before invoicing.`
          : 'No active account named "Sales" found in this Xero organisation.',
      );
    }
    if (resolvedTaxRate.outcome !== 'found') {
      throw new Error(
        resolvedTaxRate.outcome === 'multiple'
          ? `${resolvedTaxRate.candidateCount} active 20% sales tax rates found in Xero — this needs to be resolved in Xero before invoicing.`
          : 'No active 20% sales VAT rate found in this Xero organisation.',
      );
    }

    // Built from `row`, which was just fetched fresh from the database —
    // the frontend always persists the editor's current description/
    // works_order_number/due_date/line items before calling this function,
    // so this reflects whatever Luke currently sees, not a stale save.
    const lineItems: XeroInvoiceLineItemInput[] = row.invoice_line_items.map((li) => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unit_amount,
      AccountCode: resolvedAccount.account.code ?? resolvedAccount.account.accountId,
      TaxType: resolvedTaxRate.taxRate.taxType,
    }));

    // Creates a new Xero invoice when row.xero_invoice_id is absent, or
    // UPDATES that exact existing one (POST /Invoices/{InvoiceID} — never
    // the bare /Invoices collection endpoint, which would create a second
    // invoice) when it's already present. Either way, the result reflects
    // the current contact/line items/dates/reference above.
    const createdOrUpdatedInvoice = await createOrUpdateAuthorisedInvoice(
      accessToken,
      {
        contactId: xeroContactId,
        reference: row.works_order_number,
        dueDate: row.due_date,
        lineItems,
      },
      row.xero_invoice_id ?? undefined,
    );

    // Persisted before attempting the email step — if emailing fails, a
    // retry must not create/duplicate anything, only retry the send.
    await updateInvoiceRow(
      callerClient,
      invoiceId,
      { xero_invoice_id: createdOrUpdatedInvoice.InvoiceID, xero_invoice_number: createdOrUpdatedInvoice.InvoiceNumber },
      `Invoice ${row.xero_invoice_id ? 'updated' : 'created'} in Xero (${createdOrUpdatedInvoice.InvoiceNumber}) but failed to save locally`,
    );

    await assertXeroContactHasEmail(accessToken, xeroContactId);
    await emailInvoiceOrExplain(accessToken, createdOrUpdatedInvoice.InvoiceID);

    await updateInvoiceRow(
      callerClient,
      invoiceId,
      { status: 'sent', sent_at: new Date().toISOString() },
      'Invoice sent but failed to record it locally',
    );

    return json(
      { status: 'sent', xeroInvoiceId: createdOrUpdatedInvoice.InvoiceID, xeroInvoiceNumber: createdOrUpdatedInvoice.InvoiceNumber },
      200,
    );
  } catch (err) {
    const message = errorMessage(err);
    await markFailed(callerClient, invoiceId, message);
    return json({ status: 'failed', error: message }, 502);
  }
});
