import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  jobTypeLabel,
  listNeedsCorrection,
  listTodayVisits,
  listUpcomingVisits,
  retryUnlessOffline,
  type TechnicianCorrectionSummary,
  type TechnicianVisitSummary,
} from './api';
import { useSyncStatus } from './offline/syncEngine';

/** Same reasoning/value as JobFilePage.tsx/JobReportPage.tsx's identical constant — a technician re-opening Today's Jobs seconds after it was already loaded shouldn't force a new round trip. Left unchanged — newly booked/assigned jobs reaching this screen promptly is instead handled by POLL_INTERVAL_MS below plus TechnicianShell.tsx's online/foreground invalidation, not by shortening this. */
const VISIT_LIST_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * A newly booked/assigned visit (or a report bounced back for correction)
 * can only ever be noticed by actually asking the server — there's no
 * Realtime subscription. Polling this lightly, and only while the device
 * is genuinely online, closes that gap without hammering the network or
 * fighting the 5-minute staleTime above (refetchInterval bypasses
 * staleTime by design; it's an independent "also refetch on this timer"
 * rule). Returning `false` while offline stops the interval from even
 * attempting a doomed request, on top of TanStack Query's own default
 * online-aware networkMode.
 */
const POLL_INTERVAL_MS = 60_000;
function pollWhileOnline(): number | false {
  return navigator.onLine ? POLL_INTERVAL_MS : false;
}

type Tab = 'today' | 'upcoming' | 'returned';

