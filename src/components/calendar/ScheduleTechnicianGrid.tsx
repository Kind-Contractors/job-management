import { Fragment } from 'react';
import type { JobRow, ScheduleActivity, Technician, VisitStatus, WeekVisit } from '../../domain/types';
import { isVisitParticipant, visitTechnicianNames } from '../../lib/visitTechnicians';
import { UNASSIGNED_ROW_ID, mergeDayItems, type DayItem } from '../../lib/dayItems';
import { formatTimeRange } from '../../lib/timeRange';

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
const DAY_NUM = new Intl.DateTimeFormat('en-GB', { day: 'numeric' });

/** An activity chip is deliberately not a status colour: dashed + neutral reads as "not a job", and done is the one functional tone it uses. */
const ACTIVITY_CHIP = 'border-dashed border-neutral-400 bg-white text-ink';
const ACTIVITY_CHIP_DONE = 'border-dashed border-done bg-done/10 text-done-fg';

/**
 * The "By technician" arrangement — one row per technician, one column per
 * displayed day. Extracted verbatim (same props/behavior) from
 * ThisWeekPage.tsx's former inline JSX, restyled for the Schedule redesign
 * (today/selected-day treatment, clearer chip hierarchy). Presentational
 * only — every query/mutation stays in ThisWeekPage.tsx, per CLAUDE.md
 * section 12.
 *
 * Activities (non-job items) share each cell's running order with the jobs: one numbered sequence,
 * with an optional time shown on the chip but never used to order it. Activities with nobody
 * assigned get an extra "Unassigned" row (only while at least one exists in the displayed days).
 */
