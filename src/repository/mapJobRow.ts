// Maps a raw Supabase `jobs` row (with its embedded building/client/access/
// technician/visits data) onto the existing JobRow shape, applying every
// honest-fallback rule from the reviewed integration plans (CLAUDE.md
// section 14 and the "Jobs view reflects real operational state" plan).
// `technician`/`status`/`nextDueLabel` are now derived from real
// `jobs.default_technician_id`/`visits` data — see `deriveVisitState` below
// for the exact, deterministic cascade. Nothing here infers a date from
// `frequency_type`/`frequency_raw`,
// and nothing here treats a stale `booked` visit as `missed` — only the DB's
// own `visits.status = 'missed'` ever produces that status.

import type {
  Frequency,
  FrequencyType,
  JobRow,
  JobStatus,
  JobVisitSummary,
  LocalInvoiceStatus,
  ReportReviewStatus,
  Schedule,
  ScheduleIntervalUnit,
  ScheduleType,
  ScheduleWeekOrdinal,
  ScheduleWeekday,
  VisitStatus,
} from '../domain/types';
import { DEFAULT_ACCESS_NOTE } from '../lib/constants';
import { describeScheduleShort } from '../lib/scheduleFormat';

export const FREQUENCY_TYPE_LABEL: Record<FrequencyType, Frequency> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  biannual: 'Biannual',
  annual: 'Annual',
  ask_adhoc: 'Ask / ad-hoc',
  one_off: 'One-off',
};

/** Visits/year for the yearly-value computation — 0 means "never compute a total". */
const VISITS_PER_YEAR_BY_TYPE: Record<FrequencyType, number> = {
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
  quarterly: 4,
  biannual: 2,
  annual: 1,
  ask_adhoc: 0,
  one_off: 0,
};

export interface DerivedPricing {
  yearlyValue: number | null;
  monthlyValue: number | null;
}

/**
 * The one place price-per-month/price-per-year are derived from
 * price-per-visit + frequency — used by mapJobRow() below for real jobs, and
 * reused as-is by JobCreator/JobEditor for their live create/edit preview, so
 * there is never a second calculation to keep in sync. Both values are null
 * together whenever a meaningful recurring total can't be honestly computed
 * (variable pricing, no frequency set, ask/ad-hoc, or one-off) — never a
 * fabricated number. monthlyValue is simply yearlyValue / 12 (the same
 * visits-per-year model, just averaged over 12 months) rather than a second,
 * independently-tunable rate. See CLAUDE.md section 14.2.
 */
export function computeDerivedPricing(
  pricingType: 'fixed' | 'variable',
  frequencyType: FrequencyType | null,
  pricePerVisit: number | null,
): DerivedPricing {
  const canCompute =
    pricingType === 'fixed' &&
    frequencyType != null &&
    frequencyType !== 'ask_adhoc' &&
    frequencyType !== 'one_off' &&
    pricePerVisit != null;

  if (!canCompute) return { yearlyValue: null, monthlyValue: null };

  const yearlyValue = pricePerVisit! * VISITS_PER_YEAR_BY_TYPE[frequencyType!];
  return { yearlyValue, monthlyValue: yearlyValue / 12 };
}

interface SupabaseBuildingAccess {
  access_notes: string | null;
}

interface SupabaseClient {
  id: string;
  company_name: string;
}

interface SupabaseBuilding {
  id: string;
  client_id: string;
  address: string;
  invoice_details: string | null;
  name: string | null;
  postcode: string | null;
  clients: SupabaseClient | SupabaseClient[] | null;
  building_access: SupabaseBuildingAccess | SupabaseBuildingAccess[] | null;
}

interface SupabaseTechnician {
  id: string;
  name: string;
  is_active: boolean;
}

interface SupabaseSchedule {
  schedule_type: ScheduleType;
  interval_unit: ScheduleIntervalUnit | null;
  interval_count: number | null;
  weekday: ScheduleWeekday | null;
  week_ordinal: ScheduleWeekOrdinal | null;
  day_of_month: number | null;
  roll_forward_on_weekend: boolean;
  due_month: number | null;
  notes: string | null;
}

interface SupabaseReport {
  id: string;
  review_status: ReportReviewStatus;
  sent_to_client_at: string | null;
  sent_to_accounts_at: string | null;
}

