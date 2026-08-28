// Core domain model — see CLAUDE.md section 5.
// CLIENT (1) -> BUILDING (many) -> JOB (many) -> VISIT (many) -> REPORT (many)
// This pass only models Client/Building/Job; Visit/Report are not built yet.

export type Division = 'General' | 'Specialist';

export type Frequency =
  | 'Weekly'
  | 'Fortnightly'
  | 'Monthly'
  | 'Quarterly'
  | 'Biannual'
  | 'Annual'
  | 'Ask / ad-hoc';

/**
 * A job's current operational status. This stands in for real visit/report
 * state (no visits/reports schema exists yet) — see CLAUDE.md section 13.
 */
export type JobStatus =
  | 'booked'
  | 'needs_booking'
  | 'not_due'
  | 'review'
  | 'onsite'
  | 'missed'
  | 'ask';

export interface Client {
  id: string;
  companyName: string;
  invoiceAddress: string;
}

export interface Building {
  id: string;
  clientId: string;
  name: string;
  street: string;
  postcode: string;
  /**
   * A short, deliberately redacted-by-default access summary (key safe /
   * keyholder / parking) — never shown on a client-facing report. The full
   * building file (with photos/documents/history) is a later pass; this is
   * just enough for the job inspector drawer. See CLAUDE.md section 8.
   */
  internalAccessNote: string;
}

export interface Job {
  id: string;
  buildingId: string;
  jobSummary: string;
  division: Division;
  frequency: Frequency;
  pricePerVisit: number;
  /** Derived from price x frequency in real usage — stored directly on mock data for now. */
  yearlyValue: number;
  nextDueLabel: string;
  status: JobStatus;
  team: string;
  /** Human-readable recurrence, e.g. "Monthly · last Thu" — see CLAUDE.md section 6. */
  schedulePattern: string;
}

/** A job denormalized with its building/client for grid display. */
export interface JobRow extends Job {
  buildingName: string;
  street: string;
  postcode: string;
  buildingInternalAccessNote: string;
  clientId: string;
  clientName: string;
  clientInvoiceAddress: string;
}
