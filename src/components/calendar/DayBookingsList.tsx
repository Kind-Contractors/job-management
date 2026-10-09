import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRow, ScheduleActivity, Technician, WeekVisit } from '../../domain/types';
import { saveDayItemOrder, setVisitTimeRange } from '../../repository/techniciansRepository';
import { visitTechnicianNames } from '../../lib/visitTechnicians';
import { isLiveDayItem, mergeDayItems, type DayItem } from '../../lib/dayItems';
import { formatTimeRange, normalizeTime, timeRangeError } from '../../lib/timeRange';
import TimeRangeFields from './TimeRangeFields';

interface DayBookingsListProps {
  /** Every booking on the day, any technician. */
  dayVisits: WeekVisit[];
  /** Every activity on the day (including cancelled ones, shown greyed at the end). Optional: a day with none renders exactly as before. */
  dayActivities?: ScheduleActivity[];
  /** The day's date, 'YYYY-MM-DD' - needed to save the combined order. Derived from the items when omitted. */
  dateISO?: string;
  jobById: Map<string, JobRow>;
  technicianById: Map<string, Technician>;
  visitStatusStyle: Record<WeekVisit['status'], string>;
  onSelectVisit: (jobId: string) => void;
  /** Opens this activity for editing. */
  onSelectActivity?: (activity: ScheduleActivity) => void;
  /** Opens the cancellation dialog for this visit. Omitted = no cancel button (the list is then unchanged). */
  onCancelVisit?: (visitId: string) => void;
}

const ACTIVITY_STYLE = 'border-dashed border-neutral-400 bg-white text-ink';
const ACTIVITY_DONE_STYLE = 'border-dashed border-done bg-done/10 text-done-fg';
const ACTIVITY_CANCELLED_STYLE = 'border-dashed border-neutral-300 bg-neutral-100 text-neutral-400 line-through';

/**
 * The day's items in the running order the technicians receive them in - jobs AND activities in ONE
 * sequence - with up/down buttons to change it. The order (visits.sort_order / activities.sort_order) is
 * one sequence for the whole day: each technician's own list is just their items taken from it in that
 * order, and a shared job has a single position that everyone assigned to it sees. Moving an item swaps it
 * with its neighbour and saves the whole day's order in one call. Order, not time: an optional time is
 * shown beside the item but never moves it.
 *
 * A day with no activities is saved with the original set_visit_order call, exactly as before; a day
 * with activities uses set_day_order.
 */
