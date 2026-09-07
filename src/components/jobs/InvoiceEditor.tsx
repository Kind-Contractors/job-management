import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoiceLineItem } from '../../domain/types';
import {
  discardInvoiceDraft,
  getInvoice,
  sendInvoice,
  updateInvoiceDraft,
  updateInvoiceLineItem,
} from '../../repository/invoicesRepository';

function money(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface InvoiceEditorProps {
  invoiceId: string;
  onClose: () => void;
}

/**
 * Review-and-edit panel for a draft invoice, shown before Send — reuses the
 * same inline-panel style as ScheduleEditor/JobEditor rather than a new
 * modal/page. Covers both the "normal" (one visit) and "combined" (several
 * manager-selected visits) cases identically: both are just however many
 * line items the invoice was created with.
 */
export default function InvoiceEditor({ invoiceId, onClose }: InvoiceEditorProps) {
  const queryClient = useQueryClient();
  const { data: invoice, isLoading } = useQuery({ queryKey: ['invoice', invoiceId], queryFn: () => getInvoice(invoiceId) });

  const [description, setDescription] = useState('');
  const [worksOrderNumber, setWorksOrderNumber] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<InvoiceLineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Seed local editable state once the invoice loads (or reloads after a save/send).
  useEffect(() => {
    if (!invoice) return;
    setDescription(invoice.description ?? '');
    setWorksOrderNumber(invoice.worksOrderNumber ?? '');
    setDueDate(invoice.dueDate);
    setLines(invoice.lineItems);
  }, [invoice]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  };

  const editable = invoice?.status === 'draft' || invoice?.status === 'failed';

  // A 'failed' invoice may already have a real xero_invoice_id (Xero created
  // it, a later step like email failed) — discarding the local row in that
  // state would orphan the real Xero invoice and free the visit for a
  // second one. Discard is only ever safe when no Xero invoice exists yet.
  const canDiscard = editable && !invoice?.xeroInvoiceId;

  const saveMutation = useMutation({
    mutationFn: async () => {
      await updateInvoiceDraft(invoiceId, { description: description || null, worksOrderNumber: worksOrderNumber || null, dueDate });
      await Promise.all(
        lines.map((line) =>
          updateInvoiceLineItem(line.id, { description: line.description, quantity: line.quantity, unitAmount: line.unitAmount }),
        ),
      );
    },
    onSuccess: () => {
      invalidate();
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save changes.'),
  });

  const discardMutation = useMutation({
    mutationFn: () => discardInvoiceDraft(invoiceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to discard invoice.'),
  });

  const sendMutation = useMutation({
    mutationFn: () => sendInvoice(invoiceId),
    onSuccess: (result) => {
      invalidate();
      if (result.status === 'sent') {
        setSendResult({ ok: true, message: `Sent — Xero invoice ${result.xeroInvoiceNumber}.` });
      } else {
        setSendResult({ ok: false, message: result.error ?? 'Failed to send.' });
      }
    },
    onError: (err) => setSendResult({ ok: false, message: err instanceof Error ? err.message : 'Failed to send.' }),
  });

  // Save/Send/Discard are mutually exclusive — while any one is running, the
  // other two must not be startable (a Discard landing mid-Send could leave
  // a real Xero invoice with no local record at all).
  const anyMutationPending = saveMutation.isPending || sendMutation.isPending || discardMutation.isPending;

  if (isLoading || !invoice) {
    return (
      <div className="m-3.5 border border-neutral-300 p-3 text-[12.5px] text-neutral-500">Loading invoice…</div>
    );
  }

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitAmount, 0);
  const estimatedVat = subtotal * 0.2;

  return (
    <div className="m-3.5 border border-neutral-300 p-3">
      <div className="flex items-center gap-2">
        <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
          Invoice · {invoiceStatusLabel(invoice.status)}
        </div>
        <button onClick={onClose} className="ml-auto cursor-pointer text-[11.5px] text-neutral-500 hover:text-ink">
          Close
        </button>
      </div>

      {invoice.status === 'sent' && invoice.xeroInvoiceNumber && (
        <div className="mt-2 border border-teal-700/40 bg-teal-100 p-2 text-[12.5px] text-teal-700">
          Sent to Xero as invoice {invoice.xeroInvoiceNumber}.
        </div>
      )}
      {invoice.status === 'failed' && invoice.xeroInvoiceId && (
        <div className="mt-2 border border-missed bg-missed/10 p-2 text-[12.5px] text-missed-fg">
          <div className="font-semibold">
            Xero invoice {invoice.xeroInvoiceNumber} was created, but sending it failed.
          </div>
          <div className="mt-1 text-neutral-600">Sending "Send" again will retry emailing this same invoice — it will not create another one.</div>
          {invoice.lastError && <div className="mt-1">{invoice.lastError}</div>}
        </div>
      )}
      {invoice.status === 'failed' && !invoice.xeroInvoiceId && invoice.lastError && (
        <div className="mt-2 border border-missed bg-missed/10 p-2 text-[12.5px] text-missed-fg">{invoice.lastError}</div>
      )}
      {invoice.status === 'sending' && (
        <div className="mt-2 border border-neutral-300 bg-neutral-100 p-2 text-[12.5px] text-neutral-600">
          Sending — creating and emailing this invoice in Xero…
        </div>
      )}

      <div className="mt-2.5 flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!editable}
            rows={2}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Works order number
          <input
            value={worksOrderNumber}
            onChange={(e) => setWorksOrderNumber(e.target.value)}
            disabled={!editable}
            placeholder="Not provided yet — can be added later, before sending"
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Due date
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={!editable}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500"
          />
        </label>

        <div className="text-[11px] text-neutral-600">Line items ({lines.length})</div>
        {lines.map((line, i) => (
          <div key={line.id} className="flex flex-col gap-1 border border-neutral-300 bg-neutral-100 p-2">
            <input
              value={line.description}
              onChange={(e) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, description: e.target.value } : l)))}
              disabled={!editable}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-200 disabled:text-neutral-500"
            />
            <div className="flex gap-1.5">
              <label className="flex flex-1 flex-col gap-0.5 text-[10.5px] text-neutral-600">
                Quantity
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={line.quantity}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, quantity: Number(e.target.value) } : l)))
                  }
                  disabled={!editable}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-200 disabled:text-neutral-500"
                />
              </label>
              <label className="flex flex-1 flex-col gap-0.5 text-[10.5px] text-neutral-600">
                Unit price
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={line.unitAmount}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, unitAmount: Number(e.target.value) } : l)))
                  }
                  disabled={!editable}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-200 disabled:text-neutral-500"
                />
              </label>
              <div className="flex flex-1 flex-col gap-0.5 text-[10.5px] text-neutral-600">
                Line total
                <div className="px-2 py-1 text-[12.5px] tabular-nums text-ink">{money(line.quantity * line.unitAmount)}</div>
              </div>
            </div>
          </div>
        ))}

        <div className="flex flex-col gap-0.5 border-t border-divider pt-1.5 text-[12.5px] tabular-nums">
          <div className="flex justify-between text-neutral-600">
            <span>Subtotal</span>
            <span>{money(subtotal)}</span>
          </div>
          <div className="flex justify-between text-neutral-600">
            <span>VAT (estimated, 20%)</span>
            <span>{money(estimatedVat)}</span>
          </div>
          <div className="flex justify-between font-semibold text-ink">
            <span>Estimated total</span>
            <span>{money(subtotal + estimatedVat)}</span>
          </div>
          <div className="text-[10.5px] text-neutral-500">
            VAT/account code are resolved against Xero when sent — this total is an estimate, not what Xero will charge.
          </div>
        </div>

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}
        {sendResult && (
          <div className={`text-[11.5px] ${sendResult.ok ? 'text-teal-700' : 'text-missed-fg'}`}>{sendResult.message}</div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {editable && (
            <>
              <button
                onClick={() => saveMutation.mutate()}
                disabled={anyMutationPending}
                className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700 disabled:opacity-60"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save changes'}
              </button>
              <button
                onClick={() => {
                  setSendResult(null);
                  sendMutation.mutate();
                }}
                disabled={anyMutationPending || lines.length === 0}
                className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendMutation.isPending ? 'Sending…' : 'Send'}
              </button>
              <button
                onClick={() => discardMutation.mutate()}
                disabled={anyMutationPending || !canDiscard}
                title={canDiscard ? undefined : 'A Xero invoice already exists for this record — discard is disabled to avoid orphaning it. Use Send to retry, or fix this in Xero directly.'}
                className="cursor-pointer text-[11px] text-missed-fg hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
              >
                Discard
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function invoiceStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'sending':
      return 'Sending';
    case 'sent':
      return 'Sent';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}