interface SupabaseInvoice {
  status: LocalInvoiceStatus;
}

interface SupabaseInvoiceLineItem {
  invoice_id: string;
  invoices: SupabaseInvoice | SupabaseInvoice[] | null;
}

interface SupabaseVisit {
  id: string;
  technician_id: string | null;
  scheduled_date: string | null;
  status: VisitStatus;
  price_charged: number | null;
  completed_at: string | null;
  technicians: SupabaseTechnician | SupabaseTechnician[] | null;
  reports: SupabaseReport | SupabaseReport[] | null;
  invoice_line_items: SupabaseInvoiceLineItem | SupabaseInvoiceLineItem[] | null;
}

export interface SupabaseJobRecord {
  id: string;
  building_id: string;
  job_type: 'general' | 'specialist';
  job_summary: string | null;
  job_notes: string | null;
  frequency_raw: string | null;
  frequency_type: FrequencyType | null;
  pricing_type: 'fixed' | 'variable';
  price_per_visit: number | null;
  source_job_id: string | null;
  default_technician_id: string | null;
  buildings: SupabaseBuilding | SupabaseBuilding[] | null;
  technicians: SupabaseTechnician | SupabaseTechnician[] | null;
  schedules: SupabaseSchedule | SupabaseSchedule[] | null;
  visits: SupabaseVisit[] | null;
}

/** Supabase embeds can come back as a single object or a one-item array depending on how it infers relationship cardinality — normalize both shapes. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const DAY_NUM = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function formatFutureDate(iso: string, todayISO: string): string {
  if (iso === todayISO) return 'Today';
  const tomorrow = new Date(todayISO);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (iso === tomorrow.toISOString().slice(0, 10)) return 'Tomorrow';
  const d = new Date(iso);
  return `${DAY_LABEL.format(d)} ${DAY_NUM.format(d)}`;
}

function formatPastDate(iso: string): string {
  const d = new Date(iso);
  return DAY_NUM.format(d);
}

interface VisitState {
  status: JobStatus;
  nextDueLabel: string;
}

/**
 * The one deterministic cascade every job's status/next-due-label goes
 * through — see the reviewed plan for the full case-by-case rationale.
 * `cancelled` visits are never considered "current"; a stale `booked`/`due`
 * visit becomes 'overdue' (a calendar observation), never 'missed' (which
 * only ever comes from the DB's own visits.status). A visit whose linked
 * report is still `awaiting_review`/`returned_for_correction` takes priority
 * over everything else below — it's actionable today regardless of what's
 * scheduled next (see the "reports to review" plan).
 */
export function deriveVisitState(visits: SupabaseVisit[], todayISO: string): VisitState {
  const active = visits.filter((v) => v.status !== 'cancelled');

  const needsReview = active
    .filter((v) => {
      const report = one(v.reports);
      return report != null && (report.review_status === 'awaiting_review' || report.review_status === 'returned_for_correction');
    })
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '') || a.id.localeCompare(b.id));
  if (needsReview.length > 0) {
    const report = one(needsReview[0].reports);
    const label = report?.review_status === 'returned_for_correction' ? 'Report returned for correction' : 'Report awaiting review';
    return { status: 'review', nextDueLabel: label };
  }

  const dated = active.filter(
    (v): v is SupabaseVisit & { scheduled_date: string } =>
      v.scheduled_date != null && (v.status === 'due' || v.status === 'booked'),
  );

  const future = dated
    .filter((v) => v.scheduled_date >= todayISO)
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.id.localeCompare(b.id));
  if (future.length > 0) {
    return { status: 'booked', nextDueLabel: formatFutureDate(future[0].scheduled_date, todayISO) };
  }

  const undated = active.filter((v) => v.scheduled_date == null && (v.status === 'due' || v.status === 'booked'));
  if (undated.length > 0) {
    return { status: 'needs_booking', nextDueLabel: 'Due — no date set' };
  }

  const overdue = dated
    .filter((v) => v.scheduled_date < todayISO)
    .sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date) || a.id.localeCompare(b.id));
  if (overdue.length > 0) {
    return { status: 'overdue', nextDueLabel: `Overdue · ${formatPastDate(overdue[0].scheduled_date)}` };
  }

  const missed = active
    .filter((v) => v.status === 'missed')
    .sort((a, b) => (b.scheduled_date ?? '').localeCompare(a.scheduled_date ?? '') || a.id.localeCompare(b.id));
  if (missed.length > 0) {
    const date = missed[0].scheduled_date;
    return { status: 'missed', nextDueLabel: date ? `Missed · ${formatPastDate(date)}` : 'Missed' };
  }

  return { status: 'unscheduled', nextDueLabel: 'Not yet scheduled' };
}

