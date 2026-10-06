import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  dayItemKey,
  isDayItemDone,
  isSharedVisit,
  isVisitDoneForMe,
  jobTypeLabel,
  listNeedsCorrection,
  listPastVisits,
  listTodayItems,
  nextStopIndex,
  retryUnlessOffline,
  setActivityDone,
  sharedVisitLabel,
  type TechnicianActivityItem,
  type TechnicianCorrectionSummary,
  type TechnicianVisitSummary,
} from './api';
import { useSyncStatus } from './offline/syncEngine';
import { technicianKeys, useTechnicianUserId } from './queryKeys';
import { formatTimeRange } from '../lib/timeRange';

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

type Tab = 'today' | 'past' | 'correction';

// Module-level so the selected tab survives opening a job and coming back
// (this page unmounts on navigation); resets to Today on a full reload.
let lastSelectedTab: Tab = 'today';

const PAST_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The next stop is the only one that carries visual weight (per the
 * technician flow PDF's own stated rule) — every other incomplete stop
 * stays neutral. `isNext` is true only for the first non-completed visit in
 * the (already office-ordered) list; done stops fade regardless of position.
 *
 * `dateLabel`, when given (the Past tab only), replaces the numbered
 * stop-order circle with a plain date badge instead — Past spans many
 * different days, so a "1/2/3" sequence badge would wrongly imply an
 * office-set running order the way it genuinely does within a single day
 * on Today. No reordering affordance exists here or anywhere else in this
 * list; it's read-only, chronological, server-sorted.
 */
export function StopRow({
  visit,
  index,
  isNext,
  dateLabel,
  onSelect,
}: {
  /** A job; on Today it also carries its optional time of day (display only). */
  visit: TechnicianVisitSummary & { startTime?: string | null; endTime?: string | null };
  index: number;
  isNext: boolean;
  dateLabel?: string;
  onSelect: () => void;
}) {
  const done = isVisitDoneForMe(visit);
  const timeLabel = formatTimeRange(visit.startTime ?? null, visit.endTime ?? null);
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
        {timeLabel && <div className="mt-0.5 text-[12px] font-semibold text-teal-700 tabular-nums">{timeLabel}</div>}
        {isSharedVisit(visit) && (
          <div className="mt-0.5 text-[11px] text-teal-700">
            {sharedVisitLabel(visit.assignedCount)}
            {!visit.reportSubmitted && ' · your part is still to do'}
          </div>
        )}
      </div>
      <span className="text-neutral-400">›</span>
    </div>
  );
}

/**
 * An Activity in the technician's day: a non-job item (a quote visit, picking up keys, a meeting) in the
 * same numbered sequence as the jobs. It is clearly marked "Activity", shows its optional time, location and
 * notes, and can be marked done (and undone) by the technician it is assigned to. A done activity stays in
 * the list, faded with a tick; an incomplete one can be the "Next stop". Tapping the row shows the full notes.
 */
