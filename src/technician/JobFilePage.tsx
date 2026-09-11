import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { getVisitDetail, jobTypeLabel, listTodayVisits, retryUnlessOffline } from './api';
import { useSyncStatus } from './offline/syncEngine';

/**
 * Reusing the exact same query key JobReportPage.tsx uses for the same
 * visit — see JobReportPage.tsx's own comment on this staleTime. Kept
 * identical in both places: they share one cache entry, so divergent
 * staleTime values here would just make the *other* page's mount win.
 */
const VISIT_DETAIL_STALE_TIME_MS = 5 * 60 * 1000;

export default function JobFilePage() {
  const navigate = useNavigate();
  const { visitId } = useParams<{ visitId: string }>();

  const {
    data: visit,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['technician', 'visitDetail', visitId],
    queryFn: () => getVisitDetail(visitId!),
    enabled: !!visitId,
    staleTime: VISIT_DETAIL_STALE_TIME_MS,
    retry: retryUnlessOffline,
  });
  const { online } = useSyncStatus();
  // No cached data at all, and genuinely offline (or navigator.onLine
  // wrongly says so) — the one case neither the existing "Couldn't load"
  // nor "isn't available" messaging was ever written to describe
  // honestly. TechnicianShell's header already shows a persistent
  // "Offline" badge, so this is only for the specific empty-state case,
  // not a second offline indicator layered on top of working content.
  const offlineWithNoData = !visit && !online;

  // Best-effort only — the page must render correctly even if this hasn't
  // loaded, has never been fetched (direct navigation to this URL), or
  // errors. Never gates the page's own render on this query.
  const { data: todayVisits } = useQuery({ queryKey: ['technician', 'todayVisits'], queryFn: listTodayVisits });
  const stopNumber = todayVisits && visitId ? todayVisits.findIndex((v) => v.visitId === visitId) + 1 : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-divider bg-neutral-200 px-4 py-2.5">
        <button onClick={() => navigate('/technician')} className="cursor-pointer text-[12.5px] text-teal-700 hover:underline">
          ‹ Your day
        </button>
      </div>

      {offlineWithNoData ? (
        <div className="p-4">
          <div className="border border-neutral-300 bg-neutral-100 p-4">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">You're offline</div>
            <div className="mt-1.5 text-[13px] text-ink">
              This job hasn't been saved on this device yet, so it can't be shown without a connection.
            </div>
            <button
              onClick={() => void refetch()}
              className="mt-3 cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            >
              Try again
            </button>
          </div>
        </div>
      ) : isLoading ? (
        <div className="p-4">
          <div className="grid gap-1.5">
            {[1, 0.8, 0.6].map((o, i) => (
              <div key={i} className="h-[24px] animate-shimmer bg-neutral-300" style={{ opacity: o }} />
            ))}
          </div>
          <div className="mt-4 font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading job…</div>
        </div>
      ) : isError ? (
        <div className="p-4">
          <div className="border border-missed bg-missed/10 p-4">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">Couldn't load this job</div>
            <div className="mt-1.5 text-[13px] text-ink">{error instanceof Error ? error.message : 'Something went wrong.'}</div>
          </div>
        </div>
      ) : !visit ? (
        <div className="p-4">
          <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              This visit isn't available
            </div>
            <div className="mt-1.5 text-[13px] text-neutral-600">
              It may not be assigned to you, or no longer exists.{' '}
              <button onClick={() => navigate('/technician')} className="cursor-pointer text-teal-700 hover:underline">
                Back to your day
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto bg-white">
          <div className="border-b border-divider px-4 py-3">
            {stopNumber > 0 && (
              <div className="mb-1 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                Stop {stopNumber}
              </div>
            )}
            <h1 className="font-heading text-xl leading-tight font-semibold">{visit.buildingName ?? visit.buildingAddress}</h1>
            <div className="text-[13px] text-neutral-600">{[visit.buildingAddress, visit.buildingPostcode].filter(Boolean).join(', ')}</div>
            <div className="mt-1.5 font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
              {jobTypeLabel(visit.jobType)}, {visit.jobSummary}
            </div>
          </div>

          <div className="border-b border-divider px-4 py-3">
            <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              Specification of works
            </div>
            <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{visit.jobSummary ?? visit.jobNotes}</div>
          </div>

          {visit.siteInstructions && (
            <div className="border-b border-divider px-4 py-3">
              <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                Site instructions
              </div>
              <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{visit.siteInstructions}</div>
            </div>
          )}

          {(visit.keySafeCode || visit.accessNotes || visit.keyholderName) && (
            <div className="border-b border-divider px-4 py-3">
              <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">Access</div>
              {visit.keySafeCode && (
                <div className="mb-2">
                  <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Key safe</div>
                  <div className="font-heading text-[28px] leading-tight font-bold tracking-[0.15em] text-ink tabular-nums">
                    {visit.keySafeCode}
                  </div>
                </div>
              )}
              {visit.accessNotes && <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{visit.accessNotes}</div>}
              {visit.keyholderName && (
                <div className="mt-1.5 text-[13.5px] text-ink">
                  Keyholder: {visit.keyholderName}
                  {visit.keyholderPhone ? ` ${visit.keyholderPhone}` : ''}
                </div>
              )}
            </div>
          )}

          {visit.parkingNotes && (
            <div className="border-b border-divider px-4 py-3">
              <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">Parking</div>
              <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{visit.parkingNotes}</div>
            </div>
          )}

          {visit.reportReviewStatus === 'returned_for_correction' && (
            <div className="m-3.5 border border-due bg-due/10 p-3">
              <div className="font-heading text-[11px] font-semibold tracking-[0.11em] text-due-fg uppercase">Returned for correction</div>
              {visit.reportReturnReason && <div className="mt-1 text-[12.5px] leading-snug text-due-fg">{visit.reportReturnReason}</div>}
            </div>
          )}

          <div className="mt-auto p-4">
            {visit.reportReviewStatus === 'returned_for_correction' ? (
              <button
                onClick={() => navigate(`/technician/visits/${visit.visitId}/report`)}
                className="w-full cursor-pointer bg-due px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90"
              >
                Fix and resubmit
              </button>
            ) : visit.reportId ? (
              <div className="border border-neutral-300 bg-neutral-100 px-3 py-2.5 text-center text-sm font-semibold text-neutral-600">
                Report submitted
              </div>
            ) : (
              <button
                onClick={() => navigate(`/technician/visits/${visit.visitId}/report`)}
                className="w-full cursor-pointer bg-teal px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90"
              >
                Add report
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
