import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobRow } from '../../domain/types';
import { listTeams, createVisit } from '../../repository/teamsRepository';
import { assignJobTeam } from '../../repository/jobsRepository';
import { createInvoiceDraft } from '../../repository/invoicesRepository';
import { useAuth } from '../../auth/AuthProvider';
import VisitRow from './VisitRow';
import ScheduleEditor from './ScheduleEditor';
import JobEditor from './JobEditor';
import InvoiceEditor from './InvoiceEditor';
import { describeSchedule, suggestNextDate } from '../../lib/scheduleFormat';
import { getStatusPresentation, isVisitReadyForAccounts } from '../../lib/statusPresentation';
import StatusPill from './StatusPill';

interface JobInspectorDrawerProps {
  job: JobRow;
  siblings: JobRow[];
  onClose: () => void;
  onSelectSibling: (jobId: string) => void;
  /**
   * Forces the "Book a visit" panel open regardless of `job.status` — for
   * callers like the Month Matrix, where a specific month can be honestly
   * due-and-unbooked even while the job's own single, job-level status is
   * something else (e.g. booked from a visit in a different month).
   */
  forceShowBooking?: boolean;
  /** Pre-fills the booking date input — never fabricated by this component itself, only ever passed in by a caller that computed a real, honest date (or left it undefined for the normal today-default). */
  presetVisitDate?: string;
}

const NOT_BUILT_TITLE = 'Not built yet';

