// Records: the reports and invoices that have LEFT the attention queues, kept findable. Pure functions (no React, no network)
// so the rules are tested directly. Nothing is copied or stored: reports come from the same job rows the queues read, invoices
// from the invoices table as JMS recorded them.
import type { JobRow, LocalInvoiceStatus } from '../domain/types';
import { isReportAvailableForBuilding, type BuildingReportEntry } from './buildingReports';
import type { InvoiceRecord, InvoiceRecordLine } from '../repository/invoiceRecordsRepository';

// ---- job reports ------------------------------------------------------------------------------------------------------------------

/**
 * Every delivered report - emailed successfully through the system, or marked Completed - across all buildings, from any number
 * of job lists (active and historical are loaded separately). A report reached twice is listed once. Reports that are only
 * approved (still awaiting delivery) are never listed here: they are in Ready for client.
 */
export function deliveredReportRecords(...jobLists: JobRow[][]): BuildingReportEntry[] {
  const seenJobs = new Set<string>();
  const byReport = new Map<string, BuildingReportEntry>();
  for (const jobs of jobLists) {
    for (const job of jobs) {
      if (seenJobs.has(job.id)) continue;
      seenJobs.add(job.id);
      for (const visit of job.visits) {
        if (!visit.reportId || !isReportAvailableForBuilding(visit) || byReport.has(visit.reportId)) continue;
        byReport.set(visit.reportId, { reportId: visit.reportId, job, visit, sentToClientAt: visit.sentToClientAt ?? null, completedAt: visit.reportCompletedAt ?? null });
      }
    }
  }
  return [...byReport.values()].sort((a, b) => deliveredAt(b).localeCompare(deliveredAt(a)));
}

/** When the report was delivered: the later of its email and its completion. */
export function deliveredAt(entry: Pick<BuildingReportEntry, 'sentToClientAt' | 'completedAt'>): string {
  return [entry.sentToClientAt ?? '', entry.completedAt ?? ''].sort().pop() ?? '';
}

export type ReportRecordStatus = 'all' | 'emailed' | 'completed';

export interface ReportRecordFilters {
  search: string;
  status: ReportRecordStatus;
  /** yyyy-mm-dd, on the delivery date; '' = open-ended. */
  from: string;
  to: string;
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** Search (client, building, street, postcode, job), status (emailed / marked completed) and delivery-date range. */
export function filterReportRecords(entries: BuildingReportEntry[], f: ReportRecordFilters): BuildingReportEntry[] {
  const q = f.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (f.status === 'emailed' && !e.sentToClientAt) return false;
    if (f.status === 'completed' && !e.completedAt) return false;
    const day = deliveredAt(e).slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (!q) return true;
    return [e.job.clientName, e.job.buildingName, e.job.street, e.job.postcode, e.job.jobSummary].some((v) => norm(v).includes(q));
  });
}

// ---- invoices -------------------------------------------------------------------------------------------------------------------

/** The invoice's amount from its JMS lines, BEFORE VAT - not Xero's authoritative total. Rounded to the penny. */
export function exVatTotal(lines: Pick<InvoiceRecordLine, 'quantity' | 'unitAmount'>[]): number {
  return Math.round(lines.reduce((sum, l) => sum + l.quantity * l.unitAmount, 0) * 100) / 100;
}

export function formatMoney(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The status JMS recorded. "Sent" means created in Xero AND emailed by Xero; "In Xero · not emailed" was created only. */
export const INVOICE_STATUS_LABEL: Record<LocalInvoiceStatus, string> = {
  draft: 'Draft',
  sending: 'Sending',
  failed: 'Failed',
  sent: 'Sent (emailed)',
  in_xero_not_emailed: 'In Xero · not emailed',
};

/** A link that opens the invoice in Xero (for someone signed in to that Xero organisation), or null when there is no Xero id. */
export function xeroInvoiceUrl(xeroInvoiceId: string | null | undefined): string | null {
  if (!xeroInvoiceId || !/^[0-9a-fA-F-]{36}$/.test(xeroInvoiceId)) return null;
  return `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${xeroInvoiceId}`;
}

export type InvoiceRecordStatusFilter = 'all' | LocalInvoiceStatus;

export interface InvoiceRecordFilters {
  search: string;
  status: InvoiceRecordStatusFilter;
  /** yyyy-mm-dd, on the created date; '' = open-ended. */
  from: string;
  to: string;
}

/** Search (invoice number, client, building, street, postcode, job), JMS status and created-date range. */
export function filterInvoiceRecords(records: InvoiceRecord[], f: InvoiceRecordFilters): InvoiceRecord[] {
  const q = f.search.trim().toLowerCase();
  return records.filter((r) => {
    if (f.status !== 'all' && r.status !== f.status) return false;
    const day = (r.createdAt ?? '').slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (!q) return true;
    return [r.xeroInvoiceNumber, r.clientName, r.buildingName, r.buildingAddress, r.buildingPostcode, r.jobSummary].some((v) => norm(v).includes(q));
  });
}
