// Emails a report's client-facing PDF summary to one of the client's own
// contacts — the send half of the "Ready for Client" workflow (Phase 2B).
// POST only, manager-gated (see ../_shared/auth.ts). Body:
// { reportId: string; contactId: string; pdfBase64: string }.
//
// The PDF itself is generated in the Manager's own browser (see
// src/lib/clientReportPdf.ts — the exact same function Phase 2A's preview
// page already uses) and arrives here as base64; this function never
// regenerates or re-selects report content. What it DOES independently
// verify, server-side, before ever calling the email provider: the report
// is actually approved, and the given contact genuinely belongs to this
// report's own client and has an email address — never trusts the
// request body for either of those, so a compromised or buggy client
// caller can't send an approved-looking report that isn't, or send to an
// arbitrary email address unrelated to the client.
//
// Records one row in report_client_sends per attempt (success or
// failure) — the real send-history table; only marks
// reports.sent_to_client_at/_by once the email provider confirms success.
// A failed attempt never touches sent_to_client_at, so the report stays
// visible in Ready for Client for the Manager to retry.
//
// Requires RESEND_API_KEY and RESEND_FROM_EMAIL as Supabase Edge Function
// secrets — see this repo's setup notes. Never logs or returns either.
//
// TEMPORARY DEMO/TEST MODE — remove once the real sending domain is
// verified in Resend (see this repo's setup notes for the exact removal
// steps). Controlled by a single secret, RESEND_TEST_RECIPIENT_EMAIL:
// when it's SET, every send in this function is forced to
// `from: onboarding@resend.dev` / `to: <that secret's value>` regardless
// of which real contact the Manager selected — the report/contact
// validation, approval check, and send-history recording all still run
// exactly as normal against the REAL selected contact (recipient_contact_id
// still records who the Manager actually chose), only the literal Resend
// API call's from/to are overridden. When the secret is UNSET, this
// function behaves exactly as originally built (RESEND_FROM_EMAIL, the
// real contact's email, no restrictions) — there is no separate mode flag
// to keep in sync, removing this one secret alone fully returns to
// production behavior.

import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { assertManager, UnauthorizedError } from '../_shared/auth.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

interface BuildingRow {
  id: string;
  name: string | null;
  client_id: string;
}

interface JobRow {
  id: string;
  job_summary: string | null;
  buildings: BuildingRow | BuildingRow[] | null;
}

interface VisitRow {
  id: string;
  jobs: JobRow | JobRow[] | null;
}

interface ReportRow {
  id: string;
  review_status: string;
  visits: VisitRow | VisitRow[] | null;
}

interface ContactRow {
  id: string;
  client_id: string;
  name: string;
  email: string | null;
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

  let reportId: string;
  let contactId: string;
  let pdfBase64: string;
  try {
    const body = await req.json();
    reportId = body.reportId;
    contactId = body.contactId;
    pdfBase64 = body.pdfBase64;
    if (!reportId || typeof reportId !== 'string') throw new Error('Missing reportId.');
    if (!contactId || typeof contactId !== 'string') throw new Error('Missing contactId.');
    if (!pdfBase64 || typeof pdfBase64 !== 'string') throw new Error('Missing pdfBase64.');
  } catch (err) {
    return json({ error: `Invalid request body: ${errorMessage(err)}` }, 400);
  }

  const {
    data: { user },
  } = await callerClient.auth.getUser();
  const actor = user?.email ?? 'unknown';

  /** Records a failed attempt (best-effort — a logging failure must not hide the real error) and returns the caller-facing response. */
  async function fail(message: string, recipientEmail: string | null): Promise<Response> {
    const { error } = await callerClient.from('report_client_sends').insert({
      report_id: reportId,
      recipient_contact_id: contactId,
      recipient_email: recipientEmail ?? 'unknown',
      sent_by: actor,
      status: 'failed',
      error_message: message,
    });
    if (error) console.error('Failed to record send failure:', error.message);
    return json({ status: 'failed', error: message }, 400);
  }

