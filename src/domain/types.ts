// Core domain model — see CLAUDE.md section 5.
// CLIENT (1) -> BUILDING (many) -> JOB (many) -> VISIT (many) -> REPORT (many)
// This pass only models Client/Building/Job; Visit/Report are not built yet.

export type Division = 'General' | 'Specialist';

/** The real `jobs.frequency_type` enum — the bucket `frequency`/`frequencyRaw` are derived from. `null` means it was never confidently classified during migration (see CLAUDE.md section 14). */
export type FrequencyType =
  | 'weekly'
  | 'fortnightly'
  | 'monthly'
  | 'quarterly'
  | 'biannual'
  | 'annual'
  | 'ask_adhoc'
  | 'one_off';

export type Frequency =
  | 'Weekly'
  | 'Fortnightly'
  | 'Monthly'
  | 'Quarterly'
  | 'Biannual'
  | 'Annual'
  | 'Ask / ad-hoc'
  | 'One-off'
  | 'Unknown';

/**
 * A job's current operational status, derived from its real `visits` rows
 * (see `mapJobRow.ts`'s `deriveVisitState` cascade) now that Teams+Visits
 * exist. 'not_due'/'onsite'/'ask' are mock-only — kept only because
 * `src/mock/jobsData.ts` still uses them for its own fictional data; the real
 * mapping path never produces them (no live-presence/ad-hoc-tracking data
 * exists). 'review' IS produced by the real mapping path: any visit whose
 * linked report is `awaiting_review`/`returned_for_correction` puts the whole
 * job into 'review', taking priority over every other state — a report
 * sitting unreviewed is actionable today regardless of what's scheduled next.
 * 'unscheduled' means no visit rows exist at all for the job. 'overdue' is a
 * purely calendar-derived observation (a booked/due visit's date has passed
 * without being resolved) — never a claim that the visit was missed; only
 * the DB's own `visits.status = 'missed'` produces the 'missed' status.
 */
export type JobStatus =
  | 'booked'
  | 'needs_booking'
  | 'not_due'
  | 'review'
  | 'onsite'
  | 'missed'
  | 'ask'
  | 'unscheduled'
  | 'overdue';

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
  /** The real, raw `jobs.job_notes` column — unlike `jobSummary`, which falls back to this when `job_summary` is null, this is the actual distinct value an editor must read/write. */
  jobNotes: string | null;
  division: Division;
  /** Internal grouping/bucketing key — see `frequencyRaw` for the display text. */
  frequency: Frequency;
  /**
   * The literal, per-job frequency text — always populated, never collapsed
   * into the `frequency` bucket. This is what the UI actually displays (grid
   * column, drawer pill) so real specificity (e.g. "Six-Weekly") is never
   * lost. Equal to `frequency` for jobs whose frequency is a known bucket.
   */
  frequencyRaw: string;
  /** The real, raw `jobs.frequency_type` value (or null) — unlike `frequency`/`frequencyRaw`, which are display labels, this is what an editor must read/write to avoid guessing from formatted text. */
  frequencyType: FrequencyType | null;
  /** null when pricing is variable per visit — see CLAUDE.md section 14.2. */
  pricePerVisit: number | null;
  /**
   * Derived from price x frequency. null whenever it can't be honestly
   * computed (variable pricing, or frequency unknown) — never a fabricated
   * number. See CLAUDE.md section 14.2.
   */
  yearlyValue: number | null;
  /**
   * yearlyValue / 12 — averaged over 12 months rather than a second,
   * independently-tunable rate, so it can never drift from the yearly figure.
   * null exactly when yearlyValue is null (variable pricing, unknown
   * frequency, or ask/ad-hoc/one-off) — never a fabricated number. See
   * `computeDerivedPricing()` in mapJobRow.ts, the one place both figures are
   * derived.
   */
  monthlyValue: number | null;
  /** Derived from real `visits` rows — see `mapJobRow.ts`'s `deriveVisitState`. */
  nextDueLabel: string;
  /** Derived from real `visits` rows — see `mapJobRow.ts`'s `deriveVisitState`. */
  status: JobStatus;
  /** The default technician's name, `"Unassigned"`, or `"<name> (inactive)"` if the assigned technician has since been deactivated. */
  technician: string;
  /** `jobs.default_technician_id` — the job's usual/default technician. Independent of any individual visit's own assignee — drives the assignment editor and pre-fills the visit-booking form, but a visit can always be assigned a different technician. */
  defaultTechnicianId: string | null;
  /** Human-readable recurrence — a real, structured description when `schedule` exists, otherwise `frequencyRaw` (see CLAUDE.md section 6). */
  schedulePattern: string;
  /** The job's real, manager-entered recurrence definition — null for most jobs today. Never inferred from frequency_raw/frequency_type/staging data. */
  schedule: Schedule | null;
  /** Every real visit for this job, sorted soonest-first — for the drawer's "Visits" history list. Never fabricated; `[]` when none exist. */
  visits: JobVisitSummary[];
}

