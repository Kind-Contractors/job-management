// Creates OR updates and sends a Xero sales invoice for an existing local
// draft invoice — the only place this app ever writes to Xero. POST only,
// manager-gated (see ../_shared/auth.ts), body:
// { invoiceId: string; contactId?: string }. contactId is the LOCAL
// contacts.id the manager chose for this invoice. On a first send, when it
// is omitted the building's saved default recipient is used, and with no
// default the send is refused (a recipient is never guessed). Once Xero
// holds the invoice the recipient is LOCKED: a retry may omit contactId or
// name the same contact, and any other contact is refused (safeguard 5).
//
// A Send action always reflects whatever is CURRENTLY saved on the local
// invoice row at the moment this runs (description/works_order_number/
// due_date/line items) — the frontend persists the editor's current state
// before ever calling this function (see invoicesRepository.sendInvoice's
// caller), so this never needs to guess between "current" and "saved".
//
// Never creates a second Xero invoice for the same draft on retry: the
// draft is atomically claimed (status draft/failed -> sending) before any
// Xero WRITE, and once a xero_invoice_id already exists, every subsequent
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
// SAFEGUARDS (see ../_shared/xeroSafeguards.ts), all fail-closed:
//   1. Two switches, both off unless exactly "true" (see ../_shared/xeroSafeguards.ts):
//      - XERO_CREATION_ENABLED (or XERO_SENDING_ENABLED): may contacts and invoices be created in Xero at all? Checked
//        BEFORE the invoice is claimed, so a blocked request leaves the invoice row exactly as it was.
//      - XERO_SENDING_ENABLED: may invoices be EMAILED at all here? Checked again immediately before the email step, together
//        with the manager's Automatic Invoice Emails toggle (safeguard 7): both must allow it. When either does not
//        the invoice is still created and authorised in Xero, nobody is emailed, and it is recorded as
//        'in_xero_not_emailed' - never 'sent'. Such an invoice is not retried by the app (only draft/failed are claimed),
//        so turning emailing on later never emails it.
//   2. XERO_EXPECTED_ORG_ID must be set, and the organisation the connection is actually bound to (GET /Organisation)
//      must equal it. Both the token request and this comparison are read-only and run BEFORE the invoice is claimed,
//      so a wrong organisation leaves the invoice row untouched (the atomic claim remains the concurrency guard).
//   3. A linked recipient (contacts.xero_contact_id) is re-read by id in the connected organisation (it must exist there,
//      be ACTIVE and have an email) before any invoice is created, updated or authorised; an id from another organisation
//      does not exist here and is refused. A recipient the manager chose that is NOT linked yet is, on a first send only,
//      linked to its one existing Xero contact with the same email, or created in Xero (../_shared/autoXeroContact.ts):
//      after the organisation check, never by name alone, refused when ambiguous, idempotent across retries.
//   4. An invoice that already has a Xero invoice id must still exist in the connected organisation before it is updated.
//   5. The recipient is never guessed (see ../_shared/invoiceRecipients.ts). On a first send it is the contact the manager
//      explicitly chose, else the BUILDING'S SAVED DEFAULT, else the send is refused. The contact's link must be recorded
//      for the connected Xero organisation and still be good in Xero. Once Xero holds the invoice the recipient is LOCKED:
//      a retry can only go to the Xero contact the invoice was created for, a request naming another contact is refused
//      (so a direct call to this function cannot change it), and a database trigger enforces the same.
//   6. The invoice must be internally consistent (see ../_shared/invoiceRelationships.ts): every line is linked to a visit
//      of the invoice's own job, and the job resolves to the building and client the recipient is checked against. This
//      is checked BEFORE any Xero call and before the claim, so an invalid invoice leaves the row exactly as it was; it
//      is checked again after the claim, on the data as it is then. A combined invoice therefore cannot mix jobs or
//      buildings whatever the screen allowed.
//   7. Automatic invoice emails (app_settings.auto_invoice_emails_enabled, see ../_shared/invoiceEmailSetting.ts) is read
//      immediately before the email step on every attempt. Off: the invoice is still created in Xero, nobody is emailed,
//      and it is recorded as 'in_xero_not_emailed' (never 'sent'). Unreadable: not emailed, and recorded as 'failed' so a
//      retry updates the same Xero invoice. It never overrides XERO_SENDING_ENABLED or any check above.
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
  emailInvoice,
  describeTaxRateProblem,
  find20PercentSalesTaxRate,
  findSalesAccount,
  getXeroAccessToken,
  xeroGet,
  type XeroAccount,
  type XeroInvoiceLineItemInput,
  type XeroTaxRate,
} from '../_shared/xeroClient.ts';
import { InvoiceRelationshipError, loadAndValidateInvoice, type ValidatedInvoice } from '../_shared/invoiceRelationships.ts';
import { resolveFirstSendRecipient, resolveLockedRecipient, type ResolvedRecipient } from '../_shared/invoiceRecipients.ts';
import { linkOrCreateXeroContact } from '../_shared/autoXeroContact.ts';
import { decideAutoInvoiceEmail } from '../_shared/invoiceEmailSetting.ts';
import {
  assertConnectedToExpectedOrganisation,
  assertExpectedOrganisationConfigured,
  isCreationEnabled,
  isSendingEnabled,
  requireInvoiceInConnectedOrganisation,
  XeroSafeguardError,
} from '../_shared/xeroSafeguards.ts';

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
  xero_contact_id: string | null;
  xero_org_id: string | null;
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
 * Refuses a Xero response that does not belong to this local invoice: an update must come back with the invoice it updated,
 * and a newly created invoice must not already be recorded on another local invoice. Fails safe: if that cannot be checked,
 * it is refused too. Throws before anything is saved or emailed.
 */
