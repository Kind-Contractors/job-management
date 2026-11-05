import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listBuildingInvoiceRecords, type InvoiceRecord } from '../../repository/invoiceRecordsRepository';
import InvoiceRecordItem from '../records/InvoiceRecordItem';
import ScrollableList from '../shared/ScrollableList';

/** Presentational: the building's invoices (any status, jobs of any lifecycle), newest first. */
export function BuildingInvoicesList({ invoices, loading, error, onRetry }: { invoices: InvoiceRecord[]; loading: boolean; error: boolean; onRetry: () => void }) {
  return (
    <div data-testid="building-invoices" className="border border-neutral-300 bg-white">
      <div className="flex items-center border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
        Invoices · {invoices.length}
        <Link to="/records?tab=invoices" className="ml-auto font-sans text-[11px] font-normal tracking-normal text-teal-700 normal-case hover:underline">
          All invoices in Records →
        </Link>
      </div>
      {error ? (
        <div className="px-4 py-3 text-[12.5px] text-missed-fg">
          The invoices could not be loaded.{' '}
          <button type="button" onClick={onRetry} className="cursor-pointer underline">
            Try again
          </button>
        </div>
      ) : loading ? (
        <div className="px-4 py-3 text-[12.5px] text-neutral-500">Loading invoices…</div>
      ) : invoices.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-neutral-500">No invoices for this building yet.</div>
      ) : (
        <ScrollableList count={invoices.length} label="Invoices">
          {invoices.map((i) => (
            <InvoiceRecordItem key={i.id} invoice={i} showBuilding={false} />
          ))}
        </ScrollableList>
      )}
      <div className="border-t border-divider px-4 py-1.5 text-[11px] text-neutral-500">Status as recorded in JMS; amounts before VAT from the JMS lines. Paid / voided / credited is only in Xero.</div>
    </div>
  );
}

/** The Building File's Invoices panel: invoices of every job at this building (via invoices.job_id -> jobs.building_id). */
export default function BuildingInvoicesPanel({ buildingId }: { buildingId: string }) {
  const q = useQuery({ queryKey: ['buildingInvoiceRecords', buildingId], queryFn: () => listBuildingInvoiceRecords(buildingId) });
  return <BuildingInvoicesList invoices={q.data ?? []} loading={q.isPending} error={q.isError} onRetry={() => void q.refetch()} />;
}
