import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../../domain/types';
import { listTechnicians, createVisit } from '../../repository/techniciansRepository';
import { assignJobTechnician } from '../../repository/jobsRepository';
import { useAuth } from '../../auth/AuthProvider';
import VisitRow from './VisitRow';
import ScheduleVisitCard from './ScheduleVisitCard';
import JobEditDialog from './JobEditDialog';
import EndJobMenu from './EndJobMenu';
import OfficeReportDialog, { officeReportTargets, type OfficeReportTargets } from './OfficeReportDialog';
import VisitTechnicianPicker from './VisitTechnicianPicker';
import { activeSelection, splitPrimary } from '../../lib/visitTechnicianSelection';
import ScheduleEditor from './ScheduleEditor';
import JobEditor from './JobEditor';
import JobLifecycleDialog, { type JobLifecycleTransition } from './JobLifecycleDialog';
import CancelWorkDialog from './CancelWorkDialog';
import { describeSchedule, suggestNextDate } from '../../lib/scheduleFormat';
import { getStatusPresentation } from '../../lib/statusPresentation';
import StatusPill from './StatusPill';

interface JobInspectorDrawerProps {
  job: JobRow;
  onClose: () => void;
  /**
   * Forces the "Book a visit" panel open regardless of `job.status` — for
   * callers like the Month Matrix, where a specific month can be honestly
   * due-and-unbooked even while the job's own single, job-level status is
   * something else (e.g. booked from a visit in a different month).
   */
  forceShowBooking?: boolean;
  /** Pre-fills the booking date input — never fabricated by this component itself, only ever passed in by a caller that computed a real, honest date (or left it undefined for the normal today-default). */
  presetVisitDate?: string;
  /**
   * Offer the office "Complete & report" / "Write report" on each eligible visit (Schedule only). The dialog opens HERE, at drawer level,
   * locked to that visit - not inside the visit's row, which is rebuilt when a saved visit moves from "Upcoming & open" to "Past".
   */
  allowOfficeReport?: boolean;
  /**
   * "tabbed" (Schedule only): the Visits / Details layout - upcoming visit cards with the main action on the card, a compact Past
   * list, and the job's facts on a second tab. Same state, writes and dialogs as "classic" (every other page); only the layout differs.
   */
  layout?: 'classic' | 'tabbed';
}

/** Past visits shown before "Show all": the latest few are what matters day to day. */
export const PAST_VISITS_SHOWN = 5;

/**
 * The drawer's visit list: "Upcoming & open" (due / booked, soonest first, no date last) and "Past" (completed / missed / cancelled,
 * most recent first). Pure - display order only.
 */
export function groupVisits(visits: JobVisitSummary[]): { open: JobVisitSummary[]; past: JobVisitSummary[] } {
  const isOpen = (v: JobVisitSummary) => v.status === 'due' || v.status === 'booked';
  const open = visits.filter(isOpen).sort((a, b) => (a.scheduledDate ?? '9999-12-31').localeCompare(b.scheduledDate ?? '9999-12-31'));
  const past = visits.filter((v) => !isOpen(v)).sort((a, b) => (b.scheduledDate ?? '').localeCompare(a.scheduledDate ?? ''));
  return { open, past };
}

/**
 * The office report action for one visit, from the dialog's own eligibility (officeReportTargets): "Complete & report" for an eligible
 * due/booked visit, "Write report" for an eligible completed one with no report, the reason when the rules block it, else nothing. Pure.
 */
export function officeReportActionFor(
  targets: OfficeReportTargets,
  visit: JobVisitSummary,
): { label: string } | { blockedReason: string } | undefined {
  if (targets.available.some((a) => a.id === visit.id)) return { label: visit.status === 'completed' ? 'Write report' : 'Complete & report' };
  const blocked = targets.blocked.find((b) => b.visit.id === visit.id);
  return blocked ? { blockedReason: blocked.reason } : undefined;
}

