// Server-side check that an invoice is internally consistent, run BEFORE the invoice is claimed and before any Xero call.
//
// An invoice belongs to ONE job (invoices.job_id), and the job resolves to one building and one client. The recipient is
// validated against that client, and the whole invoice is sent to that one recipient. A "combined" invoice has several
// line items, each linked to a visit. The Ready for accounts screen only lets a manager tick visits of the same job, but a
// checkbox is not a safeguard: nothing in the database stops a line pointing at a visit of ANOTHER job (the only
// constraints are the invoice -> job foreign key and "a visit can be on one line, ever"). So the function checks it itself:
//
//   - the invoice exists, and its job resolves to a building and a client;
//   - it has at least one line;
//   - EVERY line is linked to a visit that exists (a line with no visit cannot be checked, so it is refused);
//   - EVERY visit belongs to that exact job, and resolves to the same building and the same client.
//
// Anything else is refused with a plain explanation and nothing is sent. The checks are pure (validateInvoiceRelationships)
// so they can be tested directly; loadAndValidateInvoice adds the one read that feeds them.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type InvoiceRelationshipCode =
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_NO_LINES'
  | 'JOB_UNRESOLVED'
  | 'LINE_WITHOUT_VISIT'
  | 'VISIT_NOT_FOUND'
  | 'MIXED_JOBS'
  | 'RELATIONSHIP_INCONSISTENT';

export class InvoiceRelationshipError extends Error {
  readonly code: InvoiceRelationshipCode;
  readonly status: number;
  constructor(code: InvoiceRelationshipCode, message: string, status = 422) {
    super(message);
    this.name = 'InvoiceRelationshipError';
    this.code = code;
    this.status = status;
  }
}

type Maybe<T> = T | T[] | null | undefined;
interface BuildingRef {
  id: string | null;
  client_id: string | null;
}
interface JobRef {
  id: string | null;
  building_id: string | null;
  buildings: Maybe<BuildingRef>;
}
interface VisitRef {
  id: string | null;
  job_id: string | null;
  jobs: Maybe<JobRef>;
}
interface LineRef {
  id: string;
  visit_id: string | null;
  visits: Maybe<VisitRef>;
}
export interface InvoiceRelationshipRow {
  id: string;
  job_id: string | null;
  invoice_line_items: LineRef[] | null;
  jobs: Maybe<JobRef>;
}

export interface ValidatedInvoice {
  jobId: string;
  buildingId: string;
  clientId: string;
  visitIds: string[];
}

/** The exact columns the checks need. */
export const INVOICE_RELATIONSHIP_SELECT = `id, job_id,
  invoice_line_items ( id, visit_id, visits ( id, job_id, jobs ( id, building_id, buildings ( id, client_id ) ) ) ),
  jobs ( id, building_id, buildings ( id, client_id ) )`;

function one<T>(value: Maybe<T>): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** Pure. Throws InvoiceRelationshipError for anything missing, inconsistent or mixed; otherwise returns the one job, building and client every line resolves to. */
export function validateInvoiceRelationships(row: InvoiceRelationshipRow | null): ValidatedInvoice {
  if (!row) throw new InvoiceRelationshipError('INVOICE_NOT_FOUND', 'Invoice not found.', 404);

  const job = one(row.jobs);
  if (!row.job_id || !job || !job.id) {
    throw new InvoiceRelationshipError('JOB_UNRESOLVED', "This invoice's job could not be found, so its building and client cannot be checked. Nothing was sent.");
  }
  if (job.id !== row.job_id) {
    throw new InvoiceRelationshipError('RELATIONSHIP_INCONSISTENT', "This invoice's job record does not match the invoice. Nothing was sent.");
  }
  const building = one(job.buildings);
  if (!building || !building.id || !job.building_id || building.id !== job.building_id) {
    throw new InvoiceRelationshipError('JOB_UNRESOLVED', "This invoice's job has no building, so its client cannot be checked. Nothing was sent.");
  }
  if (!building.client_id) {
    throw new InvoiceRelationshipError('JOB_UNRESOLVED', "This invoice's building has no client, so the recipient cannot be checked. Nothing was sent.");
  }

  const lines = row.invoice_line_items ?? [];
  if (lines.length === 0) throw new InvoiceRelationshipError('INVOICE_NO_LINES', 'This invoice has no line items. Nothing was sent.');

  const visitIds: string[] = [];
  lines.forEach((line, index) => {
    const n = index + 1;
    if (!line.visit_id) {
      throw new InvoiceRelationshipError('LINE_WITHOUT_VISIT', `Line ${n} is not linked to a visit, so it cannot be checked against this invoice's job. Nothing was sent.`);
    }
    const visit = one(line.visits);
    if (!visit || !visit.id || visit.id !== line.visit_id) {
      throw new InvoiceRelationshipError('VISIT_NOT_FOUND', `Line ${n}'s visit could not be found. Nothing was sent.`);
    }
    if (visit.job_id !== job.id) {
      throw new InvoiceRelationshipError(
        'MIXED_JOBS',
        `Line ${n} is for a visit that belongs to a different job than this invoice. An invoice can only combine visits from the same job. Nothing was sent.`,
      );
    }
    const visitJob = one(visit.jobs);
    const visitBuilding = visitJob ? one(visitJob.buildings) : null;
    if (!visitJob || visitJob.id !== visit.job_id || !visitBuilding || visitBuilding.id !== building.id || visitBuilding.client_id !== building.client_id) {
      throw new InvoiceRelationshipError(
        'RELATIONSHIP_INCONSISTENT',
        `Line ${n}'s visit does not resolve to the same building and client as this invoice. Nothing was sent.`,
      );
    }
    visitIds.push(visit.id);
  });

  return { jobId: job.id, buildingId: building.id, clientId: building.client_id, visitIds };
}

/**
 * Reads the invoice, its lines and the job, building and client of each, and validates them. A failed READ is an error,
 * never a pass: if the data cannot be loaded, nothing is sent.
 */
export async function loadAndValidateInvoice(client: SupabaseClient, invoiceId: string): Promise<ValidatedInvoice> {
  const { data, error } = await client.from('invoices').select(INVOICE_RELATIONSHIP_SELECT).eq('id', invoiceId).maybeSingle();
  if (error) throw new Error(`Could not check the invoice before sending: ${error.message}`);
  return validateInvoiceRelationships(data as unknown as InvoiceRelationshipRow | null);
}
