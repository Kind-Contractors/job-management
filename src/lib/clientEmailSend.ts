import { checkEmailMessage } from '../../supabase/functions/_shared/reportEmail';
import type { SendClientReportInput } from '../repository/reportsRepository';

/**
 * The exact request sent to the send-client-report function: the manager's confirmed message (cleaned and trimmed, the
 * same way the server will) travels with the report, recipient and PDF. An invalid message produces no request at all.
 */
export function buildSendClientReportInput(
  reportId: string,
  contactId: string,
  pdfBase64: string,
  emailMessage: string,
): { ok: true; input: SendClientReportInput } | { ok: false; error: string } {
  const checked = checkEmailMessage(emailMessage);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, input: { reportId, contactId, pdfBase64, message: checked.message } };
}
