import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { JobRow, JobVisitSummary, Technician } from '../../domain/types';
import { getReportReviewStatusPresentation, getVisitStatusPresentation, isReportDelivered } from '../../lib/statusPresentation';
import { isVisitInReviewQueue } from '../../lib/queueJobs';
import StatusPill from './StatusPill';
import CancelWorkDialog from './CancelWorkDialog';
import CompleteVisitForm from './CompleteVisitForm';
import { useVisitManagement } from './useVisitManagement';

interface ScheduleVisitCardProps {
  job: JobRow;
  visit: JobVisitSummary;
  actor: string;
  technicians: Technician[];
  /** "upcoming": a due/booked visit card; "past": a compact completed/missed/cancelled row. */
  variant: 'upcoming' | 'past';
  /** Same contract as VisitRow's: the drawer decides eligibility (officeReportTargets) and opens the dialog itself. */
  officeReport?: { label: string; onOpen: () => void } | { blockedReason: string };
  /** Start with the chevron area open. Collapsed by default. */
  initiallyExpanded?: boolean;
}

/**
 * Where a visit's report is looked at from the Schedule drawer: Review (awaiting review or returned - Report review opens on it)
 * or View (approved - Ready for client, on its "Sent or completed" list once delivered). Null when there is nothing to open. Pure.
 */
export function reportLinkFor(visit: JobVisitSummary): { label: 'Review' | 'View'; to: string } | null {
  if (!visit.reportId) return null;
  if (isVisitInReviewQueue(visit)) return { label: 'Review', to: `/report-review?report=${visit.reportId}` };
  if (visit.reportReviewStatus === 'approved') {
    return {
      label: 'View',
      to: isReportDelivered(visit) ? `/ready-for-client?view=delivered&visit=${visit.id}` : `/ready-for-client?visit=${visit.id}`,
    };
  }
  return null;
}

/** Today's LOCAL calendar day as YYYY-MM-DD (never toISOString, which is UTC). */
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "MO" from "Mo", "JS" from "Jane Smith". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const fieldClass =
  'w-full cursor-pointer rounded-md border border-neutral-300 bg-white px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400';

/**
 * One visit in the Schedule drawer's Visits tab. Shares every write, lock and rule with VisitRow through useVisitManagement -
 * only the layout differs: the main action (Complete & report / Write report / Review / View) is on the card, everything else
 * (date, technicians, complete without report, missed, cancel) sits behind the chevron.
 */
