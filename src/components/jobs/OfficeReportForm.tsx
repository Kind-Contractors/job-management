import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../../domain/types';
import { FIELD_LABEL } from '../../lib/reportTextAutosave';
import {
  completeVisitWithOfficeReport,
  officeReportFormError,
  technicianLockoutWarning,
  type OfficeReportResult,
} from '../../repository/officeReportsRepository';
import ReportPhotos from '../reports/ReportPhotos';
import ReportVideos from '../reports/ReportVideos';

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

const input = 'border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal';
const label = 'flex flex-col gap-1 text-[11px] text-neutral-600';

interface OfficeReportFormProps {
  job: JobRow;
  /** The visit to complete and report on - or null to record work already done for a job with no visit for it in JMS. */
  visit: JobVisitSummary | null;
  /** For the photo/video steps afterwards (the database decides who wrote the report itself). */
  actor: string;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * "Complete & write report" - the office completes a visit and writes its report in one step (one database call, one transaction;
 * see officeReportsRepository.ts). The report is saved already approved and marked "written by the office", so it goes straight to
 * Ready for client and Ready for accounts. Photos and videos are added afterwards with the same sections Report review uses.
 */
export default function OfficeReportForm({ job, visit, actor, onDone, onCancel }: OfficeReportFormProps) {
  const queryClient = useQueryClient();
  const today = localToday();
  const alreadyCompleted = visit?.status === 'completed';
  const defaultDate = visit?.scheduledDate && visit.scheduledDate <= today ? visit.scheduledDate : today;

  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(localNowTime());
  const [price, setPrice] = useState(job.pricePerVisit != null ? String(job.pricePerVisit) : '');
  const [workCarriedOut, setWorkCarriedOut] = useState(job.jobSummary ?? '');
  const [technicianNotes, setTechnicianNotes] = useState('');
  const [issues, setIssues] = useState('');
  const [specMet, setSpecMet] = useState(true);
  const [onSiteStart, setOnSiteStart] = useState('');
  const [onSiteEnd, setOnSiteEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<OfficeReportResult | null>(null);

  const warning = visit ? technicianLockoutWarning(visit, today) : null;

  const saveMutation = useMutation({
    mutationFn: () =>
      completeVisitWithOfficeReport({
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
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      queryClient.invalidateQueries({ queryKey: ['visits'] });
      queryClient.invalidateQueries({ queryKey: ['buildingRows'] });
      setError(null);
      setSaved(result);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The report couldn’t be saved.'),
  });

  if (saved) {
    return (
      <div className="mt-2 flex flex-col gap-2 border border-teal-700/40 bg-teal-100/40 p-2.5" data-testid="office-report-saved">
        <div className="text-[12px] text-teal-700">
          <span className="font-semibold">Saved.</span> The visit is completed and the report is approved — it’s now in Ready for client and
          Ready for accounts.
        </div>
        <div className="text-[11px] text-neutral-600">Add photos or videos if you have them (optional):</div>
        <div className="bg-white">
          <ReportPhotos reportId={saved.reportId} visitId={saved.visitId} completed={false} actor={actor} />
          {/* reviewedAt null: the office adding its own videos just after saving is not "added after approval". */}
          <ReportVideos reportId={saved.reportId} visitId={saved.visitId} reviewStatus="approved" reviewedAt={null} completed={false} actor={actor} />
        </div>
        <div>
          <button onClick={onDone} className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5 border border-neutral-300 bg-neutral-100 p-2.5" data-testid="office-report-form">
      <div className="font-heading text-[10.5px] font-semibold tracking-[0.12em] text-neutral-700 uppercase">
        {visit ? (alreadyCompleted ? 'Write the report' : 'Complete & write report') : 'Record work already done'}
      </div>
      <div className="text-[11px] text-neutral-500">
        Written by the office: saved as approved, so it goes straight to Ready for client and Ready for accounts.
      </div>
      {warning && (
        <div
          data-testid="office-report-technician-warning"
          className={`border px-2 py-1.5 text-[11px] ${warning.strong ? 'border-missed/50 bg-missed/5 text-missed-fg' : 'border-due/50 bg-due/5 text-due-fg'}`}
        >
          {warning.text}
        </div>
      )}

      {alreadyCompleted ? (
        <div className="text-[11px] text-neutral-600">
          Completed {visit?.completedAt ? new Date(visit.completedAt).toLocaleString('en-GB') : ''}
          {visit?.priceCharged != null && ` · £${visit.priceCharged.toLocaleString('en-GB')}`} — kept as recorded.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          <label className={label}>
            {visit ? 'Date done' : 'Date the work was done'}
            <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={input} />
          </label>
          <label className={label}>
            Finished at
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} />
          </label>
          <label className={`${label} col-span-2`}>
            <span>
              Price charged {job.pricePerVisit == null && <span className="text-due-fg">(variable job — enter actual amount)</span>}
            </span>
            <input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} className={input} />
          </label>
        </div>
      )}

      <label className={label}>
        {FIELD_LABEL.workCarriedOut}
        <textarea value={workCarriedOut} onChange={(e) => setWorkCarriedOut(e.target.value)} rows={2} className={input} />
      </label>
      <label className={label}>
        {FIELD_LABEL.issues}
        <textarea value={issues} onChange={(e) => setIssues(e.target.value)} rows={2} className={input} />
      </label>
      <label className={label}>
        {FIELD_LABEL.technicianNotes}
        <textarea value={technicianNotes} onChange={(e) => setTechnicianNotes(e.target.value)} rows={2} className={input} />
      </label>

      <fieldset className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-600">
        <legend className="mb-0.5">Specification</legend>
        <label className="flex items-center gap-1">
          <input type="radio" name="spec" checked={specMet} onChange={() => setSpecMet(true)} /> Everything as specified
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="spec" checked={!specMet} onChange={() => setSpecMet(false)} /> Something not done
        </label>
      </fieldset>

      <div className="grid grid-cols-2 gap-1.5">
        <label className={label}>
          On site from (optional)
          <input type="time" value={onSiteStart} onChange={(e) => setOnSiteStart(e.target.value)} className={input} />
        </label>
        <label className={label}>
          On site until (optional)
          <input type="time" value={onSiteEnd} onChange={(e) => setOnSiteEnd(e.target.value)} className={input} />
        </label>
      </div>

      {error && <div className="text-[11px] text-missed-fg">{error}</div>}
      <div className="flex gap-1.5">
        <button
          onClick={() => {
            const problem = officeReportFormError({
              needsWorkDate: !visit,
              workDate: date,
              completedAt: alreadyCompleted ? null : at(date, time) ?? '',
              price: alreadyCompleted ? '0' : price,
              onSiteStart,
              onSiteEnd,
            });
            if (problem) {
              setError(problem);
              return;
            }
            saveMutation.mutate();
          }}
          disabled={saveMutation.isPending}
          className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save report'}
        </button>
        <button onClick={onCancel} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600">
          Cancel
        </button>
      </div>
    </div>
  );
}
