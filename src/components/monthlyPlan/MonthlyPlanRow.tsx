// One job on the Monthly Plan: what it is, where it stands this month, and - when it still wants a date - the
// date and technician(s) to book it with.
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
// STYLING follows the shared grid conventions: px-3 so the building name lines up with the band title above it,
// a 1px hairline under every row, and the same control sizes the Job Inspector and All Live Jobs use.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobVisitSummary, Technician } from '../../domain/types';
import { createVisit } from '../../repository/techniciansRepository';
import { activeSelection, splitPrimary } from '../../lib/visitTechnicianSelection';
import { carriedOverLabel, visitsOnDate, type MonthlyPlanEntry } from '../../lib/monthlyPlan';
import VisitTechnicianPicker from '../jobs/VisitTechnicianPicker';

export interface MonthlyPlanRowProps {
  entry: MonthlyPlanEntry;
  technicians: Technician[];
  onOpenJob: (jobId: string, presetDate?: string) => void;
}

/** "Anna", "Anna +2", or null — JobVisitSummary already carries the names, so no lookup is needed. */
function technicianSummary(v: JobVisitSummary): string | null {
  if (!v.technicianName) return null;
  const extra = v.additionalTechnicians.length;
  return extra > 0 ? `${v.technicianName} +${extra}` : v.technicianName;
}

const KIND_BADGE: Record<MonthlyPlanEntry['kind'], { label: string; className: string }> = {
  booked: { label: 'Booked', className: 'border-teal bg-teal-100 text-teal-700' },
  due_no_date: { label: 'To book', className: 'border-due bg-due/10 text-due-fg' },
  carried_over: { label: 'Overdue', className: 'border-missed bg-missed/10 text-missed-fg' },
  not_determinable: { label: 'Can’t tell', className: 'border-neutral-300 text-neutral-600' },
  no_schedule: { label: 'No schedule', className: 'border-neutral-300 text-neutral-600' },
};

export default function MonthlyPlanRow({ entry, technicians, onOpenJob }: MonthlyPlanRowProps) {
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

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-neutral-300 px-3 py-2 last:border-b-0 hover:bg-neutral-100/60"
      data-testid="monthly-plan-row"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            onClick={() => onOpenJob(job.id)}
            className="cursor-pointer text-left text-[12.5px] font-semibold text-ink hover:underline"
          >
            {job.buildingName}
          </button>
          <span
            className={`border px-1.5 py-px font-heading text-[9.5px] font-semibold tracking-[0.08em] uppercase ${badge.className}`}
          >
            {badge.label}
          </span>
          {entry.needsSchedule && entry.kind !== 'no_schedule' && (
            <span
              className="border border-due bg-due/10 px-1.5 py-px font-heading text-[9.5px] font-semibold tracking-[0.08em] text-due-fg uppercase"
              data-testid="needs-schedule-chip"
            >
              No schedule
            </span>
          )}
          {overdue && (
            <span
              className="border border-missed bg-missed/10 px-1.5 py-px text-[10.5px] text-missed-fg"
              data-testid="overdue-chip"
            >
              {overdue}
            </span>
          )}
        </div>

        <div className="mt-0.5 text-[11.5px] text-neutral-600">
          {job.clientName} · {job.jobSummary}
          <span className="text-neutral-400"> · </span>
          <span className="tabular-nums">{job.schedulePattern}</span>
        </div>

        {entry.kind === 'booked' && (
          <div className="mt-1 text-[11.5px] text-neutral-700" data-testid="booked-visits">
            {entry.visitsInMonth.map((v) => (
              <div key={v.id} className="tabular-nums">
                {v.scheduledDate && new Date(v.scheduledDate).toLocaleDateString('en-GB')} ·{' '}
                <span className="text-neutral-600">{technicianSummary(v) ?? 'No technician yet'}</span>
              </div>
            ))}
            {/* Moving a booked visit or changing who is on it happens on the visit itself, in the job drawer: both are
                in-place updates (rescheduleVisit / assignVisitTechnician), so neither can ever make a second visit.
                Booking a NEW one is the only thing that inserts, and that is the form above - which a booked row
                deliberately does not show. */}
            <button
              onClick={() => onOpenJob(job.id)}
              className="mt-0.5 cursor-pointer text-[11px] text-teal-700 hover:underline"
              data-testid="change-booking"
            >
              Change date or team
            </button>
          </div>
        )}

        {entry.kind === 'no_schedule' && (
          <div className="mt-1 text-[11.5px] text-neutral-600" data-testid="no-schedule-explainer">
            Priced as {job.frequencyRaw.toLowerCase()} work, but no schedule is set, so it never becomes due on its own.{' '}
            <button onClick={() => onOpenJob(job.id)} className="cursor-pointer text-teal-700 hover:underline">
              Set a schedule
            </button>
          </div>
        )}

        {entry.kind === 'not_determinable' && (
          <div className="mt-1 text-[11.5px] text-neutral-600">
            This job repeats less often than monthly and has no “counted from” date, so which months it falls in can’t be
            worked out.{' '}
            <button onClick={() => onOpenJob(job.id)} className="cursor-pointer text-teal-700 hover:underline">
              Set it on the job
            </button>
          </div>
        )}
      </div>

      {canBook && (
        <div className="flex flex-none flex-col items-end gap-1">
          {/* items-end, not items-center: VisitTechnicianPicker carries its own label above its button, so the
              three controls line up on their bottom edge rather than drifting apart. */}
          <div className="flex items-end gap-1.5">
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setConfirmingClash(false);
              }}
              aria-label={`Date for ${job.buildingName}`}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink tabular-nums outline-none focus:border-teal"
            />
            <VisitTechnicianPicker
              technicians={technicians}
              selectedIds={technicianIds}
              onChange={setTechnicianIds}
              textClass="text-[12.5px]"
            />
            <button
              onClick={onBook}
              disabled={!date || bookMutation.isPending}
              className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:opacity-50"
            >
              {bookMutation.isPending ? 'Booking…' : confirmingClash ? 'Book anyway' : 'Book'}
            </button>
          </div>
          {!date && (
            <div className="max-w-[320px] text-right text-[11px] text-neutral-600" data-testid="no-set-date-hint">
              No set date for this month — choose one.
            </div>
          )}
          {confirmingClash && clash.length > 0 && (
            <div role="alert" className="max-w-[320px] text-right text-[11px] text-due-fg" data-testid="clash-warning">
              There is already a visit for this job on {new Date(date).toLocaleDateString('en-GB')}. Book another one?
            </div>
          )}
          {error && (
            <div role="alert" className="max-w-[320px] text-right text-[11px] text-missed-fg">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
