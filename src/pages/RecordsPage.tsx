import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listHistoricalJobRows, listJobRows } from '../repository/jobsRepository';
import { listInvoiceRecords, type InvoiceRecord } from '../repository/invoiceRecordsRepository';
import { IN_XERO_INVOICE_STATUSES } from '../lib/invoiceStatus';
import {
  INVOICE_STATUS_LABEL,
  deliveredReportRecords,
  filterInvoiceRecords,
  filterReportRecords,
  type InvoiceRecordStatusFilter,
  type ReportRecordStatus,
} from '../lib/records';
import type { BuildingReportEntry } from '../lib/buildingReports';
import { useDebouncedValue } from '../lib/dialogHooks';
import Pager, { usePaged } from '../components/shared/Pager';
import { isActiveJob } from '../lib/queueJobs';
import { formatWhen } from '../components/reports/ReportCompletionControls';
import InvoiceRecordItem, { formatDay } from '../components/records/InvoiceRecordItem';
import { useReportPdf } from '../components/records/useReportPdf';

type Tab = 'reports' | 'invoices';

const input = 'border border-neutral-300 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-teal';

// Search is the global box in the top bar (?q=, shared by both tabs); these are the tab's own filters.
function Filters({
  from,
  to,
  onFrom,
  onTo,
  dateLabel,
  children,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  dateLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-2.5">
      <label className="flex items-center gap-1 text-[11.5px] text-neutral-600">
        {dateLabel} from
        <input type="date" value={from} max={to || undefined} onChange={(e) => onFrom(e.target.value)} aria-label={`${dateLabel} from`} className="border border-neutral-300 px-1.5 py-1 text-[12px]" />
      </label>
      <label className="flex items-center gap-1 text-[11.5px] text-neutral-600">
        to
        <input type="date" value={to} min={from || undefined} onChange={(e) => onTo(e.target.value)} aria-label={`${dateLabel} to`} className="border border-neutral-300 px-1.5 py-1 text-[12px]" />
      </label>
      {children}
    </div>
  );
}

/** Delivered job reports: emailed through the system or marked Completed, from active and historical jobs. */
export function ReportRecordsTab({ entries, search, loading, error, historicalError }: { entries: BuildingReportEntry[]; search: string; loading: boolean; error: boolean; historicalError: boolean }) {
  const [status, setStatus] = useState<ReportRecordStatus>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useDebouncedValue(search, 250);
  const rows = useMemo(() => filterReportRecords(entries, { search: q, status, from, to }), [entries, q, status, from, to]);
  const paged = usePaged(rows, JSON.stringify([q, status, from, to]));
  const pdf = useReportPdf();

  return (
    <div data-testid="report-records">
      <Filters from={from} to={to} onFrom={setFrom} onTo={setTo} dateLabel="Delivered">
        <select value={status} onChange={(e) => setStatus(e.target.value as ReportRecordStatus)} aria-label="Report status" className={input}>
          <option value="all">Emailed or completed</option>
          <option value="emailed">Emailed through the system</option>
          <option value="completed">Marked completed</option>
        </select>
      </Filters>
      {historicalError && <p className="px-4 py-2 text-[12px] text-missed-fg">Couldn&apos;t load completed and closed jobs, so their reports may be missing from this list.</p>}
      {loading ? (
        <p className="px-4 py-3 text-[12.5px] text-neutral-500">Loading…</p>
      ) : error ? (
        <p className="px-4 py-3 text-[12.5px] text-missed-fg">The reports could not be loaded.</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] text-neutral-500">{entries.length === 0 ? 'No reports have been emailed or marked completed yet.' : 'No reports match these filters.'}</p>
      ) : (
        <div>
          {paged.pageRows.map((e) => {
            const busy = pdf.busyReportId === e.reportId;
            return (
              <div key={e.reportId} data-testid="report-record" className="border-b border-divider px-4 py-2.5 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <span className="font-semibold text-ink">{e.job.clientName}</span>
                      <span className="text-neutral-600">
                        {' '}
                        · {e.job.buildingName}
                        {e.job.postcode && ` · ${e.job.postcode}`}
                      </span>
                    </div>
                    <div className="truncate text-neutral-600">
                      {e.job.jobSummary} · Visit {formatDay(e.visit.scheduledDate)}
                      {!isActiveJob(e.job) && <span className="ml-1 text-[11px] text-neutral-500">(job {e.job.lifecycleStatus})</span>}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 text-[11px]">
                    {e.sentToClientAt && <span className="bg-teal px-1 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-white uppercase">Emailed {formatWhen(e.sentToClientAt)}</span>}
                    {e.completedAt && <span className="border border-teal-700 px-1 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">Completed {formatWhen(e.completedAt)}</span>}
                  </div>
                  <button type="button" onClick={() => void pdf.start(e, 'view')} disabled={pdf.busyReportId !== null} className="cursor-pointer bg-teal px-2.5 py-1 text-[11.5px] font-semibold text-white disabled:opacity-60">
                    View report
                  </button>
                  <button type="button" onClick={() => void pdf.start(e, 'download')} disabled={pdf.busyReportId !== null} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-60">
                    Download PDF
                  </button>
                  {isActiveJob(e.job) ? (
                    // Send again / Reopen are the existing Ready for client actions - opened there, on this report.
                    <Link to={`/ready-for-client?view=delivered&visit=${e.visit.id}`} className="text-[11.5px] text-teal-700 underline">
                      {e.completedAt ? 'Reopen…' : 'Send again…'}
                    </Link>
                  ) : (
                    <span className="text-[11px] text-neutral-400" title="This job is closed: its reports can be viewed and downloaded only.">
                      View only
                    </span>
                  )}
                </div>
                {busy && <div className="mt-1 text-[11.5px] text-neutral-500">Preparing the report…</div>}
                {pdf.errors[e.reportId] && (
                  <div role="alert" className="mt-1 text-[11.5px] text-missed-fg">
                    {pdf.errors[e.reportId]}
                  </div>
                )}
              </div>
            );
          })}
          <Pager {...paged} label="Job reports" />
        </div>
      )}
      {pdf.dialogs}
    </div>
  );
}

