import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listHistoricalJobRows, listJobRows } from '../repository/jobsRepository';
import { listInvoiceRecords, type InvoiceRecord } from '../repository/invoiceRecordsRepository';
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
import { isActiveJob } from '../lib/queueJobs';
import { formatWhen } from '../components/reports/ReportCompletionControls';
import InvoiceRecordItem, { formatDay } from '../components/records/InvoiceRecordItem';
import { useReportPdf } from '../components/records/useReportPdf';

type Tab = 'reports' | 'invoices';

const input = 'border border-neutral-300 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-teal';

function Filters({
  search,
  onSearch,
  placeholder,
  from,
  to,
  onFrom,
  onTo,
  dateLabel,
  children,
}: {
  search: string;
  onSearch: (v: string) => void;
  placeholder: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  dateLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-2.5">
      <input type="search" value={search} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} aria-label={placeholder} className={`${input} w-72`} />
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
export function ReportRecordsTab({ entries, loading, error, historicalError }: { entries: BuildingReportEntry[]; loading: boolean; error: boolean; historicalError: boolean }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ReportRecordStatus>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useDebouncedValue(search, 250);
  const rows = useMemo(() => filterReportRecords(entries, { search: q, status, from, to }), [entries, q, status, from, to]);
  const pdf = useReportPdf();

  return (
    <div data-testid="report-records">
      <Filters search={search} onSearch={setSearch} placeholder="Search client, building, address or job" from={from} to={to} onFrom={setFrom} onTo={setTo} dateLabel="Delivered">
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
          {rows.map((e) => {
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
        </div>
      )}
      {pdf.dialogs}
    </div>
  );
}

/** Every invoice recorded in JMS, whatever its status or its job's lifecycle. */
export function InvoiceRecordsTab({ invoices, loading, error }: { invoices: InvoiceRecord[]; loading: boolean; error: boolean }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<InvoiceRecordStatusFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useDebouncedValue(search, 250);
  const rows = useMemo(() => filterInvoiceRecords(invoices, { search: q, status, from, to }), [invoices, q, status, from, to]);

  return (
    <div data-testid="invoice-records">
      <Filters search={search} onSearch={setSearch} placeholder="Search invoice number, client, building or job" from={from} to={to} onFrom={setFrom} onTo={setTo} dateLabel="Created">
        <select value={status} onChange={(e) => setStatus(e.target.value as InvoiceRecordStatusFilter)} aria-label="Invoice status" className={input}>
          <option value="all">Any status</option>
          {(Object.keys(INVOICE_STATUS_LABEL) as (keyof typeof INVOICE_STATUS_LABEL)[]).map((s) => (
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
        <p className="px-4 py-3 text-[12.5px] text-neutral-500">{invoices.length === 0 ? 'No invoices have been created yet.' : 'No invoices match these filters.'}</p>
      ) : (
        rows.map((i) => <InvoiceRecordItem key={i.id} invoice={i} />)
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
          <p className="mt-1 text-[13px] text-neutral-600">Job reports already delivered to clients, and every invoice. Work still to do is in Ready for client and Ready for accounts.</p>
        </div>
        <div className="segmented ml-auto flex border border-neutral-300" role="group" aria-label="Records">
          {tabButton('reports', 'Job reports', active.isPending ? null : reportEntries.length)}
          {tabButton('invoices', 'Invoices', invoices.isPending ? null : (invoices.data ?? []).length)}
        </div>
      </div>
      <div className="mx-5 mb-5 border border-neutral-300 bg-white">
        {tab === 'reports' ? (
          <ReportRecordsTab entries={reportEntries} loading={active.isPending} error={active.isError} historicalError={historical.isError} />
        ) : (
          <InvoiceRecordsTab invoices={invoices.data ?? []} loading={invoices.isPending} error={invoices.isError} />
        )}
      </div>
    </div>
  );
}
