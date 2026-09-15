// Data-access layer for buildings — mirrors jobsRepository.ts's structure.
// Job counts / per-year totals are deliberately NOT recomputed here; the
// Buildings pages combine this with the app's existing listJobRows() result
// (grouped client-side by buildingId), so the yearly-value honesty rules
// (mapJobRow.ts) are computed in exactly one place. See the reviewed plan.

import type { BuildingHistoryEvent, BuildingRow } from '../domain/types';
import { supabase } from '../lib/supabaseClient';
import { mapBuildingRow, type SupabaseBuildingRecord } from './mapBuildingRow';
import { logCurrentUserActivity } from './activityEventsRepository';
import { listPhotosForReports, type ReportPhotoWithReport } from './reportsRepository';

const BUILDING_SELECT = `
  id,
  client_id,
  address,
  invoice_details,
  extra_requirements,
  name,
  postcode,
  clients ( id, company_name ),
  building_access ( key_safe_code, keyholder_name, keyholder_phone, parking_notes, access_notes )
`;

export async function listBuildingRows(): Promise<BuildingRow[]> {
  const { data, error } = await supabase.from('buildings').select(BUILDING_SELECT);

  if (error) {
    throw new Error(`Failed to load buildings: ${error.message}`);
  }

  return ((data ?? []) as unknown as SupabaseBuildingRecord[]).map(mapBuildingRow);
}

export interface BuildingCreateFields {
  address: string;
  name: string | null;
  postcode: string | null;
  invoiceDetails: string | null;
  siteInstructions: string | null;
}

/**
 * Creates a building for an already-existing client — a plain single-table
 * insert, no atomicity requirement (see createClientAndBuilding() for the
 * new-client case, which genuinely needs one). `building_access`/`who` are
 * never set here — access details are a separate table with no creation UI
 * yet, and `who` is a legacy column nothing in this app reads.
 */
