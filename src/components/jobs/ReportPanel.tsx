import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveReport,
  getReport,
  resubmitReport,
  returnReportForCorrection,
  sendReportToAccounts,
  sendReportToClient,
  updateReport,
} from '../../repository/reportsRepository';
import { getReportReviewStatusPresentation } from '../../lib/statusPresentation';
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
 * The one report-review/approve/return/resubmit/send surface in the app —
 * used by VisitRow.tsx inline in the Job Inspector, and by
 * ReportReviewPage.tsx's dedicated queue. Deliberately decoupled from both
 * callers' surrounding markup (only these four primitive props), so there is
 * exactly one implementation of this workflow to keep correct, not two.
 */
export default function ReportPanel({ reportId, reviewStatus, actor, readyForAccounts }: ReportPanelProps) {
  const queryClient = useQueryClient();
  // Auto-open whenever this report is actually actionable — this is what
  // makes the Job Inspector's "review" banner (see JobInspectorDrawer.tsx)
  // land the manager straight on the thing they need to act on, with no
  // extra click and no separate expand/scroll plumbing between components.
  // Approved-but-unsent (readyForAccounts) is equally actionable — a manager
  // arriving via the "Ready for accounts" rail item should see the Send to
  // accounts button already open, not one more click away.
  const [expanded, setExpanded] = useState(reviewStatus !== 'approved' || readyForAccounts);
  const [returnReason, setReturnReason] = useState('');
  const [returnError, setReturnError] = useState<string | null>(null);
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [editWork, setEditWork] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState<string | null>(null);

  const { data: report } = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => getReport(reportId),
    enabled: expanded,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['report', reportId] });
    queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  };

  const saveEditsMutation = useMutation({
    mutationFn: () => updateReport(reportId, { workCarriedOut: editWork ?? undefined, technicianNotes: editNotes ?? undefined }),
    onSuccess: () => {
      invalidate();
      setEditWork(null);
      setEditNotes(null);
    },
  });

  const approveMutation = useMutation({ mutationFn: () => approveReport(reportId, actor), onSuccess: invalidate });
  const resubmitMutation = useMutation({ mutationFn: () => resubmitReport(reportId, actor), onSuccess: invalidate });
  const sendClientMutation = useMutation({ mutationFn: () => sendReportToClient(reportId, actor), onSuccess: invalidate });
  const sendAccountsMutation = useMutation({ mutationFn: () => sendReportToAccounts(reportId, actor), onSuccess: invalidate });

  const returnMutation = useMutation({
    mutationFn: () => returnReportForCorrection(reportId, returnReason, actor),
    onSuccess: () => {
      invalidate();
      setShowReturnForm(false);
      setReturnReason('');
    },
  });

  return (
    <div className="mt-2 border border-neutral-300 p-2.5">
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

          {report.reviewStatus === 'returned_for_correction' && report.returnReason && (
            <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
              Returned: {report.returnReason}
            </div>
          )}

          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Work carried out
            <textarea
              value={editWork ?? report.workCarriedOut ?? ''}
              onChange={(e) => setEditWork(e.target.value)}
              rows={2}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Notes
            <textarea
              value={editNotes ?? report.technicianNotes ?? ''}
              onChange={(e) => setEditNotes(e.target.value)}
              rows={2}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          {(editWork !== null || editNotes !== null) && (
            <button
              onClick={() => saveEditsMutation.mutate()}
              disabled={saveEditsMutation.isPending}
              className="w-fit cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700"
            >
              {saveEditsMutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
          )}

          <div className="mt-1 flex flex-wrap gap-1.5">
            {report.reviewStatus === 'awaiting_review' && (
              <>
                <button
                  onClick={() => approveMutation.mutate()}
                  disabled={approveMutation.isPending}
                  className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white"
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
                <button
                  onClick={() => resubmitMutation.mutate()}
                  disabled={resubmitMutation.isPending}
                  className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700"
                >
                  Resubmit
                </button>
                <button
                  onClick={() => approveMutation.mutate()}
                  disabled={approveMutation.isPending}
                  className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white"
                >
                  Approve directly
                </button>
              </>
            )}
            {report.reviewStatus === 'approved' && (
              <>
                <button
                  onClick={() => sendClientMutation.mutate()}
                  disabled={sendClientMutation.isPending || !!report.sentToClientAt}
                  className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500"
                >
                  {report.sentToClientAt
                    ? `Sent to client ${new Date(report.sentToClientAt).toLocaleDateString('en-GB')}`
                    : 'Send to client'}
                </button>
                <button
                  onClick={() => sendAccountsMutation.mutate()}
                  disabled={sendAccountsMutation.isPending || !!report.sentToAccountsAt}
                  className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500"
                >
                  {report.sentToAccountsAt
                    ? `Sent to accounts ${new Date(report.sentToAccountsAt).toLocaleDateString('en-GB')}`
                    : 'Send to accounts'}
                </button>
              </>
            )}
          </div>

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
