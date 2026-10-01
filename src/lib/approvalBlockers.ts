import type { ReportContributionOverview } from '../repository/reportsRepository';

/**
 * Why a contribution-mode report can't be approved yet - mirrors the database
 * gate in check_report_review_transition (which stays the real enforcement):
 * every technician currently on the visit must have a submitted, uncorrected
 * contribution or be waived. Empty for legacy single-technician reports.
 */
export function getApprovalBlockers(overview: ReportContributionOverview | undefined): string[] {
  if (!overview?.contributionMode) return [];
  const blockers: string[] = [];
  const awaitingCorrection = overview.participants.filter((p) => p.status === 'submitted' && p.needsCorrection);
  const pending = overview.participants.filter((p) => p.status === 'pending');
  if (awaitingCorrection.length > 0) {
    blockers.push(`Waiting for a correction from ${awaitingCorrection.map((p) => p.name).join(', ')}.`);
  }
  if (pending.length > 0) {
    blockers.push(`Waiting for ${pending.map((p) => p.name).join(', ')} to submit - or waive them below.`);
  }
  return blockers;
}
