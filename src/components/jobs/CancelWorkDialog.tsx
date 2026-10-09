import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../../domain/types';
import { cancelJobWork, type CancelWorkResult, type CancelWorkScope } from '../../repository/jobsRepository';
import { isOpenVisit, planCancelWork } from '../../lib/cancelWork';

function dateLabel(date: string | null): string {
  return date ? new Date(date).toLocaleDateString('en-GB') : 'No date set';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const OPTIONS: { scope: CancelWorkScope; title: string; text: string; needsVisit: boolean }[] = [
  {
    scope: 'visit',
    title: 'Cancel this visit only',
    text: 'Cancel only this scheduled visit. The recurring job and other visits will remain active.',
    needsVisit: true,
  },
  {
    scope: 'this_and_future',
    title: 'Cancel this and all future visits',
    text: 'Cancel this visit and all future scheduled visits. Past work will remain unchanged.',
    needsVisit: true,
  },
  {
    scope: 'job',
    title: 'Cancel the entire job',
    text: 'Remove this job from the active schedule and close it. Historical visits, reports, photos and invoices will be kept.',
    needsVisit: false,
  },
];

interface CancelWorkDialogProps {
  job: JobRow;
  /** The visit the cancellation starts from (Job Inspector visit row, Schedule day drawer). Null from the Job status panel, where only "the entire job" applies. */
  visit: JobVisitSummary | null;
  onClose: () => void;
  /** Called after the server has confirmed (and the person has seen any "kept" notice). result.lifecycleStatus === 'cancelled' means the job itself moved to Historical Jobs, so a caller showing that job should close. */
  onDone: (result: CancelWorkResult) => void;
}

/**
 * The one cancellation dialog, used from the Job Inspector (a visit row, and the Job status panel) and from the Schedule
 * day drawer. Three choices - this visit, this and all future visits, the entire job - with the exact number of visits
 * affected, a warning for any visit that has to be kept, and an optional reason. Nothing is deleted: history stays
 * available. All the work is one database call (cancel_job_work), never partial writes from the browser.
 */
export default function CancelWorkDialog({ job, visit, onClose, onDone }: CancelWorkDialogProps) {
  const queryClient = useQueryClient();
  const startVisit = visit && isOpenVisit(visit) ? visit : null;
  const [scope, setScope] = useState<CancelWorkScope>(startVisit ? 'visit' : 'job');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<CancelWorkResult | null>(null);

  const plan = planCancelWork(job, scope, startVisit);
  const nothingToCancel = scope !== 'job' && plan.willCancel.length === 0;

  const mutation = useMutation({
    mutationFn: () =>
      cancelJobWork({ jobId: job.id, scope, fromVisitId: scope === 'job' ? null : (startVisit?.id ?? null), reason: reason.trim() || null }),
    onSuccess: (res) => {
      // Server-confirmed - only now do the schedule, the queues and Historical Jobs refetch.
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
      queryClient.invalidateQueries({ queryKey: ['historicalJobRows'] });
      if (res.keptVisits.length === 0) {
        onDone(res);
      } else {
        setResult(res);
      }
    },
  });

  const subtitle = `${job.buildingName} · ${job.jobSummary}${startVisit ? ` · ${dateLabel(startVisit.scheduledDate)}` : ''}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={result ? undefined : onClose}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[85vh] w-[460px] overflow-y-auto border border-neutral-300 bg-white p-4">
        <div className="border-b border-divider pb-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Cancel</div>
          <h2 className="mt-1 font-heading text-lg font-semibold">What do you want to cancel?</h2>
          <div className="text-[12.5px] text-neutral-600">{subtitle}</div>
        </div>

        {result ? (
          <div className="mt-3 flex flex-col gap-2.5">
            <div role="status" className="text-[12.5px] text-ink">
              {plural(result.cancelledVisitIds.length, 'visit was', 'visits were')} cancelled.
            </div>
            <div role="alert" className="border border-due bg-due/10 p-3 text-[12.5px] text-due-fg">
              {plural(result.keptVisits.length, 'visit was', 'visits were')} not cancelled because{' '}
              {result.keptVisits.length === 1 ? 'it already has' : 'they already have'} a report or an invoice. They stay in Report review,
              Ready for client and Ready for accounts until finished.
              <ul className="mt-1.5 list-inside list-disc">
                {result.keptVisits.map((k) => (
                  <li key={k.id}>{dateLabel(k.scheduledDate)}</li>
                ))}
              </ul>
            </div>
            <button onClick={() => onDone(result)} className="mt-1 w-fit cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white">
              Done
            </button>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2.5">
            <div role="radiogroup" aria-label="What to cancel" className="flex flex-col gap-1.5">
              {OPTIONS.map((o) => {
                const disabled = o.needsVisit && !startVisit;
                const selected = scope === o.scope;
                return (
                  <label
                    key={o.scope}
                    className={`flex gap-2 border p-2.5 ${selected ? 'border-teal bg-teal-100/40' : 'border-neutral-300'} ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                  >
                    <input
                      type="radio"
                      name="cancel-scope"
                      value={o.scope}
                      checked={selected}
                      disabled={disabled || mutation.isPending}
                      onChange={() => setScope(o.scope)}
                      className="mt-0.5 accent-teal"
                    />
                    <span className="flex flex-col">
                      <span className="text-[12.5px] font-semibold text-ink">{o.title}</span>
                      <span className="text-[12px] text-neutral-600">{o.text}</span>
                      {disabled && <span className="text-[11.5px] text-neutral-500">Choose a visit to use this option.</span>}
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="text-[12.5px] text-ink" aria-live="polite">
              {scope === 'visit' && plan.willCancel.length === 1 && `1 visit will be cancelled (${dateLabel(startVisit?.scheduledDate ?? null)}).`}
              {scope === 'this_and_future' &&
                plan.willCancel.length > 0 &&
                `${plural(plan.willCancel.length, 'visit', 'visits')} will be cancelled, from ${dateLabel(startVisit?.scheduledDate ?? null)}. The job stays active and won’t ask for new work after that date.`}
              {scope === 'job' &&
                (plan.willCancel.length > 0
                  ? `${plural(plan.willCancel.length, 'scheduled visit', 'scheduled visits')} will be cancelled and the job will move to Historical Jobs.`
                  : 'There are no scheduled visits to cancel. The job will move to Historical Jobs.')}
              {nothingToCancel && plan.kept.length === 0 && 'There are no scheduled visits to cancel.'}
            </div>

            {plan.kept.length > 0 && (
              <div role="alert" className="border border-due bg-due/10 p-3 text-[12.5px] text-due-fg">
                {plural(plan.kept.length, 'visit', 'visits')} already {plan.kept.length === 1 ? 'has' : 'have'} a report or an invoice, so{' '}
                {plan.kept.length === 1 ? 'it won’t' : 'they won’t'} be cancelled. {plan.kept.length === 1 ? 'It stays' : 'They stay'} in the report
                queues until finished.
                <ul className="mt-1.5 list-inside list-disc">
                  {plan.kept.map((k) => (
                    <li key={k.visit.id}>
                      {dateLabel(k.visit.scheduledDate)} — {k.reason === 'has_invoice' ? 'has an invoice' : 'has a report'}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              Reason (optional)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                disabled={mutation.isPending}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
            </label>

            <div className="text-[11.5px] text-neutral-500">
              Nothing is deleted. Completed visits, reports, photos and invoices stay available in the job’s history.
            </div>

            {mutation.isError && (
              <div role="alert" className="text-[11.5px] text-missed-fg">
                {mutation.error instanceof Error ? mutation.error.message : 'Failed to cancel.'}
              </div>
            )}

            <div className="mt-1 flex gap-1.5">
              <button
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending || nothingToCancel}
                className="cursor-pointer bg-missed px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {mutation.isPending ? 'Cancelling…' : 'Confirm cancellation'}
              </button>
              <button
                onClick={onClose}
                disabled={mutation.isPending}
                className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Keep
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
