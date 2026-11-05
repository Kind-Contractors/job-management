import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import type { WasteDraft, WasteMedia } from './offline/wasteDb';
import {
  editWasteDraftAgain,
  getWasteDraft,
  listWasteMedia,
  retryWaitingUploads,
  retryWasteSubmit,
  subscribeWasteQueue,
  summarizeWasteUploads,
  type WasteUploadSummary,
} from './offline/wasteSyncEngine';
import { listMyWasteReports } from './wasteApi';
import { formatWorkDates } from './wasteRules';
import { myWasteReportsKey } from './WasteShell';

/** What this screen shows for a report, from the phone's own record and (once that is gone) the server's list. */
export type SentState =
  | { kind: 'loading' }
  /** failed: files the server refused for good (the report can't be sent until they are removed). */
  | { kind: 'sending'; draft: WasteDraft; ready: number; total: number; failed: number; uploads: WasteUploadSummary }
  | { kind: 'refused'; draft: WasteDraft }
  | { kind: 'sent' }
  | { kind: 'unknown' };

export function sentStateFor(draft: WasteDraft | null | undefined, media: WasteMedia[], onServer: boolean | null): SentState {
  if (draft === undefined) return { kind: 'loading' };
  if (draft && draft.submitRequested) {
    if (draft.permanentFailure) return { kind: 'refused', draft };
    const uploads = summarizeWasteUploads(media);
    return { kind: 'sending', draft, ready: uploads.ready, total: uploads.total, failed: uploads.needsAttention, uploads };
  }
  // The phone keeps a report only until the server has confirmed it, so "gone from the phone" + "on the server" means sent.
  if (onServer === null) return { kind: 'loading' };
  return onServer ? { kind: 'sent' } : { kind: 'unknown' };
}

/** After "Send report": the live state of that report, and "Start another report". */
export default function WasteReportSentPage() {
  const { reportId = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const userId = session?.user.id ?? '';
  const [draft, setDraft] = useState<WasteDraft | null | undefined>(undefined);
  const [media, setMedia] = useState<WasteMedia[]>([]);

  // Follows the upload engine (an external store) for this report.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void Promise.all([getWasteDraft(reportId), listWasteMedia(reportId)]).then(([d, m]) => {
        if (cancelled) return;
        setDraft(d ?? null);
        setMedia(m);
      });
    };
    refresh();
    const unsubscribe = subscribeWasteQueue(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [reportId]);

  const server = useQuery({
    queryKey: myWasteReportsKey(userId),
    queryFn: listMyWasteReports,
    enabled: userId !== '' && draft === null,
  });
  const onServerReport = server.data?.find((r) => r.id === reportId) ?? null;
  // An older cached list that lacks this report is not an answer while a fresh one is on its way.
  let onServer: boolean | null = null;
  if (onServerReport) onServer = true;
  else if (!server.isFetching && (server.data || server.isError)) onServer = false;
  const state = sentStateFor(draft, media, draft === null ? onServer : null);

  return (
    <div className="flex flex-col gap-4 px-4 py-5">
      {state.kind === 'loading' && <p className="text-[13px] text-neutral-500">Checking…</p>}

      {state.kind === 'sending' && state.failed > 0 && (
        // Blocked: it will NOT be sent by itself - say so, why, and the one thing to do.
        <div className="border border-missed bg-missed/10 px-4 py-3" role="alert" data-testid="waste-needs-attention">
          <h1 className="font-heading text-[19px] font-semibold text-missed-fg">Your report needs attention</h1>
          <p className="mt-1 text-[13px] text-ink">
            {state.failed === 1 ? '1 photo or video can’t be sent' : `${state.failed} photos or videos can’t be sent`}, so the report can’t be sent yet. Open
            the report, remove {state.failed === 1 ? 'it' : 'them'} (add {state.failed === 1 ? 'it' : 'them'} again if needed) and send it again. The {state.ready}{' '}
            already uploaded are kept.
          </p>
          <ul className="mt-1.5 list-disc pl-5 text-[12.5px] text-missed-fg">
            {state.uploads.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void editWasteDraftAgain(reportId).then(() => navigate(`/waste?report=${reportId}`))}
            className="mt-3 w-full cursor-pointer bg-missed py-2.5 text-[14px] font-semibold text-white"
          >
            Open the report to fix it
          </button>
        </div>
      )}

      {state.kind === 'sending' && state.failed === 0 && (
        <div className="border border-due bg-due/10 px-4 py-3" data-testid="waste-sending">
          <h1 className="font-heading text-[19px] font-semibold text-due-fg">Sending your report</h1>
          <p className="mt-1 text-[13px] text-ink">
            {state.total === 0 ? 'Waiting for a connection…' : `${state.ready} of ${state.total} photos and videos uploaded.`} It is saved on this phone and
            will be sent by itself - you can start another report now. Keep the app open until it’s sent if you can.
          </p>
          {state.uploads.retrying > 0 && (
            <div className="mt-2 text-[12.5px] text-due-fg" data-testid="waste-retrying">
              {state.uploads.retrying === 1 ? '1 file is' : `${state.uploads.retrying} files are`} waiting for a better signal. They keep trying by themselves.{' '}
              <button type="button" onClick={() => void retryWaitingUploads(reportId)} className="cursor-pointer font-semibold underline">
                Try now
              </button>
            </div>
          )}
        </div>
      )}

      {state.kind === 'refused' && (
        <div className="border border-missed bg-missed/10 px-4 py-3" role="alert" data-testid="waste-refused">
          <h1 className="font-heading text-[19px] font-semibold text-missed-fg">The report couldn’t be sent</h1>
          <p className="mt-1 text-[13px] text-ink">{state.draft.submitError}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void editWasteDraftAgain(reportId).then(() => navigate('/waste'))} className="flex-1 cursor-pointer border border-neutral-300 bg-white py-2.5 text-[13px]">
              Change the report
            </button>
            <button type="button" onClick={() => void retryWasteSubmit(reportId)} className="flex-1 cursor-pointer bg-teal py-2.5 text-[13px] font-semibold text-white">
              Try again
            </button>
          </div>
        </div>
      )}

      {state.kind === 'sent' && (
        <div className="border border-done bg-done/10 px-4 py-3" data-testid="waste-sent">
          <h1 className="font-heading text-[19px] font-semibold text-done-fg">✓ Report sent</h1>
          {onServerReport && (
            <p className="mt-1 text-[13px] text-ink">
              {onServerReport.address} · {formatWorkDates(onServerReport.startDate, onServerReport.endDate)} · {onServerReport.photoCount} photo
              {onServerReport.photoCount === 1 ? '' : 's'}, {onServerReport.videoCount} video{onServerReport.videoCount === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}

      {state.kind === 'unknown' && <p className="text-[13px] text-neutral-600">This report isn’t on this phone any more and wasn’t found among your sent reports.</p>}

      <button type="button" onClick={() => navigate('/waste')} className="w-full cursor-pointer bg-teal py-3.5 text-[15px] font-semibold text-white">
        Start another report
      </button>
      <button type="button" onClick={() => navigate('/waste/reports')} className="mx-auto cursor-pointer text-[13px] text-neutral-600 underline">
        My reports
      </button>
    </div>
  );
}
