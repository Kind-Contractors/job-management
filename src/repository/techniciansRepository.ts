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
import { normalizeTime, timeRangeForSave } from '../lib/timeRange';
import { toDayOrderPayload, type DayItem } from '../lib/dayItems';

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
  // The ACTIVE schedule only: a cancelled visit, and any visit of a job that is no longer active (cancelled, completed, lost,
  // on hold), is not part of anyone's schedule. It stays in the job's visit history and on the Historical Jobs page.
  const { data, error } = await supabase
    .from('visits')
    .select('id, job_id, technician_id, scheduled_date, status, sort_order, created_at, start_time, end_time, visit_technicians ( technician_id ), jobs!inner ( lifecycle_status )')
    .gte('scheduled_date', startDate)
    .lte('scheduled_date', endDate)
    .neq('status', 'cancelled')
    .eq('jobs.lifecycle_status', 'active');

  if (error) {
    throw new Error(`Failed to load visits: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    jobId: row.job_id,
    technicianId: row.technician_id,
    additionalTechnicianIds: (row.visit_technicians ?? []).map((vt: { technician_id: string }) => vt.technician_id),
    sortOrder: row.sort_order == null ? null : Number(row.sort_order),
    createdAt: row.created_at,
    scheduledDate: row.scheduled_date,
    status: row.status,
    startTime: normalizeTime(row.start_time),
    endTime: normalizeTime(row.end_time),
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
export async function createVisit(
  jobId: string,
  technicianId: string | null,
  scheduledDate: string,
  additionalTechnicianIds: string[] = [],
  /** Optional time of day for the visit (display only - it never orders the visit). Omit for no time. */
  timeRange?: { startTime?: string | null; endTime?: string | null },
): Promise<void> {
  const { startTime, endTime } = timeRangeForSave(timeRange?.startTime, timeRange?.endTime);
  const hasTime = startTime != null;

  // Additional technicians: one atomic database call creates the visit AND every
  // assignment, or nothing at all. The no-extras path below is the original
  // plain insert, unchanged.
  if (additionalTechnicianIds.length > 0) {
    const { data: visitId, error: rpcError } = await supabase.rpc('create_visit_with_technicians', {
      p_job_id: jobId,
      p_technician_id: technicianId,
      p_scheduled_date: scheduledDate,
      p_additional_technician_ids: additionalTechnicianIds,
    });

    if (rpcError) {
      throw new Error(`Failed to book visit: ${rpcError.message}`);
    }

    await logCurrentUserActivity('visit', visitId as string, 'visit_created');
    for (const extraId of additionalTechnicianIds) {
      await logCurrentUserActivity('visit', visitId as string, 'visit_technician_added', await technicianName(extraId));
    }
    // The atomic function above does not take a time, so it is saved right after as a plain update of this one visit.
    if (hasTime) {
      try {
        await setVisitTimeRange(visitId as string, startTime, endTime);
      } catch (err) {
        throw new Error(`The visit was booked, but its time could not be saved: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    return;
  }

  const { data, error } = await supabase
    .from('visits')
    .insert({
      job_id: jobId,
      technician_id: technicianId,
      scheduled_date: scheduledDate,
      status: 'booked',
      // Only sent when a time was chosen, so a booking without one is the exact same insert as before.
      ...(hasTime ? { start_time: startTime, end_time: endTime } : {}),
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

async function technicianName(technicianId: string): Promise<string> {
  const { data } = await supabase.from('technicians').select('name').eq('id', technicianId).maybeSingle();
  return data?.name ?? 'Unknown';
}

/**
 * Adds an additional technician to a visit (`visit_technicians`) — any number
 * can be added; the primary `visits.technician_id` is untouched. The database
 * refuses inactive technicians and duplicates, and the UI also filters both out.
 */
export async function addVisitTechnician(visitId: string, technicianId: string): Promise<void> {
  const { error } = await supabase.from('visit_technicians').insert({ visit_id: visitId, technician_id: technicianId });

  if (error) {
    throw new Error(`Failed to add technician: ${error.message}`);
  }

  await logCurrentUserActivity('visit', visitId, 'visit_technician_added', await technicianName(technicianId));
}

/**
 * Removes an additional technician from a visit. The database refuses this once
 * the technician has contributed to (or been waived from) the visit's report.
 */
export async function removeVisitTechnician(visitId: string, technicianId: string): Promise<void> {
  const name = await technicianName(technicianId);
  const { error } = await supabase
    .from('visit_technicians')
    .delete()
    .eq('visit_id', visitId)
    .eq('technician_id', technicianId);

  if (error) {
    throw new Error(`Failed to remove technician: ${error.message}`);
  }

  await logCurrentUserActivity('visit', visitId, 'visit_technician_removed', name);
}

/**
 * Saves one day's running order for the given visits - the first id becomes
 * 1, the next 2, and so on - in a single database call (set_visit_order), so
 * an order is either fully applied or not at all. Visits must all be on the
 * same date. A shared multi-technician visit has one order, so moving it
 * moves it for everyone assigned to it.
 */
export async function setVisitOrder(orderedVisitIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('set_visit_order', { p_visit_ids: orderedVisitIds });

  if (error) {
    throw new Error(`Failed to save visit order: ${error.message}`);
  }
}

/**
 * Saves one day's running order for jobs AND activities together (set_day_order): the first item
 * becomes 1, the next 2, and so on, in a single database call. `items` must be exactly that day's
 * live items (not cancelled), in the new order - if the day changed since it was loaded the database
 * refuses and asks for a refresh, so two items can never end up on the same number. A time is never
 * part of this.
 */
export async function setDayOrder(dateISO: string, items: DayItem[]): Promise<void> {
  const { error } = await supabase.rpc('set_day_order', { p_date: dateISO, p_items: toDayOrderPayload(items) });

  if (error) {
    throw new Error(error.message || 'Failed to save the day order.');
  }
}

/**
 * Saves a day's running order from the items shown. A day with NO activities is saved with the original
 * set_visit_order call, exactly as before activities existed; a day that has any activity uses set_day_order
 * (which orders jobs and activities together). `items` must be the day's live items, in the new order.
 */
export async function saveDayItemOrder(dateISO: string, items: DayItem[]): Promise<void> {
  if (items.some((i) => i.kind === 'activity')) {
    await setDayOrder(dateISO, items);
    return;
  }
  await setVisitOrder(items.map((i) => i.id));
}

/**
 * Sets (or clears, with nulls) a job visit's optional time of day - a plain update of this one visit's
 * start_time/end_time. Display only: the visit's position in the day is not touched. An end without a
 * start is never stored.
 */
export async function setVisitTimeRange(visitId: string, startTime: string | null, endTime: string | null): Promise<void> {
  const range = timeRangeForSave(startTime, endTime);
  const { error } = await supabase.from('visits').update({ start_time: range.startTime, end_time: range.endTime }).eq('id', visitId);

  if (error) {
    throw new Error(`Failed to save the time: ${error.message}`);
  }
}
