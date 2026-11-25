import { useState } from 'react';
import type { JobRow, JobVisitSummary, Technician } from '../../domain/types';
import { getReportReviewStatusPresentation, getVisitStatusPresentation } from '../../lib/statusPresentation';
import StatusPill from './StatusPill';
import CancelWorkDialog from './CancelWorkDialog';
import CompleteVisitForm from './CompleteVisitForm';
import { useVisitManagement } from './useVisitManagement';

interface VisitRowProps {
  job: JobRow;
  visit: JobVisitSummary;
  actor: string;
  /** Active technicians selectable for (re)assignment — the same list callers already fetch via listTechnicians()/['technicians']. */
  technicians: Technician[];
  /** Start expanded (the Job Details drawer opens its next open visit this way). Collapsed by default. */
  initiallyExpanded?: boolean;
  /**
   * The office report action for this visit, decided by the drawer from the existing eligibility rules (officeReportTargets):
   * a button ("Complete & report" / "Write report") that asks the DRAWER to open the dialog, or the reason it isn't available.
   * Omitted (every page but Schedule): nothing is shown.
   */
  officeReport?: { label: string; onOpen: () => void } | { blockedReason: string };
}

const officeReportButton = 'cursor-pointer bg-teal px-2 py-0.5 text-[11px] font-semibold text-white hover:opacity-90';

/**
 * One visit in the Job Details drawer: a one-line summary (date, technicians, visit status, report status) that expands to the
 * visit's details and actions - the same controls and safeguards as before, only shown when the visit is expanded.
 */
