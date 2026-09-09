import type { DragEvent } from 'react';
import type { JobRow, Technician, WeekVisit } from '../../domain/types';

const WEEKDAY_HEADER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NUM = new Intl.DateTimeFormat('en-GB', { day: 'numeric' });
const MAX_CHIPS_PER_DAY = 2;

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
  /** Reschedules an already-booked visit to this date (dragged from another day) — never creates a second visit, never touches its assigned technician. Only offered for 'due'/'booked' chips (see the drag source below). */
  onRescheduleVisit: (visitId: string, date: string) => void;
  onConfirmBooking: () => void;
  onCancelBooking: () => void;
  bookingPending: boolean;
  onSelectVisit: (jobId: string) => void;
  /** Opens the Schedule Day Drawer for this date — fires on a click anywhere in an empty cell, the date number, or "+N more", never on an existing booking chip (which stops propagation) or while a drop is pending confirmation. */
  onSelectDay: (dateISO: string) => void;
  /** Today's real date — the one cell that always gets a distinct visual mark, regardless of month/selection. */
  todayISO: string;
  /** The day currently open in the Schedule Day Drawer, if any — gets its own outline so the calendar and the drawer visibly agree on what's selected. */
  selectedDateISO: string | null;
  /** For showing the assigned technician's name on each chip — status still carries the color (see statusPresentation.ts's restraint rule); technician identity is text, not a second hue. */
  technicianById: Map<string, Technician>;
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
  onRescheduleVisit,
  onConfirmBooking,
  onCancelBooking,
  bookingPending,
  onSelectVisit,
  onSelectDay,
  todayISO,
  selectedDateISO,
  technicianById,
}: MonthGridProps) {
  return (
    <div className="grid grid-cols-7 border border-neutral-300 bg-white">
      {WEEKDAY_HEADER.map((label) => (
        <div
          key={label}
          className="border-b border-l border-neutral-300 bg-neutral-100 px-2.5 py-2 text-center font-heading text-[10px] font-semibold tracking-[0.14em] text-neutral-500 uppercase first:border-l-0"
        >
          {label}
        </div>
      ))}

      {days.map((day, i) => {
        const dayVisits = visits.filter((v) => v.scheduledDate === day.dateISO);
        const isPending = pendingDrop?.date === day.dateISO;
        const shown = dayVisits.slice(0, MAX_CHIPS_PER_DAY);
        const overflow = dayVisits.length - shown.length;
        const isToday = day.dateISO === todayISO;
        const isSelected = day.dateISO === selectedDateISO;

        const handleDragOver = (e: DragEvent) => e.preventDefault();
        const handleDrop = (e: DragEvent) => {
          e.preventDefault();
          // An already-booked chip being dragged carries its visit id under
          // this dedicated mime type (set by the chip's own onDragStart
          // below) — checked first so a reschedule never falls through to
          // onDropJob and creates a second visit. The "Needs booking"/
          // "Overdue" drag source only ever sets 'text/plain', so it's
          // unaffected.
          const visitId = e.dataTransfer.getData('application/x-visit-id');
          if (visitId) {
            onRescheduleVisit(visitId, day.dateISO);
            return;
          }
          const jobId = e.dataTransfer.getData('text/plain');
          if (!jobId) return;
          onDropJob(jobId, day.dateISO);
        };

        const handleCellClick = () => {
          if (!isPending) onSelectDay(day.dateISO);
        };

        return (
          <div
            key={day.dateISO}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={handleCellClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') handleCellClick();
            }}
            className={`min-h-[112px] border-b border-l border-neutral-300 px-2 py-2 transition-colors ${
              isPending ? '' : 'cursor-pointer hover:bg-neutral-100'
            } ${i % 7 === 0 ? 'border-l-0' : ''} ${day.inMonth ? 'bg-white' : 'bg-neutral-100'} ${
              isSelected ? 'ring-1 ring-inset ring-teal' : ''
            }`}
          >
            <div
              className={`inline-flex h-6 w-6 items-center justify-center text-[11.5px] tabular-nums ${
                isToday
                  ? 'bg-teal font-semibold text-white'
                  : day.inMonth
                    ? 'text-neutral-600'
                    : 'text-neutral-400'
              }`}
            >
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
                <div className="mt-1 flex flex-col gap-1">
                  {shown.map((v) => {
                    const job = jobById.get(v.jobId);
                    const technician = v.technicianId ? technicianById.get(v.technicianId) : undefined;
                    // Only a 'due'/'booked' visit can be dragged to reschedule —
                    // a completed/missed/cancelled visit shouldn't be moved by
                    // dragging its chip around.
                    const draggableChip = v.status === 'due' || v.status === 'booked';
                    return (
                      <div
                        key={v.id}
                        draggable={draggableChip}
                        onDragStart={
                          draggableChip
                            ? (e) => {
                                e.stopPropagation();
                                e.dataTransfer.setData('application/x-visit-id', v.id);
                              }
                            : undefined
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectVisit(v.jobId);
                        }}
                        title={job ? `${job.jobSummary} · ${job.buildingName}` : v.jobId}
                        className={`border px-1.5 py-1 text-[10.5px] leading-tight ${draggableChip ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${visitStatusStyle[v.status]}`}
                      >
                        <div className="truncate font-semibold">{technician ? technician.name : 'Unassigned'}</div>
                        <div className="truncate opacity-80">{job ? job.buildingName : 'Job'}</div>
                      </div>
                    );
                  })}
                  {overflow > 0 && (
                    <div className="px-0.5 text-[10.5px] font-medium text-neutral-500">+{overflow} more</div>
                  )}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