export default function DayBookingsList({
  dayVisits,
  dayActivities = [],
  dateISO,
  jobById,
  technicianById,
  visitStatusStyle,
  onSelectVisit,
  onSelectActivity,
  onCancelVisit,
}: DayBookingsListProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editingTimeVisitId, setEditingTimeVisitId] = useState<string | null>(null);
  const [timeDraft, setTimeDraft] = useState<{ start: string; end: string }>({ start: '', end: '' });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['visits'] });
    queryClient.invalidateQueries({ queryKey: ['activities'] });
  };

  const all = mergeDayItems(dayVisits, dayActivities);
  const live = all.filter(isLiveDayItem);
  const cancelled = all.filter((i) => !isLiveDayItem(i));
  const day = dateISO ?? dayVisits[0]?.scheduledDate ?? dayActivities[0]?.scheduledDate ?? '';

  const moveMutation = useMutation({
    mutationFn: (ordered: DayItem[]) => saveDayItemOrder(day, ordered),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to save the order.');
      refresh(); // the day may have changed since it was loaded - show the current state
    },
  });

  const timeMutation = useMutation({
    mutationFn: ({ visitId, start, end }: { visitId: string; start: string; end: string }) =>
      setVisitTimeRange(visitId, normalizeTime(start), normalizeTime(end)),
    onSuccess: () => {
      setError(null);
      setEditingTimeVisitId(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save the time.'),
  });

  const move = (index: number, delta: -1 | 1) => {
    const next = [...live];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    moveMutation.mutate(next);
  };

  const arrowClass =
    'flex h-6 w-6 flex-none cursor-pointer items-center justify-center border border-neutral-300 bg-white text-[10px] leading-none text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30';

  const timeClass = 'flex-none text-[11px] leading-tight text-neutral-600 tabular-nums';

  const renderVisit = (item: Extract<DayItem, { kind: 'visit' }>, index: number | null) => {
    const v = item.visit;
    const job = jobById.get(v.jobId);
    const names = visitTechnicianNames(v, technicianById);
    const who = names.length > 0 ? names.join(', ') : 'Unassigned';
    const shared = names.length > 1;
    const building = job ? job.buildingName : 'Job';
    // `?? null`: a visit restored from a cache written before times existed has no such field.
    const timeLabel = formatTimeRange(v.startTime ?? null, v.endTime ?? null);
    const editingTime = editingTimeVisitId === v.id;
    return (
      <li key={`v-${v.id}`} className={`flex flex-col gap-1.5 border px-2 py-1.5 ${visitStatusStyle[v.status]}`}>
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 flex-none items-center justify-center bg-teal text-[11px] font-bold text-white tabular-nums">
            {index == null ? '–' : index + 1}
          </span>
          <button
            type="button"
            onClick={() => onSelectVisit(v.jobId)}
            title={`${building} · ${job?.jobSummary ?? '—'} · ${who}`}
            className="min-w-0 flex-1 cursor-pointer text-left"
          >
            <span className="block truncate text-[12px] font-semibold">{building}</span>
            <span className="block truncate text-[11px] opacity-80">
              {job?.jobSummary ?? '—'} · {who}
            </span>
          </button>
          {timeLabel && (
            <span className={timeClass} title="Time (display only - it does not set the order)">
              {timeLabel}
            </span>
          )}
          {/* Fixed-width control area: the arrows line up on every row whatever the text length. */}
          <div className={`flex ${onCancelVisit ? 'w-[102px]' : 'w-[78px]'} flex-none items-center justify-end gap-1`}>
            {onCancelVisit && (v.status === 'due' || v.status === 'booked') && (
              <button
                type="button"
                onClick={() => onCancelVisit(v.id)}
                aria-label={`Cancel ${building}`}
                title="Cancel this visit, this and all future visits, or the entire job"
                className={arrowClass}
              >
                ✕
              </button>
            )}
            {v.status !== 'cancelled' && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setTimeDraft({ start: v.startTime ?? '', end: v.endTime ?? '' });
                  setEditingTimeVisitId(editingTime ? null : v.id);
                }}
                aria-label={`Set time for ${building}`}
                title="Set or change the time (optional)"
                className={arrowClass}
              >
                ⏱
              </button>
            )}
            {index != null && (
              <>
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0 || moveMutation.isPending}
                  aria-label={`Move ${building} up`}
                  title={shared ? 'Moves this booking for everyone assigned to it' : 'Move up'}
                  className={arrowClass}
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === live.length - 1 || moveMutation.isPending}
                  aria-label={`Move ${building} down`}
                  title={shared ? 'Moves this booking for everyone assigned to it' : 'Move down'}
                  className={arrowClass}
                >
                  ▼
                </button>
              </>
            )}
          </div>
        </div>
        {editingTime && (
          <div className="flex flex-col gap-1.5 border-t border-current/20 bg-white/70 p-2 text-ink">
            <TimeRangeFields start={timeDraft.start} end={timeDraft.end} onChange={(s, e) => setTimeDraft({ start: s, end: e })} label="Visit" disabled={timeMutation.isPending} />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={timeMutation.isPending || timeRangeError(timeDraft.start, timeDraft.end) != null}
                onClick={() => timeMutation.mutate({ visitId: v.id, start: timeDraft.start, end: timeDraft.end })}
                className="cursor-pointer bg-teal px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {timeMutation.isPending ? 'Saving…' : 'Save time'}
              </button>
              <button
                type="button"
                disabled={timeMutation.isPending}
                onClick={() => setEditingTimeVisitId(null)}
                className="cursor-pointer border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </li>
    );
  };

  const renderActivity = (item: Extract<DayItem, { kind: 'activity' }>, index: number | null) => {
    const a = item.activity;
    const isCancelled = (a.cancelledAt ?? null) != null;
    const isDone = (a.doneAt ?? null) != null;
    const who = a.technicianId ? (technicianById.get(a.technicianId)?.name ?? 'Unknown') : 'Unassigned';
    const timeLabel = formatTimeRange(a.startTime ?? null, a.endTime ?? null);
    const style = isCancelled ? ACTIVITY_CANCELLED_STYLE : isDone ? ACTIVITY_DONE_STYLE : ACTIVITY_STYLE;
    return (
      <li key={`a-${a.id}`} className={`flex items-center gap-2 border px-2 py-1.5 ${style}`}>
        <span className="flex h-5 w-5 flex-none items-center justify-center bg-neutral-600 text-[11px] font-bold text-white tabular-nums">
          {index == null ? '–' : index + 1}
        </span>
        <button
          type="button"
          onClick={() => onSelectActivity?.(a)}
          title={`${a.description} · ${who}${a.location ? ` · ${a.location}` : ''}`}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="flex items-center gap-1.5">
            <span className="flex-none border border-current px-1 font-heading text-[8.5px] font-semibold tracking-[0.1em] uppercase opacity-80">Activity</span>
            <span className="block truncate text-[12px] font-semibold">{a.description}</span>
          </span>
          <span className="block truncate text-[11px] opacity-80">
            {who}
            {a.location ? ` · ${a.location}` : ''}
            {isCancelled ? ' · Cancelled' : isDone ? ' · ✓ Done' : ''}
          </span>
        </button>
        {timeLabel && (
          <span className={timeClass} title="Time (display only - it does not set the order)">
            {timeLabel}
          </span>
        )}
        <div className="flex w-[78px] flex-none items-center justify-end gap-1">
          {/* Same width as a job row's controls so the arrows line up; activities are edited by clicking the row. */}
          <span className="h-6 w-6 flex-none" aria-hidden />
          {index != null && (
            <>
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0 || moveMutation.isPending}
                aria-label={`Move ${a.description} up`}
                title="Move up"
                className={arrowClass}
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === live.length - 1 || moveMutation.isPending}
                aria-label={`Move ${a.description} down`}
                title="Move down"
                className={arrowClass}
              >
                ▼
              </button>
            </>
          )}
        </div>
      </li>
    );
  };

  const renderItem = (item: DayItem, index: number | null) => (item.kind === 'visit' ? renderVisit(item, index) : renderActivity(item, index));

  return (
    <>
      <ol className="flex flex-col gap-1.5">
        {live.map((item, i) => renderItem(item, i))}
        {cancelled.map((item) => renderItem(item, null))}
      </ol>
      {error && (
        <div role="alert" className="mt-2 text-[11px] text-missed-fg">
          {error}
        </div>
      )}
    </>
  );
}
