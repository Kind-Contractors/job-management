import { useState } from 'react';
import type { InvoiceRecord } from '../../repository/invoiceRecordsRepository';
import { INVOICE_STATUS_LABEL, exVatTotal, formatMoney, xeroInvoiceUrl } from '../../lib/records';
import { formatWhen } from '../reports/ReportCompletionControls';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? '—' : DATE.format(d);
}

const STATUS_CLASS: Record<string, string> = {
  sent: 'border-teal-700 text-teal-700',
  in_xero_not_emailed: 'border-teal-700 text-teal-700',
  failed: 'border-missed text-missed-fg',
  sending: 'border-neutral-400 text-neutral-600',
  draft: 'border-neutral-400 text-neutral-600',
};

/**
 * One invoice as JMS recorded it: number, status, amounts and dates, and (expanded) its lines, recipient and any problem.
 * `showBuilding` = false inside a Building File (the building is the page itself).
 */
export default function InvoiceRecordItem({ invoice, showBuilding = true }: { invoice: InvoiceRecord; showBuilding?: boolean }) {
  const [open, setOpen] = useState(false);
  const total = exVatTotal(invoice.lines);
  const xero = xeroInvoiceUrl(invoice.xeroInvoiceId);
  return (
    <div data-testid="invoice-record" className="border-b border-divider px-4 py-2.5 text-[12.5px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="cursor-pointer text-neutral-500" aria-label={open ? 'Hide invoice details' : 'Show invoice details'}>
          {open ? '▾' : '▸'}
        </button>
        <span className="w-24 font-semibold text-ink tabular-nums">{invoice.xeroInvoiceNumber ?? 'No number yet'}</span>
        <div className="min-w-0 flex-1">
          {showBuilding && (
            <div className="truncate">
              <span className="font-semibold text-ink">{invoice.clientName}</span>
              <span className="text-neutral-600"> · {invoice.buildingName}</span>
            </div>
          )}
          <div className="truncate text-neutral-600">{invoice.jobSummary}</div>
        </div>
        <span className={`border px-1.5 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] uppercase ${STATUS_CLASS[invoice.status] ?? ''}`}>
          {INVOICE_STATUS_LABEL[invoice.status] ?? invoice.status}
        </span>
        <span className="w-28 text-right tabular-nums" title="Calculated from the invoice lines recorded in JMS, before VAT - Xero holds the authoritative total.">
          {formatMoney(total)} <span className="text-[10.5px] text-neutral-500">ex VAT</span>
        </span>
        <span className="w-24 text-right text-[11.5px] text-neutral-500 tabular-nums">{formatDay(invoice.createdAt)}</span>
        {xero ? (
          <a href={xero} target="_blank" rel="noreferrer" className="text-[11.5px] text-teal-700 underline">
            View in Xero
          </a>
        ) : (
          <span className="text-[11.5px] text-neutral-400">Not in Xero</span>
        )}
      </div>
      {open && (
        <div data-testid="invoice-record-details" className="mt-2 ml-6 flex flex-col gap-1.5 text-[12px]">
          <div className="text-neutral-600">
            Created {formatWhen(invoice.createdAt)}
            {invoice.sentAt && ` · emailed ${formatWhen(invoice.sentAt)}`}
            {invoice.dueDate && ` · due ${formatDay(invoice.dueDate)}`}
            {invoice.worksOrderNumber && ` · works order ${invoice.worksOrderNumber}`}
          </div>
          {(invoice.recipientName || invoice.recipientEmail) && (
            <div className="text-neutral-600">
              To {invoice.recipientName ?? '—'}
              {invoice.recipientEmail && ` <${invoice.recipientEmail}>`}
            </div>
          )}
          {invoice.status === 'in_xero_not_emailed' && <div className="text-neutral-600">Created in Xero; Xero did not email it{invoice.notEmailedReason === 'app_setting_off' ? ' (automatic invoice emails were off)' : ''}.</div>}
          {invoice.status === 'failed' && invoice.lastError && <div className="text-missed-fg">Last attempt failed: {invoice.lastError}</div>}
          {invoice.status === 'sending' && <div className="text-due-fg">Recorded as still sending. If this does not change, check the invoice in Xero before trying again.</div>}
          <table className="mt-1 w-full max-w-[640px] text-[11.5px]">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="py-0.5 font-normal">Line</th>
                <th className="py-0.5 font-normal">Visit</th>
                <th className="py-0.5 text-right font-normal">Qty</th>
                <th className="py-0.5 text-right font-normal">Unit (ex VAT)</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l) => (
                <tr key={l.id} className="border-t border-divider">
                  <td className="py-0.5 pr-2">{l.description || '—'}</td>
                  <td className="py-0.5 pr-2 tabular-nums">{formatDay(l.visitDate)}</td>
                  <td className="py-0.5 text-right tabular-nums">{l.quantity}</td>
                  <td className="py-0.5 text-right tabular-nums">{formatMoney(l.unitAmount)}</td>
                </tr>
              ))}
              {invoice.lines.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-0.5 text-neutral-500">
                    No lines recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
