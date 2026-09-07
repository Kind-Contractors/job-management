// Data-access layer for technicians/visits — for the This Week view. A
// `technicians` row is one individual person (renamed from `teams` — Luke
// does not use a team/group concept; assignment is always to one person,
// optionally left unassigned and set later). Both tables are effectively
// empty in production today; these are real queries against them (not
// stubs), so the view lights up automatically once technician/visit data
// exists, mirroring buildingsRepository.ts's listBuildingHistory pattern.

import type { Technician, WeekVisit } from '../domain/types';
import { supabase } from '../lib/supabaseClient';

export async function listTechnicians(): Promise<Technician[]> {
  const { data, error } = await supabase.from('technicians').select('id, name, is_active, notes');

  if (error) {
    throw new Error(`Failed to load technicians: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    notes: row.notes,
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
    .select('id, name, is_active, notes')
    .single();

  if (error) {
    throw new Error(`Failed to create technician: ${error.message}`);
  }

  return { id: data.id, name: data.name, isActive: data.is_active, notes: data.notes };
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
  const { error } = await supabase.from('visits').insert({
    job_id: jobId,
    technician_id: technicianId,
    scheduled_date: scheduledDate,
    status: 'booked',
  });

  if (error) {
    throw new Error(`Failed to book visit: ${error.message}`);
  }
}
