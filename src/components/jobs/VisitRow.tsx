import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary, Technician } from '../../domain/types';
import { completeVisit, createReport, markVisitCancelled, markVisitMissed } from '../../repository/reportsRepository';
import { assignVisitTechnician, rescheduleVisit } from '../../repository/techniciansRepository';
import { getReportReviewStatusPresentation, getVisitStatusPresentation } from '../../lib/statusPresentation';
import StatusPill from './StatusPill';

function nowLocalDateTime(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function invalidateAfterVisitChange(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  queryClient.invalidateQueries({ queryKey: ['visits'] });
}

interface VisitRowProps {
  job: JobRow;
  visit: JobVisitSummary;
  actor: string;
  /** Active technicians selectable for (re)assignment — the same list callers already fetch via listTechnicians()/['technicians']. */
  technicians: Technician[];
}

export default function VisitRow({ job, visit, actor, technicians }: VisitRowProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'summary' | 'complete' | 'report'>('summary');
  const [price, setPrice] = useState(job.pricePerVisit != null ? String(job.pricePerVisit) : '');
  const [completedAt, setCompletedAt] = useState(nowLocalDateTime());
  const [error, setError] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);

  /**
   * Manually moves THIS visit to a specific date — the exact same
   * rescheduleVisit() drag-and-drop already uses in Day/Week/Month
   * (touches only scheduled_date, never technician_id/job_id/status), so a
   * visit can be moved to a date outside whatever range is currently
   * visible on the calendar without needing to drag it there. Never
   * touches jobs/schedules — the job's own recurrence definition is
   * completely unaffected by moving one of its visits.
   */
  const rescheduleMutation = useMutation({
    mutationFn: (date: string) => rescheduleVisit(visit.id, date),
    onSuccess: () => {
      invalidateAfterVisitChange(queryClient);
      setDateError(null);
    },
    onError: (err) => setDateError(err instanceof Error ? err.message : 'Failed to reschedule visit.'),
  });

  /**
   * Assigns/reassigns/clears THIS visit's own technician_id only — never
   * jobs.default_technician_id (see assignVisitTechnician's own doc comment).
   * Reuses the same invalidation pair every other visit mutation in this
   * file already uses, so Day/Week/Month/All Live Jobs all pick up the new
   * technician the same way they already pick up a reschedule.
   */
  const assignTechnicianMutation = useMutation({
    mutationFn: (technicianId: string | null) => assignVisitTechnician(visit.id, technicianId),
    onSuccess: () => {
      invalidateAfterVisitChange(queryClient);
      setAssignError(null);
    },
    onError: (err) => setAssignError(err instanceof Error ? err.message : 'Failed to assign technician.'),
  });

  const completeMutation = useMutation({
    mutationFn: () => completeVisit(visit.id, Number(price), new Date(completedAt).toISOString(), actor),
    onSuccess: () => {
      invalidateAfterVisitChange(queryClient);
      setMode('summary');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to mark complete.'),
  });

  const missedMutation = useMutation({
    mutationFn: () => markVisitMissed(visit.id, actor),
    onSuccess: () => invalidateAfterVisitChange(queryClient),
  });

  const cancelledMutation = useMutation({
    mutationFn: () => markVisitCancelled(visit.id, actor),
    onSuccess: () => invalidateAfterVisitChange(queryClient),
  });

  const dateLabel = visit.scheduledDate ? new Date(visit.scheduledDate).toLocaleDateString('en-GB') : 'No date set';

  return (
    <div className="border-b border-divider py-1.5 text-[12.5px]">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5">
          <StatusPill presentation={getVisitStatusPresentation(visit.status)} />
          <span className="text-neutral-500"> · {visit.technicianName ?? 'Unassigned'}</span>
          {visit.priceCharged != null && (
            <span className="text-neutral-500"> · £{visit.priceCharged.toLocaleString('en-GB')}</span>
          )}
        </span>
        <span className="tabular-nums text-neutral-600">{dateLabel}</span>
      </div>

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
              {technicians.map((t) => (
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

      {(visit.status === 'due' || visit.status === 'booked') && mode === 'summary' && (
        <div className="mt-1 flex gap-2">
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
            onClick={() => cancelledMutation.mutate()}
            disabled={cancelledMutation.isPending}
            className="cursor-pointer text-[11px] text-neutral-500 hover:underline"
          >
            Mark cancelled
          </button>
        </div>
      )}

      {mode === 'complete' && (
        <div className="mt-2 flex flex-col gap-1.5 border border-neutral-300 bg-neutral-100 p-2.5">
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Price charged {job.pricePerVisit == null && <span className="text-due-fg">(variable job — enter actual amount)</span>}
            <input
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Completed at
            <input
              type="datetime-local"
              value={completedAt}
              onChange={(e) => setCompletedAt(e.target.value)}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          {error && <div className="text-[11px] text-missed-fg">{error}</div>}
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                if (!price) {
                  setError('Enter a price charged.');
                  return;
                }
                completeMutation.mutate();
              }}
              disabled={completeMutation.isPending}
              className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
            >
              {completeMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setMode('summary')} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600">
              Cancel
            </button>
          </div>
        </div>
      )}

      {visit.status === 'completed' && !visit.reportId && mode === 'summary' && (
        <div className="mt-1">
          <button onClick={() => setMode('report')} className="cursor-pointer text-[11px] text-teal-700 hover:underline">
            Create report
          </button>
        </div>
      )}
      {mode === 'report' && !visit.reportId && (
        <CreateReportForm
          visitId={visit.id}
          actor={actor}
          onDone={() => {
            invalidateAfterVisitChange(queryClient);
            setMode('summary');
          }}
          onCancel={() => setMode('summary')}
        />
      )}

      {/*
        A lightweight status line only — no photos, work-carried-out,
        notes, or approve/return actions here. Full report inspection and
        approval now lives exclusively in Report Review
        (ReportReviewPage.tsx/ReportPanel.tsx); invoicing/sending live in
        Ready for Accounts/Ready for Client. This drawer stays a job/visit
        management panel, not a second place to review or act on a report.
      */}
      {visit.reportId && visit.reportReviewStatus && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-600">
          Report:
          <StatusPill presentation={getReportReviewStatusPresentation(visit.reportReviewStatus)} />
        </div>
      )}
    </div>
  );
}

interface CreateReportFormProps {
  visitId: string;
  actor: string;
  onDone: () => void;
  onCancel: () => void;
}

function CreateReportForm({ visitId, actor, onDone, onCancel }: CreateReportFormProps) {
  const [workCarriedOut, setWorkCarriedOut] = useState('');
  const [technicianNotes, setTechnicianNotes] = useState('');
  const [issues, setIssues] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createReport(visitId, actor, {
        workCarriedOut: workCarriedOut || null,
        technicianNotes: technicianNotes || null,
        issues: issues || null,
        onSiteStart: null,
        onSiteEnd: null,
        includePhotos: true,
        includeNotes: true,
        includeIssues: true,
        includePrice: false,
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create report.'),
  });

  return (
    <div className="mt-2 flex flex-col gap-1.5 border border-neutral-300 bg-neutral-100 p-2.5">
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Work carried out
        <textarea
          value={workCarriedOut}
          onChange={(e) => setWorkCarriedOut(e.target.value)}
          rows={2}
          className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Notes
        <textarea
          value={technicianNotes}
          onChange={(e) => setTechnicianNotes(e.target.value)}
          rows={2}
          className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Issues
        <textarea
          value={issues}
          onChange={(e) => setIssues(e.target.value)}
          rows={2}
          className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
        />
      </label>
      <div className="text-[11px] text-neutral-500">No photos on this visit yet.</div>
      {error && <div className="text-[11px] text-missed-fg">{error}</div>}
      <div className="flex gap-1.5">
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
        >
          {createMutation.isPending ? 'Saving…' : 'Save report'}
        </button>
        <button onClick={onCancel} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600">
          Cancel
        </button>
      </div>
    </div>
  );
}