export type ScheduleType = 'fixed_weekday' | 'fixed_date' | 'due_month' | 'ad_hoc';
export type ScheduleIntervalUnit = 'week' | 'month' | 'quarter' | 'year';
export type ScheduleWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type ScheduleWeekOrdinal = '1st' | '2nd' | '3rd' | '4th' | 'last';

/**
 * A real `schedules` row — the job's genuine, manager-entered recurrence
 * definition (CLAUDE.md section 6). Never inferred from
 * frequency_raw/frequency_type/staging data — only ever written by a
 * manager through the schedule editor. At most one per job (`job_id` is the
 * table's primary key).
 */
export interface Schedule {
  jobId: string;
  scheduleType: ScheduleType;
  intervalUnit: ScheduleIntervalUnit | null;
  intervalCount: number | null;
  weekday: ScheduleWeekday | null;
  weekOrdinal: ScheduleWeekOrdinal | null;
  dayOfMonth: number | null;
  rollForwardOnWeekend: boolean;
  dueMonth: number | null;
  notes: string | null;
}

export type VisitStatus = 'due' | 'booked' | 'completed' | 'missed' | 'cancelled';

export type ReportReviewStatus = 'awaiting_review' | 'approved' | 'returned_for_correction';

/** Local invoice lifecycle state (`invoices.status`) — independent of any Xero-side status. */
export type LocalInvoiceStatus = 'draft' | 'sending' | 'sent' | 'failed';

export interface JobVisitSummary {
  id: string;
  scheduledDate: string | null;
  status: VisitStatus;
  /** `visits.technician_id` — the real id backing `technicianName`, needed to drive an assignment select. Independent of `job.defaultTechnicianId`: reassigning one visit never touches the job's default. */
  technicianId: string | null;
  technicianName: string | null;
  /** Set once the visit is marked completed — see CLAUDE.md section 14.2/the visit-completion plan. */
  priceCharged: number | null;
  completedAt: string | null;
  /** Non-null only once a report has been created for this visit (reports.visit_id is UNIQUE). */
  reportId: string | null;
  reportReviewStatus: ReportReviewStatus | null;
  /** Mirrors the linked report's send timestamps — null until that report is actually sent. */
  sentToClientAt: string | null;
  sentToAccountsAt: string | null;
  /**
   * Non-null once this visit is linked to an invoice line item
   * (invoice_line_items.visit_id is UNIQUE — at most one). This is the
   * actual duplicate-invoicing guard: a visit with a non-null invoiceId
   * must never be offered for selection into another invoice.
   */
  invoiceId: string | null;
  invoiceStatus: LocalInvoiceStatus | null;
}

/**
 * The full `reports` row, fetched on demand (not embedded in listJobRows(),
 * to avoid pulling every report's text body into the main jobs list) once a
 * manager expands a visit's report in the Job Inspector. Manager-only
 * workflow this pass — submitted_by/reviewed_by/sent_to_*_by are always the
 * signed-in manager's real email, never a fabricated technician identity.
 */