export default function ScheduleVisitCard({ job, visit, actor, technicians, variant, officeReport, initiallyExpanded = false }: ScheduleVisitCardProps) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [mode, setMode] = useState<'summary' | 'complete'>('summary');
  const [cancelOpen, setCancelOpen] = useState(false);
  const {
    rescheduleMutation,
    assignTechnicianMutation,
    addTechnicianMutation,
    removeTechnicianMutation,
    missedMutation,
    dateError,
    setDateError,
    assignError,
    extraError,
    officeAuthor,
    additionalTechnicians,
    extrasLocked,
    extrasLockedReason,
    showExtras,
    addableTechnicians,
    primaryOptions,
    isOpen,
    technicianLocked,
  } = useVisitManagement({ visit, actor, technicians });

  const date = visit.scheduledDate ? new Date(visit.scheduledDate) : null;
  const dateLabel = date
    ? date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : 'No date set';
  // For screen readers: each visit's buttons name their visit ("Review report — 23 Nov 2026"), so a list of them is not a list of "Review".
  const shortDate = date ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'no date set';
  // A due/booked visit whose date has passed - the job's "Overdue" status, shown on the visit it comes from.
  const overdue = isOpen && visit.scheduledDate != null && visit.scheduledDate < todayISO();
  const technicianLabel = `${visit.technicianName ?? 'Unassigned'}${additionalTechnicians.length > 0 ? ` + ${additionalTechnicians.length}` : ''}`;
  const visitStatus = getVisitStatusPresentation(visit.status);
  const reportLink = reportLinkFor(visit);
  const officeAction = officeReport && 'onOpen' in officeReport ? officeReport : null;
  const blockedReason = officeReport && 'blockedReason' in officeReport ? officeReport.blockedReason : null;
  // A past visit only has something behind the chevron when there is a price, someone else to manage, or who wrote the report.
  const hasPastDetails =
    visit.priceCharged != null || (showExtras && (additionalTechnicians.length > 0 || !extrasLocked)) || (visit.reportId != null && officeAuthor != null);
  const canExpand = variant === 'upcoming' || hasPastDetails;

  const extras = showExtras && (additionalTechnicians.length > 0 || !extrasLocked) && (
    <div className="mt-2.5">
      <div className="text-[11px] text-neutral-600">Also on this visit</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px]">
        {additionalTechnicians.map((t) => {
          const locked = t.contribution !== 'pending';
          return (
            <span key={t.technicianId} className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-1.5 py-0.5 text-ink">
              {t.name}
              {t.contribution === 'submitted' && <span className="text-done-fg">· submitted</span>}
              {t.contribution === 'waived' && <span className="text-neutral-500">· waived</span>}
              <button
                type="button"
                onClick={() => removeTechnicianMutation.mutate(t.technicianId)}
                disabled={locked || removeTechnicianMutation.isPending}
                title={locked ? "Can't be removed — they have already contributed to (or been waived from) this report." : `Remove ${t.name} from this visit`}
                aria-label={`Remove ${t.name}`}
                className="cursor-pointer text-neutral-500 hover:text-missed-fg disabled:cursor-not-allowed disabled:text-neutral-300"
              >
                ×
              </button>
            </span>
          );
        })}
        {!extrasLocked && (
          <select
            value=""
            onChange={(e) => e.target.value && addTechnicianMutation.mutate(e.target.value)}
            disabled={addTechnicianMutation.isPending || addableTechnicians.length === 0}
            aria-label="Add another technician to this visit"
            className="cursor-pointer rounded-md border border-dashed border-neutral-400 bg-white px-2 py-0.5 text-[11.5px] text-teal-700 outline-none focus:border-teal disabled:cursor-not-allowed disabled:text-neutral-400"
          >
            <option value="">{addableTechnicians.length === 0 ? 'No one else to add' : '+ Add another technician'}</option>
            {addableTechnicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {extrasLocked && <span className="text-neutral-500">{extrasLockedReason} Additional technicians can't be added.</span>}
        {(addTechnicianMutation.isPending || removeTechnicianMutation.isPending) && <span className="text-neutral-500">Saving…</span>}
        {extraError && <span className="text-missed-fg">{extraError}</span>}
      </div>
    </div>
  );

  return (
    <div className="border-b border-divider last:border-b-0" data-testid={`schedule-visit-${variant}`}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        {variant === 'upcoming' && (
          <div aria-hidden className="flex w-[46px] flex-none flex-col items-center rounded-md border border-neutral-300 py-1 leading-none">
            <span className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-600 uppercase">
              {date ? date.toLocaleDateString('en-GB', { weekday: 'short' }) : '—'}
            </span>
            <span className="mt-1 text-[18px] font-bold tabular-nums text-ink">{date ? date.getDate() : '?'}</span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold tabular-nums text-ink">{dateLabel}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-neutral-600">
            {variant === 'upcoming' && visit.technicianName && (
              <span aria-hidden className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-teal-100 text-[9.5px] font-bold text-teal-700">
                {initials(visit.technicianName)}
              </span>
            )}
            <span className="truncate" title={technicianLabel}>
              {technicianLabel}
            </span>
            <span aria-hidden>·</span>
            <span data-testid="schedule-visit-status" className="flex-none">
              <StatusPill presentation={visitStatus} />
            </span>
            {overdue && (
              <span data-testid="visit-overdue" className="flex-none font-heading text-[11px] font-semibold tracking-[0.07em] text-missed-fg uppercase">
                · Overdue
              </span>
            )}
          </div>
        </div>
        {visit.reportId && visit.reportReviewStatus && (
          <span data-testid="visit-report-status" className="flex-none rounded-md border border-neutral-300 px-1.5 py-0.5">
            <StatusPill presentation={getReportReviewStatusPresentation(visit.reportReviewStatus)} />
          </span>
        )}
        {visit.status === 'completed' && !visit.reportId && !officeAction && (
          <span data-testid="visit-no-report" className="flex-none text-[11.5px] text-neutral-500">
            No report
          </span>
        )}
        {officeAction && mode === 'summary' && (
          <button
            type="button"
            onClick={officeAction.onOpen}
            aria-label={`${officeAction.label} — ${shortDate}`}
            data-testid="visit-office-report"
            className="flex-none cursor-pointer rounded-md bg-teal px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-teal-700"
          >
            {officeAction.label}
          </button>
        )}
        {reportLink && (
          <button
            type="button"
            onClick={() => navigate(reportLink.to)}
            aria-label={`${reportLink.label} report — ${shortDate}`}
            data-testid="visit-report-link"
            className="min-w-[52px] flex-none cursor-pointer text-right text-[12.5px] font-semibold text-teal-700 hover:underline"
          >
            {reportLink.label}
          </button>
        )}
        {canExpand && mode === 'summary' && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : variant === 'upcoming' ? 'Edit' : 'Show'} visit on ${dateLabel}`}
            className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-md border border-neutral-300 text-neutral-600 hover:bg-neutral-100"
          >
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>

      {blockedReason && mode === 'summary' && (
        <div className="-mt-1 px-3 pb-2 text-[11.5px] text-neutral-500" data-testid="visit-office-report-blocked">
          Complete &amp; report isn’t available: {blockedReason}
        </div>
      )}

      {expanded && mode === 'summary' && (
        <div className="border-t border-divider bg-neutral-50 px-3 py-3 text-[12.5px]" data-testid="visit-details">
          {visit.priceCharged != null && (
            <div className="text-[11.5px] text-neutral-600">Price charged: £{visit.priceCharged.toLocaleString('en-GB')}</div>
          )}

          {isOpen && mode === 'summary' && (
            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                Date
                <input
                  type="date"
                  value={visit.scheduledDate ?? ''}
                  onChange={(e) => {
                    if (!e.target.value) return; // cleared, not a valid date to save
                    setDateError(null);
                    rescheduleMutation.mutate(e.target.value);
                  }}
                  disabled={rescheduleMutation.isPending}
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                Technician
                <select
                  value={visit.technicianId ?? ''}
                  onChange={(e) => assignTechnicianMutation.mutate(e.target.value || null)}
                  disabled={assignTechnicianMutation.isPending || technicianLocked}
                  title={technicianLocked ? "Can't be changed — a report has already been submitted for this visit." : undefined}
                  className={fieldClass}
                >
                  <option value="">Unassigned</option>
                  {primaryOptions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              {(rescheduleMutation.isPending || assignTechnicianMutation.isPending) && (
                <span className="col-span-2 text-[11px] text-neutral-500">Saving…</span>
              )}
              {dateError && <span className="col-span-2 text-[11px] text-missed-fg">{dateError}</span>}
              {assignError && <span className="col-span-2 text-[11px] text-missed-fg">{assignError}</span>}
              {technicianLocked && (
                <span className="col-span-2 text-[11px] text-neutral-500">A report has been submitted — technician can't be changed.</span>
              )}
            </div>
          )}

          {mode === 'summary' && extras}

          {isOpen && mode === 'summary' && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-divider pt-2.5 text-[12px]">
              <button type="button" onClick={() => setMode('complete')} className="cursor-pointer font-semibold text-teal-700 hover:underline">
                Complete without report
              </button>
              <button
                type="button"
                onClick={() => missedMutation.mutate()}
                disabled={missedMutation.isPending}
                className="cursor-pointer font-semibold text-neutral-700 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
              >
                Mark missed
              </button>
              <button type="button" onClick={() => setCancelOpen(true)} className="cursor-pointer font-semibold text-missed-fg hover:underline">
                Cancel visit
              </button>
            </div>
          )}

          {visit.reportId && officeAuthor && (
            <div className="mt-2 text-[11.5px] text-neutral-600">
              Report: <span data-testid="office-author">{officeAuthor}</span>
            </div>
          )}
        </div>
      )}

      {/* Outside the chevron area on purpose: while it is open the chevron is hidden, so the form can't be collapsed out of sight. */}
      {mode === 'complete' && (
        <div className="border-t border-divider bg-neutral-50 px-3 py-3" data-testid="visit-complete-form">
          <CompleteVisitForm job={job} visit={visit} actor={actor} onDone={() => setMode('summary')} onCancel={() => setMode('summary')} />
        </div>
      )}

      {cancelOpen && (
        <CancelWorkDialog job={job} visit={visit} onClose={() => setCancelOpen(false)} onDone={() => setCancelOpen(false)} />
      )}
    </div>
  );
}
