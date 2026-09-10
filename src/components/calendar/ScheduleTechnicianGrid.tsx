import { Fragment } from 'react';
import type { JobRow, Technician, VisitStatus, WeekVisit } from '../../domain/types';

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const DAY_NUM = new Intl.DateTimeFormat('en-GB', { day: 'numeric' });

/**
 * The "By technician" arrangement — one row per technician, one column per
 * displayed day. Extracted verbatim (same props/behavior) from
 * ThisWeekPage.tsx's former inline JSX, restyled for the Schedule redesign
 * (today/selected-day treatment, clearer chip hierarchy). Presentational
 * only — every query/mutation stays in ThisWeekPage.tsx, per CLAUDE.md
 * section 12.
 */
export default function ScheduleTechnicianGrid({
  days,
  technicians,
  visits,
  displayVisits,
  jobById,
  visitStatusStyle,
  todayISO,
  selectedDateISO,
  onSelectDay,
  onSelectVisit,
  onDrop,
  onToggleTechnicianActive,
}: {
  days: Date[];
  technicians: Technician[];
  /** The technician's true, unfiltered visit set — used only for the workload count, never for which chips render. */
  visits: WeekVisit[];
  /** Search/Division-narrowed visits — what actually renders as chips. */
  displayVisits: WeekVisit[];
  jobById: Map<string, JobRow>;
  visitStatusStyle: Record<VisitStatus, string>;
  todayISO: string;
  selectedDateISO: string | null;
  onSelectDay: (dateISO: string) => void;
  onSelectVisit: (jobId: string) => void;
  /**
   * Handles a drop on this technician's cell for the given date — the
   * returned handler itself decides whether this is a new job booking or an
   * already-booked visit being rescheduled (by which mime type the drag
   * carries), so this component doesn't need to know the difference; see
   * ThisWeekPage.tsx's handleDrop.
   */
  onDrop: (technicianId: string, dateISO: string) => (e: React.DragEvent) => void;
  onToggleTechnicianActive: (id: string, isActive: boolean) => void;
}) {
  const toISODate = (d: Date) => {
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
  };

  return (
    <div className="border border-neutral-300 bg-white">
      <div className={`grid ${days.length === 1 ? 'grid-cols-[180px_1fr]' : 'grid-cols-[180px_repeat(6,1fr)]'}`}>
        <div className="border-b border-neutral-300 bg-neutral-100 px-3 py-2.5 font-heading text-[10px] font-semibold tracking-[0.14em] text-neutral-500 uppercase">
          Technician
        </div>
        {days.map((d) => {
          const headerDateISO = toISODate(d);
          const isToday = headerDateISO === todayISO;
          return (
            <div
              key={d.toISOString()}
              onClick={() => onSelectDay(headerDateISO)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelectDay(headerDateISO);
              }}
              title="Open this day"
              className={`cursor-pointer border-b border-l border-neutral-300 px-3 py-2.5 text-center font-heading text-[10px] font-semibold tracking-[0.1em] uppercase hover:bg-neutral-200 ${
                isToday ? 'bg-teal-100 text-teal-700' : 'bg-neutral-100 text-neutral-500'
              }`}
            >
              {DAY_LABEL.format(d)} <span className="tabular-nums normal-case">{DAY_NUM.format(d)}</span>
            </div>
          );
        })}

        {technicians.map((technician) => {
          const technicianVisits = visits.filter((v) => v.technicianId === technician.id);
          const technicianDisplayVisits = displayVisits.filter((v) => v.technicianId === technician.id);
          return (
            <Fragment key={technician.id}>
              <div
                className={`flex items-center gap-2 border-b border-neutral-300 px-3 py-2.5 text-[13px] ${
                  technician.isActive ? '' : 'text-neutral-400'
                }`}
              >
                <span className="font-semibold text-ink">{technician.name}</span>
                <span
                  title="Real visit count for this period — not a capacity estimate"
                  className="ml-auto border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 text-[10.5px] text-neutral-600 tabular-nums"
                >
                  {technicianVisits.length}
                </span>
                <button
                  onClick={() => onToggleTechnicianActive(technician.id, !technician.isActive)}
                  className="cursor-pointer text-[10.5px] text-teal-700 hover:underline"
                >
                  {technician.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
              {days.map((d) => {
                const cellDateISO = toISODate(d);
                const dayVisits = technicianDisplayVisits.filter((v) => v.scheduledDate === cellDateISO);
                const isToday = cellDateISO === todayISO;
                const isSelected = cellDateISO === selectedDateISO;
                return (
                  <div
                    key={`${technician.id}-${cellDateISO}`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={onDrop(technician.id, cellDateISO)}
                    onClick={() => onSelectDay(cellDateISO)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') onSelectDay(cellDateISO);
                    }}
                    className={`cursor-pointer border-b border-l border-neutral-300 px-2 py-2 transition-colors hover:bg-neutral-100 ${
                      isToday ? 'bg-teal-100/40' : ''
                    } ${isSelected ? 'ring-1 ring-inset ring-teal' : ''}`}
                  >
                    {dayVisits.length === 0 ? (
                      <span className="text-[11px] text-neutral-400">Free</span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {dayVisits.map((v) => {
                          const job = jobById.get(v.jobId);
                          // Only 'due'/'booked' visits can be dragged to a
                          // different day — see MonthGrid.tsx's identical rule.
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
                              className={`truncate border px-1.5 py-1 text-[11px] leading-tight ${draggableChip ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${visitStatusStyle[v.status]}`}
                              title={job ? `${job.jobSummary} · ${job.buildingName}` : v.jobId}
                            >
                              {job ? job.buildingName : 'Job'}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      {technicians.length === 0 ? (
        <div className="border-t border-neutral-300 bg-white px-5 py-10 text-center">
          <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
            No technicians have been set up yet
          </div>
          <div className="mt-1.5 text-[13px] text-neutral-600">Add a technician to start booking visits.</div>
        </div>
      ) : (
        !technicians.some((t) => t.isActive) && (
          <div className="border-t border-due bg-due/10 px-5 py-3 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-due-fg uppercase">
              No active technicians available
            </div>
            <div className="mt-1.5 text-[13px] text-neutral-700">
              Every technician above is currently deactivated — reactivate one before assigning new visits. Existing
              bookings are still shown above.
            </div>
          </div>
        )
      )}
    </div>
  );
}
