import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobVisitSummary, Technician } from '../../domain/types';
import { markVisitMissed } from '../../repository/reportsRepository';
import { getReportAuthorship, officeAuthorLabel } from '../../repository/officeReportsRepository';
import { addVisitTechnician, assignVisitTechnician, removeVisitTechnician, rescheduleVisit } from '../../repository/techniciansRepository';

function invalidateAfterVisitChange(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  queryClient.invalidateQueries({ queryKey: ['visits'] });
}

/**
 * Everything that manages ONE visit - its writes, their errors, and the rules about what may change - shared by the two ways a visit is
 * shown in the Job Details drawer: the list row (VisitRow, most pages) and the Schedule card (ScheduleVisitCard). One copy of the logic,
 * so both always follow the same rules; only how they are drawn differs.
 */
export function useVisitManagement({ visit, actor, technicians }: { visit: JobVisitSummary; actor: string; technicians: Technician[] }) {
  const queryClient = useQueryClient();
  const [assignError, setAssignError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [extraError, setExtraError] = useState<string | null>(null);

  /**
   * Manually moves THIS visit to a specific date — the exact same
   * rescheduleVisit() drag-and-drop already uses in Day/Week/Month
   * (touches only scheduled_date, never technician_id/job_id/status), so a
   * visit can be moved to a date outside whatever range is currently
   * visible on the calendar without needing to drag it there. Never
   * touches jobs/schedules — the job's own recurrence definition is
   * completely unaffected by moving one of its visits.
   */
  const rescheduleMutation = useMutation({
    mutationFn: (date: string) => rescheduleVisit(visit.id, date),
    onSuccess: () => {
      invalidateAfterVisitChange(queryClient);
      setDateError(null);
    },
    onError: (err) => setDateError(err instanceof Error ? err.message : 'Failed to reschedule visit.'),
  });

  /**
   * Assigns/reassigns/clears THIS visit's own technician_id only — never
   * jobs.default_technician_id (see assignVisitTechnician's own doc comment).
   * Reuses the same invalidation pair every other visit mutation here
   * already uses, so Day/Week/Month/All Live Jobs all pick up the new
   * technician the same way they already pick up a reschedule.
   */
  const assignTechnicianMutation = useMutation({
    mutationFn: (technicianId: string | null) => assignVisitTechnician(visit.id, technicianId),
    onSuccess: () => {
      invalidateAfterVisitChange(queryClient);
      setAssignError(null);
    },
    onError: (err) => setAssignError(err instanceof Error ? err.message : 'Failed to assign technician.'),
  });

  /**
   * Additional technicians (`visit_technicians`) — any number, alongside the
   * unchanged primary above. Same invalidation pair as every other visit
   * mutation; the database independently refuses inactive technicians,
   * duplicates, and removing someone who has already contributed/been waived.
   */
  const addTechnicianMutation = useMutation({
    mutationFn: (technicianId: string) => addVisitTechnician(visit.id, technicianId),
    onSuccess: () => {
      invalidateAfterVisitChange(queryClient);
      setExtraError(null);
    },
    onError: (err) => setExtraError(err instanceof Error ? err.message : 'Failed to add technician.'),
  });

  const removeTechnicianMutation = useMutation({
    mutationFn: (technicianId: string) => removeVisitTechnician(visit.id, technicianId),
    onSuccess: () => {
      invalidateAfterVisitChange(queryClient);
      setExtraError(null);
    },
    onError: (err) => setExtraError(err instanceof Error ? err.message : 'Failed to remove technician.'),
  });

  // "Written by the office · Luke" on a report the office wrote (none for a technician's report, or one from before this was recorded).
  const { data: authorship } = useQuery({
    queryKey: ['reportAuthorship', visit.reportId],
    queryFn: () => getReportAuthorship(visit.reportId!),
    enabled: visit.reportId != null,
    staleTime: 5 * 60_000,
  });
  const officeAuthor = authorship ? officeAuthorLabel(authorship.source, authorship.submittedBy) : null;

  const missedMutation = useMutation({
    mutationFn: () => markVisitMissed(visit.id, actor),
    onSuccess: () => invalidateAfterVisitChange(queryClient),
  });

  // `?? []`: job rows restored from a cache written before multi-technician visits have no additionalTechnicians.
  const additionalTechnicians = visit.additionalTechnicians ?? [];

  // A legacy (non-contribution) report has no per-technician tracking, so an
  // extra technician could never submit into it; an approved report is final.
  const extrasLocked =
    (visit.reportId != null && !visit.reportHasContributions) || visit.reportReviewStatus === 'approved';
  const extrasLockedReason =
    visit.reportReviewStatus === 'approved'
      ? 'This visit’s report is already approved.'
      : 'A single-technician report has already been submitted for this visit.';
  const showExtras = visit.status !== 'cancelled' && visit.status !== 'missed';
  const assignedIds = new Set([visit.technicianId, ...additionalTechnicians.map((t) => t.technicianId)]);
  const addableTechnicians = technicians.filter((t) => t.isActive && !assignedIds.has(t.id));
  const extraIds = new Set(additionalTechnicians.map((t) => t.technicianId));
  const primaryOptions = technicians.filter((t) => !extraIds.has(t.id));
  const isOpen = visit.status === 'due' || visit.status === 'booked';
  // visit.reportId is non-null once a report has been submitted for this visit (reports.visit_id is UNIQUE) - every technician-facing
  // RPC/Storage ownership check is CURRENT technician_id only, with no reassignment history, so changing it after that point would let
  // a newly assigned technician read the previous technician's already-submitted report/photos. Also enforced at the database level
  // (prevent_technician_reassignment_after_report trigger on visits) so this can't be bypassed by calling the update directly.
  const technicianLocked = visit.reportId != null;

  return {
    rescheduleMutation,
    assignTechnicianMutation,
    addTechnicianMutation,
    removeTechnicianMutation,
    missedMutation,
    dateError,
    setDateError,
    assignError,
    extraError,
    officeAuthor,
    additionalTechnicians,
    extrasLocked,
    extrasLockedReason,
    showExtras,
    addableTechnicians,
    primaryOptions,
    isOpen,
    technicianLocked,
  };
}
