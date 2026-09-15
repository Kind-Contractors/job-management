// Data-access layer for technicians/visits — for the This Week view. A
// `technicians` row is one individual person (renamed from `teams` — Luke
// does not use a team/group concept; assignment is always to one person,
// optionally left unassigned and set later). Both tables are effectively
// empty in production today; these are real queries against them (not
// stubs), so the view lights up automatically once technician/visit data
// exists, mirroring buildingsRepository.ts's listBuildingHistory pattern.

import type { Technician, WeekVisit } from '../domain/types';
import { supabase } from '../lib/supabaseClient';
import { logCurrentUserActivity } from './activityEventsRepository';

export async function listTechnicians(): Promise<Technician[]> {
  const { data, error } = await supabase.from('technicians').select('id, name, is_active, notes, app_user_id');

  if (error) {
    throw new Error(`Failed to load technicians: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    notes: row.notes,
    appUserId: row.app_user_id,
  }));
}

/**
 * startDate/endDate are 'YYYY-MM-DD' — inclusive range. Never derives a date
 * from job frequency. Shared by every calendar mode (day/week/month) and
 * This Week — one query, one cache-key shape, so every view that reads it
 * stays live-linked by construction (see the Calendar plan's §3.1/§3.6).
 */
export async function listVisitsForRange(startDate: string, endDate: string): Promise<WeekVisit[]> {
  const { data, error } = await supabase
    .from('visits')
    .select('id, job_id, technician_id, scheduled_date, status')
    .gte('scheduled_date', startDate)
    .lte('scheduled_date', endDate);

  if (error) {
    throw new Error(`Failed to load visits: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    jobId: row.job_id,
    technicianId: row.technician_id,
    scheduledDate: row.scheduled_date,
    status: row.status,
  }));
}

/** Creates a technician. Technicians are deactivated, never deleted — see setTechnicianActive. */
export async function createTechnician(name: string, notes?: string | null): Promise<Technician> {
  const { data, error } = await supabase
    .from('technicians')
    .insert({ name, notes: notes ?? null })
    .select('id, name, is_active, notes, app_user_id')
    .single();

  if (error) {
    throw new Error(`Failed to create technician: ${error.message}`);
  }

  return { id: data.id, name: data.name, isActive: data.is_active, notes: data.notes, appUserId: data.app_user_id };
}

/** Deactivate/reactivate a technician — never delete (jobs/visits reference it with ON DELETE RESTRICT). */
export async function setTechnicianActive(technicianId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('technicians').update({ is_active: isActive }).eq('id', technicianId);

  if (error) {
    throw new Error(`Failed to update technician: ${error.message}`);
  }
}

/**
 * Books a one-off visit with an explicit date — never derived from
 * frequency_type/frequency_raw, and never writes to `schedules` (that would
 * be defining a recurring rule, out of scope for this pass). price_charged/
 * completed_at are left null; the visits_completion_requires_charge_check
 * constraint only applies once status reaches 'completed', which this
 * function never sets. `technicianId` is nullable — a visit can be booked
 * unassigned and assigned later (Luke: "I won't even assign the job until
 * the day before or the day of").
 */
export async function createVisit(jobId: string, technicianId: string | null, scheduledDate: string): Promise<void> {
  const { data, error } = await supabase
    .from('visits')
    .insert({
      job_id: jobId,
      technician_id: technicianId,
      scheduled_date: scheduledDate,
      status: 'booked',
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to book visit: ${error.message}`);
  }

  await logCurrentUserActivity('visit', data.id, 'visit_created');
}

/**
 * Reschedules an EXISTING visit to a new date — a plain update against its
 * own row (by id), never an insert. Used by dragging an already-booked
 * chip from one calendar day to another. Deliberately touches only
 * scheduled_date: technician_id, job_id, status, price_charged, and every
 * other field are left exactly as they are, so the assigned technician and
 * all job/building data stay unchanged, per the calendar's own drag-to-
 * reschedule requirement. Never call this for a job with no existing
 * visit — that's createVisit's job (a genuinely new booking), not this
 * one's.
 */
export async function rescheduleVisit(visitId: string, scheduledDate: string): Promise<void> {
  const { data: before } = await supabase.from('visits').select('scheduled_date').eq('id', visitId).maybeSingle();

  const { error } = await supabase.from('visits').update({ scheduled_date: scheduledDate }).eq('id', visitId);

  if (error) {
    throw new Error(`Failed to reschedule visit: ${error.message}`);
  }

  if (before && before.scheduled_date !== scheduledDate) {
    const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB');
    const detail = before.scheduled_date ? `${fmt(before.scheduled_date)} → ${fmt(scheduledDate)}` : `Set to ${fmt(scheduledDate)}`;
    await logCurrentUserActivity('visit', visitId, 'visit_rescheduled', detail);
  }
}

/**
 * Assigns (or clears, if technicianId is null) an EXISTING visit's own
 * technician — a plain update by id, touching only technician_id. Distinct
 * from jobsRepository.ts's assignJobTechnician(), which sets the job's
 * default/prefill for FUTURE bookings only: this is the one function that
 * changes who is actually doing an already-booked visit, and never writes
 * jobs.default_technician_id. technicianId stays nullable so a visit can
 * always be set back to Unassigned if plans change (Luke: flexible,
 * changeable person assignment — reference/Luke_manager_app_version_1.txt).
 */
export async function assignVisitTechnician(visitId: string, technicianId: string | null): Promise<void> {
  const { data: before } = await supabase.from('visits').select('technician_id').eq('id', visitId).maybeSingle();

  const { error } = await supabase.from('visits').update({ technician_id: technicianId }).eq('id', visitId);

  if (error) {
    throw new Error(`Failed to assign technician: ${error.message}`);
  }

  const beforeId = before?.technician_id ?? null;
  if (beforeId === technicianId) return;

  const idsToResolve = [beforeId, technicianId].filter((id): id is string => !!id);
  const namesById = new Map<string, string>();
  if (idsToResolve.length > 0) {
    const { data: techs } = await supabase.from('technicians').select('id, name').in('id', idsToResolve);
    for (const t of techs ?? []) namesById.set(t.id, t.name);
  }
  const beforeName = beforeId ? (namesById.get(beforeId) ?? 'Unknown') : 'Unassigned';
  const afterName = technicianId ? (namesById.get(technicianId) ?? 'Unknown') : 'Unassigned';
  const eventType = !beforeId ? 'visit_technician_assigned' : !technicianId ? 'visit_technician_unassigned' : 'visit_technician_changed';
  await logCurrentUserActivity('visit', visitId, eventType, `${beforeName} → ${afterName}`);
}
