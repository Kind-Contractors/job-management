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
// secrets (RESEND_FROM_EMAIL e.g. "Kind Contractors <reports@mail.kindcontractors.co.uk>",
// on the now-verified mail.kindcontractors.co.uk domain). Never logs or
// returns either.
//
// The previous temporary demo/test mode (forcing every send through
// onboarding@resend.dev via a RESEND_TEST_RECIPIENT_EMAIL secret) has been
// removed now that the real sending domain is verified in Resend — this
// function sends to the real selected contact unconditionally. If that
// secret is still set in this project, it is simply ignored.

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
  scheduled_date: string | null;
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

/** "15 September 2026" — matches the app's own en-GB date formatting elsewhere; 'Not set' is honest rather than fabricating a date the visit doesn't have. */
function formatReportDate(scheduledDate: string | null): string {
  if (!scheduledDate) return 'date not set';
  return new Date(`${scheduledDate}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
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
         visits ( id, scheduled_date, jobs ( id, job_summary, buildings ( id, name, client_id ) ) )`,
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

    if (!resendApiKey || !resendFromEmail) {
      return await fail(
        'Email sending is not configured yet (RESEND_API_KEY/RESEND_FROM_EMAIL are missing from this project\'s Edge Function secrets).',
        contact.email,
      );
    }

    const { data: sendRow, error: insertError } = await callerClient
      .from('report_client_sends')
      .insert({
        report_id: reportId,
        recipient_contact_id: contact.id,
        recipient_email: contact.email,
        sent_by: actor,
        status: 'sending',
      })
      .select('id')
      .single();

    if (insertError || !sendRow) throw new Error(insertError?.message ?? 'Failed to record send attempt.');

    const buildingName = building.name ?? 'your property';
    const dateLabel = formatReportDate(visit?.scheduled_date ?? null);
    const subject = job?.job_summary
      ? `Service report — ${buildingName} (${job.job_summary}) — ${dateLabel}`
      : `Service report — ${buildingName} — ${dateLabel}`;

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: resendFromEmail,
        to: contact.email,
        subject,
        html: `<p>Hello ${contact.name},</p><p>Please find attached the service report for ${buildingName}, dated ${dateLabel}. This report is for your records.</p><p>Kind regards,<br/>Kind Contractors</p>`,
        attachments: [{ filename: 'service-report.pdf', content: pdfBase64 }],
      }),
    });

    if (!emailResponse.ok) {
      const responseBody = await emailResponse.text();
      const message = `Email provider returned HTTP ${emailResponse.status}: ${responseBody}`;
      await callerClient.from('report_client_sends').update({ status: 'failed', error_message: message }).eq('id', sendRow.id);
      return json({ status: 'failed', error: message }, 502);
    }

    // Resend's success body is `{ id: "<message id>" }` — best-effort parse;
    // a malformed/unexpected body here must never turn an already-sent
    // email into a reported failure.
    let resendMessageId: string | null = null;
    try {
      const responseJson = await emailResponse.json();
      resendMessageId = typeof responseJson?.id === 'string' ? responseJson.id : null;
    } catch {
      resendMessageId = null;
    }

    const now = new Date().toISOString();
    await callerClient
      .from('report_client_sends')
      .update({ status: 'sent', updated_at: now, resend_message_id: resendMessageId })
      .eq('id', sendRow.id);
    await callerClient.from('reports').update({ sent_to_client_at: now, sent_to_client_by: actor }).eq('id', reportId);

    // The one, canonical place 'report_sent_to_client' is ever logged — only
    // reached once the email provider has actually confirmed delivery (a
    // failed send returns from fail()/the !emailResponse.ok branch above
    // instead, well before this line). Best-effort: a logging failure must
    // never turn an already-successful send into an error response.
    const { error: activityError } = await callerClient.from('activity_events').insert({
      entity_type: 'report',
      entity_id: reportId,
      event_type: 'report_sent_to_client',
      actor,
      occurred_at: now,
    });
    if (activityError) console.error('Failed to log activity event "report_sent_to_client":', activityError.message);

    return json({ status: 'sent' }, 200);
  } catch (err) {
    const message = errorMessage(err);
    return await fail(message, null);
  }
});