const UPCOMING_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The next stop is the only one that carries visual weight (per the
 * technician flow PDF's own stated rule) — every other incomplete stop
 * stays neutral. `isNext` is true only for the first non-completed visit in
 * the (already office-ordered) list; done stops fade regardless of position.
 *
 * `dateLabel`, when given (the Upcoming tab only), replaces the numbered
 * stop-order circle with a plain date badge instead — Upcoming spans many
 * different days, so a "1/2/3" sequence badge would wrongly imply an
 * office-set running order the way it genuinely does within a single day
 * on Today. No reordering affordance exists here or anywhere else in this
 * list; it's read-only, chronological, server-sorted.
 */
function StopRow({
  visit,
  index,
  isNext,
  dateLabel,
  onSelect,
}: {
  visit: TechnicianVisitSummary;
  index: number;
  isNext: boolean;
  dateLabel?: string;
  onSelect: () => void;
}) {
  const done = visit.status === 'completed' || visit.reportSubmitted;
  return (
    <div
      onClick={onSelect}
      className={`flex cursor-pointer items-center gap-3 border-b border-l-4 border-divider px-4 py-3 hover:bg-neutral-100 ${
        done ? 'border-l-transparent bg-white opacity-50' : isNext ? 'border-l-teal bg-teal-100' : 'border-l-transparent bg-white'
      }`}
    >
      {dateLabel ? (
        <span className="flex h-10 w-12 flex-none flex-col items-center justify-center border border-neutral-300 font-heading text-[10px] font-semibold text-neutral-600 uppercase">
          {dateLabel}
        </span>
      ) : (
        <span
          className={`flex h-6 w-6 flex-none items-center justify-center rounded-full font-heading text-[11px] font-semibold ${
            done ? 'bg-neutral-300 text-neutral-600' : isNext ? 'bg-teal text-white' : 'border border-neutral-400 text-neutral-600'
          }`}
        >
          {done ? '✓' : index + 1}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {isNext && (
          <div className="mb-0.5 font-heading text-[9.5px] font-semibold tracking-[0.13em] text-teal-700 uppercase">Next stop</div>
        )}
        <div className="truncate text-[14px] font-semibold text-ink">{visit.buildingName ?? visit.buildingAddress}</div>
        <div className="truncate text-[12.5px] text-neutral-600">
          {[visit.buildingAddress, visit.buildingPostcode].filter(Boolean).join(', ')}
        </div>
        <div className="mt-0.5 font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
          {jobTypeLabel(visit.jobType)}, {visit.jobSummary}
        </div>
      </div>
      <span className="text-neutral-400">›</span>
    </div>
  );
}

/** Shared by all three tabs below — shown only when a tab has never successfully fetched anything AND the device is currently offline (see the `*OfflineWithNoData` checks in DayViewPage), never for a genuinely empty online result. */
function OfflineEmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="p-4">
      <div className="border border-neutral-300 bg-neutral-100 p-4">
        <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">You're offline</div>
        <div className="mt-1.5 text-[13px] text-ink">
          Nothing has been saved on this device yet, so it can't be shown without a connection.
        </div>
        <button
          onClick={onRetry}
          className="mt-3 cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

/** Reuses the same row shape as StopRow — no sequence badge (order doesn't apply here), a due-toned accent instead of teal, and the manager's return reason shown beneath the address. */
function ReturnedRow({ item, onSelect }: { item: TechnicianCorrectionSummary; onSelect: () => void }) {
  return (
    <div
      onClick={onSelect}
      className="flex cursor-pointer items-center gap-3 border-b border-l-4 border-due bg-due/10 px-4 py-3 hover:bg-due/20"
    >
      <span className="h-2.5 w-2.5 flex-none rounded-full bg-due" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-ink">{item.buildingName ?? item.buildingAddress}</div>
        <div className="truncate text-[12.5px] text-neutral-600">
          {[item.buildingAddress, item.buildingPostcode].filter(Boolean).join(', ')}
        </div>
        <div className="mt-0.5 font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
          {jobTypeLabel(item.jobType)}, {item.jobSummary}
        </div>
        {item.returnReason && <div className="mt-1 truncate text-[12px] text-due-fg">Returned: {item.returnReason}</div>}
      </div>
      <span className="text-neutral-400">›</span>
    </div>
  );
}

export default function DayViewPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('today');

  const { online } = useSyncStatus();

  const {
    data: visitsData,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['technician', 'todayVisits'],
    queryFn: listTodayVisits,
    staleTime: VISIT_LIST_STALE_TIME_MS,
    retry: retryUnlessOffline,
    refetchInterval: pollWhileOnline,
  });
  const visits = visitsData ?? [];
  // visitsData (not the defaulted `visits`) distinguishes "never
  // successfully fetched" from "fetched, and there's genuinely nothing
  // scheduled" — an empty array is a legitimate, common online result,
  // not itself a sign of missing data.
  const todayOfflineWithNoData = visitsData === undefined && !online;

  const {
    data: needsCorrectionData,
    isLoading: correctionLoading,
    isFetching: correctionFetching,
    isError: correctionError,
    error: correctionErrorObj,
    refetch: refetchCorrection,
  } = useQuery({
    queryKey: ['technician', 'needsCorrection'],
    queryFn: listNeedsCorrection,
    staleTime: VISIT_LIST_STALE_TIME_MS,
    retry: retryUnlessOffline,
    refetchInterval: pollWhileOnline,
  });
  const needsCorrection = needsCorrectionData ?? [];
  const correctionOfflineWithNoData = needsCorrectionData === undefined && !online;

  const {
    data: upcomingVisitsData,
    isLoading: upcomingLoading,
    isFetching: upcomingFetching,
    isError: upcomingError,
    error: upcomingErrorObj,
    refetch: refetchUpcoming,
  } = useQuery({
    queryKey: ['technician', 'upcomingVisits'],
    queryFn: listUpcomingVisits,
    enabled: tab === 'upcoming',
    staleTime: VISIT_LIST_STALE_TIME_MS,
    retry: retryUnlessOffline,
    refetchInterval: pollWhileOnline,
  });
  const upcomingVisits = upcomingVisitsData ?? [];
  const upcomingOfflineWithNoData = upcomingVisitsData === undefined && !online;

  const isManuallyRefreshing = isFetching || correctionFetching || upcomingFetching;
  const handleManualRefresh = () => {
    if (!online) return;
    void refetch();
    void refetchCorrection();
    if (tab === 'upcoming') void refetchUpcoming();
  };

  const doneCount = visits.filter((v) => v.status === 'completed' || v.reportSubmitted).length;
  const nextIndex = visits.findIndex((v) => v.status !== 'completed' && !v.reportSubmitted);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between border-b border-divider bg-neutral-200 px-4 py-3">
        <h1 className="font-heading text-xl font-semibold">{tab === 'returned' ? 'Returned' : 'Your day'}</h1>
        <div className="flex items-center gap-2.5">
          {tab === 'today' && !isLoading && !isError && (
            <span className="text-[12px] text-neutral-600 tabular-nums">
              {visits.length} stop{visits.length === 1 ? '' : 's'} · {doneCount} done
            </span>
          )}
          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={!online || isManuallyRefreshing}
            title={!online ? "You're offline — showing what was last saved on this device" : 'Refresh'}
            aria-label="Refresh"
            className="cursor-pointer border border-neutral-300 bg-white px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!online ? 'Offline' : isManuallyRefreshing ? 'Refreshing…' : '⟳ Refresh'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'today' &&
          (todayOfflineWithNoData ? (
            <OfflineEmptyState onRetry={() => void refetch()} />
          ) : isLoading ? (
            <div className="p-4">
              <div className="grid gap-1.5">
                {[1, 0.85, 0.7, 0.55].map((o, i) => (
                  <div key={i} className="h-[58px] animate-shimmer bg-neutral-300" style={{ opacity: o }} />
                ))}
              </div>
              <div className="mt-4 font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
                Loading your day…
              </div>
            </div>
          ) : isError ? (
            <div className="p-4">
              <div className="border border-missed bg-missed/10 p-4">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                  Couldn't load your day
                </div>
                <div className="mt-1.5 text-[13px] text-ink">{error instanceof Error ? error.message : 'Something went wrong.'}</div>
              </div>
            </div>
          ) : visits.length === 0 ? (
            <div className="p-4">
              <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                  Nothing scheduled today
                </div>
                <div className="mt-1.5 text-[13px] text-neutral-600">Check back later, or contact the office if this looks wrong.</div>
              </div>
            </div>
          ) : (
            <div>
              {visits.map((visit, index) => (
                <StopRow
                  key={visit.visitId}
                  visit={visit}
                  index={index}
                  isNext={index === nextIndex}
                  onSelect={() => navigate(`/technician/visits/${visit.visitId}`)}
                />
              ))}
            </div>
          ))}

        {tab === 'upcoming' &&
          (upcomingOfflineWithNoData ? (
            <OfflineEmptyState onRetry={() => void refetchUpcoming()} />
          ) : upcomingLoading ? (
            <div className="p-4">
              <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
            </div>
          ) : upcomingError ? (
            <div className="p-4">
              <div className="border border-missed bg-missed/10 p-4">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                  Couldn't load upcoming visits
                </div>
                <div className="mt-1.5 text-[13px] text-ink">
                  {upcomingErrorObj instanceof Error ? upcomingErrorObj.message : 'Something went wrong.'}
                </div>
              </div>
            </div>
          ) : upcomingVisits.length === 0 ? (
            <div className="p-4">
              <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                  Nothing scheduled yet
                </div>
                <div className="mt-1.5 text-[13px] text-neutral-600">No future visits assigned to you at the moment.</div>
              </div>
            </div>
          ) : (
            <div>
              {upcomingVisits.map((visit, index) => (
                <StopRow
                  key={visit.visitId}
                  visit={visit}
                  index={index}
                  isNext={false}
                  dateLabel={UPCOMING_DATE_FORMAT.format(new Date(`${visit.scheduledDate}T00:00:00`))}
                  onSelect={() => navigate(`/technician/visits/${visit.visitId}`)}
                />
              ))}
            </div>
          ))}

        {tab === 'returned' &&
          (correctionOfflineWithNoData ? (
            <OfflineEmptyState onRetry={() => void refetchCorrection()} />
          ) : correctionLoading ? (
            <div className="p-4">
              <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
            </div>
          ) : correctionError ? (
            <div className="p-4">
              <div className="border border-missed bg-missed/10 p-4">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">Couldn't load returned reports</div>
                <div className="mt-1.5 text-[13px] text-ink">
                  {correctionErrorObj instanceof Error ? correctionErrorObj.message : 'Something went wrong.'}
                </div>
              </div>
            </div>
          ) : needsCorrection.length === 0 ? (
            <div className="p-4">
              <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">Nothing returned</div>
              </div>
            </div>
          ) : (
            <div>
              {needsCorrection.map((item) => (
                <ReturnedRow key={item.reportId} item={item} onSelect={() => navigate(`/technician/visits/${item.visitId}`)} />
              ))}
            </div>
          ))}
      </div>

      <div className="grid flex-none grid-cols-3 border-t border-divider bg-neutral-100">
        {(
          [
            { key: 'today', label: 'Today' },
            { key: 'upcoming', label: 'Upcoming' },
            { key: 'returned', label: `Returned${needsCorrection.length > 0 ? ` · ${needsCorrection.length}` : ''}` },
          ] as { key: Tab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`cursor-pointer border-t-2 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.1em] uppercase ${
              tab === key ? 'border-teal text-teal-700' : 'border-transparent text-neutral-500 hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