export function mapJobRow(row: SupabaseJobRecord): JobRow {
  const building = one(row.buildings);
  const client = building ? one(building.clients) : null;
  const access = building ? one(building.building_access) : null;
  const defaultTechnician = one(row.technicians);

  const frequencyType = row.frequency_type;
  const frequency: Frequency = frequencyType ? FREQUENCY_TYPE_LABEL[frequencyType] : 'Unknown';
  const frequencyRaw = frequencyType ? FREQUENCY_TYPE_LABEL[frequencyType] : (row.frequency_raw ?? 'Unknown');

  const { yearlyValue, monthlyValue } = computeDerivedPricing(row.pricing_type, frequencyType, row.price_per_visit);

  const supabaseSchedule = one(row.schedules);
  const schedule: Schedule | null = supabaseSchedule
    ? {
        jobId: row.id,
        scheduleType: supabaseSchedule.schedule_type,
        intervalUnit: supabaseSchedule.interval_unit,
        intervalCount: supabaseSchedule.interval_count,
        weekday: supabaseSchedule.weekday,
        weekOrdinal: supabaseSchedule.week_ordinal,
        dayOfMonth: supabaseSchedule.day_of_month,
        rollForwardOnWeekend: supabaseSchedule.roll_forward_on_weekend,
        dueMonth: supabaseSchedule.due_month,
        notes: supabaseSchedule.notes,
      }
    : null;

  const buildingName = building?.name ?? building?.address.split(',')[0]?.trim() ?? '';

  const technician = !defaultTechnician
    ? 'Unassigned'
    : defaultTechnician.is_active
      ? defaultTechnician.name
      : `${defaultTechnician.name} (inactive)`;

  const todayISO = new Date().toISOString().slice(0, 10);
  const rawVisits = row.visits ?? [];
  const { status, nextDueLabel } = deriveVisitState(rawVisits, todayISO);

  const visits: JobVisitSummary[] = [...rawVisits]
    .sort((a, b) => (a.scheduled_date ?? '').localeCompare(b.scheduled_date ?? ''))
    .map((v) => {
      const report = one(v.reports);
      const invoiceLineItem = one(v.invoice_line_items);
      const invoice = invoiceLineItem ? one(invoiceLineItem.invoices) : null;
      return {
        id: v.id,
        scheduledDate: v.scheduled_date,
        status: v.status,
        technicianId: v.technician_id,
        technicianName: one(v.technicians)?.name ?? null,
        priceCharged: v.price_charged,
        completedAt: v.completed_at,
        reportId: report?.id ?? null,
        reportReviewStatus: report?.review_status ?? null,
        sentToClientAt: report?.sent_to_client_at ?? null,
        sentToAccountsAt: report?.sent_to_accounts_at ?? null,
        invoiceId: invoiceLineItem?.invoice_id ?? null,
        invoiceStatus: invoice?.status ?? null,
      };
    });

  return {
    id: row.id,
    buildingId: row.building_id,
    jobSummary: row.job_summary ?? row.job_notes ?? '—',
    jobNotes: row.job_notes,
    division: row.job_type === 'specialist' ? 'Specialist' : 'General',
    frequency,
    frequencyRaw,
    frequencyType,
    pricePerVisit: row.price_per_visit,
    yearlyValue,
    monthlyValue,
    nextDueLabel,
    status,
    technician,
    defaultTechnicianId: row.default_technician_id,
    schedulePattern: schedule ? describeScheduleShort(schedule) : frequencyRaw,
    schedule,
    visits,
    buildingName,
    street: '',
    postcode: building?.postcode ?? '',
    buildingInternalAccessNote: access?.access_notes ?? DEFAULT_ACCESS_NOTE,
    clientId: client?.id ?? '',
    clientName: client?.company_name ?? '',
    clientInvoiceAddress: building?.invoice_details ?? '',
  };
}
