import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  resetCombinedReport,
  returnContributionForCorrection,
  waiveContribution,
  type ReportContributionOverview,
  type ReportParticipant,
} from '../../repository/reportsRepository';

interface ReportContributionsSectionProps {
  reportId: string;
  reviewStatus: 'awaiting_review' | 'approved' | 'returned_for_correction';
  /** True when a manager has marked the report Completed. A completed report is approved, so a technician's section cannot be sent back until it is reopened. */
  completed?: boolean;
  actor: string;
  overview: ReportContributionOverview;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function statusLabel(p: ReportParticipant): { text: string; className: string } {
  if (p.status === 'waived') return { text: 'Waived', className: 'border-neutral-300 text-neutral-600' };
  if (p.status === 'submitted' && p.needsCorrection) return { text: 'Correction requested', className: 'border-due bg-due/10 text-due-fg' };
  if (p.status === 'submitted') return { text: 'Submitted', className: 'border-done text-done-fg' };
  return { text: 'Pending', className: 'border-due text-due-fg' };
}

/**
 * Per-technician view of a multi-technician report: progress summary, each
 * technician's own contribution, per-technician return-for-correction and
 * waive. Only rendered for reports that have contributions; the ordinary
 * single-technician report never reaches this component.
 */
export default function ReportContributionsSection({ reportId, reviewStatus, completed = false, actor, overview }: ReportContributionsSectionProps) {
  const queryClient = useQueryClient();
  const [returningId, setReturningId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { participants, managerEditedAt } = overview;
  const submitted = participants.filter((p) => p.status === 'submitted').length;
  const waived = participants.filter((p) => p.status === 'waived').length;
  const pending = participants.filter((p) => p.status === 'pending');
  // The database would pull an approved report back to "returned" if a contribution were flagged after approval.
  const editable = reviewStatus !== 'approved';

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['report', reportId] });
    queryClient.invalidateQueries({ queryKey: ['reportContributions', reportId] });
    queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  };

  const returnMutation = useMutation({
    mutationFn: (p: ReportParticipant) => returnContributionForCorrection(reportId, p.technicianId, p.name, reason.trim(), actor),
    onSuccess: () => {
      refresh();
      setReturningId(null);
      setReason('');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to return contribution.'),
  });

  const waiveMutation = useMutation({
    mutationFn: (p: ReportParticipant) => waiveContribution(reportId, p.technicianId, p.name, actor),
    onSuccess: () => {
      refresh();
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to waive technician.'),
  });

  const resetMutation = useMutation({
    mutationFn: () => resetCombinedReport(reportId),
    onSuccess: () => {
      refresh();
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to rebuild combined report.'),
  });

  return (
    <div className="flex flex-col gap-1.5 border border-neutral-300 bg-neutral-50 p-2">
      <div className="font-heading text-[10.5px] font-semibold tracking-[0.09em] text-neutral-700 uppercase">
        Technicians · {participants.length} assigned · {submitted} submitted
        {waived > 0 && ` · ${waived} waived`}
        {pending.length > 0 && ` · ${pending.length} pending`}
      </div>

      {pending.length > 0 && (
        <div className="text-[11.5px] text-due-fg">Still to submit: {pending.map((p) => p.name).join(', ')}</div>
      )}

      {completed && (
        <div role="note" className="border border-done bg-done/10 p-1.5 text-[11px] text-done-fg">
          This report is Completed, so a technician&rsquo;s section can&rsquo;t be sent back for correction. Reopen it first (Ready for client &rarr; Completed &rarr; Reopen).
        </div>
      )}

      {managerEditedAt && (
        <div className="flex flex-wrap items-center gap-2 border border-neutral-300 bg-white p-1.5 text-[11px] text-neutral-600">
          <span>
            The combined text below was edited by the office on {dateTimeFmt.format(new Date(managerEditedAt))}. Later
            technician submissions are not merged into it.
          </span>
          <button
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending || !editable}
            className="cursor-pointer border border-neutral-300 px-2 py-0.5 text-teal-700 disabled:cursor-not-allowed disabled:text-neutral-400"
          >
            {resetMutation.isPending ? 'Rebuilding…' : 'Rebuild from contributions'}
          </button>
        </div>
      )}

      {participants.map((p) => {
        const label = statusLabel(p);
        const laterThanEdit = managerEditedAt != null && p.submittedAt != null && p.submittedAt >= managerEditedAt;
        return (
          <div key={p.technicianId} className="flex flex-col gap-1 border border-neutral-300 bg-white p-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="font-semibold text-ink">{p.name}</span>
              {p.isPrimary && <span className="text-[10.5px] text-neutral-500">primary</span>}
              {!p.isActive && <span className="text-[10.5px] text-neutral-400">deactivated</span>}
              <span className={`border px-1.5 py-0.5 text-[10.5px] font-semibold ${label.className}`}>{label.text}</span>
              {p.submittedAt && (
                <span className="text-[10.5px] text-neutral-500">
                  submitted {dateTimeFmt.format(new Date(p.submittedAt))}
                  {laterThanEdit && ' · after the office edit'}
                </span>
              )}
              {p.status === 'waived' && p.waivedAt && (
                <span className="text-[10.5px] text-neutral-500">
                  by {p.waivedBy} · {dateTimeFmt.format(new Date(p.waivedAt))}
                </span>
              )}
            </div>

            {p.status === 'submitted' && (
              <div className="flex flex-col gap-0.5 text-[11.5px] text-neutral-700">
                {p.onSiteStart && p.onSiteEnd && (
                  <div className="text-neutral-500">
                    On site {timeFmt.format(new Date(p.onSiteStart))} to {timeFmt.format(new Date(p.onSiteEnd))} ·{' '}
                    {p.specMet ? 'Specification completed' : 'Specification not fully completed'}
                  </div>
                )}
                {p.workCarriedOut && (
                  <div>
                    <span className="text-neutral-500">Work: </span>
                    {p.workCarriedOut}
                  </div>
                )}
                {p.issues && (
                  <div>
                    <span className="text-neutral-500">Issues: </span>
                    {p.issues}
                  </div>
                )}
                {p.technicianNotes && (
                  <div>
                    <span className="text-neutral-500">Notes: </span>
                    {p.technicianNotes}
                  </div>
                )}
              </div>
            )}

            {p.needsCorrection && p.correctionReason && (
              <div className="border border-due bg-due/10 p-1.5 text-[11.5px] text-due-fg">Returned: {p.correctionReason}</div>
            )}

            {editable && p.status === 'submitted' && !p.needsCorrection && returningId !== p.technicianId && (
              <button
                onClick={() => {
                  setReturningId(p.technicianId);
                  setReason('');
                  setError(null);
                }}
                className="w-fit cursor-pointer border border-due px-2 py-0.5 text-[11px] text-due-fg"
              >
                Return {p.name} for correction
              </button>
            )}

            {returningId === p.technicianId && (
              <div className="flex flex-col gap-1.5 border border-due bg-due/10 p-2">
                <label className="flex flex-col gap-1 text-[11px] text-due-fg">
                  Reason for {p.name} (required)
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                  />
                </label>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      if (!reason.trim()) {
                        setError(`Enter a reason for returning ${p.name} for correction.`);
                        return;
                      }
                      setError(null);
                      returnMutation.mutate(p);
                    }}
                    disabled={returnMutation.isPending}
                    className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white"
                  >
                    {returnMutation.isPending ? 'Returning…' : 'Confirm return'}
                  </button>
                  <button
                    onClick={() => setReturningId(null)}
                    className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {editable && p.status === 'pending' && (
              <button
                onClick={() => waiveMutation.mutate(p)}
                disabled={waiveMutation.isPending}
                title="Stops this technician blocking approval. They will not be able to add to this report."
                className="w-fit cursor-pointer border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700"
              >
                {waiveMutation.isPending ? 'Waiving…' : `Waive ${p.name}`}
              </button>
            )}
          </div>
        );
      })}

      {error && <div className="text-[11px] text-missed-fg">{error}</div>}
    </div>
  );
}
