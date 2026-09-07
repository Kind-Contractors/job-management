import type { DragEvent } from 'react';
import type { JobRow, Technician, WeekVisit } from '../../domain/types';

const WEEKDAY_HEADER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NUM = new Intl.DateTimeFormat('en-GB', { day: 'numeric' });
const MAX_CHIPS_PER_DAY = 3;

export interface MonthGridDay {
  date: Date;
  dateISO: string;
  inMonth: boolean;
}

export interface PendingDrop {
  jobId: string;
  date: string;
}

interface MonthGridProps {
  days: MonthGridDay[];
  visits: WeekVisit[];
  jobById: Map<string, JobRow>;
  visitStatusStyle: Record<WeekVisit['status'], string>;
  activeTechnicians: Technician[];
  pendingDrop: PendingDrop | null;
  pendingTechnicianId: string;
  onPendingTechnicianChange: (technicianId: string) => void;
  onDropJob: (jobId: string, date: string) => void;
  onConfirmBooking: () => void;
  onCancelBooking: () => void;
  bookingPending: boolean;
  onSelectVisit: (jobId: string) => void;
}

/**
 * Presentational only — every write path (createVisit via the parent's
 * bookMutation) and every query lives in ThisWeekPage.tsx, per CLAUDE.md
 * section 12 (orchestration in the container, not here).
 */
export default function MonthGrid({
  days,
  visits,
  jobById,
  visitStatusStyle,
  activeTechnicians,
  pendingDrop,
  pendingTechnicianId,
  onPendingTechnicianChange,
  onDropJob,
  onConfirmBooking,
  onCancelBooking,
  bookingPending,
  onSelectVisit,
}: MonthGridProps) {
  return (
    <div className="grid grid-cols-7 border border-neutral-300">
      {WEEKDAY_HEADER.map((label) => (
        <div
          key={label}
          className="border-b border-l border-neutral-300 bg-neutral-200 px-2 py-1.5 text-center font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase first:border-l-0"
        >
          {label}
        </div>
      ))}

      {days.map((day, i) => {
        const dayVisits = visits.filter((v) => v.scheduledDate === day.dateISO);
        const isPending = pendingDrop?.date === day.dateISO;
        const shown = dayVisits.slice(0, MAX_CHIPS_PER_DAY);
        const overflow = dayVisits.length - shown.length;

        const handleDragOver = (e: DragEvent) => e.preventDefault();
        const handleDrop = (e: DragEvent) => {
          e.preventDefault();
          const jobId = e.dataTransfer.getData('text/plain');
          if (!jobId) return;
          onDropJob(jobId, day.dateISO);
        };

        return (
          <div
            key={day.dateISO}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className={`min-h-[92px] border-b border-l border-neutral-300 px-1.5 py-1.5 ${
              i % 7 === 0 ? 'border-l-0' : ''
            } ${day.inMonth ? '' : 'bg-neutral-100'}`}
          >
            <div className={`text-[11px] tabular-nums ${day.inMonth ? 'text-neutral-600' : 'text-neutral-400'}`}>
              {DAY_NUM.format(day.date)}
            </div>

            {isPending ? (
              <div className="mt-1 flex flex-col gap-1 border border-teal bg-teal-100 p-1.5">
                {activeTechnicians.length === 0 ? (
                  <>
                    <div className="text-[10.5px] text-neutral-700">No active technicians — add one in Week mode first.</div>
                    <button
                      onClick={onCancelBooking}
                      className="cursor-pointer border border-neutral-300 bg-white py-1 text-[10.5px] text-neutral-700 hover:bg-neutral-100"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <select
                      value={pendingTechnicianId}
                      onChange={(e) => onPendingTechnicianChange(e.target.value)}
                      className="border border-neutral-300 bg-white px-1 py-1 text-[10.5px] text-ink outline-none focus:border-teal"
                    >
                      <option value="" disabled>
                        Choose a technician…
                      </option>
                      {activeTechnicians.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-1">
                      <button
                        onClick={onConfirmBooking}
                        disabled={!pendingTechnicianId || bookingPending}
                        className="flex-1 cursor-pointer bg-teal py-1 text-[10.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {bookingPending ? 'Booking…' : 'Book'}
                      </button>
                      <button
                        onClick={onCancelBooking}
                        className="cursor-pointer border border-neutral-300 bg-white px-2 py-1 text-[10.5px] text-neutral-700 hover:bg-neutral-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              dayVisits.length > 0 && (
                <div className="mt-1 flex flex-col gap-0.5">
                  {shown.map((v) => {
                    const job = jobById.get(v.jobId);
                    return (
                      <div
                        key={v.id}
                        onClick={() => onSelectVisit(v.jobId)}
                        title={job ? `${job.jobSummary} · ${job.buildingName}` : v.jobId}
                        className={`cursor-pointer truncate border px-1 py-0.5 text-[10px] ${visitStatusStyle[v.status]}`}
                      >
                        {job ? job.buildingName : 'Job'}
                      </div>
                    );
                  })}
                  {overflow > 0 && <div className="text-[10px] text-neutral-500">+{overflow} more</div>}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
