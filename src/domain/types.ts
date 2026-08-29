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
  | 'Ask / ad-hoc'
  | 'One-off'
  | 'Unknown';

/**
 * A job's current operational status, derived from its real `visits` rows
 * (see `mapJobRow.ts`'s `deriveVisitState` cascade) now that Teams+Visits
 * exist. 'not_due'/'review'/'onsite'/'ask' are mock-only — kept only because
 * `src/mock/jobsData.ts` still uses them for its own fictional data; the real
 * mapping path never produces them (no report/live-presence data exists).
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
  /** null when pricing is variable per visit — see CLAUDE.md section 14.2. */
  pricePerVisit: number | null;
  /**
   * Derived from price x frequency. null whenever it can't be honestly
   * computed (variable pricing, or frequency unknown) — never a fabricated
   * number. See CLAUDE.md section 14.2.
   */
  yearlyValue: number | null;
  /** Derived from real `visits` rows — see `mapJobRow.ts`'s `deriveVisitState`. */
  nextDueLabel: string;
  /** Derived from real `visits` rows — see `mapJobRow.ts`'s `deriveVisitState`. */
  status: JobStatus;
  /** The active team's name, `"Unassigned"`, or `"<name> (inactive)"` if the assigned team has since been deactivated. */
  team: string;
  /** `jobs.default_team_id` — drives the team-assignment editor and pre-fills the visit-booking form. */
  defaultTeamId: string | null;
  /** Human-readable recurrence, e.g. "Monthly · last Thu" — see CLAUDE.md section 6. */
  schedulePattern: string;
  /** Every real visit for this job, sorted soonest-first — for the drawer's "Visits" history list. Never fabricated; `[]` when none exist. */
  visits: JobVisitSummary[];
}

export type VisitStatus = 'due' | 'booked' | 'completed' | 'missed' | 'cancelled';

export type ReportReviewStatus = 'awaiting_review' | 'approved' | 'returned_for_correction';

export interface JobVisitSummary {
  id: string;
  scheduledDate: string | null;
  status: VisitStatus;
  teamName: string | null;
  /** Set once the visit is marked completed — see CLAUDE.md section 14.2/the visit-completion plan. */
  priceCharged: number | null;
  completedAt: string | null;
  /** Non-null only once a report has been created for this visit (reports.visit_id is UNIQUE). */
  reportId: string | null;
  reportReviewStatus: ReportReviewStatus | null;
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

/** A real `activity_events` row for a building's History tab — never fabricated (CLAUDE.md section 15). */
export interface BuildingHistoryEvent {
  id: string;
  eventType: string;
  detail: string | null;
  occurredAt: string;
  actor: string | null;
}

/**
 * A real `teams` row — for the This Week view (CLAUDE.md section 4/6: rows
 * are teams, not hours). The table has 0 rows in production today; this
 * shape is minimal on purpose since there's no real team yet to design a
 * richer shape (members, load bar) against.
 */
export interface Team {
  id: string;
  name: string;
  isActive: boolean;
  notes: string | null;
}

/**
 * A real `visits` row scoped to a week, for placing chips in This Week's
 * grid once teams/visits exist. Never derived from job frequency — only a
 * real scheduled_date means anything here (CLAUDE.md section 15).
 */
export interface WeekVisit {
  id: string;
  jobId: string;
  teamId: string | null;
  scheduledDate: string | null;
  status: VisitStatus;
}
