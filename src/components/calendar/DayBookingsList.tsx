import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRow, Technician, WeekVisit } from '../../domain/types';
import { setVisitOrder } from '../../repository/techniciansRepository';
import { compareVisitsInDay, visitTechnicianNames } from '../../lib/visitTechnicians';

interface DayBookingsListProps {
  /** Every booking on the day, any technician. */
  dayVisits: WeekVisit[];
  jobById: Map<string, JobRow>;
  technicianById: Map<string, Technician>;
  visitStatusStyle: Record<WeekVisit['status'], string>;
  onSelectVisit: (jobId: string) => void;
}

/**
 * The day's bookings, in the running order the technicians receive them in,
 * with up/down buttons to change it. The order is ONE sequence for the whole
 * day (visits.sort_order): each technician's own list is just their bookings
 * taken from it in that order, and a shared booking has a single position that
 * every assigned technician sees. Moving a booking swaps it with its neighbour
 * and saves the whole day's order in one call. Order, not time.
 */
export default function DayBookingsList({ dayVisits, jobById, technicianById, visitStatusStyle, onSelectVisit }: DayBookingsListProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const moveMutation = useMutation({
    mutationFn: (orderedIds: string[]) => setVisitOrder(orderedIds),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['visits'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save the order.'),
  });

  // Cancelled bookings are not part of anyone's day, so they carry no number or controls.
  const live = dayVisits.filter((v) => v.status !== 'cancelled').sort(compareVisitsInDay);
  const cancelled = dayVisits.filter((v) => v.status === 'cancelled');

  const move = (index: number, delta: -1 | 1) => {
    const next = live.map((v) => v.id);
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    moveMutation.mutate(next);
  };

  const arrowClass =
    'flex h-6 w-6 flex-none cursor-pointer items-center justify-center border border-neutral-300 bg-white text-[10px] leading-none text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30';

  const renderRow = (v: WeekVisit, index: number | null) => {
    const job = jobById.get(v.jobId);
    const names = visitTechnicianNames(v, technicianById);
    const who = names.length > 0 ? names.join(', ') : 'Unassigned';
    const shared = names.length > 1;
    const building = job ? job.buildingName : 'Job';
    return (
      <li key={v.id} className={`flex items-center gap-2 border px-2 py-1.5 ${visitStatusStyle[v.status]}`}>
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
        {/* Fixed-width control area: the arrows line up on every row whatever the text length. */}
        <div className="flex w-[52px] flex-none items-center justify-end gap-1">
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
      </li>
    );
  };

  return (
    <>
      <ol className="flex flex-col gap-1.5">
        {live.map((v, i) => renderRow(v, i))}
        {cancelled.map((v) => renderRow(v, null))}
      </ol>
      {error && <div className="mt-2 text-[11px] text-missed-fg">{error}</div>}
    </>
  );
}