export async function createBuilding(clientId: string, input: BuildingCreateFields): Promise<string> {
  const { data, error } = await supabase
    .from('buildings')
    .insert({
      client_id: clientId,
      address: input.address,
      name: input.name,
      postcode: input.postcode,
      invoice_details: input.invoiceDetails,
      extra_requirements: input.siteInstructions,
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to create building: ${error.message}`);
  }

  await logCurrentUserActivity('building', data.id, 'building_created');
  return data.id;
}

export interface BuildingEditFields {
  name: string | null;
  address: string;
  postcode: string | null;
  invoiceDetails: string | null;
  siteInstructions: string | null;
}

/**
 * Edits a building's own general details — never client_id (no reassignment
 * workflow exists, and none is being added here) and never building_access
 * (a separate table/function below, kept behind its own reveal-gated UI).
 * Plain update by id, same manager_full_access RLS as createBuilding().
 */
export async function updateBuilding(buildingId: string, fields: BuildingEditFields): Promise<void> {
  const { data: before } = await supabase
    .from('buildings')
    .select('name, address, postcode, invoice_details, extra_requirements')
    .eq('id', buildingId)
    .maybeSingle();

  const { error } = await supabase
    .from('buildings')
    .update({
      name: fields.name,
      address: fields.address,
      postcode: fields.postcode,
      invoice_details: fields.invoiceDetails,
      extra_requirements: fields.siteInstructions,
    })
    .eq('id', buildingId);

  if (error) {
    throw new Error(`Failed to update building: ${error.message}`);
  }

  if (!before) return;

  // Site instructions get their own event type (a distinct bullet in the
  // requirements) — everything else here is a general "details updated"
  // event naming only which fields changed, never their values.
  const changedFields: string[] = [];
  if (before.name !== fields.name) changedFields.push('name');
  if (before.address !== fields.address) changedFields.push('address');
  if (before.postcode !== fields.postcode) changedFields.push('postcode');
  if (before.invoice_details !== fields.invoiceDetails) changedFields.push('invoice details');
  if (changedFields.length > 0) {
    await logCurrentUserActivity('building', buildingId, 'building_details_updated', `Updated: ${changedFields.join(', ')}`);
  }
  if (before.extra_requirements !== fields.siteInstructions) {
    await logCurrentUserActivity('building', buildingId, 'site_instructions_updated');
  }
}

export interface BuildingAccessEditFields {
  keySafeCode: string | null;
  keyholderName: string | null;
  keyholderPhone: string | null;
  parkingNotes: string | null;
  accessNotes: string | null;
}

/**
 * Upserts building_access, keyed on building_id (its primary key) — most
 * buildings (~325/342) have no row here yet, so a plain UPDATE would
 * silently touch zero rows the first time a manager records access details
 * for one. Internal-only data: never read by anything client-facing, and
 * this function is only ever called from the Building File's already
 * reveal-gated access panel. updated_by is deliberately left unset this
 * pass (not required yet).
 */
export async function upsertBuildingAccess(buildingId: string, fields: BuildingAccessEditFields): Promise<void> {
  const { data: before } = await supabase
    .from('building_access')
    .select('key_safe_code, keyholder_name, keyholder_phone, parking_notes, access_notes')
    .eq('building_id', buildingId)
    .maybeSingle();

  const { error } = await supabase.from('building_access').upsert(
    {
      building_id: buildingId,
      key_safe_code: fields.keySafeCode,
      keyholder_name: fields.keyholderName,
      keyholder_phone: fields.keyholderPhone,
      parking_notes: fields.parkingNotes,
      access_notes: fields.accessNotes,
    },
    { onConflict: 'building_id' },
  );

  if (error) {
    throw new Error(`Failed to update access details: ${error.message}`);
  }

  // Names ONLY which category changed — never the actual key safe code,
  // keyholder phone, parking notes, or access notes text. `before` is null
  // the first time a building gets access details at all; every provided
  // field then correctly counts as "changed" against that absent baseline.
  const changedGroups: string[] = [];
  if ((before?.key_safe_code ?? null) !== fields.keySafeCode) changedGroups.push('Key safe information');
  if ((before?.keyholder_name ?? null) !== fields.keyholderName || (before?.keyholder_phone ?? null) !== fields.keyholderPhone) {
    changedGroups.push('Keyholder information');
  }
  if ((before?.parking_notes ?? null) !== fields.parkingNotes) changedGroups.push('Parking information');
  if ((before?.access_notes ?? null) !== fields.accessNotes) changedGroups.push('Access notes');

  if (changedGroups.length > 0) {
    await logCurrentUserActivity('building', buildingId, 'access_info_updated', `Updated: ${changedGroups.join(', ')}`);
  }
}

export interface NewClientBuildingInput extends BuildingCreateFields {
  companyName: string;
}

/**
 * Creates a brand-new client and its first building together, atomically —
 * via the create_client_and_building() Postgres function (SECURITY INVOKER,
 * so it's bound by the exact same manager_full_access RLS check the two
 * inserts would face individually; no new privilege surface). Atomic by
 * Postgres's own function-call transaction semantics: if the building insert
 * fails, the client insert inside the same call is rolled back too — an
 * orphan client cannot result from a failed building insert.
 */
export async function createClientAndBuilding(input: NewClientBuildingInput): Promise<{ clientId: string; buildingId: string }> {
  const { data, error } = await supabase
    .rpc('create_client_and_building', {
      p_company_name: input.companyName,
      p_address: input.address,
      p_name: input.name,
      p_postcode: input.postcode,
      p_invoice_details: input.invoiceDetails,
      p_extra_requirements: input.siteInstructions,
    })
    .single();

  if (error) {
    throw new Error(`Failed to create client and building: ${error.message}`);
  }

  const row = data as unknown as { client_id: string; building_id: string };
  await logCurrentUserActivity('building', row.building_id, 'building_created');
  return { clientId: row.client_id, buildingId: row.building_id };
}

/**
 * Real activity_events for a building's History tab. The table is empty for
 * every building today — this returns [] rather than any fabricated event
 * (CLAUDE.md section 15).
 */
interface RawActivityEvent {
  id: string;
  entity_id: string;
  event_type: string;
  detail: string | null;
  occurred_at: string;
  actor: string | null;
}

const ACTIVITY_EVENT_SELECT = 'id, entity_id, event_type, detail, occurred_at, actor';

function toHistoryEvent(row: RawActivityEvent, jobSummary: string | null): BuildingHistoryEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    detail: row.detail,
    occurredAt: row.occurred_at,
    actor: row.actor,
    jobSummary,
  };
}

/**
 * `entity_id` is deliberately not a real foreign key (activity_events is
 * polymorphic across building/job/visit/report — see its own migration
 * comment), so a building's full timeline can't be a single join. Instead:
 * walk building -> its jobs -> their visits -> their reports to collect
 * every relevant id, then fetch each entity_type's own events by id. This
 * also lets every job/visit/report event carry the CURRENT job name at
 * display time (never stored in the event itself — see req. 6), by
 * resolving it here from the same id maps already built for the id lookup.
 */
export async function listBuildingHistory(buildingId: string): Promise<BuildingHistoryEvent[]> {
  const { data: jobs, error: jobsError } = await supabase.from('jobs').select('id, job_summary').eq('building_id', buildingId);
  if (jobsError) throw new Error(`Failed to load building history: ${jobsError.message}`);

  const jobIds = (jobs ?? []).map((j) => j.id);
  const jobSummaryByJobId = new Map((jobs ?? []).map((j) => [j.id, j.job_summary as string | null]));

  const { data: visits, error: visitsError } =
    jobIds.length > 0
      ? await supabase.from('visits').select('id, job_id').in('job_id', jobIds)
      : { data: [] as { id: string; job_id: string }[], error: null };
  if (visitsError) throw new Error(`Failed to load building history: ${visitsError.message}`);

  const visitIds = (visits ?? []).map((v) => v.id);
  const jobIdByVisitId = new Map((visits ?? []).map((v) => [v.id, v.job_id]));

  const { data: reports, error: reportsError } =
    visitIds.length > 0
      ? await supabase.from('reports').select('id, visit_id').in('visit_id', visitIds)
      : { data: [] as { id: string; visit_id: string }[], error: null };
  if (reportsError) throw new Error(`Failed to load building history: ${reportsError.message}`);

  const reportIds = (reports ?? []).map((r) => r.id);
  const visitIdByReportId = new Map((reports ?? []).map((r) => [r.id, r.visit_id]));

  const jobSummaryForVisitId = (visitId: string): string | null => {
    const jobId = jobIdByVisitId.get(visitId);
    return jobId ? (jobSummaryByJobId.get(jobId) ?? null) : null;
  };
  const jobSummaryForReportId = (reportId: string): string | null => {
    const visitId = visitIdByReportId.get(reportId);
    return visitId ? jobSummaryForVisitId(visitId) : null;
  };

  const [buildingEvents, jobEvents, visitEvents, reportEvents] = await Promise.all([
    supabase.from('activity_events').select(ACTIVITY_EVENT_SELECT).eq('entity_type', 'building').eq('entity_id', buildingId),
    jobIds.length > 0
      ? supabase.from('activity_events').select(ACTIVITY_EVENT_SELECT).eq('entity_type', 'job').in('entity_id', jobIds)
      : Promise.resolve({ data: [] as RawActivityEvent[], error: null }),
    visitIds.length > 0
      ? supabase.from('activity_events').select(ACTIVITY_EVENT_SELECT).eq('entity_type', 'visit').in('entity_id', visitIds)
      : Promise.resolve({ data: [] as RawActivityEvent[], error: null }),
    reportIds.length > 0
      ? supabase.from('activity_events').select(ACTIVITY_EVENT_SELECT).eq('entity_type', 'report').in('entity_id', reportIds)
      : Promise.resolve({ data: [] as RawActivityEvent[], error: null }),
  ]);

  for (const result of [buildingEvents, jobEvents, visitEvents, reportEvents]) {
    if (result.error) throw new Error(`Failed to load building history: ${result.error.message}`);
  }

  const events: BuildingHistoryEvent[] = [
    ...(buildingEvents.data ?? []).map((row) => toHistoryEvent(row as RawActivityEvent, null)),
    ...(jobEvents.data ?? []).map((row) => {
      const r = row as RawActivityEvent;
      return toHistoryEvent(r, jobSummaryByJobId.get(r.entity_id) ?? null);
    }),
    ...(visitEvents.data ?? []).map((row) => {
      const r = row as RawActivityEvent;
      return toHistoryEvent(r, jobSummaryForVisitId(r.entity_id));
    }),
    ...(reportEvents.data ?? []).map((row) => {
      const r = row as RawActivityEvent;
      return toHistoryEvent(r, jobSummaryForReportId(r.entity_id));
    }),
  ];

  return events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/** One report's worth of work photos, for Building History's "Work Photos" section — a report is always exactly one visit, so this is also "one visit's photos." Bare metadata only; signing is the caller's own job (see BuildingFilePage.tsx), matching how ReportPanel.tsx/ReadyForClientPage.tsx already separate "what photos exist" from "get their URLs". */
export interface BuildingPhotoGroup {
  jobId: string;
  jobSummary: string;
  visitId: string;
  scheduledDate: string | null;
  reportId: string;
  photos: ReportPhotoWithReport[];
}

/**
 * Standalone resolution of the same photos.report_id -> reports.visit_id ->
 * visits.job_id -> jobs.building_id chain listBuildingHistory() above also
 * walks — deliberately not sharing that function's internals, so neither
 * can be affected by a change to the other. Groups by report (one visit's
 * worth of photos) rather than flattening, so the caller can show job name
 * + visit date per group and never has to re-derive which photos belong
 * together.
 */
export async function listBuildingPhotos(buildingId: string): Promise<BuildingPhotoGroup[]> {
  const { data: jobs, error: jobsError } = await supabase.from('jobs').select('id, job_summary').eq('building_id', buildingId);
  if (jobsError) throw new Error(`Failed to load building photos: ${jobsError.message}`);
  const jobIds = (jobs ?? []).map((j) => j.id);
  if (jobIds.length === 0) return [];
  const jobSummaryByJobId = new Map((jobs ?? []).map((j) => [j.id, j.job_summary as string]));

  const { data: visits, error: visitsError } = await supabase
    .from('visits')
    .select('id, job_id, scheduled_date')
    .in('job_id', jobIds);
  if (visitsError) throw new Error(`Failed to load building photos: ${visitsError.message}`);
  const visitIds = (visits ?? []).map((v) => v.id);
  if (visitIds.length === 0) return [];
  const visitById = new Map((visits ?? []).map((v) => [v.id, v]));

  const { data: reports, error: reportsError } = await supabase.from('reports').select('id, visit_id').in('visit_id', visitIds);
  if (reportsError) throw new Error(`Failed to load building photos: ${reportsError.message}`);
  const reportIds = (reports ?? []).map((r) => r.id);
  if (reportIds.length === 0) return [];
  const visitIdByReportId = new Map((reports ?? []).map((r) => [r.id, r.visit_id]));

  const photos = await listPhotosForReports(reportIds);
  if (photos.length === 0) return [];

  const groupsByReportId = new Map<string, BuildingPhotoGroup>();
  for (const photo of photos) {
    let group = groupsByReportId.get(photo.reportId);
    if (!group) {
      const visitId = visitIdByReportId.get(photo.reportId) ?? '';
      const visit = visitById.get(visitId);
      const jobId = visit?.job_id ?? '';
      group = {
        jobId,
        jobSummary: jobSummaryByJobId.get(jobId) ?? 'Job',
        visitId,
        scheduledDate: visit?.scheduled_date ?? null,
        reportId: photo.reportId,
        photos: [],
      };
      groupsByReportId.set(photo.reportId, group);
    }
    group.photos.push(photo);
  }

  return Array.from(groupsByReportId.values()).sort((a, b) => (b.scheduledDate ?? '').localeCompare(a.scheduledDate ?? ''));
}
