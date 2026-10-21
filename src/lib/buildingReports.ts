// Which client reports the Building screen offers for download. Kept free of React so the rule can be tested directly.
//
// A visit's report is AVAILABLE once either:
//   - a manager has marked it Completed (Ready for client -> Completed), or
//   - it has been emailed to the client through the system (Send to client sets sent_to_client_at).
// Marking a JOB as completed requires every report on it to be Completed first (JobLifecycleDialog), so a completed job's
// reports are always available here too. A report that has both is ONE entry (a visit has at most one report: reports.visit_id
// is unique), shown with both facts. Reports still in review or awaiting completion are counted, not offered.

import type { JobRow, JobVisitSummary } from '../domain/types';

export interface BuildingReportEntry {
  reportId: string;
  job: JobRow;
  visit: JobVisitSummary;
  sentToClientAt: string | null;
  completedAt: string | null;
}

export interface BuildingReports {
  /** Downloadable reports, latest visit first. */
  available: BuildingReportEntry[];
  /** Reports at this building that are not available yet (still in review, or approved but not completed or sent). */
  notYetAvailable: number;
}

export function isReportAvailableForBuilding(visit: JobVisitSummary): boolean {
  return !!visit.reportId && ((visit.reportCompletedAt ?? null) !== null || (visit.sentToClientAt ?? null) !== null);
}

/**
 * The reports of every job at `buildingId`, from any number of job lists (active and historical jobs are loaded separately);
 * a job listed twice, or a report reached twice, still gives one entry. Jobs at other buildings are ignored.
 */
export function buildingReports(buildingId: string, ...jobLists: JobRow[][]): BuildingReports {
  const seenJobs = new Set<string>();
  const byReport = new Map<string, BuildingReportEntry>();
  let notYetAvailable = 0;
  const pending = new Set<string>();
  for (const jobs of jobLists) {
    for (const job of jobs) {
      if (job.buildingId !== buildingId || seenJobs.has(job.id)) continue;
      seenJobs.add(job.id);
      for (const visit of job.visits) {
        if (!visit.reportId) continue;
        if (!isReportAvailableForBuilding(visit)) {
          if (!pending.has(visit.reportId)) {
            pending.add(visit.reportId);
            notYetAvailable += 1;
          }
          continue;
        }
        if (byReport.has(visit.reportId)) continue;
        byReport.set(visit.reportId, {
          reportId: visit.reportId,
          job,
          visit,
          sentToClientAt: visit.sentToClientAt ?? null,
          completedAt: visit.reportCompletedAt ?? null,
        });
      }
    }
  }
  const available = [...byReport.values()].sort(
    (a, b) =>
      (b.visit.scheduledDate ?? '').localeCompare(a.visit.scheduledDate ?? '') ||
      (b.completedAt ?? b.sentToClientAt ?? '').localeCompare(a.completedAt ?? a.sentToClientAt ?? ''),
  );
  return { available, notYetAvailable };
}