/** The invoices created in Xero, whatever their job's lifecycle. Unfinished ones (draft, sending, failed) are in Ready for accounts. */
export function InvoiceRecordsTab({ invoices, search, loading, error }: { invoices: InvoiceRecord[]; search: string; loading: boolean; error: boolean }) {
  const [status, setStatus] = useState<InvoiceRecordStatusFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useDebouncedValue(search, 250);
  const rows = useMemo(() => filterInvoiceRecords(invoices, { search: q, status, from, to }), [invoices, q, status, from, to]);
  const paged = usePaged(rows, JSON.stringify([q, status, from, to]));

  return (
    <div data-testid="invoice-records">
      <Filters from={from} to={to} onFrom={setFrom} onTo={setTo} dateLabel="Created">
        <select value={status} onChange={(e) => setStatus(e.target.value as InvoiceRecordStatusFilter)} aria-label="Invoice status" className={input}>
          <option value="all">Any status</option>
          {IN_XERO_INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {INVOICE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </Filters>
      <p className="border-b border-divider bg-neutral-100 px-4 py-1.5 text-[11.5px] text-neutral-600">
        Statuses are as recorded in JMS when the invoice was created or emailed. Paid, voided or credited invoices are only shown in Xero. Amounts are
        calculated from the JMS invoice lines, before VAT.
      </p>
      {loading ? (
        <p className="px-4 py-3 text-[12.5px] text-neutral-500">Loading…</p>
      ) : error ? (
        <p className="px-4 py-3 text-[12.5px] text-missed-fg">The invoices could not be loaded.</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] text-neutral-500">
          {invoices.length === 0 ? (
            <>
              No invoices have been created in Xero yet. Drafts and invoices still to be created are in{' '}
              <Link to="/ready-for-accounts" className="text-teal-700 underline">
                Ready for accounts
              </Link>
              .
            </>
          ) : (
            'No invoices match these filters.'
          )}
        </p>
      ) : (
        <>
          {paged.pageRows.map((i) => (
            <InvoiceRecordItem key={i.id} invoice={i} />
          ))}
          <Pager {...paged} label="Invoices" />
        </>
      )}
    </div>
  );
}

/**
 * Records: the job reports and invoices that have left the attention queues (Ready for client / Ready for accounts), so
 * nothing finished is lost. Read-only views over the existing data - no copies. Historical Jobs stays the place for a job's
 * own lifecycle (completed / lost / cancelled).
 */
export default function RecordsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'invoices' ? 'invoices' : 'reports';
  // The global search box in the top bar (it keeps ?q= when the tab changes).
  const search = searchParams.get('q') ?? '';
  const active = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });
  const historical = useQuery({ queryKey: ['historicalJobRows'], queryFn: listHistoricalJobRows });
  const invoices = useQuery({ queryKey: ['invoiceRecords'], queryFn: listInvoiceRecords });
  const reportEntries = useMemo(() => deliveredReportRecords(active.data ?? [], historical.data ?? []), [active.data, historical.data]);

  const setTab = (next: Tab) => {
    const p = new URLSearchParams(searchParams);
    if (next === 'reports') p.delete('tab');
    else p.set('tab', next);
    setSearchParams(p, { replace: true });
  };
  const tabButton = (value: Tab, label: string, count: number | null) => (
    <button
      type="button"
      aria-pressed={tab === value}
      onClick={() => setTab(value)}
      className={`cursor-pointer px-3 py-1.5 text-[12.5px] font-semibold tabular-nums ${tab === value ? 'bg-teal text-white' : 'bg-white text-neutral-700 hover:bg-neutral-100'}`}
    >
      {label}
      {count != null && ` (${count})`}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-wrap items-end gap-4 px-5 pt-4 pb-3">
        <div>
          <h1 className="font-heading text-[26px] leading-none font-semibold text-ink">Records</h1>
          <p className="mt-1 text-[13px] text-neutral-600">Job reports already delivered to clients, and invoices created in Xero. Work still to do, including draft invoices, is in Ready for client and Ready for accounts.</p>
        </div>
        <div className="segmented ml-auto flex border border-neutral-300" role="group" aria-label="Records">
          {tabButton('reports', 'Job reports', active.isPending ? null : reportEntries.length)}
          {tabButton('invoices', 'Invoices', invoices.isPending ? null : (invoices.data ?? []).length)}
        </div>
      </div>
      <div className="mx-5 mb-5 border border-neutral-300 bg-white">
        {tab === 'reports' ? (
          <ReportRecordsTab entries={reportEntries} search={search} loading={active.isPending} error={active.isError} historicalError={historical.isError} />
        ) : (
          <InvoiceRecordsTab invoices={invoices.data ?? []} search={search} loading={invoices.isPending} error={invoices.isError} />
        )}
      </div>
    </div>
  );
}