async function requireXeroInvoiceBelongsHere(
  client: SupabaseClient,
  invoiceId: string,
  existingXeroInvoiceId: string | null,
  returned: { InvoiceID: string; InvoiceNumber: string },
): Promise<void> {
  const refuse = (detail: string) =>
    new XeroSafeguardError(
      'XERO_INVOICE_ALREADY_RECORDED',
      `Xero answered with invoice ${returned.InvoiceNumber}, ${detail} Nothing was saved or emailed. Check Xero before sending again.`,
    );
  if (existingXeroInvoiceId) {
    if (existingXeroInvoiceId.trim().toLowerCase() !== returned.InvoiceID.trim().toLowerCase()) {
      throw refuse('which is not the Xero invoice this invoice already has.');
    }
    return;
  }
  const { data, error } = await client.from('invoices').select('id').eq('xero_invoice_id', returned.InvoiceID).neq('id', invoiceId).limit(1);
  if (error) throw refuse(`and the app could not check whether another invoice already has it (${error.message}).`);
  if ((data ?? []).length > 0) throw refuse('which is already recorded on another invoice in the app.');
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
        "If this organisation is Xero's own Demo Company, it has a zero invoice-email limit and can never send real emails. " +
        "Otherwise check this organisation's email and branding settings in Xero, and status.developer.xero.com. " +
        "The invoice itself exists in Xero; sending again will retry the email on that same invoice.",
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

  let body: Record<string, unknown> | null = null;
  let bodyError: string | null = null;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the body must be a JSON object.');
    body = parsed as Record<string, unknown>;
  } catch (err) {
    bodyError = errorMessage(err);
  }

  // Read-only, for the invoice editor's wording only ("Send invoice" or "Create in Xero"): what this environment's switches
  // permit right now. Touches no invoice, no database row and no Xero endpoint. It decides nothing: every send re-checks
  // both switches and the app setting on the server, immediately before the step they govern.
  if (body?.action === 'capabilities') {
    return json({ creationEnabled: isCreationEnabled(), sendingEnabled: isSendingEnabled() }, 200);
  }

  // Kill switch and organisation configuration are checked BEFORE the invoice is claimed: a blocked request must
  // leave the invoice row untouched (never 'sending', never 'failed'), and needs no Xero call.
  if (!isCreationEnabled()) {
    return json(
      {
        status: 'blocked',
        code: 'CREATION_DISABLED',
        error: 'Creating invoices in Xero is disabled for this environment (neither XERO_CREATION_ENABLED nor XERO_SENDING_ENABLED is "true"). Nothing was sent.',
      },
      503,
    );
  }
  try {
    assertExpectedOrganisationConfigured();
  } catch (err) {
    if (err instanceof XeroSafeguardError) return json({ status: 'blocked', code: err.code, error: err.message }, 503);
    return json({ error: errorMessage(err) }, 500);
  }

  let invoiceId: string;
  let contactId: string | undefined;
  try {
    if (!body) throw new Error(bodyError ?? 'the body must be a JSON object.');
    invoiceId = body.invoiceId as string;
    if (!invoiceId || typeof invoiceId !== 'string') throw new Error('Missing invoiceId.');
    // Optional in the body's shape, but effectively always required in
    // practice — the frontend always supplies it. If genuinely omitted and
    // this invoice already has a Xero invoice, the currently-assigned Xero
    // Contact is reused as a fallback rather than failing outright.
    if (body.contactId !== undefined && typeof body.contactId !== 'string') throw new Error('contactId must be a string.');
    contactId = (body.contactId as string) || undefined;
  } catch (err) {
    return json({ error: `Invalid request body: ${errorMessage(err)}` }, 400);
  }

  // The invoice must be consistent BEFORE anything else happens: a database-only check, so an invalid invoice causes no Xero
  // call at all and is never claimed (it cannot be left 'sending'). A failure to LOAD the data blocks the send as well.
  let validated: ValidatedInvoice;
  try {
    validated = await loadAndValidateInvoice(callerClient, invoiceId);
  } catch (err) {
    if (err instanceof InvoiceRelationshipError) return json({ status: 'blocked', code: err.code, error: err.message }, err.status);
    return json({ status: 'blocked', error: errorMessage(err) }, 500);
  }

  // Authenticate with Xero and verify the connected organisation BEFORE the invoice is claimed. Both steps are
  // read-only, so a wrong organisation, a failed lookup or a failed login leaves the invoice row exactly as it was
  // (never 'sending', never 'failed'). The claim below is still the concurrency guard: two simultaneous requests
  // can both pass this check, but only one can claim the invoice.
  let accessToken: string;
  let connectedOrgId: string;
  try {
    accessToken = await getXeroAccessToken();
    connectedOrgId = await assertConnectedToExpectedOrganisation(accessToken);
  } catch (err) {
    const message = errorMessage(err);
    if (err instanceof XeroSafeguardError) return json({ status: 'blocked', code: err.code, error: message }, 503);
    return json({ status: 'blocked', code: 'XERO_AUTH_FAILED', error: message }, 502);
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
        `id, description, works_order_number, due_date, xero_invoice_id, xero_invoice_number, xero_contact_id, xero_org_id,
         invoice_line_items ( id, description, quantity, unit_amount ),
         jobs ( id, buildings ( client_id, clients ( id, company_name ) ) )`,
      )
      .eq('id', invoiceId)
      .single();

    if (fetchError || !invoice) throw new Error(fetchError?.message ?? 'Invoice not found.');
    const row = invoice as unknown as InvoiceRow;

    if (row.invoice_line_items.length === 0) throw new Error('This invoice has no line items.');

    // The invoice is claimed now, so its data can no longer change under another request of ours, but it may have
    // changed since the first check. Check again, on the data as it is NOW, before anything more is asked of Xero.
    const recheck = await loadAndValidateInvoice(callerClient, invoiceId);
    if (recheck.jobId !== validated.jobId || recheck.clientId !== validated.clientId) {
      throw new Error("This invoice's job or client changed while it was being sent. Nothing was sent; check the invoice and try again.");
    }

    // An invoice that already exists in Xero must exist in THIS organisation before it is updated.
    const existingXeroInvoice = row.xero_invoice_id
      ? await requireInvoiceInConnectedOrganisation(accessToken, row.xero_invoice_id)
      : null;

    const job = one(row.jobs);
    const building = job ? one(job.buildings) : null;
    const client = building ? one(building.clients) : null;
    if (!client) throw new Error('Could not resolve the client for this invoice.');
    // The client the recipient is checked against is the one the whole invoice was validated against.
    if (client.id !== recheck.clientId) {
      throw new Error("This invoice's client does not match the client its visits belong to. Nothing was sent.");
    }

    // WHO the invoice goes to (see ../_shared/invoiceRecipients.ts). Nothing is searched for, created or guessed.
    //   - A Xero invoice already exists: the recipient is LOCKED to the contact it was created for. A different contact in
    //     the request is refused here, whoever sent it (including a direct call to this function).
    //   - Otherwise: the contact the manager chose, else the building's saved default, else the send is refused.
    // Either way the link must be recorded for the connected organisation and be good in Xero (active, with an email)
    // before any invoice is created, updated or authorised.
    const recipientContext = { db: callerClient, accessToken, connectedOrgId, clientId: client.id };
    const recipient: ResolvedRecipient = existingXeroInvoice
      ? await resolveLockedRecipient({ ...recipientContext, invoice: row, existingXeroInvoice, requestedContactId: contactId })
      : await resolveFirstSendRecipient({
          ...recipientContext,
          buildingId: recheck.buildingId,
          requestedContactId: contactId,
          // An explicitly chosen contact that is not linked yet is linked to its existing Xero contact (by email) or created
          // in Xero - in the connected organisation verified above, never by name alone, never on a retry of an invoice
          // Xero already holds (that recipient is locked).
          autoLink: async (contact) => {
            const { data: who } = await callerClient.auth.getUser();
            return linkOrCreateXeroContact({
              db: callerClient,
              accessToken,
              connectedOrgId,
              clientName: client.company_name,
              contact,
              linkedBy: `auto (invoice send): ${who.user?.email ?? 'unknown'}`,
            });
          },
        });
    const xeroContactId = recipient.xeroContactId;

    // FIRST creation only: record who this invoice is for, and in which Xero organisation, BEFORE it is created in Xero.
    // If this write fails nothing has been sent to Xero yet. When Xero already holds the invoice the recipient is not
    // rewritten here: it is locked (and a database trigger refuses any change to it).
    if (!row.xero_invoice_id) {
      await updateInvoiceRow(
        callerClient,
        invoiceId,
        { xero_contact_id: xeroContactId, xero_org_id: connectedOrgId },
        'Could not record the invoice recipient',
      );
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
      // Refused before anything is created or updated in Xero; the message lists the rates Xero returned (names and codes only).
      throw new Error(describeTaxRateProblem(resolvedTaxRate));
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
        localInvoiceId: invoiceId,
        contactId: xeroContactId,
        reference: row.works_order_number,
        dueDate: row.due_date,
        lineItems,
      },
      row.xero_invoice_id ?? undefined,
    );

    // The Xero invoice Xero answered with must be THIS local invoice's: the same one it already had, or - on a first
    // creation - one no other local invoice has recorded. Otherwise (for example Xero replaying another invoice's request)
    // nothing is saved and nothing is emailed: two local invoices must never claim one Xero invoice.
    await requireXeroInvoiceBelongsHere(callerClient, invoiceId, row.xero_invoice_id, createdOrUpdatedInvoice);

    // Persisted before attempting the email step — if emailing fails, a
    // retry must not create/duplicate anything, only retry the send.
    await updateInvoiceRow(
      callerClient,
      invoiceId,
      {
        xero_invoice_id: createdOrUpdatedInvoice.InvoiceID,
        xero_invoice_number: createdOrUpdatedInvoice.InvoiceNumber,
        // The recipient and organisation the Xero invoice was actually created/updated for. For an invoice that already had
        // them these are the same values (the database refuses any change); for one sent before they were recorded they
        // are filled in once.
        xero_contact_id: xeroContactId,
        xero_org_id: connectedOrgId,
        // Who Xero holds this invoice for, as Xero names them now: shown to the manager as the recipient.
        xero_recipient_name: recipient.xeroContactName,
        xero_recipient_email: recipient.xeroContactEmail,
      },
      `Invoice ${row.xero_invoice_id ? 'updated' : 'created'} in Xero (${createdOrUpdatedInvoice.InvoiceNumber}) but failed to save locally`,
    );

    // An email needs BOTH permissions, checked immediately before the only email call, on every attempt (first send or retry):
    //   1. XERO_SENDING_ENABLED - the operator's switch for this environment (the ceiling; absent = never email), then
    //   2. app_settings.auto_invoice_emails_enabled - the manager's "Automatic Invoice Emails" toggle, read from the database
    //      now (only an explicit "on" counts; off or unreadable never emails).
    // Without both, the invoice exists in Xero, authorised, nobody is emailed, and it is recorded as exactly that.
    const emailDecision: { send: true } | { send: false; reason: 'environment' | 'disabled' | 'unreadable' } = isSendingEnabled()
      ? await decideAutoInvoiceEmail(callerClient)
      : { send: false, reason: 'environment' };
    if (!emailDecision.send) {
      if (emailDecision.reason === 'unreadable') {
        // Fail safe, and stay retryable: the invoice exists in Xero (saved above), so a retry updates that same invoice.
        throw new Error(
          `Invoice ${createdOrUpdatedInvoice.InvoiceNumber} was created in Xero but NOT emailed: the automatic invoice email setting could not be read, so the app did not email it. ` +
            'Try again later (the same Xero invoice is used), or send it from Xero.',
        );
      }
      await updateInvoiceRow(
        callerClient,
        invoiceId,
        { status: 'in_xero_not_emailed', last_error: null, not_emailed_reason: emailDecision.reason === 'environment' ? 'environment' : 'app_setting_off' },
        `Invoice created in Xero (${createdOrUpdatedInvoice.InvoiceNumber}) but failed to record it locally`,
      );
      return json(
        {
          status: 'in_xero_not_emailed',
          emailed: false,
          code: emailDecision.reason === 'environment' ? 'EMAIL_DISABLED' : 'AUTO_EMAIL_OFF',
          xeroInvoiceId: createdOrUpdatedInvoice.InvoiceID,
          xeroInvoiceNumber: createdOrUpdatedInvoice.InvoiceNumber,
          recipientSource: recipient.source,
          recipientName: recipient.xeroContactName,
          recipientEmail: recipient.xeroContactEmail,
        },
        200,
      );
    }

    await emailInvoiceOrExplain(accessToken, createdOrUpdatedInvoice.InvoiceID);

    await updateInvoiceRow(
      callerClient,
      invoiceId,
      { status: 'sent', sent_at: new Date().toISOString(), not_emailed_reason: null },
      'Invoice sent but failed to record it locally',
    );

    return json(
      {
        status: 'sent',
        emailed: true,
        xeroInvoiceId: createdOrUpdatedInvoice.InvoiceID,
        xeroInvoiceNumber: createdOrUpdatedInvoice.InvoiceNumber,
        recipientSource: recipient.source,
        recipientName: recipient.xeroContactName,
        recipientEmail: recipient.xeroContactEmail,
      },
      200,
    );
  } catch (err) {
    const message = errorMessage(err);
    await markFailed(callerClient, invoiceId, message);
    if (err instanceof XeroSafeguardError) return json({ status: 'failed', code: err.code, error: message }, 502);
    if (err instanceof InvoiceRelationshipError) return json({ status: 'failed', code: err.code, error: message }, err.status);
    return json({ status: 'failed', error: message }, 502);
  }
});
