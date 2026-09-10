import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { getVisitDetail, listTodayVisits } from './api';
import { getDraft, getVisitPhotos, subscribeSyncEngine, trySubmitIfReady } from './offline/syncEngine';
import type { DraftReport, PendingPhoto } from './offline/db';

interface CompletedNavState {
  photoCount?: number;
  onSiteStart?: string;
  onSiteEnd?: string;
}

const timeFormatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function CompletedPage() {
  const navigate = useNavigate();
  const { visitId } = useParams<{ visitId: string }>();
  const location = useLocation();
  const state = (location.state as CompletedNavState | null) ?? {};

  // The server-confirmed source of truth — unchanged from before.
  const {
    data: visit,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['technician', 'visitDetail', visitId],
    queryFn: () => getVisitDetail(visitId!),
    enabled: !!visitId,
  });

  // The LOCAL source of truth for "did I already complete this, even if
  // the server hasn't confirmed it yet" — a report only reaches the
  // server once every one of its photos has finished uploading (see
  // offline/syncEngine.ts), which can be well after this screen is first
  // shown. Without this, reopening/reloading this screen before sync
  // finishes would wrongly show "hasn't been completed yet."
  const [draft, setDraft] = useState<DraftReport | undefined>(undefined);
  const [localPhotos, setLocalPhotos] = useState<PendingPhoto[]>([]);
  const [draftLoaded, setDraftLoaded] = useState(false);

  useEffect(() => {
    if (!visitId) return;
    let cancelled = false;
    const refresh = () => {
      void Promise.all([getDraft(visitId), getVisitPhotos(visitId)]).then(([d, photos]) => {
        if (cancelled) return;
        setDraft(d);
        setLocalPhotos(photos);
        setDraftLoaded(true);
      });
    };
    refresh();
    void trySubmitIfReady(visitId); // in case we arrived here already online and nothing has kicked off a submit attempt yet
    const unsubscribe = subscribeSyncEngine(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [visitId]);

  // Best-effort only, exactly like Job File's own "Stop N" — renders correctly with or without it.
  const { data: todayVisits } = useQuery({ queryKey: ['technician', 'todayVisits'], queryFn: listTodayVisits });
  const nextStop = todayVisits?.find((v) => v.visitId !== visitId && v.status !== 'completed' && !v.reportSubmitted);

  const isSyncedToServer = !!visit?.reportId;
  const isWaitingToSync = !isSyncedToServer && !!draft?.readyToSubmit;

  if (isLoading || !draftLoaded) {
    return (
      <div className="p-4">
        <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
      </div>
    );
  }

  if (isError || (!isSyncedToServer && !isWaitingToSync)) {
    // Never shows a false "completed" confirmation — this is the honest
    // state whenever there's neither a server-confirmed report NOR a
    // locally-queued one waiting to sync, regardless of how this screen
    // was reached.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="p-4">
          <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              This visit hasn't been completed yet
            </div>
            <div className="mt-1.5 text-[13px] text-neutral-600">No report has been submitted for this visit.</div>
            <button
              onClick={() => navigate(visitId ? `/technician/visits/${visitId}` : '/technician')}
              className="mt-3 cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            >
              Back to job file
            </button>
          </div>
        </div>
      </div>
    );
  }

  const uploadedCount = localPhotos.filter((p) => p.status === 'uploaded').length;
  const totalLocalPhotos = localPhotos.length;
  const photoCount = state.photoCount ?? totalLocalPhotos;
  const onSiteStart = state.onSiteStart ?? draft?.onSiteStart ?? undefined;
  const onSiteEnd = state.onSiteEnd ?? draft?.onSiteEnd ?? undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isSyncedToServer ? (
        <div className="flex-none border-b border-teal-700/40 bg-teal-100 px-4 py-3">
          <h1 className="font-heading text-lg font-semibold text-teal-700">Job completed</h1>
          <div className="text-[12.5px] text-teal-700">Sent to the office</div>
        </div>
      ) : (
        <div className="flex-none border-b border-due/40 bg-due/10 px-4 py-3">
          <h1 className="font-heading text-lg font-semibold text-due-fg">Job completed</h1>
          <div className="text-[12.5px] text-due-fg">
            {draft?.submitError ? 'Sync failed — will retry automatically' : 'Waiting to sync — will send automatically'}
          </div>
        </div>
      )}

      <div className="flex-1 bg-white px-4 py-4">
        {(photoCount != null || onSiteStart) && (
          <div className="mb-4 grid grid-cols-2 gap-3 border border-neutral-300 p-3">
            {photoCount != null && (
              <div>
                <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Photos</div>
                <div className="text-lg font-semibold text-ink tabular-nums">
                  {photoCount}
                  {!isSyncedToServer && totalLocalPhotos > 0 && (
                    <span className="ml-1.5 text-[11px] font-normal text-neutral-500">({uploadedCount} uploaded)</span>
                  )}
                </div>
              </div>
            )}
            {onSiteStart && onSiteEnd && (
              <div>
                <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">On site</div>
                <div className="text-lg font-semibold text-ink tabular-nums">
                  {timeFormatter.format(new Date(onSiteStart))} – {timeFormatter.format(new Date(onSiteEnd))}
                </div>
              </div>
            )}
          </div>
        )}

        {isSyncedToServer ? (
          <div className="text-[13.5px] leading-relaxed text-neutral-700">
            The office will check this report before anything goes to the client. Nothing else for you to do here.
          </div>
        ) : (
          <div className="text-[13.5px] leading-relaxed text-neutral-700">
            {draft?.submitError ? (
              <>
                The last attempt to send this report failed: {draft.submitError}. It will keep retrying automatically —
                nothing is lost, and there's nothing you need to do.
              </>
            ) : (
              <>
                This report is saved on your device and will be sent to the office automatically once every photo has
                finished uploading and you're back online. You can move on to your next stop — nothing else for you to
                do here.
              </>
            )}
          </div>
        )}
      </div>

      <div className="p-4">
        {nextStop ? (
          <button
            onClick={() => navigate(`/technician/visits/${nextStop.visitId}`)}
            className="w-full cursor-pointer bg-teal px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Next stop — {nextStop.buildingName ?? nextStop.buildingAddress}
          </button>
        ) : (
          <button
            onClick={() => navigate('/technician')}
            className="w-full cursor-pointer bg-teal px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Back to your day
          </button>
        )}
      </div>
    </div>
  );
}