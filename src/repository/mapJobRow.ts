// Maps a raw Supabase `jobs` row (with its embedded building/client/access/
// team/visits data) onto the existing JobRow shape, applying every honest-
// fallback rule from the reviewed integration plans (CLAUDE.md section 14
// and the "Jobs view reflects real operational state" plan). `team`/
// `status`/`nextDueLabel` are now derived from real `jobs.default_team_id`/
// `visits` data — see `deriveVisitState` below for the exact, deterministic
// cascade. Nothing here infers a date from `frequency_type`/`frequency_raw`,
// and nothing here treats a stale `booked` visit as `missed` — only the DB's
// own `visits.status = 'missed'` ever produces that status.

import type { Frequency, JobRow, JobStatus, JobVisitSummary, ReportReviewStatus, VisitStatus } from '../domain/types';
import { DEFAULT_ACCESS_NOTE } from '../lib/constants';

type FrequencyType =
  | 'weekly'
  | 'fortnightly'
  | 'monthly'
  | 'quarterly'
  | 'biannual'
  | 'annual'
  | 'ask_adhoc'
  | 'one_off';

const FREQUENCY_TYPE_LABEL: Record<FrequencyType, Frequency> = {
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

interface SupabaseTeam {
  id: string;
  name: string;
  is_active: boolean;
}

interface SupabaseReport {
  id: string;
  review_status: ReportReviewStatus;
}

interface SupabaseVisit {
  id: string;
  team_id: string | null;
  scheduled_date: string | null;
  status: VisitStatus;
  price_charged: number | null;
  completed_at: string | null;
  teams: SupabaseTeam | SupabaseTeam[] | null;
  reports: SupabaseReport | SupabaseReport[] | null;
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
  default_team_id: string | null;
  buildings: SupabaseBuilding | SupabaseBuilding[] | null;
  teams: SupabaseTeam | SupabaseTeam[] | null;
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
 * only ever comes from the DB's own visits.status).
 */
export function deriveVisitState(visits: SupabaseVisit[], todayISO: string): VisitState {
  const active = visits.filter((v) => v.status !== 'cancelled');

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
  const defaultTeam = one(row.teams);

  const frequencyType = row.frequency_type;
  const frequency: Frequency = frequencyType ? FREQUENCY_TYPE_LABEL[frequencyType] : 'Unknown';
  const frequencyRaw = frequencyType ? FREQUENCY_TYPE_LABEL[frequencyType] : (row.frequency_raw ?? 'Unknown');

  const canComputeYearly = row.pricing_type === 'fixed' && frequencyType != null && row.price_per_visit != null;
  const yearlyValue = canComputeYearly
    ? row.price_per_visit! * VISITS_PER_YEAR_BY_TYPE[frequencyType!]
    : null;

  const buildingName = building?.name ?? building?.address.split(',')[0]?.trim() ?? '';

  const team = !defaultTeam ? 'Unassigned' : defaultTeam.is_active ? defaultTeam.name : `${defaultTeam.name} (inactive)`;

  const todayISO = new Date().toISOString().slice(0, 10);
  const rawVisits = row.visits ?? [];
  const { status, nextDueLabel } = deriveVisitState(rawVisits, todayISO);

  const visits: JobVisitSummary[] = [...rawVisits]
    .sort((a, b) => (a.scheduled_date ?? '').localeCompare(b.scheduled_date ?? ''))
    .map((v) => {
      const report = one(v.reports);
      return {
        id: v.id,
        scheduledDate: v.scheduled_date,
        status: v.status,
        teamName: one(v.teams)?.name ?? null,
        priceCharged: v.price_charged,
        completedAt: v.completed_at,
        reportId: report?.id ?? null,
        reportReviewStatus: report?.review_status ?? null,
      };
    });

  return {
    id: row.id,
    buildingId: row.building_id,
    jobSummary: row.job_summary ?? row.job_notes ?? '—',
    division: row.job_type === 'specialist' ? 'Specialist' : 'General',
    frequency,
    frequencyRaw,
    pricePerVisit: row.price_per_visit,
    yearlyValue,
    nextDueLabel,
    status,
    team,
    defaultTeamId: row.default_team_id,
    schedulePattern: frequencyRaw,
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
