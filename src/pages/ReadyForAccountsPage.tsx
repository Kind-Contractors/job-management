import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { JobRow, JobVisitSummary } from '../domain/types';
import { accountsQueueRows, byApprovalNewestFirst, formatApprovedAt, useQueueJobRows, visitNeedsCompletion } from '../lib/queueJobs';
import { createInvoiceDraft, markVisitsInvoicedManually } from '../repository/invoicesRepository';
import { canMarkAsAlreadyInvoiced, visitsMarkedTogether } from '../lib/markInvoiced';
import MarkInvoicedDialog from '../components/accounts/MarkInvoicedDialog';
import { listBuildingRows } from '../repository/buildingsRepository';
import { useAuth } from '../auth/AuthProvider';
import { type StatusPresentation } from '../lib/statusPresentation';
import InvoiceEditor from '../components/jobs/InvoiceEditor';
import CompleteVisitForm from '../components/jobs/CompleteVisitForm';
import ClosedJobsNotice from '../components/reports/ClosedJobsNotice';
import AutoInvoiceEmailSetting from '../components/settings/AutoInvoiceEmailSetting';
import InvoiceEmailsPopover from '../components/accounts/InvoiceEmailsPopover';
import { reportLinkFor } from '../components/jobs/ScheduleVisitCard';

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
    case 'invoiced_manually':
      return { label: 'Invoiced outside JMS', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700', bg: 'bg-teal-700/10' };
    case 'in_xero_not_emailed':
      return { label: 'In Xero · not emailed', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700', bg: 'bg-teal-700/10' };
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
 * The list's compact status chip (and the detail header's longer wording): the same states accountsRowPresentation names, in the
 * same restrained palette - ochre ready to invoice, neutral draft / sending, brick failed, teal done.
 */
function accountsRowChip(row: AccountsRow): { label: string; long: string; className: string } {
  if (!row.visit.invoiceId) return { label: 'Ready', long: 'Ready to invoice', className: 'border-due/40 bg-due/15 text-due-fg' };
  switch (row.visit.invoiceStatus) {
    case 'failed':
      return { label: 'Failed', long: 'Failed invoice', className: 'border-missed/50 bg-missed/10 text-missed-fg' };
    case 'sending':
      return { label: 'Sending', long: 'Sending to Xero', className: 'border-neutral-300 bg-neutral-100 text-neutral-700' };
    case 'sent':
    case 'in_xero_not_emailed':
    case 'invoiced_manually':
      return { label: accountsRowPresentation(row).label, long: accountsRowPresentation(row).label, className: 'border-teal-700/40 bg-teal-100 text-teal-700' };
    case 'draft':
    default:
      return { label: 'Draft', long: 'Draft invoice', className: 'border-neutral-400 bg-white text-neutral-700' };
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
export default function ReadyForAccountsPage({ initialSelectedVisitId = null }: { initialSelectedVisitId?: string | null } = {}) {
  const navigate = useNavigate();
  // The rail's division filter (General / Specialist / Both) - applied to this list exactly as the rail badge applies it.
  const [searchParams] = useSearchParams();
  const division = searchParams.get('division') ?? 'Both';
  const { session } = useAuth();
  const actor = session?.user.email ?? 'unknown';
  const queryClient = useQueryClient();

  const [selectedVisitId, setSelectedVisitId] = useState<string | null>(initialSelectedVisitId);
  // The visit whose completion form was dismissed (so it shows a button instead); reset by completing it.
  const [completionHiddenFor, setCompletionHiddenFor] = useState<string | null>(null);
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  // The buildings' invoice details (the same cached list the Buildings screens use), shown with the invoice's recipient.
  const { data: buildingRows = [] } = useQuery({ queryKey: ['buildingRows'], queryFn: listBuildingRows });
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedForInvoiceIds, setSelectedForInvoiceIds] = useState<Set<string>>(new Set());
  const [combineError, setCombineError] = useState<string | null>(null);
  const [singleReference, setSingleReference] = useState('');
  const [combinedReference, setCombinedReference] = useState('');
  // "Already invoiced in Xero" (work Luke invoiced by hand in Xero): a per-row action, separate from the combine checkboxes.
  // The visits it covers - one visit, or every visit on its draft/failed invoice (an invoice is marked as a whole).
  const [markVisitIds, setMarkVisitIds] = useState<string[] | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const [markNotice, setMarkNotice] = useState<string | null>(null);
  // View-only: which rows the list shows (All / Ready / Drafts) and a text filter. Neither changes a row or what it can do.
  const [view, setView] = useState<'all' | 'ready' | 'drafts'>('all');
  const [search, setSearch] = useState('');

  // Active jobs plus closed/cancelled jobs that still have unbilled or unsent accounting work.
  const { jobRows, isLoading, isError, error, closedJobsError, retryClosedJobs } = useQueueJobRows();

  // Outstanding accounts work only: approved and not invoiced yet, or an invoice that is not in Xero yet (draft / sending /
  // failed). Once an invoice has been created in Xero ('sent' or 'in xero, not emailed') the visit leaves this list - its
  // invoice is in Records. The rows come from the same builder as the rail badge, so the two always agree.
  const rows = useMemo<AccountsRow[]>(
    // Most recently approved first.
    () => accountsQueueRows(jobRows, division).sort(byApprovalNewestFirst),
    [jobRows, division],
  );

  const selected = rows.find((r) => r.visit.id === selectedVisitId);
  // Open visit on a cancelled/closed job: the completion form is shown and Create invoice stays disabled until it is completed.
  const needsCompletion = !!selected && !selected.visit.invoiceId && visitNeedsCompletion(selected.job, selected.visit);

  const selectRow = (row: AccountsRow) => {
    setSelectedVisitId(row.visit.id);
    setOpenInvoiceId(row.visit.invoiceId ?? null);
    setCreateError(null);
    // A reference typed for the previously-selected row must never carry
    // over and get attached to a different job's invoice.
    setSingleReference('');
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
    setCombinedReference('');
  };

  const createInvoiceMutation = useMutation({
    mutationFn: ({ row, worksOrderNumber }: { row: AccountsRow; worksOrderNumber: string | null }) =>
      createInvoiceDraft({
        jobId: row.job.id,
        createdBy: actor,
        description: row.job.jobSummary,
        worksOrderNumber,
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
      setSingleReference('');
    },
    onError: (err) => setCreateError(err instanceof Error ? err.message : 'Failed to create invoice.'),
  });

  // Same shared fields and per-visit line mapping as createInvoiceMutation
  // above (jobId/description drawn from the one job every selected row
  // shares) — the only difference is more than one line item. One reference
  // covers the whole combined invoice, not one per visit — matching how
  // works_order_number is already a single per-invoice column, not per line.
  const createCombinedInvoiceMutation = useMutation({
    mutationFn: ({ rows, worksOrderNumber }: { rows: AccountsRow[]; worksOrderNumber: string | null }) =>
      createInvoiceDraft({
        jobId: rows[0].job.id,
        createdBy: actor,
        description: rows[0].job.jobSummary,
        worksOrderNumber,
        lines: rows.map((row) => ({
          visitId: row.visit.id,
          description: row.job.jobSummary,
          quantity: 1,
          unitAmount: row.visit.priceCharged ?? row.job.pricePerVisit ?? 0,
        })),
      }),
    onSuccess: (invoiceId, variables) => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      setSelectedForInvoiceIds(new Set());
      setCombineError(null);
      setCombinedReference('');
      setSelectedVisitId(variables.rows[0].visit.id);
      setOpenInvoiceId(invoiceId);
      setCreateError(null);
    },
    onError: (err) => setCombineError(err instanceof Error ? err.message : 'Failed to create combined invoice.'),
  });

  const markRows = markVisitIds ? rows.filter((r) => markVisitIds.includes(r.visit.id)) : [];
  const markInvoicedMutation = useMutation({
    mutationFn: (visitIds: string[]) => markVisitsInvoicedManually(visitIds),
    onSuccess: (result, visitIds) => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['invoiceRecords'] });
      queryClient.invalidateQueries({ queryKey: ['buildingInvoiceRecords'] });
      // An invoice open in the editor may just have been marked - it is in Records now, not editable here.
      if (selectedVisitId && visitIds.includes(selectedVisitId)) setOpenInvoiceId(null);
      // Marked work leaves the list, so it can't stay ticked for a combined invoice either.
      setSelectedForInvoiceIds((ids) => new Set([...ids].filter((id) => !visitIds.includes(id))));
      setMarkNotice(
        `${result.visits === 1 ? 'Marked as already invoiced' : `${result.visits} visits marked as already invoiced`} and moved to Records. Nothing was sent to Xero.`,
      );
      setMarkVisitIds(null);
      setMarkError(null);
    },
    onError: (err) => setMarkError(err instanceof Error ? err.message : 'Could not mark this as already invoiced.'),
  });

  // ---- view-only: tabs, filter and grouping (they decide what is SHOWN, never what a row is or does) ----
  const readyCount = rows.filter((r) => !r.visit.invoiceId).length;
  const draftCount = rows.length - readyCount;
  const term = search.trim().toLowerCase();
  const shownRows = rows.filter(
    (r) =>
      (view === 'all' || (view === 'ready' ? !r.visit.invoiceId : !!r.visit.invoiceId)) &&
      (!term || [r.job.buildingName, r.job.clientName, r.job.jobSummary].some((t) => (t ?? '').toLowerCase().includes(term))),
  );
  // Grouped by client, keeping the list's own order (most recently approved first) inside and between groups.
  const groups: { key: string; name: string; rows: AccountsRow[]; total: number }[] = [];
  for (const row of shownRows) {
    let g = groups.find((x) => x.key === row.job.clientId);
    if (!g) groups.push((g = { key: row.job.clientId, name: row.job.clientName, rows: [], total: 0 }));
    g.rows.push(row);
    g.total += row.visit.priceCharged ?? row.job.pricePerVisit ?? 0;
  }
  const tabs: { key: 'all' | 'ready' | 'drafts'; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: rows.length },
    { key: 'ready', label: 'Ready', count: readyCount },
    { key: 'drafts', label: 'Drafts', count: draftCount },
  ];
  const selectedReportLink = selected ? reportLinkFor(selected.visit) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-neutral-100 lg:flex-row">
      <section
        aria-label="Invoice queue"
        className="flex max-h-[55vh] min-h-0 w-full flex-none flex-col border-b border-divider bg-white lg:max-h-none lg:w-[440px] lg:border-r lg:border-b-0 xl:w-[480px]"
      >
        <div className="flex-none px-5 pt-5 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[22px] leading-tight font-bold tracking-tight text-ink">Ready for accounts</h1>
              <div className="mt-0.5 text-[13px] text-neutral-600 tabular-nums">
                {rows.length} visits to invoice{rows.length > 0 && ` · ${shownRows.length} shown`}
              </div>
            </div>
            <InvoiceEmailsPopover>
              <AutoInvoiceEmailSetting />
            </InvoiceEmailsPopover>
          </div>

          <div role="tablist" aria-label="Show" className="mt-4 flex gap-1 rounded-lg bg-neutral-200/70 p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={view === t.key}
                onClick={() => setView(t.key)}
                className={`flex-1 cursor-pointer rounded-md px-2 py-1.5 text-[13px] ${
                  view === t.key ? 'bg-white font-semibold text-ink shadow-sm' : 'text-neutral-700 hover:bg-white/60'
                }`}
              >
                {t.label} <span className="tabular-nums opacity-70">{t.count}</span>
              </button>
            ))}
          </div>
          <label className="mt-2.5 flex h-9 items-center gap-2 rounded-md border border-neutral-300 px-2.5 focus-within:border-teal">
            <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-none text-neutral-500">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by building, client or job"
              aria-label="Filter the list"
              className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-ink outline-none"
            />
          </label>
        </div>

        {markNotice && (
          <div role="status" data-testid="mark-invoiced-notice" className="mx-5 mb-2 flex flex-none items-start gap-2 rounded-md border border-teal-700/30 bg-teal-100/70 px-3 py-2 text-[12px] text-teal-700">
            <span className="flex-1">
              {markNotice}{' '}
              <Link to="/records?tab=invoices" className="font-semibold underline">
                Open Records
              </Link>
            </span>
            <button type="button" onClick={() => setMarkNotice(null)} aria-label="Dismiss" className="cursor-pointer leading-none hover:text-ink">
              ×
            </button>
          </div>
        )}

        {selectedForInvoiceIds.size >= 2 && (
          <div className="mx-3 mb-2 flex-none rounded-lg bg-teal px-3.5 py-3 text-white" data-testid="combine-bar">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] tabular-nums">
                <strong>{selectedForInvoiceIds.size} visits selected</strong>
                {' · '}
                {money(selectedForInvoiceRows.reduce((sum, r) => sum + (r.visit.priceCharged ?? r.job.pricePerVisit ?? 0), 0))}
              </span>
              <button
                onClick={clearSelectedForInvoice}
                className="cursor-pointer rounded-md border border-white/35 px-2 py-0.5 text-[12px] hover:bg-white/10"
              >
                Clear
              </button>
            </div>
            <div className="mt-0.5 text-[11.5px] text-white/75">One invoice for these visits of the same job.</div>
            {hasZeroAmountSelected && (
              <div className="mt-1 text-[11.5px] text-white/85">
                One or more selected visits has no price set — you can edit line amounts after creating the invoice.
              </div>
            )}
            {combineError && <div className="mt-1 rounded bg-white/90 px-2 py-1 text-[11.5px] text-missed-fg">{combineError}</div>}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[11.5px] text-white/85">
                Invoice reference (optional)
                <input
                  value={combinedReference}
                  onChange={(e) => setCombinedReference(e.target.value)}
                  placeholder="e.g. a client works order number"
                  className="rounded-md border border-white/30 bg-white px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-white"
                />
              </label>
              <button
                onClick={() =>
                  createCombinedInvoiceMutation.mutate({
                    rows: selectedForInvoiceRows,
                    worksOrderNumber: combinedReference.trim() || null,
                  })
                }
                disabled={createCombinedInvoiceMutation.isPending}
                className="cursor-pointer rounded-md bg-white px-3 py-1.5 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createCombinedInvoiceMutation.isPending
                  ? 'Creating…'
                  : `Create combined invoice (${selectedForInvoiceIds.size})`}
              </button>
            </div>
          </div>
        )}

        <ClosedJobsNotice show={closedJobsError} onRetry={retryClosedJobs} />

        {isLoading ? (
          <div className="border-t border-divider p-5">
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
          </div>
        ) : isError ? (
          <div className="border-t border-divider p-5">
            <div className="rounded-md border border-missed bg-missed/10 p-3">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                Couldn't load invoicing data
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink">
                {error instanceof Error ? error.message : 'Something went wrong.'}
              </div>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center border-t border-divider p-5 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              No work is currently ready for accounts.
            </div>
          </div>
        ) : shownRows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 border-t border-divider p-5 text-center text-[13px] text-neutral-600" data-testid="accounts-filter-empty">
            {term ? <>Nothing matches “{search.trim()}”.</> : <>Nothing in {view === 'ready' ? 'Ready' : 'Drafts'} right now.</>}
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setView('all');
              }}
              className="cursor-pointer font-semibold text-teal-700 hover:underline"
            >
              Show all
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto border-t border-divider">
            {groups.map((group) => (
              <div key={group.key}>
                <div className="sticky top-0 z-[1] flex items-center gap-2.5 border-b border-divider bg-neutral-100 px-5 py-2">
                  <span className="min-w-0 flex-1 truncate font-heading text-[11px] font-semibold tracking-[0.1em] text-neutral-800 uppercase">
                    {group.name}
                  </span>
                  <span className="flex-none text-[12px] text-neutral-600 tabular-nums">
                    {group.rows.length} {group.rows.length === 1 ? 'visit' : 'visits'} · {money(group.total)}
                  </span>
                </div>
                {group.rows.map((row) => {
                  const isSelected = row.visit.id === selectedVisitId;
                  const dateLabel = row.visit.scheduledDate ? new Date(row.visit.scheduledDate).toLocaleDateString('en-GB') : 'No date set';
                  const approvedAt = row.visit.reportApprovedAt ?? null;
                  const amount = row.visit.priceCharged ?? row.job.pricePerVisit;
                  // An open visit on a cancelled/closed job must be completed first, so it cannot be put on a combined invoice either.
                  const canSelectForInvoice = !row.visit.invoiceId && !visitNeedsCompletion(row.job, row.visit);
                  const selectForInvoiceDisabled = combineJobId !== null && row.job.id !== combineJobId;
                  const canMark = canMarkAsAlreadyInvoiced(row.job, row.visit);
                  const chip = accountsRowChip(row);
                  return (
                    <div
                      key={row.visit.id}
                      onClick={() => selectRow(row)}
                      className={`group flex cursor-pointer gap-3 border-b border-divider px-5 py-3 ${
                        isSelected ? 'bg-teal-100/60 shadow-[inset_3px_0_0_var(--color-teal)]' : 'hover:bg-neutral-100/70'
                      }`}
                    >
                      <div className="w-4 flex-none pt-0.5">
                        {canSelectForInvoice && (
                          <input
                            type="checkbox"
                            checked={selectedForInvoiceIds.has(row.visit.id)}
                            disabled={selectForInvoiceDisabled}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelectedForInvoice(row.visit.id)}
                            title={selectForInvoiceDisabled ? 'Combined invoices can only include visits from the same job.' : 'Select for a combined invoice'}
                            aria-label={`Select ${row.job.buildingName}, visit ${dateLabel}, for a combined invoice`}
                            className="h-4 w-4 cursor-pointer accent-[var(--color-teal)] disabled:cursor-not-allowed disabled:opacity-40"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{row.job.buildingName}</span>
                          <span className={`flex-none text-[13.5px] tabular-nums ${amount != null ? 'font-semibold text-ink' : 'text-neutral-600 italic'}`}>
                            {amount != null ? money(amount) : 'Variable'}
                          </span>
                        </div>
                        <div className="truncate text-[13px] text-neutral-700">{row.job.jobSummary}</div>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-600 tabular-nums">
                            {dateLabel}
                            {row.visit.technicianName ? ` · ${row.visit.technicianName}` : ''}
                            {approvedAt && (
                              <>
                                {' · '}
                                <span data-testid="accounts-approved-at">Approved {formatApprovedAt(approvedAt)}</span>
                              </>
                            )}
                          </span>
                          <span
                            title={accountsRowPresentation(row).label}
                            className={`flex-none rounded border px-1.5 py-px font-heading text-[10.5px] font-semibold tracking-[0.08em] uppercase ${chip.className}`}
                          >
                            {chip.label}
                          </span>
                        </div>
                        {/*
                          Work already invoiced by hand in Xero. Compact, and only fully shown on the selected row (and on hover / keyboard
                          focus elsewhere) so the list stays clean. Its own button: it never selects the row for a combined invoice.
                        */}
                        {canMark && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMarkError(null);
                              setMarkNotice(null);
                              setMarkVisitIds(visitsMarkedTogether(rows, row.visit));
                            }}
                            aria-label={`Already invoiced in Xero: ${row.job.buildingName}, visit ${dateLabel}`}
                            title="Have you already invoiced this yourself in Xero? Move it to Records without sending anything from JMS."
                            data-testid="mark-invoiced-action"
                            // Takes no room until wanted: shown on the selected row, on hover, or when it gets keyboard focus (still reachable with Tab).
                            className={`mt-2 cursor-pointer items-center rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-[12px] font-semibold text-teal-700 hover:bg-teal-100/60 ${
                              isSelected
                                ? 'inline-flex opacity-100'
                                : 'sr-only opacity-0 group-hover:not-sr-only group-hover:inline-flex group-hover:opacity-100 focus:not-sr-only focus:inline-flex focus:opacity-100'
                            }`}
                          >
                            Already invoiced in Xero?
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      <div data-testid="accounts-detail" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            {selectedVisitId && !isLoading ? (
              // The visit that was open has left the queue - most often because its invoice has just been created in Xero.
              <div data-testid="left-accounts-queue" className="max-w-sm rounded-lg border border-done bg-done/10 p-4 text-left text-[13px] text-ink">
                <div className="font-semibold text-done-fg">No longer waiting for invoicing</div>
                <p className="mt-1">
                  This visit has left Ready for accounts - its invoice is in Xero (or it is no longer in this division). The invoice is in{' '}
                  <Link to="/records?tab=invoices" className="text-teal-700 underline">
                    Records
                  </Link>
                  .
                </p>
              </div>
            ) : (
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                Select an item on the left
              </div>
            )}
          </div>
        ) : (
          <div className="w-full max-w-[920px] px-5 py-6 lg:px-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[24px] leading-tight font-bold tracking-tight text-ink">{selected.job.buildingName}</h2>
                <div className="mt-1 text-[14px] text-neutral-700">
                  {selected.job.clientName} · {selected.job.jobSummary}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-neutral-600">
                  {(selected.visit.scheduledDate || selected.visit.technicianName) && (
                    <span className="tabular-nums">
                      {selected.visit.scheduledDate && `Visit ${new Date(selected.visit.scheduledDate).toLocaleDateString('en-GB')}`}
                      {selected.visit.scheduledDate && selected.visit.technicianName && ' · '}
                      {selected.visit.technicianName}
                    </span>
                  )}
                  {selected.visit.reportApprovedAt && (
                    <span className="tabular-nums">Report approved {formatApprovedAt(selected.visit.reportApprovedAt)}</span>
                  )}
                  {selectedReportLink && (
                    <button
                      type="button"
                      onClick={() => navigate(selectedReportLink.to)}
                      className="cursor-pointer font-semibold text-teal-700 hover:underline"
                      data-testid="accounts-view-report"
                    >
                      {selectedReportLink.label} report
                    </button>
                  )}
                  <button
                    onClick={() => navigate(`/buildings/${selected.job.buildingId}`)}
                    className="cursor-pointer font-semibold text-teal-700 hover:underline"
                  >
                    Building file
                  </button>
                </div>
              </div>
              <span
                className={`flex-none rounded-md border px-2.5 py-1 font-heading text-[11px] font-semibold tracking-[0.1em] uppercase ${accountsRowChip(selected).className}`}
                data-testid="accounts-detail-status"
              >
                {accountsRowChip(selected).long}
              </span>
            </div>

            <div className="mt-5">
              {openInvoiceId ? (
                <InvoiceEditor
                  invoiceId={openInvoiceId}
                  onClose={() => setOpenInvoiceId(null)}
                  clientId={selected.job.clientId}
                  clientName={selected.job.clientName}
                  buildingId={selected.job.buildingId}
                  invoiceDetails={buildingRows.find((b) => b.id === selected.job.buildingId)?.invoiceDetails ?? ''}
                  clientContacts={selected.job.clientContacts}
                  buildingDefault={selected.job.buildingDefaultRecipient}
                  buildingRecipient={selected.job.buildingInvoiceRecipient ?? null}
                />
              ) : selected.visit.invoiceId ? (
                <div className="rounded-lg border border-neutral-300 bg-white p-5">
                  <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Invoice</div>
                  <div className="mt-1.5 text-[13px] text-neutral-700">
                    This visit already has an invoice ({accountsRowPresentation(selected).label.toLowerCase()}).
                  </div>
                  <button
                    onClick={() => setOpenInvoiceId(selected.visit.invoiceId)}
                    className="mt-3 cursor-pointer rounded-md bg-teal px-4 py-2 text-[13px] font-semibold text-white hover:bg-teal-700"
                  >
                    View invoice
                  </button>
                </div>
              ) : (
                <div className="rounded-lg border border-neutral-300 bg-white p-5">
                  {needsCompletion && (
                    <div role="region" aria-label="Complete this visit" className="mb-4 rounded-md border border-due bg-due/10 p-3">
                      <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-due-fg uppercase">Complete this visit first</div>
                      <div className="mt-1 text-[13px] text-ink">
                        This visit is still marked {selected.visit.status === 'due' ? 'Due' : 'Booked'}, but its job has been {selected.job.lifecycleStatus === 'cancelled' ? 'cancelled' : 'closed'}.
                        Complete it to record its price and date, then you can invoice it. Completing the visit does not reopen or reactivate the job: the job stays{' '}
                        {selected.job.lifecycleStatus === 'cancelled' ? 'cancelled' : 'closed'} and off the schedule.
                      </div>
                      {completionHiddenFor === selected.visit.id ? (
                        <button
                          onClick={() => setCompletionHiddenFor(null)}
                          className="mt-2 cursor-pointer rounded-md bg-teal px-3 py-1.5 text-[12.5px] font-semibold text-white"
                        >
                          Complete this visit
                        </button>
                      ) : (
                        <CompleteVisitForm
                          job={selected.job}
                          visit={selected.visit}
                          actor={actor}
                          onDone={() => setCompletionHiddenFor(null)}
                          onCancel={() => setCompletionHiddenFor(selected.visit.id)}
                        />
                      )}
                    </div>
                  )}
                  <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
                    No invoice yet
                  </div>
                  <div className="mt-1.5 text-[14px] text-ink">
                    {(() => {
                      const amount = selected.visit.priceCharged ?? selected.job.pricePerVisit;
                      return amount != null ? `${money(amount)} for this visit.` : 'This job has a variable price — confirm the amount after creating the invoice.';
                    })()}
                  </div>
                  <label className="mt-4 block max-w-md text-[13px] font-semibold text-ink">
                    Invoice reference <span className="font-normal text-neutral-500">(optional)</span>
                    <input
                      value={singleReference}
                      onChange={(e) => setSingleReference(e.target.value)}
                      placeholder="e.g. a client works order number"
                      className="mt-1.5 block w-full rounded-md border border-neutral-300 px-2.5 py-2 text-[13.5px] font-normal text-ink outline-none focus:border-teal"
                    />
                  </label>
                  {createError && <div className="mt-2 text-[12.5px] text-missed-fg">{createError}</div>}
                  <button
                    onClick={() =>
                      createInvoiceMutation.mutate({ row: selected, worksOrderNumber: singleReference.trim() || null })
                    }
                    disabled={createInvoiceMutation.isPending || needsCompletion}
                    className="mt-4 cursor-pointer rounded-md bg-teal px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {createInvoiceMutation.isPending ? 'Creating…' : 'Create invoice'}
                  </button>
                  {needsCompletion && <div className="mt-1.5 text-[12.5px] text-neutral-600">Complete the visit above first - then you can create the invoice.</div>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {markVisitIds && (
        <MarkInvoicedDialog
          rows={markRows}
          pending={markInvoicedMutation.isPending}
          error={markError}
          onConfirm={() => markInvoicedMutation.mutate(markRows.map((r) => r.visit.id))}
          onCancel={() => {
            setMarkVisitIds(null);
            setMarkError(null);
          }}
        />
      )}
    </div>
  );
}
