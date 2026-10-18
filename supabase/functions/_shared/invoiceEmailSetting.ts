// The "Automatic invoice emails" setting (public.app_settings.auto_invoice_emails_enabled), read on the server immediately
// before the app asks Xero to email an invoice. It FAILS CLOSED: only an explicit TRUE read successfully from the database
// allows the email. A read error, a missing row, a null or anything unexpected means "do not email".
//
// It only governs the email step. It never enables anything the other safeguards refuse: XERO_SENDING_ENABLED, the
// expected-organisation check, recipient verification and the invoice relationship checks all still apply first.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type AutoInvoiceEmailDecision =
  | { send: true }
  | { send: false; reason: 'disabled' | 'unreadable' };

export async function decideAutoInvoiceEmail(db: SupabaseClient): Promise<AutoInvoiceEmailDecision> {
  try {
    const { data, error } = await db.from('app_settings').select('auto_invoice_emails_enabled').eq('id', true).maybeSingle();
    if (error || !data) return { send: false, reason: 'unreadable' };
    const value = (data as { auto_invoice_emails_enabled?: unknown }).auto_invoice_emails_enabled;
    if (value === true) return { send: true };
    if (value === false) return { send: false, reason: 'disabled' };
    return { send: false, reason: 'unreadable' };
  } catch {
    return { send: false, reason: 'unreadable' };
  }
}
