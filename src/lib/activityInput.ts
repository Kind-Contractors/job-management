import { timeRangeError } from './timeRange';

export const ACTIVITY_DESCRIPTION_MAX = 120;
export const ACTIVITY_LOCATION_MAX = 200;
export const ACTIVITY_NOTES_MAX = 2000;

/** What the manager types into the Activity form (everything as the raw strings from the inputs). */
export interface ActivityFormValues {
  description: string;
  scheduledDate: string;
  /** '' = unassigned. */
  technicianId: string;
  location: string;
  notes: string;
  startTime: string;
  endTime: string;
}

/**
 * The first reason an activity cannot be saved, or null when it can. Mirrors the database rules
 * (description 1-120 characters, location <= 200, notes <= 2000, a date, and a valid time range)
 * so the form explains the problem instead of surfacing a raw database error.
 */
export function validateActivityInput(values: ActivityFormValues): string | null {
  const description = values.description.trim();
  if (description === '') return 'Describe the activity.';
  if (description.length > ACTIVITY_DESCRIPTION_MAX) return `The description must be ${ACTIVITY_DESCRIPTION_MAX} characters or fewer.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.scheduledDate)) return 'Choose a date.';
  if (values.location.trim().length > ACTIVITY_LOCATION_MAX) return `The location must be ${ACTIVITY_LOCATION_MAX} characters or fewer.`;
  if (values.notes.trim().length > ACTIVITY_NOTES_MAX) return `The notes must be ${ACTIVITY_NOTES_MAX} characters or fewer.`;
  return timeRangeError(values.startTime, values.endTime);
}
