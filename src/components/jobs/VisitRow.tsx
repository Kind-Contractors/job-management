import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../../domain/types';
import {
  approveReport,
  completeVisit,
  createReport,
  getReport,
  markVisitCancelled,
  markVisitMissed,
  resubmitReport,
  returnReportForCorrection,
  sendReportToAccounts,
  sendReportToClient,
  updateReport,
} from '../../repository/reportsRepository';

function nowLocalDateTime(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function invalidateAfterVisitChange(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  queryClient.invalidateQueries({ queryKey: ['weekVisits'] });
}

interface VisitRowProps {
  job: JobRow;
  visit: JobVisitSummary;
  actor: string;
}

export default function VisitRow({ job, visit, actor }: VisitRowProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'summary' | 'complete' | 'report'>('summary');
  const [price, setPrice] = useState(job.pricePerVisit != null ? String(job.pricePerVisit) : '');
  const [completedAt, setCompletedAt] = useState(nowLocalDateTime());
  const [error, setError] = useState<string | null>(null);

  const completeMutation = useMutation({
    mutationFn: () => completeVisit(visit.id, Number(price), new Date(completedAt).toISOString(), actor),
    onSuccess: () => {
      invalidateAfterVisitChange(queryClient);
      setMode('summary');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to mark complete.'),
  });

  const missedMutation = useMutation({
    mutationFn: () => markVisitMissed(visit.id, actor),
    onSuccess: () => invalidateAfterVisitChange(queryClient),
  });

  const cancelledMutation = useMutation({
    mutationFn: () => markVisitCancelled(visit.id, actor),
    onSuccess: () => invalidateAfterVisitChange(queryClient),
  });

  const dateLabel = visit.scheduledDate ? new Date(visit.scheduledDate).toLocaleDateString('en-GB') : 'No date set';

  return (
    <div className="border-b border-divider py-1.5 text-[12.5px]">
      <div className="flex justify-between gap-3">
        <span className="capitalize">
          {visit.status}
          {visit.teamName && <span className="text-neutral-500"> · {visit.teamName}</span>}
          {visit.priceCharged != null && (
            <span className="text-neutral-500"> · £{visit.priceCharged.toLocaleString('en-GB')}</span>
          )}
        </span>
        <span className="tabular-nums text-neutral-600">{dateLabel}</span>
      </div>

      {(visit.status === 'due' || visit.status === 'booked') && mode === 'summary' && (
        <div className="mt-1 flex gap-2">
          <button onClick={() => setMode('complete')} className="cursor-pointer text-[11px] text-teal-700 hover:underline">
            Mark complete
          </button>
          <button
            onClick={() => missedMutation.mutate()}
            disabled={missedMutation.isPending}
            className="cursor-pointer text-[11px] text-missed-fg hover:underline"
          >
            Mark missed
          </button>
          <button
            onClick={() => cancelledMutation.mutate()}
            disabled={cancelledMutation.isPending}
            className="cursor-pointer text-[11px] text-neutral-500 hover:underline"
          >
            Mark cancelled
          </button>
        </div>
      )}

      {mode === 'complete' && (
        <div className="mt-2 flex flex-col gap-1.5 border border-neutral-300 bg-neutral-100 p-2.5">
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Price charged {job.pricePerVisit == null && <span className="text-due-fg">(variable job — enter actual amount)</span>}
            <input
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Completed at
            <input
              type="datetime-local"
              value={completedAt}
              onChange={(e) => setCompletedAt(e.target.value)}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          {error && <div className="text-[11px] text-missed-fg">{error}</div>}
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                if (!price) {
                  setError('Enter a price charged.');
                  return;
                }
                completeMutation.mutate();
              }}
              disabled={completeMutation.isPending}
              className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
            >
              {completeMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setMode('summary')} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600">
              Cancel
            </button>
          </div>
        </div>
      )}

      {visit.status === 'completed' && !visit.reportId && mode === 'summary' && (
        <div className="mt-1">
          <button onClick={() => setMode('report')} className="cursor-pointer text-[11px] text-teal-700 hover:underline">
            Create report
          </button>
        </div>
      )}
      {mode === 'report' && !visit.reportId && (
        <CreateReportForm
          visitId={visit.id}
          actor={actor}
          onDone={() => {
            invalidateAfterVisitChange(queryClient);
            setMode('summary');
          }}
          onCancel={() => setMode('summary')}
        />
      )}

      {visit.reportId && visit.reportReviewStatus && (
        <ReportPanel reportId={visit.reportId} reviewStatus={visit.reportReviewStatus} actor={actor} />
      )}
    </div>
  );
}

interface CreateReportFormProps {
  visitId: string;
  actor: string;
  onDone: () => void;
  onCancel: () => void;
}

function CreateReportForm({ visitId, actor, onDone, onCancel }: CreateReportFormProps) {
  const [workCarriedOut, setWorkCarriedOut] = useState('');
  const [technicianNotes, setTechnicianNotes] = useState('');
  const [issues, setIssues] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createReport(visitId, actor, {
        workCarriedOut: workCarriedOut || null,
        technicianNotes: technicianNotes || null,
        issues: issues || null,
        onSiteStart: null,
        onSiteEnd: null,
        includePhotos: true,
        includeNotes: true,
        includeIssues: true,
        includePrice: false,
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create report.'),
  });

  return (
    <div className="mt-2 flex flex-col gap-1.5 border border-neutral-300 bg-neutral-100 p-2.5">
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Work carried out
        <textarea
          value={workCarriedOut}
          onChange={(e) => setWorkCarriedOut(e.target.value)}
          rows={2}
          className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Notes
        <textarea
          value={technicianNotes}
          onChange={(e) => setTechnicianNotes(e.target.value)}
          rows={2}
          className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Issues
        <textarea
          value={issues}
          onChange={(e) => setIssues(e.target.value)}
          rows={2}
          className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
        />
      </label>
      <div className="text-[11px] text-neutral-500">No photos on this visit yet.</div>
      {error && <div className="text-[11px] text-missed-fg">{error}</div>}
      <div className="flex gap-1.5">
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
        >
          {createMutation.isPending ? 'Saving…' : 'Save report'}
        </button>
        <button onClick={onCancel} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600">
          Cancel
        </button>
      </div>
    </div>
  );
}

interface ReportPanelProps {
  reportId: string;
  reviewStatus: 'awaiting_review' | 'approved' | 'returned_for_correction';
  actor: string;
}

const REVIEW_LABEL: Record<ReportPanelProps['reviewStatus'], string> = {
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  returned_for_correction: 'Returned for correction',
};

function ReportPanel({ reportId, reviewStatus, actor }: ReportPanelProps) {
  const queryClient = useQueryClient();
  // Auto-open whenever this report is actually actionable — this is what
  // makes the Job Inspector's "review" banner (see JobInspectorDrawer.tsx)
  // land the manager straight on the thing they need to act on, with no
  // extra click and no separate expand/scroll plumbing between components.
  const [expanded, setExpanded] = useState(reviewStatus !== 'approved');
  const [returnReason, setReturnReason] = useState('');
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
        <span className="font-heading text-[10.5px] font-semibold tracking-[0.09em] text-neutral-700 uppercase">
          Report · {REVIEW_LABEL[reviewStatus]}
        </span>
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
              <button
                onClick={() => {
                  if (!returnReason.trim()) return;
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
