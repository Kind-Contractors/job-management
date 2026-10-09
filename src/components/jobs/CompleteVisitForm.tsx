import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../../domain/types';
import { completeVisit } from '../../repository/reportsRepository';

function nowLocalDateTime(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** The one validation this form has always had: a price must be entered (an empty box is refused; the database also refuses a completed visit without one). */
export function completionPriceError(price: string): string | null {
  return price ? null : 'Enter a price charged.';
}

interface CompleteVisitFormProps {
  job: JobRow;
  visit: JobVisitSummary;
  actor: string;
  /** Called after the server has confirmed the visit is completed. */
  onDone: () => void;
  onCancel: () => void;
}

/**
 * The one "Mark complete" form for a visit: the price charged (a variable-price job asks for the actual amount) and
 * when it was completed. Used by the Job Inspector's visit row and by Ready for accounts (for an open visit on a
 * cancelled/closed job). It only ever calls completeVisit() - one update of the visit (status, price, completion time) plus
 * its audit event - so it never touches the job: completing a visit does not reopen or reactivate its job.
 */
export default function CompleteVisitForm({ job, visit, actor, onDone, onCancel }: CompleteVisitFormProps) {
  const queryClient = useQueryClient();
  const [price, setPrice] = useState(job.pricePerVisit != null ? String(job.pricePerVisit) : '');
  const [completedAt, setCompletedAt] = useState(nowLocalDateTime());
  const [error, setError] = useState<string | null>(null);

  const completeMutation = useMutation({
    mutationFn: () => completeVisit(visit.id, Number(price), new Date(completedAt).toISOString(), actor),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
      setError(null);
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to mark complete.'),
  });

  return (
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
            const problem = completionPriceError(price);
            if (problem) {
              setError(problem);
              return;
            }
            completeMutation.mutate();
          }}
          disabled={completeMutation.isPending}
          className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
        >
          {completeMutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600">
          Cancel
        </button>
      </div>
    </div>
  );
}