  try {
    const { data: reportData, error: reportError } = await callerClient
      .from('reports')
      .select(
        `id, review_status,
         visits ( id, jobs ( id, job_summary, buildings ( id, name, client_id ) ) )`,
      )
      .eq('id', reportId)
      .maybeSingle();

    if (reportError) throw new Error(reportError.message);
    if (!reportData) return await fail('This report no longer exists.', null);

    const report = reportData as unknown as ReportRow;
    if (report.review_status !== 'approved') {
      return await fail('This report is not approved — only approved reports can be sent to a client.', null);
    }

    const visit = one(report.visits);
    const job = visit ? one(visit.jobs) : null;
    const building = job ? one(job.buildings) : null;
    if (!building) return await fail('Could not resolve the building/client for this report.', null);

    const { data: contactData, error: contactError } = await callerClient
      .from('contacts')
      .select('id, client_id, name, email')
      .eq('id', contactId)
      .maybeSingle();

    if (contactError) throw new Error(contactError.message);
    const contact = contactData as ContactRow | null;

    if (!contact || contact.client_id !== building.client_id) {
      return await fail('The selected recipient does not belong to this report\'s client.', contact?.email ?? null);
    }
    if (!contact.email || !contact.email.trim()) {
      return await fail(`${contact.name} has no email address on file — add one before sending.`, null);
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const resendFromEmail = Deno.env.get('RESEND_FROM_EMAIL');
    // See this file's header comment — presence of this one secret alone
    // switches the function into demo/test mode.
    const testRecipientEmail = Deno.env.get('RESEND_TEST_RECIPIENT_EMAIL');
    const isTestMode = !!testRecipientEmail;

    if (!resendApiKey || (!isTestMode && !resendFromEmail)) {
      return await fail(
        'Email sending is not configured yet (RESEND_API_KEY/RESEND_FROM_EMAIL are missing from this project\'s Edge Function secrets).',
        contact.email,
      );
    }

    // In test mode, Resend's own onboarding@resend.dev sender can only
    // deliver to the Resend account's own verified email — never a real
    // client address. Overriding both from/to here is what makes that
    // safe: the Manager still exercises the full real workflow (contact
    // selection, validation, approval check), only the literal delivery
    // target changes.
    const effectiveFrom = isTestMode ? 'onboarding@resend.dev' : resendFromEmail!;
    const effectiveTo = isTestMode ? testRecipientEmail! : contact.email;

    // recipient_email records where the message actually went (the test
    // address, while in test mode) — recipient_contact_id still records
    // who the Manager actually selected, so history stays honest about
    // both "who was intended" and "where it really went" either way.
    const { data: sendRow, error: insertError } = await callerClient
      .from('report_client_sends')
      .insert({
        report_id: reportId,
        recipient_contact_id: contact.id,
        recipient_email: effectiveTo,
        sent_by: actor,
        status: 'sending',
      })
      .select('id')
      .single();

    if (insertError || !sendRow) throw new Error(insertError?.message ?? 'Failed to record send attempt.');

    const buildingName = building.name ?? 'your property';
    const baseSubject = job?.job_summary
      ? `Service report — ${buildingName} (${job.job_summary})`
      : `Service report — ${buildingName}`;
    const subject = isTestMode ? `[TEST] ${baseSubject}` : baseSubject;

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: effectiveFrom,
        to: effectiveTo,
        subject,
        html: `<p>Hello ${contact.name},</p><p>Please find attached the service report for ${buildingName}.</p><p>Kind regards,<br/>Kind Contractors</p>`,
        attachments: [{ filename: 'service-report.pdf', content: pdfBase64 }],
      }),
    });

    if (!emailResponse.ok) {
      const responseBody = await emailResponse.text();
      const message = `Email provider returned HTTP ${emailResponse.status}: ${responseBody}`;
      await callerClient.from('report_client_sends').update({ status: 'failed', error_message: message }).eq('id', sendRow.id);
      return json({ status: 'failed', error: message }, 502);
    }

    const now = new Date().toISOString();
    await callerClient.from('report_client_sends').update({ status: 'sent', updated_at: now }).eq('id', sendRow.id);
    await callerClient.from('reports').update({ sent_to_client_at: now, sent_to_client_by: actor }).eq('id', reportId);

    return json({ status: 'sent' }, 200);
  } catch (err) {
    const message = errorMessage(err);
    return await fail(message, null);
  }
});