export default function VisitRow({ job, visit, actor, technicians, initiallyExpanded = false, officeReport }: VisitRowProps) {
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
  } = useVisitManagement({ visit, actor, technicians });

  const dateLabel = visit.scheduledDate
    ? new Date(visit.scheduledDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : 'No date set';
  const technicianLabel = `${visit.technicianName ?? 'Unassigned'}${additionalTechnicians.length > 0 ? ` + ${additionalTechnicians.length}` : ''}`;

  return (
    <div className="border-b border-divider text-[12.5px]" data-testid="visit-row">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-label={`Visit ${dateLabel}, ${technicianLabel}, ${getVisitStatusPresentation(visit.status).label}${expanded ? ' - hide details' : ' - show details'}`}
        className="flex w-full cursor-pointer items-center gap-2 py-1.5 text-left hover:bg-neutral-50"
      >
        <span aria-hidden className={`w-3 flex-none text-[10px] text-neutral-500 transition-transform ${expanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span className="w-[108px] flex-none tabular-nums text-ink">{dateLabel}</span>
        <span className="min-w-0 flex-1 truncate text-neutral-600" title={technicianLabel}>
          {technicianLabel}
        </span>
        <span className="flex flex-none items-center gap-2">
          <StatusPill presentation={getVisitStatusPresentation(visit.status)} />
          {visit.reportId && visit.reportReviewStatus && (
            <span className="border-l border-divider pl-2" data-testid="visit-report-status">
              <StatusPill presentation={getReportReviewStatusPresentation(visit.reportReviewStatus)} />
            </span>
          )}
        </span>
      </button>

      {expanded && (
      <div className="pb-2 pl-5" data-testid="visit-details">
      {visit.priceCharged != null && (
        <div className="text-[11px] text-neutral-600">Price charged: £{visit.priceCharged.toLocaleString('en-GB')}</div>
      )}

      {(visit.status === 'due' || visit.status === 'booked') && mode === 'summary' && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-600">
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
              className="cursor-pointer border border-neutral-300 px-1.5 py-0.5 text-[11px] text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
            />
          </label>
          {rescheduleMutation.isPending && <span className="text-[11px] text-neutral-500">Saving…</span>}
          {dateError && <span className="text-[11px] text-missed-fg">{dateError}</span>}

          <label className="flex items-center gap-1.5 text-[11px] text-neutral-600">
            Technician
            <select
              value={visit.technicianId ?? ''}
              onChange={(e) => assignTechnicianMutation.mutate(e.target.value || null)}
              disabled={assignTechnicianMutation.isPending || visit.reportId != null}
              title={
                visit.reportId != null
                  ? "Can't be changed — a report has already been submitted for this visit."
                  : undefined
              }
              className="cursor-pointer border border-neutral-300 px-1.5 py-0.5 text-[11px] text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
            >
              <option value="">Unassigned</option>
              {primaryOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {assignTechnicianMutation.isPending && <span className="text-[11px] text-neutral-500">Saving…</span>}
          {assignError && <span className="text-[11px] text-missed-fg">{assignError}</span>}
          {/*
            visit.reportId is non-null once a report has been submitted for
            this visit (reports.visit_id is UNIQUE) — every technician-facing
            RPC/Storage ownership check is CURRENT technician_id only, with
            no reassignment history, so changing it after that point would
            let a newly assigned technician read the previous technician's
            already-submitted report/photos. Also enforced at the database
            level (prevent_technician_reassignment_after_report trigger on
            visits) so this can't be bypassed by calling the update directly.
          */}
          {visit.reportId != null && (
            <span className="text-[11px] text-neutral-500">A report has been submitted — technician can't be changed.</span>
          )}
        </div>
      )}

      {showExtras && mode === 'summary' && (additionalTechnicians.length > 0 || !extrasLocked) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-600">
          <span>Also on this visit:</span>
          {additionalTechnicians.length === 0 && <span className="text-neutral-400">nobody else</span>}
          {additionalTechnicians.map((t) => {
            const locked = t.contribution !== 'pending';
            return (
              <span key={t.technicianId} className="inline-flex items-center gap-1 border border-neutral-300 px-1.5 py-0.5 text-ink">
                {t.name}
                {t.contribution === 'submitted' && <span className="text-done-fg">· submitted</span>}
                {t.contribution === 'waived' && <span className="text-neutral-500">· waived</span>}
                <button
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
              className="cursor-pointer border border-neutral-300 px-1.5 py-0.5 text-[11px] text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
            >
              <option value="">{addableTechnicians.length === 0 ? 'No one else to add' : '+ Add technician'}</option>
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
      )}

      {(visit.status === 'due' || visit.status === 'booked') && mode === 'summary' && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {officeReport && 'onOpen' in officeReport && (
            <button type="button" onClick={officeReport.onOpen} className={officeReportButton} data-testid="visit-office-report">
              {officeReport.label}
            </button>
          )}
          <button onClick={() => setMode('complete')} className="cursor-pointer text-[11px] text-teal-700 hover:underline">
            Mark complete
          </button>
          <button
            onClick={() => missedMutation.mutate()}
            disabled={missedMutation.isPending}
            className="cursor-pointer text-[11px] text-missed-fg hover:underline"
          >
            Mark missed
          </button>
          <button
            onClick={() => setCancelOpen(true)}
            className="cursor-pointer text-[11px] text-neutral-500 hover:underline"
          >
            Cancel…
          </button>
        </div>
      )}

      {mode === 'complete' && (
        <CompleteVisitForm job={job} visit={visit} actor={actor} onDone={() => setMode('summary')} onCancel={() => setMode('summary')} />
      )}

      {/* The office writes a missing report with "Complete & report" in All live jobs' Actions column (OfficeReportDialog). */}
      {visit.status === 'completed' && !visit.reportId && mode === 'summary' && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
          No report yet.
          {officeReport && 'onOpen' in officeReport && (
            <button type="button" onClick={officeReport.onOpen} className={officeReportButton} data-testid="visit-office-report">
              {officeReport.label}
            </button>
          )}
        </div>
      )}
      {officeReport && 'blockedReason' in officeReport && mode === 'summary' && (
        <div className="mt-1 text-[11px] text-neutral-500" data-testid="visit-office-report-blocked">
          Complete &amp; report isn’t available: {officeReport.blockedReason}
        </div>
      )}

      {/*
        A lightweight status line only — no photos, work-carried-out,
        notes, or approve/return actions here. Full report inspection and
        approval now lives exclusively in Report Review
        (ReportReviewPage.tsx/ReportPanel.tsx); invoicing/sending live in
        Ready for Accounts/Ready for Client. This drawer stays a job/visit
        management panel, not a second place to review or act on a report.
      */}
      {/* The report's status is already in the row above; here only who wrote it, when the office did. */}
      {visit.reportId && officeAuthor && (
        <div className="mt-1 text-[11px] text-neutral-600">
          Report: <span data-testid="office-author">{officeAuthor}</span>
        </div>
      )}
      </div>
      )}

      {cancelOpen && (
        <CancelWorkDialog job={job} visit={visit} onClose={() => setCancelOpen(false)} onDone={() => setCancelOpen(false)} />
      )}
    </div>
  );
}
