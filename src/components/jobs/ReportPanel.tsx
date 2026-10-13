import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveReport,
  getReportContributionOverview,
  getReport,
  resubmitReport,
  returnReportForCorrection,
  saveReportText,
  ReportTextChangedError,
} from '../../repository/reportsRepository';
import type { ReportDetail } from '../../domain/types';
import { getReportReviewStatusPresentation } from '../../lib/statusPresentation';
import { getApprovalBlockers } from '../../lib/approvalBlockers';
import {
  FIELD_LABEL,
  ReportTextAutosave,
  isReportTextLocked,
  reportTextLockReason,
  type AutosaveState,
  type TextField,
  type TextValues,
} from '../../lib/reportTextAutosave';
import { installLeaveWarnings, registerUnsavedGuard } from '../../lib/unsavedEditsGuard';
import ReportContributionsSection from './ReportContributionsSection';
import ReportVideos from '../reports/ReportVideos';
import ReportPhotos from '../reports/ReportPhotos';
import { ReopenFirstNotice } from '../reports/ReportCompletionControls';
import AutoGrowTextarea from '../shared/AutoGrowTextarea';
import StatusPill from './StatusPill';

export interface ReportPanelProps {
  reportId: string;
  reviewStatus: 'awaiting_review' | 'approved' | 'returned_for_correction';
  actor: string;
  /** True when this report is approved and not yet sent to accounts — see isVisitReadyForAccounts. */
  readyForAccounts: boolean;
}

export const REVIEW_LABEL: Record<ReportPanelProps['reviewStatus'], string> = {
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  returned_for_correction: 'Returned for correction',
};

/**
 * The one report-review/approve/return/resubmit surface in the app — used
 * exclusively by ReportReviewPage.tsx's dedicated queue (the Job Inspector
 * drawer shows only a compact status line via VisitRow.tsx, not this
 * component — full report inspection/approval belongs only here, in Report
 * Review, to keep exactly one place that does it). Sending a report to a
 * client or to accounts is never done from here — see Ready for Client
 * (ReadyForClientPage.tsx) and Ready for Accounts (ReadyForAccountsPage.tsx),
 * the only two real send/invoice pathways in the app. This component used to
 * carry its own "Send to client"/"Send to accounts" bookkeeping-only
 * shortcuts; both were removed as a confirmed P0 (they marked a report as
 * sent/invoiced without ever generating a PDF, emailing anyone, or creating
 * a Xero invoice, silently removing that visit from the real Ready for
 * Client/Ready for Accounts queues with no recovery path).
 */
const textOf = (r: Pick<ReportDetail, 'workCarriedOut' | 'issues' | 'technicianNotes'>): TextValues => ({
  workCarriedOut: r.workCarriedOut,
  issues: r.issues,
  technicianNotes: r.technicianNotes,
});

const TEXT_BOX = 'border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal read-only:bg-neutral-100 read-only:text-neutral-600';

