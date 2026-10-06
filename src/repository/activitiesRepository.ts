// Data-access layer for Activities: non-job items in someone's working day (a quote visit, picking up
// keys, a client meeting). They live in their own `activities` table and never touch visits, jobs,
// reports or invoices. Manager-only: row-level security gives technicians no access to this table at
// all (a technician reads their own through the technician_day_items() function instead).
//
// An activity is never hard-deleted - "cancel" sets cancelled_at. No activity_events audit rows are
// written (activity_entity_type has no 'activity' value, and no history feed reads one).

import type { ScheduleActivity } from '../domain/types';
import { supabase } from '../lib/supabaseClient';
import { normalizeTime, timeRangeForSave } from '../lib/timeRange';

const ACTIVITY_COLUMNS =
  'id, description, scheduled_date, technician_id, location, notes, start_time, end_time, sort_order, created_at, done_at, cancelled_at';

interface ActivityRow {
  id: string;
  description: string;
  scheduled_date: string;
  technician_id: string | null;
  location: string | null;
  notes: string | null;
  start_time: string | null;
  end_time: string | null;
  sort_order: number | string | null;
  created_at: string;
  done_at: string | null;
  cancelled_at: string | null;
}

export function mapActivityRow(row: ActivityRow): ScheduleActivity {
  return {
    id: row.id,
    description: row.description,
    scheduledDate: row.scheduled_date,
    technicianId: row.technician_id,
    location: row.location,
    notes: row.notes,
    startTime: normalizeTime(row.start_time),
    endTime: normalizeTime(row.end_time),
    sortOrder: row.sort_order == null ? null : Number(row.sort_order),
    createdAt: row.created_at,
    doneAt: row.done_at,
    cancelledAt: row.cancelled_at,
  };
}

/** startDate/endDate are 'YYYY-MM-DD', inclusive - the same range shape as listVisitsForRange, so every calendar mode shares one cache-key shape. Cancelled activities are included (shown greyed in the day list). */
export async function listActivitiesForRange(startDate: string, endDate: string): Promise<ScheduleActivity[]> {
  const { data, error } = await supabase
    .from('activities')
    .select(ACTIVITY_COLUMNS)
    .gte('scheduled_date', startDate)
    .lte('scheduled_date', endDate);

  if (error) {
    throw new Error(`Failed to load activities: ${error.message}`);
  }

  return ((data ?? []) as ActivityRow[]).map(mapActivityRow);
}

/** The editable parts of an activity. Empty strings are stored as null; an end time without a start time is never stored. */
export interface ActivityInput {
  description: string;
  scheduledDate: string;
  /** null = unassigned. */
  technicianId: string | null;
  location?: string | null;
  notes?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function toColumns(input: ActivityInput) {
  const { startTime, endTime } = timeRangeForSave(input.startTime, input.endTime);
  return {
    description: input.description.trim(),
    scheduled_date: input.scheduledDate,
    technician_id: input.technicianId,
    location: blankToNull(input.location),
    notes: blankToNull(input.notes),
    start_time: startTime,
    end_time: endTime,
  };
}

/** Creates an activity. It starts unordered (sort_order null), so it sorts after the day's ordered items until the manager reorders the day. */
export async function createActivity(input: ActivityInput): Promise<ScheduleActivity> {
  const { data, error } = await supabase.from('activities').insert(toColumns(input)).select(ACTIVITY_COLUMNS).single();

  if (error) {
    throw new Error(`Failed to create activity: ${error.message}`);
  }

  return mapActivityRow(data as ActivityRow);
}

/**
 * Saves every editable field in one update (description, date, assignee, location, notes, times).
 * The database resets the order when the date changes but keeps the time, and clears "done" when the
 * assignee changes.
 */
export async function updateActivity(activityId: string, input: ActivityInput): Promise<void> {
  const { error } = await supabase.from('activities').update(toColumns(input)).eq('id', activityId);

  if (error) {
    throw new Error(`Failed to save activity: ${error.message}`);
  }
}

/** Moves an activity to another date and/or assignee in ONE update (drag-and-drop), so a drop can never half-apply. Pass only what changes. Its time is kept. */
export async function moveActivity(activityId: string, change: { scheduledDate?: string; technicianId?: string | null }): Promise<void> {
  const columns: Record<string, string | null> = {};
  if (change.scheduledDate !== undefined) columns.scheduled_date = change.scheduledDate;
  if (change.technicianId !== undefined) columns.technician_id = change.technicianId;
  if (Object.keys(columns).length === 0) return;

  const { error } = await supabase.from('activities').update(columns).eq('id', activityId);

  if (error) {
    throw new Error(`Failed to move activity: ${error.message}`);
  }
}

/** Cancels (never deletes) an activity: it drops out of everyone's day and out of the day order, and the row is kept. */
export async function cancelActivity(activityId: string): Promise<void> {
  const { error } = await supabase
    .from('activities')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', activityId)
    .is('cancelled_at', null);

  if (error) {
    throw new Error(`Failed to cancel activity: ${error.message}`);
  }
}