/** Formats today's own LOCAL calendar day — never `.toISOString()` here, which converts to UTC and would shift the date in any timezone ahead of UTC (same fix as scheduleFormat.ts/ThisWeekPage.tsx's toISODate). */
function todayISO(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export default function JobInspectorDrawer({
  job,
  siblings,
  onClose,
  onSelectSibling,
  forceShowBooking = false,
  presetVisitDate,
}: JobInspectorDrawerProps) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const actor = session?.user.email ?? 'unknown';
  const [revealed, setRevealed] = useState(false);
  const [editingJob, setEditingJob] = useState(false);
  const [visitDate, setVisitDate] = useState(presetVisitDate ?? todayISO());
  const [visitTeamId, setVisitTeamId] = useState<string>(job.defaultTeamId ?? '');
  const [bookingMessage, setBookingMessage] = useState<string | null>(null);
  const [selectedVisitIds, setSelectedVisitIds] = useState<Set<string>>(new Set());
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { data: teams = [] } = useQuery({ queryKey: ['teams'], queryFn: listTeams });
  const activeTeams = teams.filter((t) => t.isActive);

  const assignTeamMutation = useMutation({
    mutationFn: (teamId: string | null) => assignJobTeam(job.id, teamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobRows'] }),
  });

  const bookVisitMutation = useMutation({
    mutationFn: () => createVisit(job.id, visitTeamId || null, visitDate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
      setBookingMessage(`Visit booked for ${new Date(visitDate).toLocaleDateString('en-GB')}.`);
    },
    onError: (err) => setBookingMessage(err instanceof Error ? err.message : 'Failed to book visit.'),
  });

  const createInvoiceMutation = useMutation({
    mutationFn: (visitIds: string[]) => {
      const lines = visitIds.map((visitId) => {
        const visit = job.visits.find((v) => v.id === visitId)!;
        return {
          visitId,
          description: job.jobSummary,
          quantity: 1,
          unitAmount: visit.priceCharged ?? job.pricePerVisit ?? 0,
        };
      });
      return createInvoiceDraft({ jobId: job.id, createdBy: actor, description: job.jobSummary, worksOrderNumber: null, lines });
    },
    onSuccess: (invoiceId) => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      setSelectedVisitIds(new Set());
      setOpenInvoiceId(invoiceId);
      setInvoiceError(null);
    },
    onError: (err) => setInvoiceError(err instanceof Error ? err.message : 'Failed to create invoice.'),
  });

  const toggleVisitSelected = (visitId: string) => {
    setSelectedVisitIds((prev) => {
      const next = new Set(prev);
      if (next.has(visitId)) next.delete(visitId);
      else next.add(visitId);
      return next;
    });
  };

  const suggestedDate = job.schedule ? suggestNextDate(job.schedule, todayISO()) : null;

  const facts: [string, string][] = [
    ['Client', job.clientName],
    ['Invoice address', job.clientInvoiceAddress ? job.clientInvoiceAddress.split(',')[0] : '—'],
    ['Price per visit', job.pricePerVisit == null ? 'Variable' : `£${job.pricePerVisit.toLocaleString('en-GB')}.00`],
    ['Contract per year', job.yearlyValue ? `£${job.yearlyValue.toLocaleString('en-GB')}.00` : 'On request'],
    ['Next visit', job.nextDueLabel],
  ];

  return (
    <aside className="hidden w-[344px] flex-none flex-col overflow-y-auto border-l border-divider bg-white lg:flex">
      <div className="border-b border-divider p-4">
        <div className="flex items-center gap-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Job · {job.id}
          <button onClick={onClose} className="ml-auto cursor-pointer font-body text-sm text-neutral-500 hover:text-ink">
            ✕
          </button>
        </div>
        <h2 className="mt-1.5 font-heading text-xl leading-tight font-semibold">{job.jobSummary}</h2>
        <div className="text-[13px]">
          <span className="text-neutral-600">
            {[job.buildingName, [job.street, job.postcode].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span
            className={`px-2 py-0.5 font-heading text-[10.5px] font-semibold tracking-[0.09em] uppercase ${
              job.division === 'Specialist'
                ? 'border border-teal-700 bg-teal-100 text-teal-700'
                : 'border border-neutral-300 bg-neutral-200 text-neutral-700'
            }`}
          >
            {job.division}
          </span>
          <span className="max-w-[180px] truncate border border-neutral-300 px-2 py-0.5 font-heading text-[10.5px] font-semibold tracking-[0.09em] text-neutral-700 uppercase">
            {job.schedulePattern}
          </span>
          <span className="border border-neutral-300 px-2 py-0.5">
            <StatusPill presentation={getStatusPresentation(job.status)} />
          </span>
        </div>
      </div>

      {job.status === 'review' && (
        <div className="m-3.5 border border-teal-700/40 bg-teal-100 p-3">
          <div className="font-heading text-[11px] font-semibold tracking-[0.11em] text-teal-700 uppercase">
            Report waiting on you
          </div>
          <div className="mt-1 text-[12.5px] leading-snug text-teal-700">
            {job.nextDueLabel} — open below to approve, return, or send it.
          </div>
        </div>
      )}
      {(forceShowBooking || job.status === 'unscheduled' || job.status === 'needs_booking' || job.status === 'overdue') && (
        <div className="m-3.5 border border-neutral-300 p-3">
          <div className="font-heading text-[11px] font-semibold tracking-[0.11em] text-neutral-700 uppercase">
            Book a visit
          </div>
          {job.status === 'overdue' && (
            <div className="mt-1 mb-2 text-[12.5px] leading-snug text-missed-fg">
              This job has an overdue visit ({job.nextDueLabel}). Booking below adds a new visit —
              the overdue one isn't editable yet.
            </div>
          )}
          {job.status === 'needs_booking' && (
            <div className="mt-1 mb-2 text-[12.5px] leading-snug text-due-fg">
              This job is due with no date set yet.
            </div>
          )}
          <div className="mt-2 flex flex-col gap-2">
            {suggestedDate && (
              <div className="text-[11.5px] text-neutral-600">
                Per this job's schedule ({describeSchedule(job.schedule!)}): suggested{' '}
                {new Date(suggestedDate).toLocaleDateString('en-GB')}
                <button
                  type="button"
                  onClick={() => setVisitDate(suggestedDate)}
                  className="ml-1.5 cursor-pointer text-teal-700 hover:underline"
                >
                  Use this date
                </button>
              </div>
            )}
            <label className="flex flex-col gap-1 text-[11.5px] text-neutral-600">
              Date
              <input
                type="date"
                value={visitDate}
                onChange={(e) => setVisitDate(e.target.value)}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11.5px] text-neutral-600">
              Team
              <select
                value={visitTeamId}
                onChange={(e) => setVisitTeamId(e.target.value)}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              >
                <option value="">Unassigned</option>
                {activeTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => {
                setBookingMessage(null);
                bookVisitMutation.mutate();
              }}
              disabled={!visitDate || bookVisitMutation.isPending}
              className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {bookVisitMutation.isPending ? 'Booking…' : 'Book this visit'}
            </button>
            {bookingMessage && <div className="text-[11.5px] text-neutral-700">{bookingMessage}</div>}
          </div>
        </div>
      )}

      <div className="px-4 pt-3.5">
        <div className="flex justify-between gap-3 border-b border-divider py-1.5 text-[12.5px]">
          <span className="text-neutral-600">Assigned</span>
          <select
            value={job.defaultTeamId ?? ''}
            onChange={(e) => assignTeamMutation.mutate(e.target.value || null)}
            disabled={assignTeamMutation.isPending}
            className="cursor-pointer border-0 bg-transparent text-right text-[12.5px] text-ink outline-none"
          >
            <option value="">Unassigned</option>
            {activeTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-divider py-1.5 text-[12.5px]">
            <span className="text-neutral-600">{k}</span>
            <span className="tabular-nums">{v}</span>
          </div>
        ))}
      </div>

      {editingJob && <JobEditor job={job} onDone={() => setEditingJob(false)} />}

      <ScheduleEditor jobId={job.id} schedule={job.schedule} />

      {job.visits.length > 0 && (
        <div className="px-4 pb-1">
          <div className="mb-1.5 flex items-center gap-2">
            <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
              Visits ({job.visits.length})
            </div>
            {selectedVisitIds.size > 0 && (
              <button
                onClick={() => createInvoiceMutation.mutate([...selectedVisitIds])}
                disabled={createInvoiceMutation.isPending}
                className="ml-auto cursor-pointer bg-teal px-2 py-0.5 text-[10.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createInvoiceMutation.isPending
                  ? 'Creating…'
                  : selectedVisitIds.size === 1
                    ? 'Create invoice'
                    : `Create combined invoice (${selectedVisitIds.size})`}
              </button>
            )}
          </div>
          {invoiceError && <div className="mb-1.5 text-[11.5px] text-missed-fg">{invoiceError}</div>}
          {job.visits.map((v) => {
            const selectableForInvoice = isVisitReadyForAccounts(v) && !v.invoiceId;
            return (
              <VisitRow
                key={v.id}
                job={job}
                visit={v}
                actor={actor}
                selectableForInvoice={selectableForInvoice}
                selectedForInvoice={selectedVisitIds.has(v.id)}
                onToggleSelectForInvoice={() => toggleVisitSelected(v.id)}
                onOpenInvoice={(invoiceId) => setOpenInvoiceId(invoiceId)}
              />
            );
          })}
        </div>
      )}

      {openInvoiceId && <InvoiceEditor invoiceId={openInvoiceId} onClose={() => setOpenInvoiceId(null)} />}

      <div className="m-3.5 border border-dashed border-neutral-400 bg-neutral-100 p-3">
        <div className="flex items-center gap-2">
          <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
            Internal only · access
          </div>
          <button
            onClick={() => setRevealed((r) => !r)}
            className="ml-auto cursor-pointer text-[11.5px] text-teal-700 hover:underline"
          >
            {revealed ? 'Hide' : 'Reveal'}
          </button>
        </div>
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
          {revealed ? job.buildingInternalAccessNote : 'Hidden. Reveal to show key safe, keyholder and parking details.'}
        </div>
      </div>

      {siblings.length > 0 && (
        <div className="px-4 pb-1">
          <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
            Also at this building
          </div>
          {siblings.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelectSibling(s.id)}
              className="flex cursor-pointer justify-between border-b border-divider py-1.5 text-[12.5px] hover:text-teal-700"
            >
              {s.jobSummary} · {s.frequencyRaw}
              <span className="text-neutral-600 tabular-nums">
                {s.pricePerVisit == null ? 'Variable' : `£${s.pricePerVisit.toLocaleString('en-GB')}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-1.5 border-t border-divider p-3.5">
        <button
          onClick={() => navigate(`/buildings/${job.buildingId}`)}
          className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
        >
          Building file
        </button>
        <button
          onClick={() => setEditingJob(true)}
          className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
        >
          Edit job
        </button>
        <div title={NOT_BUILT_TITLE} className="cursor-not-allowed border border-neutral-300 px-3 py-1.5 text-xs text-neutral-500">
          See the year
        </div>
      </div>
    </aside>
  );
}
