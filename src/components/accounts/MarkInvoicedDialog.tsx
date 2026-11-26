import FormDialog from '../ui/FormDialog';
import type { JobRow, JobVisitSummary } from '../../domain/types';

interface MarkInvoicedDialogProps {
  rows: { job: JobRow; visit: JobVisitSummary }[];
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The confirmation before "Mark as already invoiced": says plainly that this is a manual record, that nothing is created or sent
 * in Xero, and lists exactly what will move to Records. Closed only by Cancel, the close button or Escape (FormDialog).
 */
export default function MarkInvoicedDialog({ rows, pending, error, onConfirm, onCancel }: MarkInvoicedDialogProps) {
  const n = rows.length;
  const noun = n === 1 ? 'visit' : 'visits';
  return (
    <FormDialog
      eyebrow="Manual reconciliation"
      title={`Mark ${n} ${noun} as already invoiced?`}
      onClose={pending ? () => {} : onCancel}
      testId="mark-invoiced-dialog"
      width={560}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5 text-[12.5px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || n === 0}
            data-testid="mark-invoiced-confirm"
            className="cursor-pointer rounded-md bg-teal px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? 'Marking…' : `Mark ${n} as already invoiced`}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-[12.5px] text-ink">
        <p>
          Use this only for work you have <strong>already invoiced yourself in Xero</strong>. {n === 1 ? 'It' : `These ${n} ${noun}`} will move from Ready for
          accounts to Records, marked <em>Invoiced outside JMS</em>.
        </p>
        <p className="rounded-md border border-teal-700/40 bg-teal-100/60 px-3 py-2 text-teal-700">
          JMS will not create, update or send anything in Xero. No Xero invoice number is recorded - check Xero for it.
        </p>
        <p className="text-neutral-600">This can't be undone from JMS.</p>
        <ul className="max-h-56 overflow-y-auto rounded-md border border-divider" data-testid="mark-invoiced-list">
          {rows.map(({ job, visit }) => {
            const amount = visit.priceCharged ?? job.pricePerVisit;
            return (
              <li key={visit.id} className="flex items-baseline justify-between gap-3 border-b border-divider px-3 py-1.5 last:border-b-0">
                <span className="min-w-0">
                  <span className="font-semibold">{job.buildingName}</span>
                  <span className="text-neutral-600">
                    {' · '}
                    {visit.scheduledDate ? new Date(visit.scheduledDate).toLocaleDateString('en-GB') : 'No date'}
                    {visit.invoiceId ? ` · ${visit.invoiceStatus === 'failed' ? 'failed invoice' : 'draft invoice'}` : ''}
                  </span>
                </span>
                {/* A draft's own lines (which may have been edited) are kept exactly as they are - so no visit price is shown for it. */}
                <span className="flex-none tabular-nums text-neutral-700">
                  {visit.invoiceId ? 'as on the invoice' : amount != null ? money(amount) : 'Variable'}
                </span>
              </li>
            );
          })}
        </ul>
        {error && (
          <div role="alert" className="rounded-md border border-missed bg-missed/10 px-3 py-2 text-missed-fg" data-testid="mark-invoiced-error">
            {error}
          </div>
        )}
      </div>
    </FormDialog>
  );
}
