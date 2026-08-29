// Data-access layer for teams/visits — for the This Week view. Both tables
// are empty in production today; these are real queries against them (not
// stubs), so the view lights up automatically once team/visit data exists,
// mirroring buildingsRepository.ts's listBuildingHistory pattern.

import type { Team, WeekVisit } from '../domain/types';
import { supabase } from '../lib/supabaseClient';

export async function listTeams(): Promise<Team[]> {
  const { data, error } = await supabase.from('teams').select('id, name, is_active, notes');

  if (error) {
    throw new Error(`Failed to load teams: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    notes: row.notes,
  }));
}

/** startDate/endDate are 'YYYY-MM-DD' — inclusive range. Never derives a date from job frequency. */
export async function listVisitsForWeek(startDate: string, endDate: string): Promise<WeekVisit[]> {
  const { data, error } = await supabase
    .from('visits')
    .select('id, job_id, team_id, scheduled_date, status')
    .gte('scheduled_date', startDate)
    .lte('scheduled_date', endDate);

  if (error) {
    throw new Error(`Failed to load this week's visits: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    jobId: row.job_id,
    teamId: row.team_id,
    scheduledDate: row.scheduled_date,
    status: row.status,
  }));
}

/** Creates a team. Teams are deactivated, never deleted — see setTeamActive. */
export async function createTeam(name: string, notes?: string | null): Promise<Team> {
  const { data, error } = await supabase
    .from('teams')
    .insert({ name, notes: notes ?? null })
    .select('id, name, is_active, notes')
    .single();

  if (error) {
    throw new Error(`Failed to create team: ${error.message}`);
  }

  return { id: data.id, name: data.name, isActive: data.is_active, notes: data.notes };
}

/** Deactivate/reactivate a team — never delete (jobs/visits reference it with ON DELETE RESTRICT). */
export async function setTeamActive(teamId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('teams').update({ is_active: isActive }).eq('id', teamId);

  if (error) {
    throw new Error(`Failed to update team: ${error.message}`);
  }
}

/**
 * Books a one-off visit with an explicit date — never derived from
 * frequency_type/frequency_raw, and never writes to `schedules` (that would
 * be defining a recurring rule, out of scope for this pass). price_charged/
 * completed_at are left null; the visits_completion_requires_charge_check
 * constraint only applies once status reaches 'completed', which this
 * function never sets.
 */
export async function createVisit(jobId: string, teamId: string | null, scheduledDate: string): Promise<void> {
  const { error } = await supabase.from('visits').insert({
    job_id: jobId,
    team_id: teamId,
    scheduled_date: scheduledDate,
    status: 'booked',
  });

  if (error) {
    throw new Error(`Failed to book visit: ${error.message}`);
  }
}
