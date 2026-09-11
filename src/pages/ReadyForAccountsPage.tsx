import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { JobRow, JobVisitSummary } from '../domain/types';
import { listJobRows } from '../repository/jobsRepository';
import { createInvoiceDraft } from '../repository/invoicesRepository';
import { useAuth } from '../auth/AuthProvider';
import { isVisitReadyForAccounts, type StatusPresentation } from '../lib/statusPresentation';
import StatusPill from '../components/jobs/StatusPill';
import InvoiceEditor from '../components/jobs/InvoiceEditor';

interface AccountsRow {
  job: JobRow;
  visit: JobVisitSummary;
}

function money(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Local to this page rather than added to statusPresentation.ts — this is a
 * per-visit accounts-workflow state (ready to invoice vs. an invoice's own
 * local lifecycle), not one of the shared Job/Visit/Report status enums
 * every other StatusPill use there renders. Same restrained palette
 * (teal=done/normal, due=needs attention, missed=failed, neutral=in
 * progress) — no new colors introduced.
 */
function accountsRowPresentation(row: AccountsRow): StatusPresentation {
  if (!row.visit.invoiceId) {
    return { label: 'Ready to invoice', fg: 'text-due-fg', dot: 'bg-due', border: 'border-due', bg: 'bg-due/10' };
  }
  switch (row.visit.invoiceStatus) {
    case 'sent':
      return { label: 'Sent', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700', bg: 'bg-teal-700/10' };
    case 'failed':
      return { label: 'Failed', fg: 'text-missed-fg', dot: 'bg-missed', border: 'border-missed', bg: 'bg-missed/10' };
    case 'sending':
      return { label: 'Sending', fg: 'text-neutral-600', dot: 'bg-neutral-400', border: 'border-neutral-400', bg: 'bg-neutral-400/10' };
    case 'draft':
    default:
      return { label: 'Draft', fg: 'text-neutral-600', dot: 'bg-neutral-400', border: 'border-neutral-400', bg: 'bg-neutral-400/10' };
  }
}

/**
 * Dedicated accounts workflow — replaces "Ready for accounts" as an All
 * Live Jobs filter with a visit-level list purpose-built for invoicing.
 * Reuses the exact same data (['jobRows']) and the exact same
 * create/edit/send invoice functions/components already proven in
 * JobInspectorDrawer/InvoiceEditor — this page only adds a different way to
 * reach them, it does not reimplement any invoice logic.
 */
export default function ReadyForAccountsPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const actor = session?.user.email ?? 'unknown';
  const queryClient = useQueryClient();

  const [selectedVisitId, setSelectedVisitId] = useState<string | null>(null);
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedForInvoiceIds, setSelectedForInvoiceIds] = useState<Set<string>>(new Set());
  const [combineError, setCombineError] = useState<string | null>(null);

  const {
    data: jobRows = [],
    isLoading,
    isError,
    error,
  } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  // A visit belongs on this page once it's approved-and-unbilled, or once it
  // already has an invoice that still needs attention (draft/sending/failed/
  // sent) — a sent invoice stays visible so its record doesn't just vanish
  // from the one place a manager checks this.
  const rows = useMemo<AccountsRow[]>(() => {
    const list: AccountsRow[] = [];
    for (const job of jobRows) {
      for (const visit of job.visits) {
        if (isVisitReadyForAccounts(visit) || visit.invoiceId) list.push({ job, visit });
      }
    }
    return list.sort((a, b) => (a.visit.scheduledDate ?? '').localeCompare(b.visit.scheduledDate ?? ''));
  }, [jobRows]);

  const selected = rows.find((r) => r.visit.id === selectedVisitId);

  const selectRow = (row: AccountsRow) => {
    setSelectedVisitId(row.visit.id);
    setOpenInvoiceId(row.visit.invoiceId ?? null);
    setCreateError(null);
  };

  // The job of whichever visits are currently checked for combining — null
  // once nothing is checked, which re-opens every job's checkboxes again.
  // Combining is scoped to a single job (never inferred from job
  // frequency, per Luke's own requirement) so every selected visit shares
  // one client automatically, with no separate client-matching check needed.
  const selectedForInvoiceRows = rows.filter((r) => selectedForInvoiceIds.has(r.visit.id));
  const combineJobId = selectedForInvoiceRows[0]?.job.id ?? null;
  const hasZeroAmountSelected = selectedForInvoiceRows.some(
    (r) => (r.visit.priceCharged ?? r.job.pricePerVisit ?? 0) === 0,
  );

  const toggleSelectedForInvoice = (visitId: string) => {
    setSelectedForInvoiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(visitId)) next.delete(visitId);
      else next.add(visitId);
      return next;
    });
    setCombineError(null);
  };

  const clearSelectedForInvoice = () => {
    setSelectedForInvoiceIds(new Set());
    setCombineError(null);
  };

  const createInvoiceMutation = useMutation({
    mutationFn: (row: AccountsRow) =>
      createInvoiceDraft({
        jobId: row.job.id,
        createdBy: actor,
        description: row.job.jobSummary,
        worksOrderNumber: null,
        lines: [
          {
            visitId: row.visit.id,
            description: row.job.jobSummary,
            quantity: 1,
            unitAmount: row.visit.priceCharged ?? row.job.pricePerVisit ?? 0,
          },
        ],
      }),
    onSuccess: (invoiceId) => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      setOpenInvoiceId(invoiceId);
      setCreateError(null);
    },
    onError: (err) => setCreateError(err instanceof Error ? err.message : 'Failed to create invoice.'),
  });

  // Same shared fields and per-visit line mapping as createInvoiceMutation
  // above (jobId/description drawn from the one job every selected row
  // shares) — the only difference is more than one line item.
  const createCombinedInvoiceMutation = useMutation({
    mutationFn: (combinedRows: AccountsRow[]) =>
      createInvoiceDraft({
        jobId: combinedRows[0].job.id,
        createdBy: actor,
        description: combinedRows[0].job.jobSummary,
        worksOrderNumber: null,
        lines: combinedRows.map((row) => ({
          visitId: row.visit.id,
          description: row.job.jobSummary,
          quantity: 1,
          unitAmount: row.visit.priceCharged ?? row.job.pricePerVisit ?? 0,
        })),
      }),
    onSuccess: (invoiceId, combinedRows) => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      setSelectedForInvoiceIds(new Set());
      setCombineError(null);
      setSelectedVisitId(combinedRows[0].visit.id);
      setOpenInvoiceId(invoiceId);
      setCreateError(null);
    },
    onError: (err) => setCombineError(err instanceof Error ? err.message : 'Failed to create combined invoice.'),
  });

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[320px] flex-none flex-col border-r border-divider bg-white">
        <div className="flex-none border-b border-divider px-3.5 py-3">
          <h1 className="font-heading text-lg font-semibold">Ready for accounts</h1>
          <div className="mt-0.5 text-xs text-neutral-600 tabular-nums">{rows.length} needing attention</div>
        </div>

        {selectedForInvoiceIds.size >= 2 && (
          <div className="flex-none border-b border-divider bg-teal-100 px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-ink tabular-nums">
                {selectedForInvoiceIds.size} visits selected
              </span>
              <button
                onClick={clearSelectedForInvoice}
                className="cursor-pointer text-[11.5px] text-neutral-600 hover:underline"
              >
                Clear
              </button>
            </div>
            {hasZeroAmountSelected && (
              <div className="mt-1 text-[11px] text-neutral-600">
                One or more selected visits has no price set — you can edit line amounts after creating the invoice.
              </div>
            )}
            {combineError && <div className="mt-1 text-[11px] text-missed-fg">{combineError}</div>}
            <button
              onClick={() => createCombinedInvoiceMutation.mutate(selectedForInvoiceRows)}
              disabled={createCombinedInvoiceMutation.isPending}
              className="mt-1.5 w-full cursor-pointer bg-teal px-2.5 py-1.5 text-[11.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {createCombinedInvoiceMutation.isPending
                ? 'Creating…'
                : `Create combined invoice (${selectedForInvoiceIds.size})`}
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="p-3.5">
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
          </div>
        ) : isError ? (
          <div className="p-3.5">
            <div className="border border-missed bg-missed/10 p-3">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                Couldn't load invoicing data
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink">
                {error instanceof Error ? error.message : 'Something went wrong.'}
              </div>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-5 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              No work is currently ready for accounts.
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {rows.map((row) => {
              const isSelected = row.visit.id === selectedVisitId;
              const dateLabel = row.visit.scheduledDate ? new Date(row.visit.scheduledDate).toLocaleDateString('en-GB') : 'No date set';
              const amount = row.visit.priceCharged ?? row.job.pricePerVisit;
              const canSelectForInvoice = !row.visit.invoiceId;
              const selectForInvoiceDisabled = combineJobId !== null && row.job.id !== combineJobId;
              return (
                <div
                  key={row.visit.id}
                  onClick={() => selectRow(row)}
                  className={`cursor-pointer border-b border-divider px-3.5 py-2.5 ${isSelected ? 'bg-teal-100' : 'hover:bg-neutral-100'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-1.5">
                      {canSelectForInvoice && (
                        <input
                          type="checkbox"
                          checked={selectedForInvoiceIds.has(row.visit.id)}
                          disabled={selectForInvoiceDisabled}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelectedForInvoice(row.visit.id)}
                          title={selectForInvoiceDisabled ? 'Combined invoices can only include visits from the same job.' : 'Select for a combined invoice'}
                          className="mt-0.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      )}
                      <span className="text-[12.5px] font-semibold text-ink">{row.job.buildingName}</span>
                    </div>
                    <StatusPill presentation={accountsRowPresentation(row)} />
                  </div>
                  <div className="text-[11.5px] text-neutral-600">
                    {row.job.clientName} · {row.job.jobSummary}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-[11px] text-neutral-500 tabular-nums">
                    <span>
                      Visit {dateLabel}
                      {row.visit.technicianName ? ` · ${row.visit.technicianName}` : ''}
                    </span>
                    <span>{amount != null ? money(amount) : 'Variable'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-5 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              Select an item on the left
            </div>
          </div>
        ) : (
          <div className="max-w-[560px] p-5">
            <div className="border-b border-divider pb-3">
              <h2 className="font-heading text-xl font-semibold">{selected.job.buildingName}</h2>
              <div className="mt-0.5 text-[13px] text-neutral-600">
                {selected.job.clientName} · {selected.job.jobSummary}
                {selected.visit.scheduledDate && ` · Visit ${new Date(selected.visit.scheduledDate).toLocaleDateString('en-GB')}`}
                {selected.visit.technicianName && ` · ${selected.visit.technicianName}`}
              </div>
              <button
                onClick={() => navigate(`/buildings/${selected.job.buildingId}`)}
                className="mt-1.5 cursor-pointer text-[11.5px] text-teal-700 hover:underline"
              >
                Open building file
              </button>
            </div>

            {openInvoiceId ? (
              <InvoiceEditor invoiceId={openInvoiceId} onClose={() => setOpenInvoiceId(null)} />
            ) : selected.visit.invoiceId ? (
              <div className="m-3.5 border border-neutral-300 p-3">
                <div className="text-[12.5px] text-neutral-600">
                  This visit already has an invoice ({accountsRowPresentation(selected).label.toLowerCase()}).
                </div>
                <button
                  onClick={() => setOpenInvoiceId(selected.visit.invoiceId)}
                  className="mt-2 cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white"
                >
                  View invoice
                </button>
              </div>
            ) : (
              <div className="m-3.5 border border-neutral-300 p-3">
                <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                  No invoice yet
                </div>
                <div className="mt-1.5 text-[12.5px] text-neutral-600">
                  {(() => {
                    const amount = selected.visit.priceCharged ?? selected.job.pricePerVisit;
                    return amount != null ? `${money(amount)} for this visit.` : 'This job has a variable price — confirm the amount after creating the invoice.';
                  })()}
                </div>
                {createError && <div className="mt-1.5 text-[11.5px] text-missed-fg">{createError}</div>}
                <button
                  onClick={() => createInvoiceMutation.mutate(selected)}
                  disabled={createInvoiceMutation.isPending}
                  className="mt-2 cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {createInvoiceMutation.isPending ? 'Creating…' : 'Create invoice'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
