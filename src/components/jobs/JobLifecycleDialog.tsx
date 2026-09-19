import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../../domain/types';
import {
  getJobLifecycleSafeguardState,
  updateJobLifecycle,
  type ActiveToHistoricalLifecycleStatus,
} from '../../repository/jobsRepository';
import { isReportReadyForClient } from '../../lib/statusPresentation';

export type JobLifecycleTransition = ActiveToHistoricalLifecycleStatus;

const TRANSITION_LABEL: Record<JobLifecycleTransition, string> = {
  completed: 'Mark as Completed',
  lost: 'Mark as Lost',
  cancelled: 'Mark as Cancelled',
};

const RECONTACT_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'No recontact' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
  { value: 18, label: '18 months' },
  { value: 24, label: '24 months' },
];

/** Local date arithmetic, never UTC — same reasoning as JobInspectorDrawer.tsx's own todayISO(): `.toISOString()` would shift the date in any timezone ahead of UTC. Simple calendar-month addition (no end-of-month clamping) — recontactDueAt is a fuzzy future reminder, not a legal deadline, so JS's own Date rollover behavior is an acceptable, honest approximation. */
function addMonthsLocalISODate(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * A visit that hasn't been resolved yet — due or booked, regardless of
 * date. Deliberately broader than "future-dated only": an overdue
 * due/booked visit is even less resolved than a future one and must block
 * exactly the same way. Missed/completed/cancelled visits are already
 * resolved and never block a lifecycle transition.
 */
function isUnresolvedVisit(visit: JobVisitSummary): boolean {
  return visit.status === 'due' || visit.status === 'booked';
}

/**
 * A visit whose report is still moving through the review/send/invoice
 * pipeline. Reuses isReportReadyForClient() as-is — it's still a correct,
 * live-maintained predicate (sentToClientAt is written only by the real
 * send-client-report Edge Function). Deliberately does NOT reuse
 * isVisitReadyForAccounts(): that predicate is keyed on sentToAccountsAt,
 * which nothing has written since the legacy "Send to accounts"
 * bookkeeping action was removed as a confirmed P0 fix earlier this
 * session — reusing it as-is would treat every approved visit as
 * eternally blocking, even one already invoiced and sent. The real "still
 * needs accounts action" condition is composed directly from
 * reportReviewStatus/invoiceId/invoiceStatus instead — approved with no
 * invoice at all, or an invoice that exists but hasn't successfully sent
 * (draft/sending/failed), both genuinely block; a fully 'sent' invoice
 * does not.
 */
function hasIncompleteReportWork(visit: JobVisitSummary): boolean {
  if (visit.reportReviewStatus === 'awaiting_review' || visit.reportReviewStatus === 'returned_for_correction') return true;
  if (isReportReadyForClient(visit)) return true;
  if (visit.reportReviewStatus === 'approved' && (!visit.invoiceId || visit.invoiceStatus !== 'sent')) return true;
  return false;
}

/**
 * Thrown by the mutation when the confirm-time FRESH safeguard re-check
 * (not the cached one computed on render) finds unresolved visits or
 * incomplete report work — distinguishes "the transition is blocked" from
 * a genuine failure (network error, verification query failure) so the UI
 * can render the same blocking panel as the initial cached check, rather
 * than a generic error message.
 */
class LifecycleSafeguardBlockedError extends Error {
  constructor(
    public unresolvedVisits: JobVisitSummary[],
    public incompleteReportVisits: JobVisitSummary[],
  ) {
    super('This job cannot change status right now — see the safeguard details.');
  }
}

interface JobLifecycleDialogProps {
  job: JobRow;
  transition: JobLifecycleTransition;
  onClose: () => void;
  /** Called once the server has confirmed the write — never before. The caller (JobInspectorDrawer) closes itself here too, since the job it was showing has just left the active dataset. */
  onSuccess: () => void;
}

/**
 * One dialog for all three active→historical transitions — the
 * confirmation copy/fields differ per `transition`, but the safeguard
 * checks and the write path are identical and shared. Safeguards run
 * twice: once on render, from `job.visits` already embedded on the JobRow
 * this component receives (early UX feedback only — no query), and again,
 * authoritatively, inside the mutation itself via
 * getJobLifecycleSafeguardState() immediately before updateJobLifecycle()
 * — closing the race window where a visit gets booked or a report's state
 * changes after this dialog opened but before Confirm is clicked.
 */
export default function JobLifecycleDialog({ job, transition, onClose, onSuccess }: JobLifecycleDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [recontactMonths, setRecontactMonths] = useState<number | null>(null);
  const [recontactNotes, setRecontactNotes] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // Cached check — computed on render from job.visits, purely for early UX
  // feedback (avoids showing a form for a job that's obviously already
  // blocked). Never the sole gate on the mutation itself — see the fresh
  // re-check inside the mutation below, which is authoritative.
  const unresolvedVisits = job.visits.filter(isUnresolvedVisit);
  const incompleteReportVisits = job.visits.filter(hasIncompleteReportWork);
  const cachedBlocked = unresolvedVisits.length > 0 || incompleteReportVisits.length > 0;

  const mutation = useMutation({
    mutationFn: async () => {
      // Authoritative pre-write check — re-reads the job's visits/reports/
      // invoices fresh from the database, never trusting the (possibly
      // stale) `job.visits` this dialog was opened with. The lifecycle
      // update below only ever runs once this has passed.
      let freshVisits: JobVisitSummary[];
      try {
        freshVisits = await getJobLifecycleSafeguardState(job.id);
      } catch {
        throw new Error("Couldn't verify the job's current status. Please try again.");
      }

      const freshUnresolvedVisits = freshVisits.filter(isUnresolvedVisit);
      const freshIncompleteReportVisits = freshVisits.filter(hasIncompleteReportWork);
      if (freshUnresolvedVisits.length > 0 || freshIncompleteReportVisits.length > 0) {
        throw new LifecycleSafeguardBlockedError(freshUnresolvedVisits, freshIncompleteReportVisits);
      }

      await updateJobLifecycle(job.id, {
        lifecycleStatus: transition,
        lostReason: transition === 'completed' ? null : reason.trim() || null,
        recontactIntervalMonths: transition === 'lost' ? recontactMonths : null,
        recontactDueAt: transition === 'lost' && recontactMonths ? addMonthsLocalISODate(recontactMonths) : null,
        recontactNotes: transition === 'lost' ? recontactNotes.trim() || null : null,
      });
    },
    onSuccess: () => {
      // Server-confirmed — only now do the active/historical views refetch.
      // Never fake the transition locally beforehand.
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['historicalJobRows'] });
      onSuccess();
    },
  });

  // A block discovered by the confirm-time FRESH safeguard re-check above
  // takes over the same blocking UI as the cached check below — the
  // dialog stays open, shows why, and offers Close only, exactly as if
  // the cached check itself had caught it.
  const freshBlock = mutation.error instanceof LifecycleSafeguardBlockedError ? mutation.error : null;
  const blockToShow = freshBlock
    ? { unresolvedVisits: freshBlock.unresolvedVisits, incompleteReportVisits: freshBlock.incompleteReportVisits }
    : cachedBlocked
      ? { unresolvedVisits, incompleteReportVisits }
      : null;

  const handleConfirm = () => {
    if (transition === 'lost' && !reason.trim()) {
      setValidationError('Enter a reason.');
      return;
    }
    setValidationError(null);
    mutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-[440px] border border-neutral-300 bg-white p-4">
        <div className="border-b border-divider pb-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Job status</div>
          <h2 className="mt-1 font-heading text-lg font-semibold">{TRANSITION_LABEL[transition]}</h2>
          <div className="text-[12.5px] text-neutral-600">
            {job.buildingName} · {job.jobSummary}
          </div>
        </div>

        {blockToShow ? (
          <div className="mt-3 flex flex-col gap-2.5">
            {blockToShow.unresolvedVisits.length > 0 && (
              <div className="border border-due bg-due/10 p-3 text-[12.5px] text-due-fg">
                This job has {blockToShow.unresolvedVisits.length} upcoming scheduled visit
                {blockToShow.unresolvedVisits.length === 1 ? '' : 's'}. Please cancel or reschedule{' '}
                {blockToShow.unresolvedVisits.length === 1 ? 'it' : 'these visits'} before changing the job status.
                <ul className="mt-1.5 list-inside list-disc">
                  {blockToShow.unresolvedVisits.slice(0, 5).map((v) => (
                    <li key={v.id}>{v.scheduledDate ? new Date(v.scheduledDate).toLocaleDateString('en-GB') : 'No date set'}</li>
                  ))}
                </ul>
              </div>
            )}
            {blockToShow.incompleteReportVisits.length > 0 && (
              <div className="border border-due bg-due/10 p-3 text-[12.5px] text-due-fg">
                This job has an outstanding report that still needs to be processed. Complete the report workflow
                (review, send to client, or send to accounts) before moving this job to Historical.
              </div>
            )}
            {freshBlock && (
              <div className="text-[11.5px] text-neutral-500">
                This was just detected — the job's status changed after this dialog opened.
              </div>
            )}
            <button
              onClick={onClose}
              className="mt-1 w-fit cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2.5">
            <div className="text-[12.5px] leading-relaxed text-ink">
              This job will move out of the active workflow and into Historical Jobs. Job details, visits, reports,
              and invoices are all preserved — nothing is deleted.
            </div>

            {transition === 'cancelled' && (
              <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                Reason (optional)
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                />
              </label>
            )}

            {transition === 'lost' && (
              <>
                <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                  Reason (required)
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                  Recontact
                  <select
                    value={recontactMonths ?? ''}
                    onChange={(e) => setRecontactMonths(e.target.value ? Number(e.target.value) : null)}
                    className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                  >
                    {RECONTACT_OPTIONS.map((o) => (
                      <option key={o.label} value={o.value ?? ''}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                  Recontact notes (optional)
                  <textarea
                    value={recontactNotes}
                    onChange={(e) => setRecontactNotes(e.target.value)}
                    rows={2}
                    className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                  />
                </label>
              </>
            )}

            {validationError && <div className="text-[11.5px] text-missed-fg">{validationError}</div>}
            {mutation.isError && !freshBlock && (
              <div className="text-[11.5px] text-missed-fg">
                {mutation.error instanceof Error ? mutation.error.message : 'Failed to update job status.'}
              </div>
            )}

            <div className="mt-1 flex gap-1.5">
              <button
                onClick={handleConfirm}
                disabled={mutation.isPending}
                className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {mutation.isPending ? 'Saving…' : 'Confirm'}
              </button>
              <button
                onClick={onClose}
                disabled={mutation.isPending}
                className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