export default function ScheduleTechnicianGrid({
  days,
  technicians,
  visits,
  displayVisits,
  activities = [],
  jobById,
  visitStatusStyle,
  todayISO,
  selectedDateISO,
  onSelectDay,
  onSelectVisit,
  onSelectActivity,
  onDrop,
  onToggleTechnicianActive,
}: {
  days: Date[];
  technicians: Technician[];
  /** The technician's true, unfiltered visit set — used only for the workload count, never for which chips render. */
  visits: WeekVisit[];
  /** Search/Division-narrowed visits — what actually renders as chips. */
  displayVisits: WeekVisit[];
  /** Search-narrowed activities to render as chips (cancelled ones are never shown here). Optional: omitted = none. */
  activities?: ScheduleActivity[];
  jobById: Map<string, JobRow>;
  visitStatusStyle: Record<VisitStatus, string>;
  todayISO: string;
  selectedDateISO: string | null;
  /** technicianId is passed whenever the click originated from a specific technician's row/cell (or its "+" affordance) — omitted from the day-header click, which isn't tied to any one technician. */
  onSelectDay: (dateISO: string, technicianId?: string) => void;
  onSelectVisit: (jobId: string) => void;
  /** Opens an activity for editing (in the day drawer). */
  onSelectActivity?: (activity: ScheduleActivity) => void;
  /**
   * Handles a drop on this technician's cell for the given date — the
   * returned handler itself decides whether this is a new job booking or an
   * already-booked visit being rescheduled (by which mime type the drag
   * carries), so this component doesn't need to know the difference; see
   * ThisWeekPage.tsx's handleDrop. The "Unassigned" row passes UNASSIGNED_ROW_ID.
   */
  onDrop: (technicianId: string, dateISO: string) => (e: React.DragEvent) => void;
  onToggleTechnicianActive: (id: string, isActive: boolean) => void;
}) {
  const technicianById = new Map(technicians.map((t) => [t.id, t]));
  const toISODate = (d: Date) => {
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
  };

  // `?? []`: activities restored from a cache written before they existed must not crash the grid.
  const liveActivities = (activities ?? []).filter((a) => (a.cancelledAt ?? null) == null);
  const dayISOs = new Set(days.map(toISODate));
  const hasUnassigned = liveActivities.some((a) => a.technicianId == null && dayISOs.has(a.scheduledDate));

  const renderChip = (item: DayItem, orderIndex: number, cellCount: number) => {
    if (item.kind === 'activity') {
      const a = item.activity;
      const done = (a.doneAt ?? null) != null;
      const time = formatTimeRange(a.startTime ?? null, a.endTime ?? null);
      return (
        <div
          key={`a-${a.id}`}
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData('application/x-activity-id', a.id);
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSelectActivity?.(a);
          }}
          className={`cursor-grab truncate rounded-md border px-1.5 py-1 text-[11px] leading-tight active:cursor-grabbing ${done ? ACTIVITY_CHIP_DONE : ACTIVITY_CHIP}`}
          title={`Activity: ${a.description}${a.location ? ` · ${a.location}` : ''}${time ? ` · ${time}` : ''}${done ? ' · Done' : ''}`}
        >
          {cellCount > 1 && (
            <span title="Order for this technician today" className="mr-1 font-bold tabular-nums">
              {orderIndex + 1}.
            </span>
          )}
          <span className="mr-1 border border-current px-0.5 font-heading text-[8px] font-semibold tracking-[0.08em] uppercase opacity-70">Act</span>
          {time && <span className="mr-1 tabular-nums opacity-80">{time}</span>}
          {a.description}
          {done && <span className="ml-1">✓</span>}
        </div>
      );
    }

    const v = item.visit;
    const job = jobById.get(v.jobId);
    // Only 'due'/'booked' visits can be dragged to a
    // different day — see MonthGrid.tsx's identical rule.
    const draggableChip = v.status === 'due' || v.status === 'booked';
    const teamNames = visitTechnicianNames(v, technicianById);
    const isMulti = teamNames.length > 1;
    const time = formatTimeRange(v.startTime ?? null, v.endTime ?? null);
    return (
      <div
        key={`v-${v.id}`}
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
        className={`truncate rounded-md border px-1.5 py-1 text-[11px] leading-tight ${draggableChip ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${visitStatusStyle[v.status]}`}
        title={`${job ? `${job.jobSummary} · ${job.buildingName}` : v.jobId}${time ? ` · ${time}` : ''}${isMulti ? ` · With: ${teamNames.join(', ')}` : ''}`}
      >
        {cellCount > 1 && (
          <span title="Order for this technician today" className="mr-1 font-bold tabular-nums">
            {orderIndex + 1}.
          </span>
        )}
        {time && <span className="mr-1 tabular-nums opacity-80">{time}</span>}
        {job ? job.buildingName : 'Job'}
        {isMulti && (
          <span className="ml-1 rounded-sm border border-current px-1 text-[9.5px] font-semibold opacity-80">
            {teamNames.length} techs
          </span>
        )}
      </div>
    );
  };

  const renderCell = (rowKey: string, rowId: string, rowName: string, cellDateISO: string, items: DayItem[], onCellSelectTechnician: string | undefined) => {
    const isToday = cellDateISO === todayISO;
    const isSelected = cellDateISO === selectedDateISO;
    return (
      <div
        key={`${rowKey}-${cellDateISO}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop(rowId, cellDateISO)}
        onClick={() => onSelectDay(cellDateISO, onCellSelectTechnician)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onSelectDay(cellDateISO, onCellSelectTechnician);
        }}
        className={`group relative cursor-pointer border-b border-l border-neutral-300 px-2 py-2 transition-colors hover:bg-neutral-100 ${
          isToday ? 'bg-teal-100/40' : ''
        } ${isSelected ? 'ring-1 ring-inset ring-teal' : ''}`}
      >
        {/* A reserved, always-present strip — never overlaps a chip below it, whether the
            cell is empty or already has bookings (see req. 7: the "+" must never sit on
            top of a booking card). Invisible until hover/focus reveals the button itself. */}
        <div className="flex h-4 items-center justify-end">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectDay(cellDateISO, onCellSelectTechnician);
            }}
            aria-label={`Add booking for ${rowName} on ${cellDateISO}`}
            title="Add booking"
            className="flex h-4 w-4 cursor-pointer items-center justify-center border border-teal bg-white text-[11px] leading-none font-semibold text-teal-700 opacity-0 hover:bg-teal-100 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            +
          </button>
        </div>
        {items.length === 0 ? (
          <span className="text-[11px] text-neutral-400">Free</span>
        ) : (
          <div className="flex flex-col gap-1">{items.map((item, orderIndex) => renderChip(item, orderIndex, items.length))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-300 bg-white">
      <div
        className={`grid ${days.length === 1 ? 'grid-cols-[180px_minmax(0,1fr)]' : 'grid-cols-[180px_repeat(6,minmax(0,1fr))]'}`}
      >
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
          // A multi-technician visit appears in EVERY participant's row (primary and additional alike).
          const technicianVisits = visits.filter((v) => isVisitParticipant(v, technician.id));
          const technicianDisplayVisits = displayVisits.filter((v) => isVisitParticipant(v, technician.id));
          const technicianActivities = liveActivities.filter((a) => a.technicianId === technician.id);
          return (
            <Fragment key={technician.id}>
              <div
                className={`flex items-center gap-2 border-b border-neutral-300 px-3 py-2.5 text-[13px] ${
                  technician.isActive ? '' : 'text-neutral-400'
                }`}
              >
                <span className="font-semibold text-ink">{technician.name}</span>
                <span
                  title="Real visit count for this period — not a capacity estimate (activities are not counted)"
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
                // Running order within the day (manual order first, then creation time) - jobs and activities in one
                // sequence, the same order the technician sees.
                const items = mergeDayItems(
                  technicianDisplayVisits.filter((v) => v.scheduledDate === cellDateISO),
                  technicianActivities.filter((a) => a.scheduledDate === cellDateISO),
                );
                return renderCell(technician.id, technician.id, technician.name, cellDateISO, items, technician.id);
              })}
            </Fragment>
          );
        })}

        {hasUnassigned && (
          <Fragment key={UNASSIGNED_ROW_ID}>
            <div className="flex items-center gap-2 border-b border-neutral-300 bg-neutral-100/60 px-3 py-2.5 text-[13px]">
              <span className="font-semibold text-neutral-600 italic">Unassigned</span>
              <span className="ml-auto text-[10.5px] text-neutral-500">activities only</span>
            </div>
            {days.map((d) => {
              const cellDateISO = toISODate(d);
              const items = mergeDayItems(
                [],
                liveActivities.filter((a) => a.technicianId == null && a.scheduledDate === cellDateISO),
              );
              return renderCell(UNASSIGNED_ROW_ID, UNASSIGNED_ROW_ID, 'Unassigned', cellDateISO, items, undefined);
            })}
          </Fragment>
        )}
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
