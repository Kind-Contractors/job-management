import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import type { WasteDraft } from './offline/wasteDb';
import { listWasteDrafts, listWasteMedia, subscribeWasteQueue, summarizeWasteUploads, type WasteUploadSummary } from './offline/wasteSyncEngine';
import { listMyWasteReports, type MySubmittedWasteReport } from './wasteApi';
import { formatWorkDates } from './wasteRules';
import { myWasteReportsKey } from './WasteShell';

const SENT_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

/** What a report still on its way says in the list - "Sending…" only while it really is on its way. */
export function sendingRowLabel(draft: WasteDraft, uploads: WasteUploadSummary | undefined): { text: string; attention: boolean } {
  if (draft.permanentFailure) return { text: 'Couldn’t be sent - tap to see why', attention: true };
  if (uploads && uploads.needsAttention > 0) return { text: 'Needs attention - a photo or video can’t be sent. Tap to fix it.', attention: true };
  const counted = uploads && uploads.total > 0 ? ` - ${uploads.ready} of ${uploads.total} uploaded` : '';
  if (uploads && uploads.retrying > 0) return { text: `Waiting for signal${counted}. It keeps trying by itself.`, attention: false };
  return { text: `Sending…${counted}`, attention: false };
}

/** Read-only: reports still being sent from this phone, then his submitted reports (newest first). Nothing here can be edited. */
export function MyWasteReportsList({
  sending,
  reports,
  uploads = {},
}: {
  sending: WasteDraft[];
  reports: MySubmittedWasteReport[];
  /** Each sending report's files, by report id. */
  uploads?: Record<string, WasteUploadSummary>;
}) {
  return (
    <div className="flex flex-col">
      {sending.map((d) => {
        const label = sendingRowLabel(d, uploads[d.reportId]);
        return (
          <Link
            key={d.reportId}
            to={`/waste/sent/${d.reportId}`}
            className={`border-b border-divider px-4 py-3 ${label.attention ? 'bg-missed/10' : 'bg-due/10'}`}
            data-testid="waste-sending-row"
          >
            <div className="text-[14px] font-semibold text-ink">{d.address.trim() || 'No address'}</div>
            <div className={`text-[12px] ${label.attention ? 'font-semibold text-missed-fg' : 'text-due-fg'}`}>{label.text}</div>
          </Link>
        );
      })}
      {reports.map((r) => (
        <div key={r.id} className="border-b border-divider px-4 py-3" data-testid="waste-report-row">
          <div className="text-[14px] font-semibold whitespace-pre-line text-ink">{r.address}</div>
          <div className="mt-0.5 text-[12px] text-neutral-600">
            {formatWorkDates(r.startDate, r.endDate)} · {r.photoCount} photo{r.photoCount === 1 ? '' : 's'} · {r.videoCount} video{r.videoCount === 1 ? '' : 's'}
          </div>
          <div className="text-[11.5px] text-neutral-500">Sent {SENT_FORMAT.format(new Date(r.submittedAt))}</div>
        </div>
      ))}
    </div>
  );
}

export default function MyWasteReportsPage() {
  const { session } = useAuth();
  const userId = session?.user.id ?? '';
  const [sending, setSending] = useState<WasteDraft[]>([]);
  const [uploads, setUploads] = useState<Record<string, WasteUploadSummary>>({});
  const { data, isPending, isError, refetch } = useQuery({ queryKey: myWasteReportsKey(userId), queryFn: listMyWasteReports, enabled: userId !== '' });

  // Follows the upload engine (an external store) for reports still on their way.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listWasteDrafts().then(async (drafts) => {
        const waiting = drafts.filter((d) => d.submitRequested);
        const summaries: Record<string, WasteUploadSummary> = {};
        for (const d of waiting) summaries[d.reportId] = summarizeWasteUploads(await listWasteMedia(d.reportId));
        if (cancelled) return;
        setSending(waiting);
        setUploads(summaries);
      });
    };
    refresh();
    const unsubscribe = subscribeWasteQueue(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="pb-6">
      <div className="px-4 pt-3 pb-2">
        <h1 className="font-heading text-[20px] leading-tight font-semibold text-ink">My reports</h1>
        <p className="text-[12px] text-neutral-500">Sent reports can’t be changed. If something needs correcting, tell the office.</p>
      </div>
      {isPending && sending.length === 0 && <p className="px-4 text-[13px] text-neutral-500">Loading…</p>}
      {isError && (
        <p className="px-4 text-[13px] text-missed-fg">
          Your reports couldn’t be loaded.{' '}
          <button type="button" onClick={() => void refetch()} className="cursor-pointer underline">
            Try again
          </button>
        </p>
      )}
      {!isPending && !isError && sending.length === 0 && (data ?? []).length === 0 && <p className="px-4 text-[13px] text-neutral-500">You haven’t sent any reports yet.</p>}
      <MyWasteReportsList sending={sending} reports={data ?? []} uploads={uploads} />
    </div>
  );
}