export interface ReportDetail {
  id: string;
  visitId: string;
  submittedBy: string;
  submittedAt: string;
  onSiteStart: string | null;
  onSiteEnd: string | null;
  workCarriedOut: string | null;
  technicianNotes: string | null;
  issues: string | null;
  /** true = specification completed (the normal/default state); false = the technician selected "Something not done" — must be visible to the Manager during review. Never a gate on approve/return/send. */
  specMet: boolean;
  reviewStatus: ReportReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  returnReason: string | null;
  includePhotos: boolean;
  includeNotes: boolean;
  includeIssues: boolean;
  includePrice: boolean;
  sentToClientAt: string | null;
  sentToClientBy: string | null;
  sentToAccountsAt: string | null;
  sentToAccountsBy: string | null;
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

/**
 * building_access's structured fields, surfaced individually (unlike
 * JobRow's single collapsed `buildingInternalAccessNote` string) — the
 * Building File is this field's proper home. `null` overall means no
 * building_access row exists for this building at all (325/342 today), which
 * is distinct from a row existing with individually-empty fields.
 */
export interface BuildingAccessInfo {
  keySafeCode: string | null;
  keyholderName: string | null;
  keyholderPhone: string | null;
  parkingNotes: string | null;
  accessNotes: string | null;
}

/** A building denormalized with its client, for the Buildings list and Building File. */
export interface BuildingRow {
  id: string;
  clientId: string;
  clientName: string;
  address: string;
  /** The real, raw `buildings.name` column — null when never set. Unlike `buildingName`, never falls back to the address; an editor must read/write this, not the fallback-applied display value. */
  name: string | null;
  /** Falls back to `address`'s first segment — `buildings.name` is 0% populated today. */
  buildingName: string;
  /** '' — `buildings.postcode` is 0% populated today. */
  postcode: string;
  /** '' when null. */
  invoiceDetails: string;
  /** From `buildings.extra_requirements` — '' when null (0% populated today). */
  siteInstructions: string;
  access: BuildingAccessInfo | null;
}

/**
 * A real `contacts` row — a named person at a client. Never fabricate a
 * primary/accounts flag; render exactly what is_primary/is_accounts_contact
 * say, including when both are false for every contact (the common case
 * today — no contact has ever been marked primary or accounts in the data).
 */
export interface Contact {
  id: string;
  clientId: string;
  name: string;
  role: string | null;
  email: string | null;
  phoneNumber: string | null;
  isPrimary: boolean;
  isAccountsContact: boolean;
  notes: string | null;
}

/** A real `activity_events` row for a building's History tab — never fabricated (CLAUDE.md section 15). */
export interface BuildingHistoryEvent {
  id: string;
  eventType: string;
  detail: string | null;
  occurredAt: string;
  actor: string | null;
}

/**
 * A real `technicians` row — one individual person, for the This Week view
 * (CLAUDE.md section 4/6: rows are teams, not hours — read today as
 * "technicians", per Luke's own explicit correction that he does not use a
 * team/group concept; see reference/Luke_manager_app_version_1.txt).
 * Assignment (job default and per-visit) is always to one such row, and is
 * always optional — a job or visit can be left unassigned. Renamed from
 * `teams`; this shape is unchanged (id/name/isActive/notes).
 */
export interface Technician {
  id: string;
  name: string;
  isActive: boolean;
  notes: string | null;
  /** `technicians.app_user_id` — non-null only when this technician is linked to a real login (created via the Users screen, or linked manually). See ThisWeekPage.tsx's technician-active toggle for why this matters: activating/deactivating a LINKED technician must go through the Users screen's admin-users Edge Function (the only path that can also touch that login's own app_users.is_active — a manager's client-side session has no write access to another user's app_users row at all), never the plain technicians-table update alone. */
  appUserId: string | null;
}

/**
 * A real `visits` row scoped to a week, for placing chips in This Week's
 * grid once technicians/visits exist. Never derived from job frequency —
 * only a real scheduled_date means anything here (CLAUDE.md section 15).
 */
export interface WeekVisit {
  id: string;
  jobId: string;
  technicianId: string | null;
  scheduledDate: string | null;
  status: VisitStatus;
}

/** One line of an invoice — either backed by a real visit, or a manually-added line (visitId null). */
export interface InvoiceLineItem {
  id: string;
  visitId: string | null;
  description: string;
  quantity: number;
  unitAmount: number;
}

/**
 * A real `invoices` row plus its line items — the draft-through-sent
 * lifecycle for one Xero invoice. `status` is this app's own local
 * lifecycle state, independent of anything Xero-side.
 */
export interface InvoiceDetail {
  id: string;
  jobId: string;
  status: LocalInvoiceStatus;
  /** Sent to Xero as the invoice DueDate — required by Xero, defaults to 30 days from creation, always editable before send. */
  dueDate: string;
  description: string | null;
  worksOrderNumber: string | null;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  lastError: string | null;
  sentAt: string | null;
  lineItems: InvoiceLineItem[];
}
