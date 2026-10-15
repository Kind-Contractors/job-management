import type { JobRow } from '../domain/types';

/**
 * Does `job` match the global search box's text? Case-insensitive substring over the same fields All Live Jobs
 * searches (building, job, client, postcode, frequency, technician, schedule pattern, id), so the same words find
 * the same job on every screen that honours the shared `?q=` param.
 *
 * Read-only by construction: it only ever looks at a job and returns a boolean - searching can never change a
 * schedule or create a visit. An empty or whitespace-only query matches everything.
 */
export function matchesJobSearch(job: JobRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack =
    `${job.buildingName} ${job.jobSummary} ${job.clientName} ${job.postcode} ${job.frequency} ${job.technician} ${job.schedulePattern} ${job.id}`.toLowerCase();
  return haystack.includes(q);
}