/** Formats today's own LOCAL calendar day — never `.toISOString()` here, which converts to UTC and would shift the date in any timezone ahead of UTC (same fix as scheduleFormat.ts/ThisWeekPage.tsx's toISODate). */
function todayISO(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export default function JobInspectorDrawer({
  job,
  onClose,
  forceShowBooking = false,
  presetVisitDate,
  allowOfficeReport = false,
  layout = 'classic',
}: JobInspectorDrawerProps) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const actor = session?.user.email ?? 'unknown';
  const [revealed, setRevealed] = useState(false);
  const [editingJob, setEditingJob] = useState(false);
  const [lifecycleTransition, setLifecycleTransition] = useState<JobLifecycleTransition | null>(null);
  // "Mark as Cancelled" opens the shared cancellation dialog (this visit / this and future / the entire job), not the lifecycle dialog.
  const [cancelOpen, setCancelOpen] = useState(false);
  // An EMPTY preset is deliberate and distinct from an absent one: it means "this month's date is genuinely not
  // set, choose one". Only an absent preset falls back to today. (`'' ?? x` is `''`, so the empty string survives.)
  const [visitDate, setVisitDate] = useState(presetVisitDate ?? todayISO());
  // Selected technician ids in selection order; the job's default technician (if any) is the initial selection and, being first, the visit's primary.
  const [visitTechnicianIds, setVisitTechnicianIds] = useState<string[]>(job.defaultTechnicianId ? [job.defaultTechnicianId] : []);
  const [bookingMessage, setBookingMessage] = useState<string | null>(null);
  const [showAllPast, setShowAllPast] = useState(false);
  // The visit whose office report dialog is open, and the message once it has finished (Schedule only).
  const [reportVisitId, setReportVisitId] = useState<string | null>(null);
  const [reportNotice, setReportNotice] = useState<string | null>(null);
  // Tabbed layout only. Both tab panels stay mounted (the hidden one only hidden), so switching never loses a half-filled form.
  const [tab, setTab] = useState<'visits' | 'details'>('visits');
  const showBookingByStatus = forceShowBooking || job.status === 'unscheduled' || job.status === 'needs_booking' || job.status === 'overdue';
  // "+ Book a visit" opens the same booking form; it starts open in exactly the cases the classic layout always shows it.
  const [bookingOpen, setBookingOpen] = useState(showBookingByStatus);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  // "Copied" / "Couldn't copy" after the job ID chip is pressed; clears itself after a moment.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<number | undefined>(undefined);
  const copyJobId = () => {
    const show = (state: 'copied' | 'failed') => {
      setCopyState(state);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopyState('idle'), 2500);
    };
    if (!navigator.clipboard) return show('failed');
    navigator.clipboard.writeText(job.id).then(() => show('copied'), () => show('failed'));
  };

  const queryClient = useQueryClient();
  const { data: technicians = [] } = useQuery({ queryKey: ['technicians'], queryFn: listTechnicians });
  const activeTechnicians = technicians.filter((t) => t.isActive);

  const assignTechnicianMutation = useMutation({
    mutationFn: (technicianId: string | null) => assignJobTechnician(job.id, technicianId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobRows'] }),
  });

  const bookVisitMutation = useMutation({
    mutationFn: () => {
      const { primaryId, additionalIds } = splitPrimary(activeSelection(visitTechnicianIds, technicians));
      return createVisit(job.id, primaryId, visitDate, additionalIds);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
      setBookingMessage(`Visit booked for ${new Date(visitDate).toLocaleDateString('en-GB')}.`);
      // Reset the form's own inputs after a successful booking — matching
      // ScheduleDayDrawer.tsx's own booking form, which resets its fields
      // rather than closing after success. Blanking the date (rather than
      // re-defaulting to today) also disables the "Book this visit" button
      // (disabled={!visitDate || ...}) until a new date is deliberately
      // chosen, so an accidental second click can't silently resubmit the
      // same booking again.
      setVisitDate('');
      setVisitTechnicianIds(job.defaultTechnicianId ? [job.defaultTechnicianId] : []);
    },
    onError: (err) => setBookingMessage(err instanceof Error ? err.message : 'Failed to book visit.'),
  });

  const suggestedDate = job.schedule ? suggestNextDate(job.schedule, todayISO()) : null;
  const visitGroups = groupVisits(job.visits);
  // Eligibility is the dialog's own rule (officeReportTargets) - the button shows only where the dialog will accept the visit.
  const officeTargets = allowOfficeReport ? officeReportTargets(job, todayISO()) : null;
  const officeReportFor = (v: JobVisitSummary) => {
    const action = officeTargets ? officeReportActionFor(officeTargets, v) : undefined;
    return action && 'label' in action ? { ...action, onOpen: () => setReportVisitId(v.id) } : action;
  };

  // The booking form's contents, shared by both layouts (each frames it its own way).
  const bookingBody = (
    <>
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
      {!visitDate && (
        <div className="text-[11.5px] text-due-fg" data-testid="no-set-date-hint">
          This job has no set date for this month — choose one.
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
      <VisitTechnicianPicker technicians={technicians} selectedIds={visitTechnicianIds} onChange={setVisitTechnicianIds} />
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
    </>
  );

  const facts: [string, string][] = [
    ['Client', job.clientName],
    ['Invoice address', job.clientInvoiceAddress ? job.clientInvoiceAddress.split(',')[0] : '—'],
    ['Price per visit', job.pricePerVisit == null ? 'Variable' : `£${job.pricePerVisit.toLocaleString('en-GB')}.00`],
    [
      'Price per month',
      job.monthlyValue ? `£${job.monthlyValue.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'On request',
    ],
    ['Contract per year', job.yearlyValue ? `£${job.yearlyValue.toLocaleString('en-GB')}.00` : 'On request'],
    ['Next visit', job.nextDueLabel],
  ];

  const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const priceTiles: [string, string][] = [
    ['Per visit', job.pricePerVisit == null ? 'Variable' : money(job.pricePerVisit)],
    ['Per month', job.monthlyValue ? money(job.monthlyValue) : 'On request'],
    ['Per year', job.yearlyValue ? money(job.yearlyValue) : 'On request'],
  ];
  const shortJobId = job.id.replace(/-/g, '').slice(0, 8).toUpperCase();
  const sectionHeading = 'font-heading text-[11px] font-semibold tracking-[0.14em] text-neutral-600 uppercase';
  const pastShown = showAllPast ? visitGroups.past : visitGroups.past.slice(0, PAST_VISITS_SHOWN);
  const tabs = [
    { id: 'visits' as const, label: 'Visits' },
    { id: 'details' as const, label: 'Details' },
  ];

  const tabbedContent = (
    <>
      <div className="px-5 pt-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            title={`Copy job ID ${job.id}`}
            aria-label={`Copy job ID ${shortJobId}`}
            onClick={copyJobId}
            className="cursor-pointer rounded-md border border-neutral-300 px-2 py-0.5 font-heading text-[10.5px] font-semibold tracking-[0.12em] text-neutral-600 uppercase hover:bg-neutral-100"
          >
            Job · {shortJobId}
            {copyState !== 'idle' && (
              <span aria-hidden className={`ml-1.5 normal-case tracking-normal ${copyState === 'copied' ? 'text-done-fg' : 'text-missed-fg'}`}>
                {copyState === 'copied' ? 'Copied' : 'Couldn’t copy'}
              </span>
            )}
          </button>
          {/* Always mounted, so screen readers announce the change when the text appears. */}
          <span role="status" aria-live="polite" className="sr-only" data-testid="copy-job-id-status">
            {copyState === 'copied' ? 'Job ID copied' : copyState === 'failed' ? 'Couldn’t copy the job ID' : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close job details"
            className="ml-auto flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-lg text-neutral-500 hover:bg-neutral-100 hover:text-ink"
          >
            ✕
          </button>
        </div>
        <h2 className="mt-2 font-heading text-2xl leading-tight font-bold text-ink">{job.jobSummary}</h2>
        <div className="mt-1 text-[13px] leading-snug text-neutral-600" data-testid="drawer-subtitle">
          <button
            type="button"
            onClick={() => navigate(`/buildings/${job.buildingId}`)}
            className="cursor-pointer font-semibold text-teal-700 hover:underline"
          >
            {job.buildingName}
          </button>
          {[job.street, job.postcode].filter(Boolean).join(', ') && (
            <span> · {[job.street, job.postcode].filter(Boolean).join(', ')}</span>
          )}
        </div>
        <div className="mt-0.5 text-[13px] text-neutral-600" data-testid="drawer-meta">
          {[job.division, job.frequency, job.pricePerVisit == null ? 'Variable price' : `£${job.pricePerVisit.toLocaleString('en-GB')} per visit`].join(' · ')}
        </div>

        <div
          role="tablist"
          aria-label="Job details sections"
          className="mt-4 flex gap-5 border-b border-divider"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const next = tab === 'visits' ? 'details' : 'visits';
            setTab(next);
            document.getElementById(`job-drawer-tab-${next}`)?.focus();
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`job-drawer-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`job-drawer-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={`-mb-px h-10 cursor-pointer border-b-2 text-[14px] ${
                tab === t.id ? 'border-teal font-semibold text-ink' : 'border-transparent text-neutral-500 hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div
        role="tabpanel"
        id="job-drawer-panel-visits"
        aria-labelledby="job-drawer-tab-visits"
        hidden={tab !== 'visits'}
        className="px-5 pt-4 pb-6"
        data-testid="drawer-visits"
      >
        {reportNotice && (
          <div role="status" data-testid="drawer-office-report-notice" className="mb-3 flex items-start gap-2 rounded-md border border-teal-700/40 bg-teal-100/60 px-2.5 py-1.5 text-[12px] text-teal-700">
            <span className="flex-1">{reportNotice}</span>
            <button type="button" onClick={() => setReportNotice(null)} aria-label="Dismiss" className="cursor-pointer leading-none hover:text-ink">
              ×
            </button>
          </div>
        )}

        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className={sectionHeading}>Upcoming · {visitGroups.open.length}</h3>
          <button
            type="button"
            onClick={() => setBookingOpen((o) => !o)}
            aria-expanded={bookingOpen}
            data-testid="drawer-book-visit-toggle"
            className="cursor-pointer rounded-md px-2 py-1 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-100/60"
          >
            {bookingOpen ? 'Close booking' : '+ Book a visit'}
          </button>
        </div>

        {bookingOpen && (
          <div className="mb-3 rounded-md border border-neutral-300 p-3" data-testid="drawer-booking">
            <div className="font-heading text-[11px] font-semibold tracking-[0.11em] text-neutral-700 uppercase">Book a visit</div>
            {bookingBody}
          </div>
        )}

        {visitGroups.open.length === 0 ? (
          <div className="rounded-md border border-dashed border-neutral-300 px-3 py-3 text-[12.5px] text-neutral-500" data-testid="drawer-no-upcoming">
            No upcoming visits.{!bookingOpen && ' Use "Book a visit" to schedule one.'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-neutral-300">
            {visitGroups.open.map((v) => (
              <ScheduleVisitCard key={v.id} job={job} visit={v} actor={actor} technicians={activeTechnicians} variant="upcoming" officeReport={officeReportFor(v)} />
            ))}
          </div>
        )}

        <ScheduleEditor jobId={job.id} schedule={job.schedule} frequencyType={job.frequencyType} />

        <h3 className={`${sectionHeading} mt-5 mb-2`}>Past · {visitGroups.past.length}</h3>
        {visitGroups.past.length === 0 ? (
          <div className="text-[12.5px] text-neutral-500">No past visits yet.</div>
        ) : (
          <>
            <div className="overflow-hidden rounded-md border border-neutral-300">
              {pastShown.map((v) => (
                <ScheduleVisitCard key={v.id} job={job} visit={v} actor={actor} technicians={activeTechnicians} variant="past" officeReport={officeReportFor(v)} />
              ))}
            </div>
            {visitGroups.past.length > PAST_VISITS_SHOWN && (
              <button
                type="button"
                onClick={() => setShowAllPast((x) => !x)}
                className="mt-1.5 cursor-pointer text-[12px] font-semibold text-teal-700 hover:underline"
              >
                {showAllPast ? 'Show fewer past visits' : `Show all ${visitGroups.past.length} past visits`}
              </button>
            )}
          </>
        )}
      </div>

      <div
        role="tabpanel"
        id="job-drawer-panel-details"
        aria-labelledby="job-drawer-tab-details"
        hidden={tab !== 'details'}
        className="px-5 pt-4 pb-6"
        data-testid="drawer-details"
      >
        <div className="grid grid-cols-3 gap-2">
          {priceTiles.map(([label, value]) => (
            <div key={label} className="rounded-md border border-neutral-300 p-3" data-testid="price-tile">
              <div className="text-[12px] text-neutral-600">{label}</div>
              <div className="mt-0.5 text-[17px] font-bold tabular-nums text-ink">{value}</div>
            </div>
          ))}
        </div>

        <dl className="mt-4 grid grid-cols-[auto_1fr] text-[13px]">
          <dt className="border-b border-divider py-2.5 text-neutral-600">Assigned to</dt>
          <dd className="border-b border-divider py-1.5 text-right">
            <select
              aria-label="Assigned technician"
              value={job.defaultTechnicianId ?? ''}
              onChange={(e) => assignTechnicianMutation.mutate(e.target.value || null)}
              disabled={assignTechnicianMutation.isPending}
              className="cursor-pointer rounded-md border border-neutral-300 bg-white px-2 py-1 text-[13px] text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">Unassigned</option>
              {activeTechnicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </dd>
          <dt className="border-b border-divider py-2.5 text-neutral-600">Client</dt>
          <dd className="border-b border-divider py-2.5 pl-4 text-right font-medium text-ink">{job.clientName}</dd>
          <dt className="border-b border-divider py-2.5 text-neutral-600">Invoice address</dt>
          <dd className="border-b border-divider py-2.5 pl-4 text-right text-ink">{job.clientInvoiceAddress || '—'}</dd>
          <dt className="py-2.5 text-neutral-600">Division · frequency</dt>
          <dd className="py-2.5 pl-4 text-right text-ink">
            {job.division} · {job.frequency}
          </dd>
        </dl>

        <section className="mt-4 rounded-md border border-dashed border-neutral-400 bg-neutral-50 p-3.5" data-testid="drawer-access">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[13.5px] font-bold text-ink">
              <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V8a4 4 0 018 0v3" />
              </svg>
              Access details
            </h3>
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              aria-expanded={revealed}
              className="cursor-pointer rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-[12.5px] font-semibold text-teal-700 hover:bg-neutral-100"
            >
              {revealed ? 'Hide' : 'Reveal'}
            </button>
          </div>
          <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
            {revealed ? job.buildingInternalAccessNote || 'No access details recorded.' : 'Internal only. Key safe, keyholder and parking.'}
          </div>
        </section>

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-divider pt-4">
          <button
            type="button"
            onClick={() => setEditDialogOpen(true)}
            className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-neutral-100"
          >
            Edit job
          </button>
          <button
            type="button"
            onClick={() => navigate(`/buildings/${job.buildingId}`)}
            className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-neutral-100"
          >
            Open building file
          </button>
          {job.lifecycleStatus === 'active' && (
            <EndJobMenu
              onSelect={(choice) => {
                // "Cancelled" opens the shared cancellation dialog (this visit / this and future / the entire job), not the lifecycle dialog.
                if (choice === 'cancelled') setCancelOpen(true);
                else setLifecycleTransition(choice);
              }}
            />
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
    <div className="fixed inset-0 z-40 hidden bg-ink/30 lg:block" onClick={onClose} />
    <aside
      {...(layout === 'tabbed'
        ? {
            'aria-label': `Job details: ${job.jobSummary}`,
            'data-testid': 'job-drawer-tabbed',
            className:
              'fixed inset-y-0 right-0 z-50 hidden w-[520px] max-w-full flex-none flex-col overflow-y-auto border-l border-divider bg-white shadow-xl lg:flex',
          }
        : { className: 'fixed inset-y-0 right-0 z-50 hidden w-[440px] flex-none flex-col overflow-y-auto border-l border-divider bg-white shadow-xl lg:flex' })}
    >
    {layout === 'tabbed' ? tabbedContent : (
    <>
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

      {showBookingByStatus && (
        <div className="m-3.5 border border-neutral-300 p-3">
          <div className="font-heading text-[11px] font-semibold tracking-[0.11em] text-neutral-700 uppercase">
            Book a visit
          </div>
          {bookingBody}
        </div>
      )}

      <div className="px-4 pt-3.5">
        <div className="flex justify-between gap-3 border-b border-divider py-1.5 text-[12.5px]">
          <span className="text-neutral-600">Assigned</span>
          <select
            value={job.defaultTechnicianId ?? ''}
            onChange={(e) => assignTechnicianMutation.mutate(e.target.value || null)}
            disabled={assignTechnicianMutation.isPending}
            className="cursor-pointer border-0 bg-transparent text-right text-[12.5px] text-ink outline-none"
          >
            <option value="">Unassigned</option>
            {activeTechnicians.map((t) => (
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

      <ScheduleEditor jobId={job.id} schedule={job.schedule} frequencyType={job.frequencyType} />

      {reportNotice && (
        <div role="status" data-testid="drawer-office-report-notice" className="mx-4 mt-3 flex items-start gap-2 border border-teal-700/40 bg-teal-100/60 px-2.5 py-1.5 text-[11.5px] text-teal-700">
          <span className="flex-1">{reportNotice}</span>
          <button type="button" onClick={() => setReportNotice(null)} aria-label="Dismiss" className="cursor-pointer leading-none hover:text-ink">
            ×
          </button>
        </div>
      )}

      {job.visits.length === 0 ? (
        <div className="px-4 pb-1">
          <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
            Visits (0)
          </div>
          <div className="pb-2 text-[12.5px] text-neutral-500">
            No visits scheduled for this job yet.
            {(forceShowBooking || job.status === 'unscheduled' || job.status === 'needs_booking') &&
              ' Use "Book a visit" above to schedule one.'}
          </div>
        </div>
      ) : (
        <div className="px-4 pb-1" data-testid="drawer-visits">
          <div className="mb-1 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
            Visits ({job.visits.length})
          </div>
          {visitGroups.open.length > 0 && (
            <>
              <div className="mt-1.5 font-heading text-[9.5px] font-semibold tracking-[0.14em] text-neutral-500 uppercase">Upcoming &amp; open</div>
              {visitGroups.open.map((v, index) => (
                <VisitRow key={v.id} job={job} visit={v} actor={actor} technicians={activeTechnicians} initiallyExpanded={index === 0} officeReport={officeReportFor(v)} />
              ))}
            </>
          )}
          {visitGroups.past.length > 0 && (
            <>
              <div className="mt-2.5 font-heading text-[9.5px] font-semibold tracking-[0.14em] text-neutral-500 uppercase">Past</div>
              {(showAllPast ? visitGroups.past : visitGroups.past.slice(0, PAST_VISITS_SHOWN)).map((v) => (
                <VisitRow key={v.id} job={job} visit={v} actor={actor} technicians={activeTechnicians} officeReport={officeReportFor(v)} />
              ))}
              {visitGroups.past.length > PAST_VISITS_SHOWN && (
                <button
                  type="button"
                  onClick={() => setShowAllPast((x) => !x)}
                  className="mt-1 cursor-pointer text-[11.5px] text-teal-700 hover:underline"
                >
                  {showAllPast ? 'Show fewer past visits' : `Show all ${visitGroups.past.length} past visits`}
                </button>
              )}
            </>
          )}
        </div>
      )}

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

      {job.lifecycleStatus === 'active' && (
        <div className="m-3.5 border border-neutral-400 p-3">
          <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
            Job status
          </div>
          <div className="mt-1 text-[12px] leading-snug text-neutral-600">
            Move this job out of the active workflow and into Historical Jobs.
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => setLifecycleTransition('completed')}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100"
            >
              Mark as Completed
            </button>
            <button
              onClick={() => setLifecycleTransition('lost')}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100"
            >
              Mark as Lost
            </button>
            <button
              onClick={() => setCancelOpen(true)}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100"
            >
              Mark as Cancelled
            </button>
          </div>
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
      </div>
    </>
    )}
    </aside>
    {editDialogOpen && <JobEditDialog job={job} onClose={() => setEditDialogOpen(false)} />}
    {reportVisitId && (
      <OfficeReportDialog
        key={reportVisitId}
        job={job}
        visitId={reportVisitId}
        actor={actor}
        userId={session?.user.id ?? null}
        onClose={() => setReportVisitId(null)}
        onCompleted={(message) => {
          setReportVisitId(null);
          setReportNotice(message);
        }}
      />
    )}
    {cancelOpen && (
      <CancelWorkDialog
        job={job}
        visit={null}
        onClose={() => setCancelOpen(false)}
        onDone={(result) => {
          setCancelOpen(false);
          // The job has just left the active dataset, so the drawer showing it closes (same as the other status changes).
          if (result.lifecycleStatus === 'cancelled') onClose();
        }}
      />
    )}
    {lifecycleTransition && (
      <JobLifecycleDialog
        job={job}
        transition={lifecycleTransition}
        onClose={() => setLifecycleTransition(null)}
        onSuccess={() => {
          setLifecycleTransition(null);
          onClose();
        }}
      />
    )}
    </>
  );
}
