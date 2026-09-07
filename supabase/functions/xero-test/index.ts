// Read-only Xero connection verification endpoint.
//
// GET only. Requires an active-manager Supabase session (see
// ../_shared/auth.ts) — this reads real organisation data (contacts, chart
// of accounts, tax rates) from whatever Xero organisation the Custom
// Connection is pointed at, so it is not open to just any signed-in caller.
//
// Does exactly three things: obtain an access token via the Custom
// Connection (client_credentials grant), fetch Contacts/Accounts/TaxRates
// read-only, and resolve (never hardcode) the "Sales" account and the 20%
// sales VAT rate from what's actually configured in the connected
// organisation. Creates nothing, sends nothing, writes nothing — to Xero or
// to this project's own database.
//
// Each of the three Xero reads is reported independently (Promise.allSettled,
// not Promise.all) — a caller needs to know specifically which of
// Contacts/Accounts/TaxRates succeeded, not just "something failed".
//
// Never logs or returns XERO_CLIENT_ID, XERO_CLIENT_SECRET, or the raw
// access token.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { assertManager, UnauthorizedError } from '../_shared/auth.ts';
import {
  find20PercentSalesTaxRate,
  findSalesAccount,
  getXeroAccessToken,
  xeroGet,
  type XeroAccount,
  type XeroContact,
  type XeroTaxRate,
} from '../_shared/xeroClient.ts';

// Canonical, SDK-maintained CORS header list (kept in sync with whatever
// headers supabase-js actually sends, enforced by the SDK's own tests) —
// not a hand-typed list, which is exactly what went stale twice already
// (first missing apikey, then missing x-client-info).
const CORS_HEADERS = corsHeaders;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed. Use GET.' }, 405);
  }

  try {
    await assertManager(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return json({ error: err.message }, 403);
    return json({ error: errorMessage(err) }, 500);
  }

  // Step 1: authenticate with Xero. Everything else depends on this, so it
  // isn't run alongside the other three — a token failure should read as
  // "Xero authentication failed", not "Contacts/Accounts/TaxRates all failed".
  let accessToken: string;
  try {
    accessToken = await getXeroAccessToken();
  } catch (err) {
    return json(
      {
        xeroAuthSucceeded: false,
        xeroAuthError: errorMessage(err),
        contactsSucceeded: false,
        accountsSucceeded: false,
        taxRatesSucceeded: false,
      },
      200,
    );
  }

  // Step 2: the three reads, independently — one failing must not hide the
  // result of the other two.
  const [contactsResult, accountsResult, taxRatesResult] = await Promise.allSettled([
    xeroGet<{ Contacts: XeroContact[] }>(accessToken, '/Contacts'),
    xeroGet<{ Accounts: XeroAccount[] }>(accessToken, '/Accounts'),
    xeroGet<{ TaxRates: XeroTaxRate[] }>(accessToken, '/TaxRates'),
  ]);

  const response: Record<string, unknown> = {
    xeroAuthSucceeded: true,
    contactsSucceeded: contactsResult.status === 'fulfilled',
    accountsSucceeded: accountsResult.status === 'fulfilled',
    taxRatesSucceeded: taxRatesResult.status === 'fulfilled',
  };

  if (contactsResult.status === 'fulfilled') {
    const contacts = contactsResult.value.Contacts ?? [];
    response.contactsCount = contacts.length;
  } else {
    response.contactsError = errorMessage(contactsResult.reason);
  }

  if (accountsResult.status === 'fulfilled') {
    const accounts = accountsResult.value.Accounts ?? [];
    response.accountsCount = accounts.length;
    response.resolvedSalesAccount = findSalesAccount(accounts);
  } else {
    response.accountsError = errorMessage(accountsResult.reason);
  }

  if (taxRatesResult.status === 'fulfilled') {
    const taxRates = taxRatesResult.value.TaxRates ?? [];
    response.taxRatesCount = taxRates.length;
    response.resolvedVatRate = find20PercentSalesTaxRate(taxRates);
  } else {
    response.taxRatesError = errorMessage(taxRatesResult.reason);
  }

  return json(response, 200);
});