export default function ReportPanel({ reportId, reviewStatus, actor, readyForAccounts }: ReportPanelProps) {
  const queryClient = useQueryClient();
  // Auto-open whenever this report is actually actionable — this is what
  // lands the manager straight on the thing they need to act on. Approved-
  // but-not-yet-invoiced (readyForAccounts) is equally worth seeing in full,
  // even though acting on it now happens on Ready for Accounts, not here.
  const [expanded, setExpanded] = useState(reviewStatus !== 'approved' || readyForAccounts);
  const [returnReason, setReturnReason] = useState('');
  const [returnError, setReturnError] = useState<string | null>(null);
  const [showReturnForm, setShowReturnForm] = useState(false);
  // Only here to re-render when the controller's state changes; what is shown is read from the controller itself.
  const [, setAutosaveState] = useState<AutosaveState>({ status: 'idle', error: null });

  const { data: report } = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => getReport(reportId),
    enabled: expanded,
  });

  // What the manager types is saved automatically (see lib/reportTextAutosave.ts); there is no Save button. The refs below hand the controller
  // the report as last loaded and whether its text is locked (approved / Completed / sent), without re-creating it on every render.
  const savedRef = useRef<TextValues | null>(null);
  const lockedRef = useRef(false);
  savedRef.current = report ? textOf(report) : null;
  lockedRef.current = report ? isReportTextLocked(report) : false;
  const readFreshReport = () => queryClient.fetchQuery({ queryKey: ['report', reportId], queryFn: () => getReport(reportId), staleTime: 0 });
  const autosaveRef = useRef<ReportTextAutosave | null>(null);
  if (autosaveRef.current === null) {
    autosaveRef.current = new ReportTextAutosave({
      getSaved: () => savedRef.current,
      isLocked: () => lockedRef.current,
      save: async (patch, expected) => {
        try {
          await saveReportText(reportId, patch, expected);
        } catch (err) {
          if (err instanceof ReportTextChangedError) {
            // Someone else changed the text (or approved the report) first: read it again so the manager sees what changed.
            try {
              const fresh = await readFreshReport();
              lockedRef.current = isReportTextLocked(fresh);
              autosaveRef.current?.sync(textOf(fresh), true);
            } catch {
              // the original error below is what the manager needs to see
            }
          }
          throw err;
        }
        void queryClient.invalidateQueries({ queryKey: ['report', reportId] });
        void queryClient.invalidateQueries({ queryKey: ['reportContributions', reportId] }); // "edited by the office" banner
      },
      onState: setAutosaveState,
    });
  }
  const autosave = autosaveRef.current;
  // Compare the report as just loaded with what the controller knows: text changed elsewhere is shown, never silently replaced (and never
  // overwrites what the manager is typing). Idempotent, so safe to run on every render.
  if (report) autosave.sync();
  const textLocked = report ? isReportTextLocked(report) : false;
  const lockReason = report ? reportTextLockReason(report) : null;
  const conflicts = autosave.conflicts;
  const changedElsewhere = autosave.changedElsewhere;
  const textBlocksApproval = changedElsewhere.length > 0;
  // While anything typed is unsaved the manager is warned before leaving: closing the tab, following a link elsewhere in the app, and
  // choosing another report (the page asks lib/unsavedEditsGuard first). Registering listeners is a real side effect. Unmounting
  // saves what is still pending as a last resort - it cannot show an error to anyone, which is why the guard above exists.
  useEffect(() => {
    const unregister = registerUnsavedGuard({ hasUnsaved: () => autosave.hasUnsavedWork(), flush: () => autosave.flush() });
    const uninstall = installLeaveWarnings();
    return () => {
      uninstall();
      unregister();
      autosave.dispose();
    };
  }, [autosave]);
  /**
   * Approve / Return / Resubmit must never go ahead without the manager's edits: read the report again (so a text changed elsewhere is
   * noticed), save, and stop if any of that fails. Approving also waits until the manager has seen text that changed under them.
   */
  const saveEditsFirst = async (approving = false) => {
    try {
      const fresh = await readFreshReport();
      lockedRef.current = isReportTextLocked(fresh);
      autosave.sync(textOf(fresh), true);
    } catch (err) {
      throw new Error(`Could not check the latest version of this report, so nothing was done. ${err instanceof Error ? err.message : ''}`.trim());
    }
    try {
      await autosave.flush();
    } catch (err) {
      throw new Error(`Your changes could not be saved, so nothing was done. ${err instanceof Error ? err.message : ''}`.trim());
    }
    if (approving && autosave.changedElsewhere.length > 0) {
      throw new Error(`${autosave.changedElsewhere.map((f) => `“${FIELD_LABEL[f]}”`).join(' and ')} was changed elsewhere while you were reviewing. Read the updated text, tick “I have read the updated text”, then approve.`);
    }
  };

  const { data: contributionOverview } = useQuery({
    queryKey: ['reportContributions', reportId],
    queryFn: () => getReportContributionOverview(reportId),
    enabled: expanded,
  });
  const approvalBlockers = getApprovalBlockers(contributionOverview);
  const approvalBlocked = approvalBlockers.length > 0;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['reportContributions', reportId] });
    queryClient.invalidateQueries({ queryKey: ['report', reportId] });
    queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  };

  const approveMutation = useMutation({
    mutationFn: async () => {
      await saveEditsFirst(true);
      await approveReport(reportId, actor);
    },
    onSuccess: invalidate,
  });
  const resubmitMutation = useMutation({
    mutationFn: async () => {
      await saveEditsFirst();
      await resubmitReport(reportId, actor);
    },
    onSuccess: invalidate,
  });

  const returnMutation = useMutation({
    mutationFn: async () => {
      await saveEditsFirst();
      await returnReportForCorrection(reportId, returnReason, actor);
    },
    onSuccess: () => {
      invalidate();
      setShowReturnForm(false);
      setReturnReason('');
    },
  });

  return (
    <div className="mt-3 border border-neutral-300 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className="font-heading text-[10.5px] font-semibold tracking-[0.09em] text-neutral-700 uppercase">Report ·</span>
        <StatusPill presentation={getReportReviewStatusPresentation(reviewStatus)} />
        <button onClick={() => setExpanded((e) => !e)} className="ml-auto cursor-pointer text-[11px] text-teal-700 hover:underline">
          {expanded ? 'Hide' : 'View'}
        </button>
      </div>

      {expanded && report && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="text-[11px] text-neutral-500">
            Submitted by {report.submittedBy} · {new Date(report.submittedAt).toLocaleString('en-GB')}
          </div>

          {/* A completed report cannot be returned for correction (or have a technician's section sent back) until it is reopened. */}
          {(report.completedAt ?? null) != null && <ReopenFirstNotice completedBy={report.completedBy ?? null} completedAt={report.completedAt ?? null} />}

          {contributionOverview?.contributionMode && (
            <ReportContributionsSection
              reportId={reportId}
              reviewStatus={report.reviewStatus}
              completed={(report.completedAt ?? null) != null}
              actor={actor}
              overview={contributionOverview}
              onCombinedReset={async () => {
                // The text was just reset from the technicians' versions: drop local edits and take the stored text as the new starting point.
                try {
                  autosave.discard(textOf(await readFreshReport()));
                } catch {
                  autosave.discard();
                }
              }}
            />
          )}

          {report.specMet ? (
            <div className="text-[11.5px] text-neutral-500">Specification: Completed</div>
          ) : (
            <div className="border border-due bg-due/10 px-2 py-1.5 text-[11.5px] font-semibold text-due-fg">
              Specification: Not fully completed
            </div>
          )}

          {report.reviewStatus === 'returned_for_correction' && report.returnReason && (
            <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
              Returned: {report.returnReason}
            </div>
          )}

          <div>
            <div className="mb-1 font-heading text-[10.5px] font-semibold tracking-[0.09em] text-neutral-700 uppercase">Photos</div>
            <ReportPhotos reportId={reportId} visitId={report.visitId} completed={(report.completedAt ?? null) != null} actor={actor} />
          </div>

          <div>
            <div className="mb-1 font-heading text-[10.5px] font-semibold tracking-[0.09em] text-neutral-700 uppercase">Videos</div>
            <ReportVideos
              reportId={reportId}
              visitId={report.visitId}
              reviewStatus={report.reviewStatus}
              reviewedAt={report.reviewedAt}
              completed={(report.completedAt ?? null) != null}
              actor={actor}
            />
          </div>

          {lockReason && (
            <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[11.5px] text-neutral-700" data-testid="text-locked-note">
              {lockReason}
            </div>
          )}
          {(['workCarriedOut', 'issues', 'technicianNotes'] as TextField[]).map((field) => (
            <div key={field} className="flex flex-col gap-1">
              <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                {FIELD_LABEL[field]}
                <AutoGrowTextarea
                  value={autosave.value(field)}
                  readOnly={textLocked}
                  onChange={(e) => autosave.edit(field, e.target.value)}
                  onBlur={() => autosave.blur()}
                  className={TEXT_BOX}
                />
              </label>
              {conflicts.includes(field) && (
                <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg" role="alert" data-testid={`text-conflict-${field}`}>
                  <div className="font-semibold">“{FIELD_LABEL[field]}” was changed elsewhere while you were editing it.</div>
                  <div className="mt-1 text-neutral-600">Your version is kept below and is not saved yet. The newer text is:</div>
                  <div className="mt-1 max-h-40 overflow-y-auto border border-neutral-300 bg-white p-1.5 whitespace-pre-wrap text-ink">{autosave.serverText(field) || '(empty)'}</div>
                  <div className="mt-1.5 flex gap-1.5">
                    <button onClick={() => autosave.keepMine(field)} className="cursor-pointer border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-700">
                      Keep my version
                    </button>
                    <button onClick={() => autosave.useTheirs(field)} className="cursor-pointer border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-700">
                      Use the newer text
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {changedElsewhere.length > 0 && (
            <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg" role="alert" data-testid="text-changed-elsewhere">
              <div className="font-semibold">
                {changedElsewhere.map((f) => `“${FIELD_LABEL[f]}”`).join(' and ')} was changed elsewhere (for example a technician resubmitted). The updated text is shown above.
              </div>
              <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-neutral-700">
                <input type="checkbox" onChange={(e) => e.target.checked && autosave.acknowledgeExternalChanges()} />
                I have read the updated text
              </label>
            </div>
          )}
          <div className="min-h-[14px] text-[10.5px] text-neutral-500" aria-live="polite" data-testid="autosave-status">
            {autosave.current.status === 'pending' && 'Changes save automatically…'}
            {autosave.current.status === 'saving' && 'Saving…'}
            {autosave.current.status === 'saved' && 'All changes saved'}
            {autosave.current.status === 'conflict' && 'Not saved yet: choose which version to keep (see above).'}
            {autosave.current.status === 'error' && (
              <span role="alert" className="text-missed-fg">
                Your changes could not be saved. {autosave.current.error}{' '}
                <button onClick={() => autosave.blur()} className="cursor-pointer underline">
                  Try again
                </button>
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap gap-1.5">
            {report.reviewStatus === 'awaiting_review' && (
              <>
                <button
                  onClick={() => approveMutation.mutate()}
                  disabled={approveMutation.isPending || approvalBlocked || textBlocksApproval}
                  title={approvalBlocked ? approvalBlockers.join(' ') : textBlocksApproval ? 'Read the updated text first.' : undefined}
                  className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  onClick={() => setShowReturnForm((s) => !s)}
                  className="cursor-pointer border border-due px-2.5 py-1 text-[11px] text-due-fg"
                >
                  Return for correction
                </button>
              </>
            )}
            {report.reviewStatus === 'returned_for_correction' && (
              <>
                {/* In a multi-technician report each technician resubmits their own part; a whole-report Resubmit would leave flagged contributions behind. */}
                {!contributionOverview?.contributionMode && (
                  <button
                    onClick={() => resubmitMutation.mutate()}
                    disabled={resubmitMutation.isPending}
                    className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700"
                  >
                    Resubmit
                  </button>
                )}
                <button
                  onClick={() => approveMutation.mutate()}
                  disabled={approveMutation.isPending || approvalBlocked || textBlocksApproval}
                  title={approvalBlocked ? approvalBlockers.join(' ') : textBlocksApproval ? 'Read the updated text first.' : undefined}
                  className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Approve directly
                </button>
              </>
            )}
          </div>

          {approvalBlocked && reviewStatus !== 'approved' && (
            <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
              <div className="font-semibold">Cannot approve yet</div>
              {approvalBlockers.map((b) => (
                <div key={b}>{b}</div>
              ))}
            </div>
          )}
          {resubmitMutation.error && (
            <div className="text-[11px] text-missed-fg" role="alert">
              {resubmitMutation.error instanceof Error ? resubmitMutation.error.message : 'Failed to resubmit.'}
            </div>
          )}
          {approveMutation.error && (
            <div className="text-[11px] text-missed-fg">
              {approveMutation.error instanceof Error ? approveMutation.error.message : 'Failed to approve.'}
            </div>
          )}

          {showReturnForm && (
            <div className="mt-1 flex flex-col gap-1.5 border border-due bg-due/10 p-2">
              <label className="flex flex-col gap-1 text-[11px] text-due-fg">
                Reason (required)
                <textarea
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  rows={2}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                />
              </label>
              {returnError && <div className="text-[11px] text-missed-fg">{returnError}</div>}
              {returnMutation.error && (
                <div className="text-[11px] text-missed-fg" role="alert">
                  {returnMutation.error instanceof Error ? returnMutation.error.message : 'Failed to return the report.'}
                </div>
              )}
              <button
                onClick={() => {
                  if (!returnReason.trim()) {
                    setReturnError('Enter a reason for returning this report.');
                    return;
                  }
                  setReturnError(null);
                  returnMutation.mutate();
                }}
                disabled={returnMutation.isPending}
                className="w-fit cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white"
              >
                {returnMutation.isPending ? 'Returning…' : 'Confirm return'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
