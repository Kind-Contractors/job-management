// App-wide settings (public.app_settings, exactly one row). Readable and changeable only by an active manager: the
// database's RLS policies decide, not this code. An update that RLS refuses changes no row, which is reported as an error.

import { supabase } from '../lib/supabaseClient';

export interface AutoInvoiceEmailSetting {
  enabled: boolean;
  updatedAt: string | null;
}

const COLUMNS = 'auto_invoice_emails_enabled, updated_at';

interface Row {
  auto_invoice_emails_enabled: boolean;
  updated_at: string | null;
}

export async function getAutoInvoiceEmailSetting(): Promise<AutoInvoiceEmailSetting> {
  const { data, error } = await supabase.from('app_settings').select(COLUMNS).eq('id', true).maybeSingle();
  if (error) throw new Error(`Could not load the automatic invoice email setting: ${error.message}`);
  if (!data) throw new Error('The automatic invoice email setting could not be loaded.');
  const row = data as Row;
  return { enabled: row.auto_invoice_emails_enabled === true, updatedAt: row.updated_at };
}

/** Saves the setting and returns what the database now holds. Throws unless the database confirms exactly the requested value. */
export async function setAutoInvoiceEmailSetting(enabled: boolean): Promise<AutoInvoiceEmailSetting> {
  const { data, error } = await supabase
    .from('app_settings')
    .update({ auto_invoice_emails_enabled: enabled })
    .eq('id', true)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`The setting was not changed: ${error.message}`);
  if (!data) throw new Error('The setting was not changed: only an active manager can change it.');
  const row = data as Row;
  if (row.auto_invoice_emails_enabled !== enabled) throw new Error('The setting was not changed as requested. Reload the page and check it.');
  return { enabled: row.auto_invoice_emails_enabled, updatedAt: row.updated_at };
}
