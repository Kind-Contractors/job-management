// Read-only access to invoices as they are recorded in JMS, for Records and the Building File's Invoices panel.
//
// Nothing here writes, and nothing calls Xero: the status shown is the one JMS recorded when it created / emailed the invoice
// (draft, sending, failed, sent, in Xero not emailed). Paid, voided or credited states live only in Xero.
//
// An invoice belongs to exactly ONE job (invoices.job_id) - the server refuses invoices that mix jobs, buildings or clients - so
// invoices.job_id -> jobs.building_id is the reliable way to find a building's invoices. Read access is the existing manager
// row-level-security policy on invoices / invoice_line_items / jobs / buildings / clients.
import { supabase } from '../lib/supabaseClient';
import type { LocalInvoiceStatus } from '../domain/types';

export interface InvoiceRecordLine {
  id: string;
  description: string;
  quantity: number;
  unitAmount: number;
  visitId: string | null;
  visitDate: string | null;
}

export interface InvoiceRecord {
  id: string;
  status: LocalInvoiceStatus;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  notEmailedReason: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  dueDate: string | null;
  description: string | null;
  worksOrderNumber: string | null;
  jobId: string;
  jobSummary: string;
  jobLifecycleStatus: string | null;
  buildingId: string | null;
  buildingName: string;
  buildingAddress: string;
  buildingPostcode: string;
  clientName: string;
  lines: InvoiceRecordLine[];
}

const INVOICE_SELECT = `
  id, status, description, works_order_number, due_date, sent_at, created_at, last_error,
  xero_invoice_id, xero_invoice_number, xero_recipient_name, xero_recipient_email, not_emailed_reason,
  invoice_line_items ( id, description, quantity, unit_amount, sort_order, visit_id, visits ( scheduled_date ) ),
  jobs!inner ( id, job_summary, lifecycle_status, building_id, buildings ( id, name, address, postcode, clients ( company_name ) ) )
`;

type Row = Record<string, unknown>;
const one = <T,>(v: unknown): T | null => (Array.isArray(v) ? ((v[0] as T) ?? null) : ((v as T) ?? null));

export function mapInvoiceRecord(r: Row): InvoiceRecord {
  const job = one<Row>(r.jobs) ?? {};
  const building = one<Row>(job.buildings);
  const client = building ? one<Row>(building.clients) : null;
  const lines = ((r.invoice_line_items ?? []) as Row[])
    .slice()
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
    .map((l) => ({
      id: l.id as string,
      description: (l.description as string) ?? '',
      quantity: Number(l.quantity ?? 0),
      unitAmount: Number(l.unit_amount ?? 0),
      visitId: (l.visit_id as string | null) ?? null,
      visitDate: (one<Row>(l.visits)?.scheduled_date as string | null) ?? null,
    }));
  return {
    id: r.id as string,
    status: r.status as LocalInvoiceStatus,
    xeroInvoiceId: (r.xero_invoice_id as string | null) ?? null,
    xeroInvoiceNumber: (r.xero_invoice_number as string | null) ?? null,
    recipientName: (r.xero_recipient_name as string | null) ?? null,
    recipientEmail: (r.xero_recipient_email as string | null) ?? null,
    notEmailedReason: (r.not_emailed_reason as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: r.created_at as string,
    sentAt: (r.sent_at as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    worksOrderNumber: (r.works_order_number as string | null) ?? null,
    jobId: (job.id as string) ?? '',
    jobSummary: (job.job_summary as string | null) ?? '—',
    jobLifecycleStatus: (job.lifecycle_status as string | null) ?? null,
    buildingId: (building?.id as string | null) ?? null,
    buildingName: (building?.name as string | null) ?? '—',
    buildingAddress: (building?.address as string | null) ?? '',
    buildingPostcode: (building?.postcode as string | null) ?? '',
    clientName: (client?.company_name as string | null) ?? '—',
    lines,
  };
}

/** Every invoice recorded in JMS, any status, for jobs of any lifecycle - newest first. */
export async function listInvoiceRecords(): Promise<InvoiceRecord[]> {
  const { data, error } = await supabase.from('invoices').select(INVOICE_SELECT).order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load invoices: ${error.message}`);
  return ((data ?? []) as unknown as Row[]).map(mapInvoiceRecord);
}

/** The invoices of the jobs at one building (active, completed, lost or cancelled) - newest first. */
export async function listBuildingInvoiceRecords(buildingId: string): Promise<InvoiceRecord[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('jobs.building_id', buildingId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load this building's invoices: ${error.message}`);
  // The building is checked again here, so an invoice of another building can never be listed even if the filter were ignored.
  return ((data ?? []) as unknown as Row[]).map(mapInvoiceRecord).filter((i) => i.buildingId === buildingId);
}
