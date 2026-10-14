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
  /** 'YYYY-MM' being planned — the fallback date when the schedule can't suggest a real day. */
  monthPrefix: string;
  onOpenJob: (jobId: string, presetDate?: string) => void;
}

/** "Anna", "Anna +2", or null — JobVisitSummary already carries the names, so no lookup is needed. */
function technicianSummary(v: JobVisitSummary): string | null {
  if (!v.technicianName) return null;
  const extra = v.additionalTechnicians.length;
  return extra > 0 ? `${v.technicianName} +${extra}` : v.technicianName;
}

const KIND_BADGE: Record<MonthlyPlanEntry['kind'], { label: string; className: string }> = {
  booked: { label: 'Booked', className: 'border-teal text-teal-700' },
  due_no_date: { label: 'To book', className: 'border-due text-due-fg' },
  carried_over: { label: 'Overdue', className: 'border-missed text-missed-fg' },
  not_determinable: { label: 'Can’t tell', className: 'border-neutral-300 text-neutral-600' },
};

export default function MonthlyPlanRow({ entry, technicians, monthPrefix, onOpenJob }: MonthlyPlanRowProps) {
  const queryClient = useQueryClient();
  const { job } = entry;
  const [date, setDate] = useState(entry.suggestedDate ?? `${monthPrefix}-01`);
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-divider px-3 py-2" data-testid="monthly-plan-row">
      <div className="min-w-0">
        <button onClick={() => onOpenJob(job.id)} className="cursor-pointer text-left text-[12.5px] font-semibold text-ink hover:underline">
          {job.buildingName}
        </button>
        <div className="text-[11.5px] text-neutral-600">
          {job.clientName} · {job.jobSummary}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
          <span className={`border px-1 py-px font-heading text-[9.5px] font-semibold tracking-[0.08em] uppercase ${badge.className}`}>{badge.label}</span>
          <span>{job.schedulePattern}</span>
          {overdue && (
            <span className="border border-missed bg-missed/10 px-1 py-px text-[10px] text-missed-fg" data-testid="overdue-chip">
              {overdue}
            </span>
          )}
        </div>

        {entry.kind === 'booked' && (
          <div className="mt-1 text-[11.5px] text-neutral-700" data-testid="booked-visits">
            {entry.visitsInMonth.map((v) => (
              <div key={v.id}>
                {v.scheduledDate && new Date(v.scheduledDate).toLocaleDateString('en-GB')} · {technicianSummary(v) ?? 'No technician yet'}
              </div>
            ))}
            {/* Moving a booked visit or changing who is on it happens on the visit itself, in the job drawer: both are
                in-place updates (rescheduleVisit / assignVisitTechnician), so neither can ever make a second visit.
                Booking a NEW one is the only thing that inserts, and that is the form above - which a booked row
                deliberately does not show. */}
            <button
              onClick={() => onOpenJob(job.id)}
              className="mt-0.5 cursor-pointer text-[11px] text-teal-700 underline"
              data-testid="change-booking"
            >
              Change date or team
            </button>
          </div>
        )}

        {entry.kind === 'not_determinable' && (
          <div className="mt-1 text-[11.5px] text-neutral-600">
            This job repeats less often than monthly and has no “counted from” date, so which months it falls in can’t be
            worked out.{' '}
            <button onClick={() => onOpenJob(job.id)} className="cursor-pointer text-teal-700 underline">
              Set it on the job
            </button>
          </div>
        )}
      </div>

      {canBook && (
        <div className="flex flex-none flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setConfirmingClash(false);
              }}
              aria-label={`Date for ${job.buildingName}`}
              className="border border-neutral-300 px-1.5 py-1 text-[11.5px] text-ink outline-none focus:border-teal"
            />
            <VisitTechnicianPicker technicians={technicians} selectedIds={technicianIds} onChange={setTechnicianIds} textClass="text-[11.5px]" />
            <button
              onClick={onBook}
              disabled={!date || bookMutation.isPending}
              className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bookMutation.isPending ? 'Booking…' : confirmingClash ? 'Book anyway' : 'Book'}
            </button>
          </div>
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
