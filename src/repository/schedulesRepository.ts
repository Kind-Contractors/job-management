// Data-access layer for a job's real, manager-entered schedule. `job_id` is
// the schedules table's primary key, so at most one schedule can ever exist
// per job — an upsert against an existing job_id is a real UPDATE of that
// same row in place (Postgres ON CONFLICT DO UPDATE), never a
// delete-and-recreate. Every write sets the FULL row (every non-applicable
// column explicitly null) since schedules_type_consistency_check requires
// an exact, mutually-exclusive field set per schedule_type — never a
// partial patch. Never infers a value from frequency_raw/frequency_type/
// staging data; every field here is exactly what a manager typed.

import type { ScheduleIntervalUnit, ScheduleType, ScheduleWeekOrdinal, ScheduleWeekday } from '../domain/types';
import { supabase } from '../lib/supabaseClient';

export type ScheduleInput =
  | {
      scheduleType: 'fixed_weekday';
      intervalUnit: ScheduleIntervalUnit;
      intervalCount: number;
      weekday: ScheduleWeekday;
      weekOrdinal: ScheduleWeekOrdinal;
      notes: string | null;
    }
  | {
      scheduleType: 'fixed_date';
      intervalUnit: ScheduleIntervalUnit;
      intervalCount: number;
      dayOfMonth: number;
      rollForwardOnWeekend: boolean;
      notes: string | null;
    }
  | {
      scheduleType: 'due_month';
      intervalUnit: ScheduleIntervalUnit;
      intervalCount: number;
      dueMonth: number;
      notes: string | null;
    }
  | { scheduleType: 'ad_hoc'; notes: string | null };

interface ScheduleRow {
  job_id: string;
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

function toRow(jobId: string, input: ScheduleInput): ScheduleRow {
  const base: ScheduleRow = {
    job_id: jobId,
    schedule_type: input.scheduleType,
    interval_unit: null,
    interval_count: null,
    weekday: null,
    week_ordinal: null,
    day_of_month: null,
    roll_forward_on_weekend: true,
    due_month: null,
    notes: input.notes,
  };

  switch (input.scheduleType) {
    case 'fixed_weekday':
      return {
        ...base,
        interval_unit: input.intervalUnit,
        interval_count: input.intervalCount,
        weekday: input.weekday,
        week_ordinal: input.weekOrdinal,
      };
    case 'fixed_date':
      return {
        ...base,
        interval_unit: input.intervalUnit,
        interval_count: input.intervalCount,
        day_of_month: input.dayOfMonth,
        roll_forward_on_weekend: input.rollForwardOnWeekend,
      };
    case 'due_month':
      return {
        ...base,
        interval_unit: input.intervalUnit,
        interval_count: input.intervalCount,
        due_month: input.dueMonth,
      };
    case 'ad_hoc':
      return base;
  }
}

/** Creates or replaces a job's one schedule — see the file header for why this is always a full-row upsert, never a partial patch. */
export async function upsertSchedule(jobId: string, input: ScheduleInput): Promise<void> {
  const { error } = await supabase.from('schedules').upsert(toRow(jobId, input), { onConflict: 'job_id' });

  if (error) {
    throw new Error(`Failed to save schedule: ${error.message}`);
  }
}

/**
 * The only destructive action in this feature: removes a job's one schedule
 * row and returns it to the honest "no schedule set" state. Safe as a real
 * delete — no other table has a foreign key into `schedules`.
 */
export async function deleteSchedule(jobId: string): Promise<void> {
  const { error } = await supabase.from('schedules').delete().eq('job_id', jobId);

  if (error) {
    throw new Error(`Failed to remove schedule: ${error.message}`);
  }
}
