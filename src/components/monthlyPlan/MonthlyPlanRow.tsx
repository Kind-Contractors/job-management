// One job on the Monthly Plan: what it is, how often it repeats, where it stands this month, and - when it still
// wants a date - the date and technician(s) to book it with.
//
// Booking is IMMEDIATE. Pressing Book writes a real visit through the same `createVisit` every other booking
// path in this app uses; there is no draft, nothing is held locally, and there is no "save the plan" step.
// Presentational state is only the two form fields.
//
// Because `visits` has no unique (job_id, scheduled_date) constraint - and cannot have a naive one, since
// cancel-then-rebook legitimately leaves two rows on one date and a genuine second visit in a day does happen -
// this row is also the double-booking guard: it lists the month's real visits, and asks before adding a second
// one to a date that already has one.
//
// LAYOUT. Six real columns, on the same track as the page's header row (MONTHLY_PLAN_COLUMNS below, which both
// import so they can never drift apart): JOB | REPEATS | STATUS | DATE | TECHNICIAN | ACTION. Every kind of row
// fills the same six, so the dates and the Book buttons line up down the page instead of floating at whatever
// height their own content happens to reach. Rows that cannot be booked say why across the DATE/TECHNICIAN
// columns and put their one fix in ACTION.
//
// STYLING is the house language, not a second one: square corners, 1px hairlines, Barlow via `font-heading`,
// and the same dot + uppercase status chip StatusPill uses (CLAUDE.md section 4).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobVisitSummary, Technician } from '../../domain/types';
import { createVisit } from '../../repository/techniciansRepository';
import { activeSelection, splitPrimary } from '../../lib/visitTechnicianSelection';
import { carriedOverLabel, visitsOnDate, type MonthlyPlanEntry } from '../../lib/monthlyPlan';
import VisitTechnicianPicker from '../jobs/VisitTechnicianPicker';

/** The one column track, shared with the page's header row so the two can never disagree. */
export const MONTHLY_PLAN_COLUMNS =
  'grid-cols-[minmax(220px,2.4fr)_minmax(116px,0.9fr)_116px_minmax(148px,1fr)_minmax(186px,1.1fr)_108px]';

export interface MonthlyPlanRowProps {
  entry: MonthlyPlanEntry;
  technicians: Technician[];
  onOpenJob: (jobId: string, presetDate?: string) => void;
  /** Opens the focused Set-a-schedule modal. Only the no-schedule row uses it; everything else opens the drawer. */
  onSetSchedule: (jobId: string) => void;
}

/** "Anna", "Anna +2", or null — JobVisitSummary already carries the names, so no lookup is needed. */
function technicianSummary(v: JobVisitSummary): string | null {
  if (!v.technicianName) return null;
  const extra = v.additionalTechnicians.length;
  return extra > 0 ? `${v.technicianName} +${extra}` : v.technicianName;
}

/**
 * The same shape StatusPill renders — a square dot plus an uppercase label — in the restrained palette
 * CLAUDE.md section 4 allows: ochre needs booking, brick missed, teal done. The two states that are not work
 * (no cycle, no schedule) are hollow and grey, exactly as `getMonthCellPresentation` treats them.
 */
const KIND_BADGE: Record<MonthlyPlanEntry['kind'], { label: string; fg: string; dot: string; border: string; bg: string }> = {
  booked: { label: 'Booked', fg: 'text-teal-700', dot: 'bg-teal', border: 'border-teal', bg: 'bg-teal-100' },
  due_no_date: { label: 'To book', fg: 'text-due-fg', dot: 'bg-due', border: 'border-due', bg: 'bg-due/10' },
  carried_over: { label: 'Overdue', fg: 'text-missed-fg', dot: 'bg-missed', border: 'border-missed', bg: 'bg-missed/10' },
  not_determinable: { label: 'Can’t tell', fg: 'text-neutral-600', dot: 'bg-transparent', border: 'border-neutral-400', bg: 'bg-transparent' },
  no_schedule: { label: 'No schedule', fg: 'text-neutral-600', dot: 'bg-transparent', border: 'border-neutral-400', bg: 'bg-transparent' },
};