export function ActivityRow({
  item,
  index,
  isNext,
  canChange,
  pending,
  error,
  onToggleDone,
}: {
  item: TechnicianActivityItem;
  index: number;
  isNext: boolean;
  /** False while offline: marking done needs a connection (the change is made on the server). */
  canChange: boolean;
  pending: boolean;
  error?: string | null;
  onToggleDone: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const done = item.done;
  const timeLabel = formatTimeRange(item.startTime, item.endTime);
  return (
    <div
      className={`flex items-start gap-3 border-b border-l-4 border-divider px-4 py-3 ${
        done ? 'border-l-transparent bg-white opacity-60' : isNext ? 'border-l-teal bg-teal-100' : 'border-l-transparent bg-white'
      }`}
    >
      <span
        className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full font-heading text-[11px] font-semibold ${
          done ? 'bg-neutral-300 text-neutral-600' : isNext ? 'bg-teal text-white' : 'border border-neutral-400 text-neutral-600'
        }`}
      >
        {done ? '✓' : index + 1}
      </span>
      <div className="min-w-0 flex-1">
        {isNext && !done && (
          <div className="mb-0.5 font-heading text-[9.5px] font-semibold tracking-[0.13em] text-teal-700 uppercase">Next stop</div>
        )}
        <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} className="block w-full cursor-pointer text-left">
          <div className="flex items-center gap-1.5">
            <span className="flex-none border border-neutral-500 px-1 font-heading text-[9px] font-semibold tracking-[0.1em] text-neutral-600 uppercase">
              Activity
            </span>
            <span className={`truncate text-[14px] font-semibold text-ink ${done ? 'line-through' : ''}`}>{item.description}</span>
          </div>
          {timeLabel && <div className="mt-0.5 text-[12px] font-semibold text-teal-700 tabular-nums">{timeLabel}</div>}
          {item.location && <div className="mt-0.5 truncate text-[12.5px] text-neutral-600">📍 {item.location}</div>}
          {item.notes && (
            <div className={`mt-0.5 text-[12.5px] whitespace-pre-line text-neutral-600 ${expanded ? '' : 'line-clamp-2'}`}>{item.notes}</div>
          )}
        </button>
        {done && <div className="mt-0.5 text-[11px] text-done-fg">Done</div>}
        {error && (
          <div role="alert" className="mt-1 text-[11.5px] text-missed-fg">
            {error}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onToggleDone}
        disabled={!canChange || pending}
        title={!canChange ? "You're offline — marking an activity done needs a connection" : undefined}
        className={`flex-none cursor-pointer border px-2.5 py-1.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
          done ? 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100' : 'border-teal-700 bg-white text-teal-700 hover:bg-teal-100'
        }`}
      >
        {pending ? 'Saving…' : done ? 'Undo' : 'Mark done'}
      </button>
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

/** Reuses the same row shape as StopRow — no sequence badge (order doesn't apply here), a due-toned accent instead of teal, and the office's reason for sending the report back shown beneath the address. */
function CorrectionRow({ item, onSelect }: { item: TechnicianCorrectionSummary; onSelect: () => void }) {
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
        {item.returnReason && <div className="mt-1 truncate text-[12px] text-due-fg">Reason: {item.returnReason}</div>}
      </div>
      <span className="text-neutral-400">›</span>
    </div>
  );
}

export default function DayViewPage() {
  const navigate = useNavigate();
  const [tab, setTabState] = useState<Tab>(lastSelectedTab);
  const setTab = (next: Tab) => {
    lastSelectedTab = next;
    setTabState(next);
  };

  const { online } = useSyncStatus();
  const userId = useTechnicianUserId();

  const queryClient = useQueryClient();

  // Today's jobs AND activities, merged in the office's running order (a separate cache key from the old
  // jobs-only list, so the two shapes can never be mistaken for each other).
  const {
    data: visitsData,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: technicianKeys.todayItems(userId),
    queryFn: listTodayItems,
    enabled: userId !== '',
    staleTime: VISIT_LIST_STALE_TIME_MS,
    retry: retryUnlessOffline,
    refetchInterval: pollWhileOnline,
  });
  const visits = visitsData ?? [];

  // Mark done / undo for an activity. Only the one row being changed shows "Saving…" or an error.
  const [activityErrors, setActivityErrors] = useState<Record<string, string>>({});
  const doneMutation = useMutation({
    mutationFn: ({ activityId, done }: { activityId: string; done: boolean }) => setActivityDone(activityId, done),
    onMutate: ({ activityId }) => setActivityErrors((prev) => ({ ...prev, [activityId]: '' })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: technicianKeys.todayItems(userId) }),
    onError: (err, { activityId }) =>
      setActivityErrors((prev) => ({ ...prev, [activityId]: err instanceof Error ? err.message : 'Could not update the activity.' })),
  });
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
    queryKey: technicianKeys.needsCorrection(userId),
    queryFn: listNeedsCorrection,
    enabled: userId !== '',
    staleTime: VISIT_LIST_STALE_TIME_MS,
    retry: retryUnlessOffline,
    refetchInterval: pollWhileOnline,
  });
  const needsCorrection = needsCorrectionData ?? [];
  const correctionOfflineWithNoData = needsCorrectionData === undefined && !online;

  // Past jobs change only when a report is submitted or a visit's date/
  // assignment is edited by the office — not something worth the 60s poll
  // Today/Needs correction use. Fetched on demand (when the tab is opened,
  // on manual refresh, and via TechnicianShell's foreground/reconnect and
  // report-synced invalidation, which already covers this key).
  const {
    data: pastVisitsData,
    isLoading: pastLoading,
    isFetching: pastFetching,
    isError: pastError,
    error: pastErrorObj,
    refetch: refetchPast,
  } = useQuery({
    queryKey: technicianKeys.pastVisits(userId),
    queryFn: listPastVisits,
    enabled: userId !== '' && tab === 'past',
    staleTime: VISIT_LIST_STALE_TIME_MS,
    retry: retryUnlessOffline,
  });
  const pastVisits = pastVisitsData ?? [];
  const pastOfflineWithNoData = pastVisitsData === undefined && !online;

  const isManuallyRefreshing = isFetching || correctionFetching || pastFetching;
  const handleManualRefresh = () => {
    if (!online) return;
    void refetch();
    void refetchCorrection();
    if (tab === 'past') void refetchPast();
  };

  const doneCount = visits.filter(isDayItemDone).length;
  // The next stop is the first item not done: a completed activity is skipped, an incomplete one can be next.
  const nextIndex = nextStopIndex(visits);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between border-b border-divider bg-neutral-200 px-4 py-3">
        <h1 className="font-heading text-xl font-semibold">{tab === 'correction' ? 'Needs correction' : tab === 'past' ? 'Past jobs' : 'Your day'}</h1>
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
              {visits.map((item, index) =>
                item.kind === 'activity' ? (
                  <ActivityRow
                    key={dayItemKey(item)}
                    item={item}
                    index={index}
                    isNext={index === nextIndex}
                    canChange={online}
                    pending={doneMutation.isPending && doneMutation.variables?.activityId === item.activityId}
                    error={activityErrors[item.activityId] || null}
                    onToggleDone={() => doneMutation.mutate({ activityId: item.activityId, done: !item.done })}
                  />
                ) : (
                  <StopRow
                    key={dayItemKey(item)}
                    visit={item}
                    index={index}
                    isNext={index === nextIndex}
                    onSelect={() => navigate(`/technician/visits/${item.visitId}`)}
                  />
                ),
              )}
            </div>
          ))}

        {tab === 'past' &&
          (pastOfflineWithNoData ? (
            <OfflineEmptyState onRetry={() => void refetchPast()} />
          ) : pastLoading ? (
            <div className="p-4">
              <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
            </div>
          ) : pastError ? (
            <div className="p-4">
              <div className="border border-missed bg-missed/10 p-4">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                  Couldn't load past jobs
                </div>
                <div className="mt-1.5 text-[13px] text-ink">
                  {pastErrorObj instanceof Error ? pastErrorObj.message : 'Something went wrong.'}
                </div>
              </div>
            </div>
          ) : pastVisits.length === 0 ? (
            <div className="p-4">
              <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                  No past jobs
                </div>
                <div className="mt-1.5 text-[13px] text-neutral-600">Earlier jobs assigned to you will appear here.</div>
              </div>
            </div>
          ) : (
            <div>
              {pastVisits.map((visit, index) => (
                <StopRow
                  key={visit.visitId}
                  visit={visit}
                  index={index}
                  isNext={false}
                  dateLabel={PAST_DATE_FORMAT.format(new Date(`${visit.scheduledDate}T00:00:00`))}
                  onSelect={() => navigate(`/technician/visits/${visit.visitId}`)}
                />
              ))}
            </div>
          ))}

        {tab === 'correction' &&
          (correctionOfflineWithNoData ? (
            <OfflineEmptyState onRetry={() => void refetchCorrection()} />
          ) : correctionLoading ? (
            <div className="p-4">
              <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
            </div>
          ) : correctionError ? (
            <div className="p-4">
              <div className="border border-missed bg-missed/10 p-4">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">Couldn't load reports needing correction</div>
                <div className="mt-1.5 text-[13px] text-ink">
                  {correctionErrorObj instanceof Error ? correctionErrorObj.message : 'Something went wrong.'}
                </div>
              </div>
            </div>
          ) : needsCorrection.length === 0 ? (
            <div className="p-4">
              <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
                <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">Nothing needs correction</div>
              </div>
            </div>
          ) : (
            <div>
              {needsCorrection.map((item) => (
                <CorrectionRow key={item.reportId} item={item} onSelect={() => navigate(`/technician/visits/${item.visitId}`)} />
              ))}
            </div>
          ))}
      </div>

      <div className="grid flex-none grid-cols-3 border-t border-divider bg-neutral-100">
        {(
          [
            { key: 'today', label: 'Today' },
            { key: 'past', label: 'Past' },
            { key: 'correction', label: 'Needs correction', badge: needsCorrection.length },
          ] as { key: Tab; label: string; badge?: number }[]
        ).map(({ key, label, badge }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`cursor-pointer rounded-none flex min-h-[44px] items-center justify-center border-t-2 px-1 py-2 text-center leading-tight font-heading text-[10.5px] font-semibold tracking-[0.1em] uppercase ${
              tab === key
                ? 'border-teal text-teal-700'
                : badge
                  ? 'border-transparent text-due-fg hover:text-ink'
                  : 'border-transparent text-neutral-500 hover:text-ink'
            }`}
          >
            {label}
            {/* A solid badge rather than plain text, so a returned report is noticed straight away from any tab. */}
            {badge ? (
              <span
                aria-label={`${badge} need correction`}
                className="ml-1.5 inline-flex min-w-[20px] flex-none items-center justify-center rounded-full bg-due px-1.5 py-0.5 text-[11px] leading-none font-bold text-white tabular-nums"
              >
                {badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
