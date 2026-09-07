// Data-access layer for invoices. Drafting (create/edit/discard) is plain
// Supabase reads/writes, exactly like every other repository in this app —
// no Xero call happens until sendInvoice() explicitly invokes the
// xero-create-invoice Edge Function, which is the one place the Xero
// client secret is ever used (see that function's own file).
//
// Duplicate-invoicing protection is a real DB constraint
// (invoice_line_items.visit_id UNIQUE), not just an application check —
// see the migration file for the full rationale. This repository never
// tries to work around that constraint; a violation surfaces as a normal
// thrown Error, same as every other constraint violation in this app.

import type { InvoiceDetail, InvoiceLineItem, LocalInvoiceStatus } from '../domain/types';
import { supabase } from '../lib/supabaseClient';

const INVOICE_SELECT = `
  id, job_id, status, description, works_order_number, due_date,
  xero_invoice_id, xero_invoice_number, last_error, sent_at,
  invoice_line_items ( id, visit_id, description, quantity, unit_amount, sort_order )
`;

interface SupabaseInvoiceLineItemRow {
  id: string;
  visit_id: string | null;
  description: string;
  quantity: number;
  unit_amount: number;
  sort_order: number;
}

interface SupabaseInvoiceRow {
  id: string;
  job_id: string;
  status: LocalInvoiceStatus;
  description: string | null;
  works_order_number: string | null;
  due_date: string;
  xero_invoice_id: string | null;
  xero_invoice_number: string | null;
  last_error: string | null;
  sent_at: string | null;
  invoice_line_items: SupabaseInvoiceLineItemRow[] | null;
}

function mapInvoice(row: SupabaseInvoiceRow): InvoiceDetail {
  const lineItems: InvoiceLineItem[] = [...(row.invoice_line_items ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((li) => ({
      id: li.id,
      visitId: li.visit_id,
      description: li.description,
      quantity: li.quantity,
      unitAmount: li.unit_amount,
    }));

  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status,
    description: row.description,
    worksOrderNumber: row.works_order_number,
    dueDate: row.due_date,
    xeroInvoiceId: row.xero_invoice_id,
    xeroInvoiceNumber: row.xero_invoice_number,
    lastError: row.last_error,
    sentAt: row.sent_at,
    lineItems,
  };
}

export async function getInvoice(invoiceId: string): Promise<InvoiceDetail> {
  const { data, error } = await supabase.from('invoices').select(INVOICE_SELECT).eq('id', invoiceId).single();
  if (error) throw new Error(`Failed to load invoice: ${error.message}`);
  return mapInvoice(data as unknown as SupabaseInvoiceRow);
}

export interface DraftLineInput {
  visitId: string;
  description: string;
  quantity: number;
  unitAmount: number;
}

export interface CreateInvoiceDraftInput {
  jobId: string;
  createdBy: string;
  description: string | null;
  worksOrderNumber: string | null;
  lines: DraftLineInput[];
}

/**
 * Creates a draft invoice with its line items. The invoice row is inserted
 * first, then every line item in a single batch insert — one INSERT
 * statement is atomic, so a UNIQUE(visit_id) violation (a visit already
 * claimed by another invoice — should never happen if the UI only offers
 * unclaimed visits, but the DB is still the final authority) fails the
 * whole batch rather than partially linking some visits and not others.
 * If the line-item batch fails, the now-orphaned invoice row (zero lines)
 * is deleted rather than left behind for the manager to puzzle over.
 */
export async function createInvoiceDraft(input: CreateInvoiceDraftInput): Promise<string> {
  if (input.lines.length === 0) {
    throw new Error('An invoice needs at least one selected visit.');
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      job_id: input.jobId,
      created_by: input.createdBy,
      description: input.description,
      works_order_number: input.worksOrderNumber,
    })
    .select('id')
    .single();

  if (invoiceError) throw new Error(`Failed to create invoice: ${invoiceError.message}`);

  const { error: lineItemsError } = await supabase.from('invoice_line_items').insert(
    input.lines.map((line, index) => ({
      invoice_id: invoice.id,
      visit_id: line.visitId,
      description: line.description,
      quantity: line.quantity,
      unit_amount: line.unitAmount,
      sort_order: index,
    })),
  );

  if (lineItemsError) {
    await supabase.from('invoices').delete().eq('id', invoice.id);
    throw new Error(`Failed to add invoice line items: ${lineItemsError.message}`);
  }

  return invoice.id;
}

export interface UpdateInvoiceDraftInput {
  description?: string | null;
  worksOrderNumber?: string | null;
  /** YYYY-MM-DD. Sent to Xero as DueDate — always editable before send. */
  dueDate?: string;
}

/** Edits an invoice's own fields — no line-item changes here, see updateInvoiceLineItem. */
export async function updateInvoiceDraft(invoiceId: string, input: UpdateInvoiceDraftInput): Promise<void> {
  const patch: Record<string, unknown> = {};
  if ('description' in input) patch.description = input.description;
  if ('worksOrderNumber' in input) patch.works_order_number = input.worksOrderNumber;
  if ('dueDate' in input) patch.due_date = input.dueDate;

  const { error } = await supabase.from('invoices').update(patch).eq('id', invoiceId);
  if (error) throw new Error(`Failed to update invoice: ${error.message}`);
}

export interface UpdateLineItemInput {
  description?: string;
  quantity?: number;
  unitAmount?: number;
}

export async function updateInvoiceLineItem(lineItemId: string, input: UpdateLineItemInput): Promise<void> {
  const patch: Record<string, unknown> = {};
  if ('description' in input) patch.description = input.description;
  if ('quantity' in input) patch.quantity = input.quantity;
  if ('unitAmount' in input) patch.unit_amount = input.unitAmount;

  const { error } = await supabase.from('invoice_line_items').update(patch).eq('id', lineItemId);
  if (error) throw new Error(`Failed to update line item: ${error.message}`);
}

/** Deletes a draft/failed invoice entirely (cascades to its line items), freeing every visit it referenced. Never call this on a sent/sending invoice — the UI should not offer it. */
export async function discardInvoiceDraft(invoiceId: string): Promise<void> {
  const { error } = await supabase.from('invoices').delete().eq('id', invoiceId);
  if (error) throw new Error(`Failed to discard invoice: ${error.message}`);
}

export interface SendInvoiceResult {
  status: LocalInvoiceStatus;
  xeroInvoiceId?: string;
  xeroInvoiceNumber?: string;
  error?: string;
}

/**
 * The only place this app ever talks to Xero — via the xero-create-invoice
 * Edge Function, never directly from the browser. Creates the Xero
 * contact if needed, creates the invoice AUTHORISED, and emails it, all in
 * one manager action (per Luke's explicit requirement — never a separate
 * "now go find it in Xero and send it" step).
 */
export async function sendInvoice(invoiceId: string): Promise<SendInvoiceResult> {
  const { data, error } = await supabase.functions.invoke<SendInvoiceResult>('xero-create-invoice', {
    body: { invoiceId },
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('No response from xero-create-invoice.');
  return data;
}