export default function MonthlyPlanRow({ entry, technicians, onOpenJob, onSetSchedule }: MonthlyPlanRowProps) {
  const queryClient = useQueryClient();
  const { job } = entry;
  // Empty when the schedule names no day for this month, rather than the 1st: substituting a date the schedule
  // never claimed makes an undecided date look decided, and one click on Book would make it real. Book is already
  // disabled while this is empty, so the manager has to choose.
  const [date, setDate] = useState(entry.suggestedDate ?? '');
  const [technicianIds, setTechnicianIds] = useState<string[]>(job.defaultTechnicianId ? [job.defaultTechnicianId] : []);
  const [confirmingClash, setConfirmingClash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const badge = KIND_BADGE[entry.kind];
  const overdue = carriedOverLabel(entry);
  const canBook = entry.kind === 'due_no_date' || entry.kind === 'carried_over';
  const clash = visitsOnDate(job, date);

  const bookMutation = useMutation({
    mutationFn: () => {
      const { primaryId, additionalIds } = splitPrimary(activeSelection(technicianIds, technicians));
      return createVisit(job.id, primaryId, date, additionalIds);
    },
    onSuccess: () => {
      setConfirmingClash(false);
      setError(null);
      // The row re-derives from these two queries and flips to "Booked" on its own — no local bookkeeping.
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
    },
    onError: (err) => {
      setConfirmingClash(false);
      setError(err instanceof Error ? err.message : 'Could not book this visit.');
    },
  });

  const onBook = () => {
    // Asked, not refused: a second visit on one day is sometimes real.
    if (clash.length > 0 && !confirmingClash) {
      setConfirmingClash(true);
      return;
    }
    bookMutation.mutate();
  };

  /** Spans the DATE and TECHNICIAN columns for a row that cannot be booked, so ACTION still lines up. */
  const explain = (text: string, actionLabel: string, onAction: () => void) => (
    <>
      <div className="col-span-2 self-center text-[11.5px] text-neutral-600">{text}</div>
      <div className="self-center text-right">
        <button onClick={onAction} className="cursor-pointer text-[11.5px] text-teal-700 hover:underline">
          {actionLabel}
        </button>
      </div>
    </>
  );

  return (
    <div
      className={`grid ${MONTHLY_PLAN_COLUMNS} items-start gap-4 border-b border-neutral-300 px-3 py-2 last:border-b-0 hover:bg-neutral-100/60`}
      data-testid="monthly-plan-row"
    >
      {/* JOB */}
      <div className="min-w-0 self-center">
        <button
          onClick={() => onOpenJob(job.id)}
          className="block max-w-full cursor-pointer truncate text-left text-[12.5px] font-semibold text-ink hover:underline"
        >
          {job.buildingName}
        </button>
        <div className="truncate text-[11.5px] text-neutral-600">
          {job.clientName} · {job.jobSummary}
        </div>
        {overdue && (
          <div className="mt-0.5 text-[11px] text-missed-fg" data-testid="overdue-chip">
            {overdue}
          </div>
        )}
      </div>

      {/* REPEATS — the pricing label on top, the real schedule rule beneath it. `schedulePattern` falls back to
          the frequency label for a job with no schedule, so the second line is dropped when it would just repeat
          the first rather than printing "Monthly / Monthly". */}
      <div className="min-w-0 self-center">
        <div className="truncate text-[12px] text-ink">{job.frequencyRaw}</div>
        {job.schedulePattern !== job.frequencyRaw && (
          <div className="truncate text-[11px] text-neutral-500 tabular-nums">{job.schedulePattern}</div>
        )}
      </div>

      {/* STATUS */}
      <div className="self-center">
        <span
          className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-heading text-[10px] font-semibold tracking-[0.07em] uppercase ${badge.border} ${badge.bg} ${badge.fg}`}
        >
          <i className={`block h-1.5 w-1.5 border ${badge.dot} ${badge.border}`} />
          {badge.label}
        </span>
        {entry.needsSchedule && entry.kind !== 'no_schedule' && (
          <div className="mt-0.5 text-[10.5px] text-due-fg" data-testid="needs-schedule-chip">
            No schedule
          </div>
        )}
      </div>

      {entry.kind === 'booked' && (
        <>
          {/* DATE */}
          <div className="self-center text-[12px] text-ink tabular-nums" data-testid="booked-visits">
            {entry.visitsInMonth.map((v) => (
              <div key={v.id}>{v.scheduledDate && new Date(v.scheduledDate).toLocaleDateString('en-GB')}</div>
            ))}
          </div>
          {/* TECHNICIAN */}
          <div className="self-center truncate text-[12px] text-neutral-700">
            {entry.visitsInMonth.map((v) => (
              <div key={v.id} className="truncate">
                {technicianSummary(v) ?? <span className="text-neutral-500">No technician yet</span>}
              </div>
            ))}
          </div>
          {/* ACTION — moving a booked visit or changing who is on it happens on the visit itself, in the job
              drawer: both are in-place updates, so neither can ever make a second visit. Booking a NEW one is the
              only thing that inserts, and that is the form a booked row deliberately does not show. */}
          <div className="self-center text-right">
            <button
              onClick={() => onOpenJob(job.id)}
              className="cursor-pointer text-[11.5px] text-teal-700 hover:underline"
              data-testid="change-booking"
            >
              Change
            </button>
          </div>
        </>
      )}

      {entry.kind === 'no_schedule' && (
        <div className="contents" data-testid="no-schedule-explainer">
          {explain('Won’t come due until a schedule is set.', 'Set a schedule', () => onSetSchedule(job.id))}
        </div>
      )}

      {/* This job HAS a schedule - it is only missing its anchor - so it keeps going to the drawer, where the
          whole job is in view. The modal is for the no-schedule case the plan flags. */}
      {entry.kind === 'not_determinable' &&
        explain('Repeats less often than monthly with no “counted from” date.', 'Set it on the job', () => onOpenJob(job.id))}

      {canBook && (
        <>
          {/* DATE */}
          <div className="self-center">
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setConfirmingClash(false);
              }}
              aria-label={`Date for ${job.buildingName}`}
              className="w-full border border-neutral-300 px-2 py-1 text-[12px] text-ink tabular-nums outline-none focus:border-teal"
            />
            {!date && (
              <div className="mt-0.5 text-[10.5px] text-due-fg" data-testid="no-set-date-hint">
                No set date — choose one.
              </div>
            )}
          </div>
          {/* TECHNICIAN — the column header already names this, so the picker drops its own caption. */}
          <div className="self-center">
            <VisitTechnicianPicker
              technicians={technicians}
              selectedIds={technicianIds}
              onChange={setTechnicianIds}
              textClass="text-[12px]"
              hideLabel
            />
          </div>
          {/* ACTION */}
          <div className="self-center text-right">
            <button
              onClick={onBook}
              disabled={!date || bookMutation.isPending}
              className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:opacity-50"
            >
              {bookMutation.isPending ? 'Booking…' : confirmingClash ? 'Book anyway' : 'Book'}
            </button>
          </div>
          {(confirmingClash || error) && (
            <div className="col-span-6 pt-0.5">
              {confirmingClash && clash.length > 0 && (
                <div role="alert" className="text-[11px] text-due-fg" data-testid="clash-warning">
                  There is already a visit for this job on {new Date(date).toLocaleDateString('en-GB')}. Book another one?
                </div>
              )}
              {error && (
                <div role="alert" className="text-[11px] text-missed-fg">
                  {error}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
