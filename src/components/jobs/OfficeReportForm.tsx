import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { JobRow, JobVisitSummary } from '../../domain/types';
import { FIELD_LABEL } from '../../lib/reportTextAutosave';
import { officeReportFormError, technicianLockoutWarning, type OfficeReportInput } from '../../repository/officeReportsRepository';

const pad = (n: number) => String(n).padStart(2, '0');
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localNowTime(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** A local date + time as an ISO instant (null when either is empty). */
function at(date: string, time: string): string | null {
  return date && time ? new Date(`${date}T${time}`).toISOString() : null;
}
function defaultDateFor(visit: JobVisitSummary | null, today: string): string {
  return visit?.scheduledDate && visit.scheduledDate <= today ? visit.scheduledDate : today;
}

const input = 'border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500';
const label = 'flex flex-col gap-1 text-[11px] text-neutral-600';

/** A numbered part of the form: "1 Visit", "2 Report", "3 Photos and videos". */
export function FormSection({ n, title, children, testId }: { n: number; title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-2 border-t border-divider pt-3 first:border-t-0 first:pt-0" data-testid={testId}>
      <h3 className="flex items-center gap-2 font-heading text-[11px] font-semibold tracking-[0.12em] text-ink uppercase">
        <span className="flex h-4 w-4 items-center justify-center bg-teal text-[10px] tracking-normal text-white">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

interface OfficeReportFormProps {
  job: JobRow;
  /** The visit to complete and report on - or null to record work already done for a job with no visit for it in JMS. */
  visit: JobVisitSummary | null;
  /** The <form>'s id: the dialog's footer button submits it from outside the scrolling body. */
  formId: string;
  /** Shown first in the Visit section ("Which visit?"). */
  chooser?: ReactNode;
  /** The third section (photos and videos) - owned by the dialog, which adds them once the report is saved. */
  media?: ReactNode;
  /** True while saving and after: the visit and report fields can't change any more (the report is saved once, never twice). */
  locked: boolean;
  /** Run after the form's own checks and before saving (the dialog checks the chosen videos still fit the chosen visit). */
  checkBeforeSave?: () => string | null;
  /**
   * Everything checked: what to send. The DIALOG sends it (with its request id), keeps it, and on an unknown outcome re-sends exactly
   * this - never a re-read of the form.
   */
  onSubmit: (input: Omit<OfficeReportInput, 'requestId'>) => void;
  /** A problem found before sending, to show next to the button. */
  onError: (message: string | null) => void;
}

/**
 * "Complete & write report" - the fields and checks of an office report (one continuous form: the visit, the report, then - from the dialog -
 * photos and videos). It does not send anything itself: once everything checks out it hands the input to the dialog (onSubmit), which saves
 * it in one database call (officeReportsRepository.ts - approved, "written by the office", idempotent per request id) and adds the files.
 */
export default function OfficeReportForm({ job, visit, formId, chooser, media, locked, checkBeforeSave, onSubmit, onError }: OfficeReportFormProps) {
  const today = localToday();
  const alreadyCompleted = visit?.status === 'completed';

  const [date, setDate] = useState(defaultDateFor(visit, today));
  const [time, setTime] = useState(localNowTime());
  const [price, setPrice] = useState(job.pricePerVisit != null ? String(job.pricePerVisit) : '');
  const [workCarriedOut, setWorkCarriedOut] = useState(job.jobSummary ?? '');
  const [technicianNotes, setTechnicianNotes] = useState('');
  const [issues, setIssues] = useState('');
  const [specMet, setSpecMet] = useState(true);
  const [onSiteStart, setOnSiteStart] = useState('');
  const [onSiteEnd, setOnSiteEnd] = useState('');

  // Choosing another visit keeps everything typed, but the date starts from that visit's own date (adjusted while rendering - see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [dateFor, setDateFor] = useState(visit?.id ?? null);
  if ((visit?.id ?? null) !== dateFor) {
    setDateFor(visit?.id ?? null);
    setDate(defaultDateFor(visit, today));
  }

  const warning = visit ? technicianLockoutWarning(visit, today) : null;

  const submit = () => {
    if (locked) return;
    const problem =
      officeReportFormError({
        needsWorkDate: !visit,
        workDate: date,
        completedAt: alreadyCompleted ? null : at(date, time) ?? '',
        price: alreadyCompleted ? '0' : price,
        onSiteStart,
        onSiteEnd,
      }) ?? checkBeforeSave?.() ?? null;
    if (problem) {
      onError(problem);
      return;
    }
    onError(null);
    onSubmit({
      visitId: visit?.id ?? null,
      jobId: visit ? null : job.id,
      workDate: visit ? null : date,
      // An already completed visit keeps its recorded time and price (the database ignores these then).
      completedAt: alreadyCompleted && visit?.completedAt ? visit.completedAt : at(date, time)!,
      priceCharged: alreadyCompleted && visit?.priceCharged != null ? visit.priceCharged : Number(price),
      workCarriedOut: workCarriedOut.trim() || null,
      technicianNotes: technicianNotes.trim() || null,
      issues: issues.trim() || null,
      specMet,
      onSiteStart: at(date, onSiteStart),
      onSiteEnd: at(date, onSiteEnd),
    });
  };

  // Enter in a one-line field must not complete the report by accident - only the button does.
  const noEnterSubmit = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'submit') e.preventDefault();
  };

  return (
    <form
      id={formId}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={noEnterSubmit}
      className="flex flex-col gap-4"
      data-testid="office-report-form"
    >
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-4">
        <FormSection n={1} title="Visit" testId="office-report-section-visit">
          {chooser}
          {warning && (
            <div
              data-testid="office-report-technician-warning"
              className={`border px-2 py-1.5 text-[11px] ${warning.strong ? 'border-missed/50 bg-missed/5 text-missed-fg' : 'border-due/50 bg-due/5 text-due-fg'}`}
            >
              {warning.text}
            </div>
          )}
          {alreadyCompleted ? (
            <div className="text-[11.5px] text-neutral-600">
              Completed {visit?.completedAt ? new Date(visit.completedAt).toLocaleString('en-GB') : ''}
              {visit?.priceCharged != null && ` · £${visit.priceCharged.toLocaleString('en-GB')}`} — kept as recorded.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className={label}>
                {visit ? 'Date done' : 'Date the work was done'}
                <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={input} />
              </label>
              <label className={label}>
                Finished at
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} />
              </label>
              <label className={label}>
                <span>
                  Price charged {job.pricePerVisit == null && <span className="text-due-fg">(variable job — enter actual amount)</span>}
                </span>
                <input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} className={input} />
              </label>
            </div>
          )}
        </FormSection>

        <FormSection n={2} title="Report" testId="office-report-section-report">
          <label className={label}>
            {FIELD_LABEL.workCarriedOut}
            <textarea value={workCarriedOut} onChange={(e) => setWorkCarriedOut(e.target.value)} rows={3} className={input} />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className={label}>
              {FIELD_LABEL.issues}
              <textarea value={issues} onChange={(e) => setIssues(e.target.value)} rows={2} className={input} />
            </label>
            <label className={label}>
              {FIELD_LABEL.technicianNotes}
              <textarea value={technicianNotes} onChange={(e) => setTechnicianNotes(e.target.value)} rows={2} className={input} />
            </label>
          </div>
          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-3">
            <fieldset className="flex flex-col gap-1 text-[11px] text-neutral-600">
              <legend className="mb-1">Specification</legend>
              <label className="flex items-center gap-1">
                <input type="radio" name={`${formId}-spec`} checked={specMet} onChange={() => setSpecMet(true)} /> Everything as specified
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" name={`${formId}-spec`} checked={!specMet} onChange={() => setSpecMet(false)} /> Something not done
              </label>
            </fieldset>
            <label className={label}>
              On site from (optional)
              <input type="time" value={onSiteStart} onChange={(e) => setOnSiteStart(e.target.value)} className={input} />
            </label>
            <label className={label}>
              On site until (optional)
              <input type="time" value={onSiteEnd} onChange={(e) => setOnSiteEnd(e.target.value)} className={input} />
            </label>
          </div>
        </FormSection>
      </fieldset>

      {media && (
        <FormSection n={3} title="Photos and videos" testId="office-report-section-media">
          {media}
        </FormSection>
      )}
    </form>
  );
}
