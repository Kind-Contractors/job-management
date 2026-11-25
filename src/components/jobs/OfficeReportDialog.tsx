import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobRow, JobVisitSummary } from '../../domain/types';
import {
  completeVisitWithOfficeReport,
  officeReportBlockedReason,
  OfficeReportOutcomeUnknownError,
  type OfficeReportInput,
  type OfficeReportResult,
} from '../../repository/officeReportsRepository';
import { addReportPhoto, checkPhotoFile, explainPhotoError } from '../../repository/reportPhotosRepository';
import { listVideosForVisit, uploadReportVideo } from '../../repository/reportVideosRepository';
import { checkVideoDuration, explainVideoError } from '../../lib/reportVideoRules';
import { readVideoMetadata } from '../../lib/videoMetadata';
import {
  checkStagedVideo,
  moveTargets,
  pendingMedia,
  stagedVideoProblem,
  uploadStagedMedia,
  type MediaPhase,
  type MediaUploadDeps,
  type StagedMedia,
} from '../../lib/officeReportMedia';
import { getVisitStatusPresentation } from '../../lib/statusPresentation';
import {
  getPendingSubmission,
  mediaEntryOf,
  removePendingSubmission,
  restorePendingMedia,
  savePendingSubmission,
  updatePendingSubmission,
  type KeptLevel,
  type PendingOfficeReport,
} from '../../lib/officeReportPending';
import FormDialog from '../ui/FormDialog';
import OfficeReportForm from './OfficeReportForm';
import OfficeReportMedia from './OfficeReportMedia';

export interface OfficeReportTargets {
  /** Visits the office can complete and write the report for: open (due/booked) ones, and completed ones with no report yet. */
  available: JobVisitSummary[];
  /** Visits that can't be used here, with the reason (more than one technician, on an invoice...). */
  blocked: { visit: JobVisitSummary; reason: string }[];
  /** "Work already done" with no visit in JMS - only for a job that is active or on hold (as the database requires). */
  canRecordNew: boolean;
  /** What is selected when the dialog opens: the earliest open visit due by today, else the earliest available one, else "new". */
  initial: string | null;
}

export const NEW_VISIT = 'new';
const isOpen = (v: JobVisitSummary) => v.status === 'due' || v.status === 'booked';

/** Which visits this job's "Complete & report" can use (the same rules the database enforces - see officeReportBlockedReason). Pure. */
export function officeReportTargets(job: JobRow, today: string): OfficeReportTargets {
  const candidates = job.visits
    .filter((v) => isOpen(v) || (v.status === 'completed' && !v.reportId))
    .sort((a, b) => (a.scheduledDate ?? '9999').localeCompare(b.scheduledDate ?? '9999'));
  const available = candidates.filter((v) => officeReportBlockedReason(v) == null);
  const blocked = candidates
    .filter((v) => officeReportBlockedReason(v) != null)
    .map((visit) => ({ visit, reason: officeReportBlockedReason(visit)! }));
  const canRecordNew = job.lifecycleStatus === 'active' || job.lifecycleStatus === 'on_hold';
  const dueOpen = available.find((v) => isOpen(v) && (v.scheduledDate ?? '') <= today);
  const initial = dueOpen?.id ?? available[0]?.id ?? (canRecordNew ? NEW_VISIT : null);
  return { available, blocked, canRecordNew, initial };
}

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'No date set');
const NEW_VISIT_LABEL = 'Work already done — not in JMS yet (adds a completed visit)';

function visitLabel(v: JobVisitSummary): string {
  if (v.status === 'completed') return `${fmtDate(v.scheduledDate)} · completed, no report yet`;
  return `${fmtDate(v.scheduledDate)} · ${getVisitStatusPresentation(v.status).label} · ${v.technicianName ?? 'Unassigned'}`;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 photos and 1 video" for what was added ('' when nothing was). */
export function mediaSummary(items: StagedMedia[]): string {
  const added = items.filter((m) => m.status === 'added');
  const photos = added.filter((m) => m.kind === 'photo').length;
  const videos = added.length - photos;
  return [photos && plural(photos, 'photo'), videos && plural(videos, 'video')].filter(Boolean).join(' and ');
}

/** The real upload functions - the same ones Report review uses, told the "Include for client" choice so the row is created with it. */
const MEDIA_DEPS: MediaUploadDeps = {
  addPhoto: (input) => addReportPhoto(input),
  addVideo: (input) => uploadReportVideo(input),
  explainPhotoError,
  explainVideoError: (e) => explainVideoError(e),
};

/**
 * editing   - filling in the form and choosing photos/videos; nothing is saved yet.
 * saving    - the one database call that completes the visit and saves the approved report.
 * uploading - the report is saved; the chosen photos and videos are being added to it.
 * partial   - the report is saved, but some files could not be added: they are marked, and can be tried again or left out.
 * uncertain - the save's reply never arrived, so it may or may not have happened. Everything stays exactly as sent (same values, same
 *             request id, the chosen files kept); "Try again" re-sends it, which either completes the save or returns the one that
 *             already happened - never a second visit or report.
 * refused   - an unfinished submission taken over from this device was re-sent and the server definitely refused it: nothing was saved,
 *             and the device copy has been cleared.
 */
type Stage = 'editing' | 'saving' | 'uploading' | 'partial' | 'uncertain' | 'refused';

const btn = 'cursor-pointer px-3 py-1.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-60';
const primary = `${btn} bg-teal font-semibold text-white`;
const secondary = `${btn} border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100`;

/**
 * "Complete & report" from the All live jobs Actions column - one continuous form: which visit, the visit details, the report, and photos
 * and videos, finished with one button. Underneath it is still the existing sequence: the report is saved first with the existing office
 * report call (validation, guards, automatic approval, attribution and the technician warning are unchanged), and the chosen files are then
 * added to it with the existing photo / video functions. When everything is in, the dialog closes and the page says so (onCompleted).
 *
 * An unfinished submission is never lost track of (officeReportPending.ts): it is written to this device - for this signed-in manager -
 * BEFORE it is sent, with its request id and exactly what is sent, and cleared only once its outcome is settled. Opening the dialog for a job
 * with one first offers to finish it (the same request id, so a save that already went through is returned, never made twice).
 */
export default function OfficeReportDialog({
  job,
  actor,
  userId,
  onClose,
  onCompleted,
}: {
  job: JobRow;
  actor: string;
  /** The signed-in manager's auth user id: unfinished submissions are kept and found per user. Null = none kept. */
  userId: string | null;
  onClose: () => void;
  /** Everything saved and added: the page closes the dialog and shows this message. */
  onCompleted: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const formId = `office-report-${useId().replace(/:/g, '')}`;
  const targets = officeReportTargets(job, localToday());
  const [selected, setSelected] = useState<string | null>(targets.initial);
  const [stage, setStage] = useState<Stage>('editing');
  // ONE request id per submission: made when the dialog opens (or taken over from an unfinished submission kept on this device) and used
  // for every attempt, so the database can recognise a save it already made. Never replaced while the outcome is unknown.
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());
  // Exactly what was sent - a re-send sends this again, never a re-read of the form.
  const [sentInput, setSentInput] = useState<Omit<OfficeReportInput, 'requestId'> | null>(null);
  // The visit as it was when Save was pressed: the job list refreshes after saving (the visit then has a report), but the form keeps
  // showing what was saved.
  const [frozen, setFrozen] = useState<{ visit: JobVisitSummary | null; label: string; wasCompleted: boolean } | null>(null);
  const [saved, setSaved] = useState<OfficeReportResult | null>(null);
  const [items, setItems] = useState<StagedMedia[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [pickError, setPickError] = useState<{ phase: MediaPhase; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [confirmClose, setConfirmClose] = useState<'discard' | 'leaveFailed' | 'leaveUncertain' | 'discardPending' | null>(null);
  const [waitNote, setWaitNote] = useState(false);
  // What this device managed to keep of the current submission: null = not written yet; 'none' = nothing (never claimed as kept).
  const [kept, setKeptState] = useState<KeptLevel | null>(null);
  // Also in a ref: the save and the file uploads run across several renders and must see the CURRENT value, not the one they started with.
  const keptRef = useRef<KeptLevel | null>(null);
  const setKept = (k: KeptLevel | null) => {
    keptRef.current = k;
    setKeptState(k);
  };
  // An unfinished submission taken over from this device (shown as a summary instead of the form).
  const [resumed, setResumed] = useState<{ record: PendingOfficeReport; missing: number } | null>(null);
  const [startedFresh, setStartedFresh] = useState(false);

  // Unfinished submission for this job, by THIS manager, kept on this device - looked at once, when the dialog opens.
  const pendingQuery = useQuery({
    queryKey: ['officePending', userId, job.id, 'open'],
    queryFn: async () => {
      const record = await getPendingSubmission(userId!, job.id);
      if (!record) return null;
      return { record, ...(await restorePendingMedia(record)) };
    },
    enabled: userId != null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const checkingPending = userId != null && pendingQuery.isLoading;

  // Previews are browser object URLs: give every one back when the dialog closes (a real side effect outside React).
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const all = urls.current;
    return () => all.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const preview = (blob: Blob) => {
    const u = URL.createObjectURL(blob);
    urls.current.add(u);
    return u;
  };

  // Take over an unfinished submission once it has been read (adjusting state while rendering, not in an effect - see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const found = pendingQuery.data;
  if (found && !resumed && !startedFresh && stage === 'editing' && found.record.requestId !== requestId) {
    const r = found.record;
    setResumed({ record: r, missing: found.missing.length });
    setRequestId(r.requestId);
    setSentInput(r.input);
    setFrozen({ visit: null, label: r.visitLabel, wasCompleted: r.visitWasCompleted });
    setKept(r.filesNotKept ? 'withoutFiles' : 'all');
    setItems(
      found.items.map((m) => ({
        ...m,
        previewUrl: m.status === 'added' ? null : m.kind === 'photo' ? preview(m.file) : m.video?.thumbnail ? preview(m.video.thumbnail) : null,
      })),
    );
    if (r.stage === 'saved' && r.result) {
      setSaved(r.result);
      setStage('partial');
    } else {
      setStage('uncertain');
      setError('This report was sent earlier, but no confirmation came back.');
    }
  }

  const liveVisit = selected && selected !== NEW_VISIT ? job.visits.find((v) => v.id === selected) ?? null : null;
  const visit = frozen ? frozen.visit : liveVisit;
  const nothing = !resumed && !checkingPending && stage === 'editing' && targets.available.length === 0 && !targets.canRecordNew;

  // Videos already on the chosen visit count towards the limits (a "work already done" visit has none - it doesn't exist yet).
  const existingVideosQuery = useQuery({
    queryKey: ['reportVideos', visit?.id],
    queryFn: () => listVideosForVisit(visit!.id),
    enabled: visit != null,
  });
  const existingVideos = visit ? existingVideosQuery.data ?? [] : [];

  const patch = (id: string, p: Partial<StagedMedia>) => setItems((prev) => prev.map((m) => (m.id === id ? { ...m, ...p } : m)));

  // Keeps the device copy's list of files in step (which are on the report, which were removed / unticked) - in order, never overlapping.
  const persistChain = useRef<Promise<unknown>>(Promise.resolve());
  const persistMedia = (list: StagedMedia[]) => {
    if (!keptRef.current || keptRef.current === 'none') return;
    const entries = list.map(mediaEntryOf);
    persistChain.current = persistChain.current.then(() => updatePendingSubmission(requestId, { media: entries }));
  };
  const clearPending = () => {
    const done = persistChain.current.then(() => removePendingSubmission(requestId));
    void done.then(() => queryClient.invalidateQueries({ queryKey: ['officePending'] }));
    return done;
  };

  const onPickPhotos = (phase: MediaPhase, files: File[]) => {
    setPickError(null);
    // Every file is checked first, so a bad one is reported before any is added (as in Report review).
    const refused = files.map((f) => checkPhotoFile(f)).find((m) => m !== null);
    if (refused) {
      setPickError({ phase, message: refused });
      return;
    }
    setItems((prev) => [
      ...prev,
      ...files.map((file): StagedMedia => ({ id: crypto.randomUUID(), kind: 'photo', phase, file, previewUrl: preview(file), include: true, status: 'ready' })),
    ]);
  };

  const onPickVideo = async (phase: MediaPhase, file: File) => {
    setPickError(null);
    const check = checkStagedVideo(file, phase, itemsRef.current, existingVideos);
    if (!check.ok) {
      setPickError({ phase, message: check.message });
      return;
    }
    const id = crypto.randomUUID();
    setItems((prev) => [...prev, { id, kind: 'video', phase, file, previewUrl: null, include: true, status: 'checking' }]);
    // Length and poster, read in the browser - best effort, exactly as Report review does before uploading.
    const meta = await readVideoMetadata(file).catch(() => ({ durationSeconds: null, thumbnail: null }));
    const tooLong = checkVideoDuration(meta.durationSeconds);
    if (tooLong) {
      setItems((prev) => prev.filter((m) => m.id !== id));
      setPickError({ phase, message: tooLong });
      return;
    }
    patch(id, {
      status: 'ready',
      previewUrl: meta.thumbnail ? preview(meta.thumbnail) : null,
      video: { mime: check.mime, ext: check.ext, durationSeconds: meta.durationSeconds, thumbnail: meta.thumbnail },
    });
  };

  const onRemove = (id: string) => {
    const item = itemsRef.current.find((m) => m.id === id);
    if (item?.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
      urls.current.delete(item.previewUrl);
    }
    const next = itemsRef.current.filter((m) => m.id !== id);
    setItems(next);
    if (stage === 'partial') persistMedia(next);
  };

  const finish = (list: StagedMedia[], wasCompleted: boolean) => {
    const media = mediaSummary(list);
    void clearPending();
    onCompleted(
      `Report saved and approved — ${job.buildingName} · ${job.jobSummary}. ` +
        `${wasCompleted ? '' : 'The visit is completed. '}It’s now in Ready for client and Ready for accounts` +
        `${media ? `, with ${media}` : ''}.`,
    );
  };

  /** Adds the chosen files to the saved report. Only files not yet added are sent; the report itself is never sent again. */
  const addMedia = async (result: OfficeReportResult, wasCompleted: boolean) => {
    setStage('uploading');
    setError(null);
    let latest = itemsRef.current;
    const final = await uploadStagedMedia(itemsRef.current, { reportId: result.reportId, visitId: result.visitId, actor }, MEDIA_DEPS, (id, p) => {
      patch(id, p);
      latest = latest.map((m) => (m.id === id ? { ...m, ...p } : m));
      if (p.savedId) persistMedia(latest); // on the report: never sent again, even after a reload
    });
    void queryClient.invalidateQueries({ queryKey: ['reportPhotos', result.reportId] });
    void queryClient.invalidateQueries({ queryKey: ['reportVideos', result.visitId] });
    if (pendingMedia(final).length === 0) finish(final, wasCompleted);
    else setStage('partial');
  };

  /** The save itself. `fresh`: a new submission from the form (kept on this device first); otherwise a re-send of exactly what was sent. */
  const send = async (input: Omit<OfficeReportInput, 'requestId'>, fresh: boolean) => {
    setConfirmClose(null);
    setWaitNote(false);
    setError(null);
    setStage('saving');
    setSentInput(input);
    const wasCompleted = fresh ? liveVisit?.status === 'completed' : frozen?.wasCompleted ?? false;
    if (fresh) {
      const label = liveVisit ? visitLabel(liveVisit) : NEW_VISIT_LABEL;
      setFrozen({ visit: liveVisit, label, wasCompleted });
      const now = new Date().toISOString();
      const level: KeptLevel = userId
        ? await savePendingSubmission(
            { requestId, userId, jobId: job.id, buildingName: job.buildingName, jobSummary: job.jobSummary, visitLabel: label, visitWasCompleted: wasCompleted,
              stage: 'unconfirmed', input, result: null, media: itemsRef.current.map(mediaEntryOf), createdAt: now, updatedAt: now },
            itemsRef.current,
          )
        : 'none';
      setKept(level);
    }
    let result: OfficeReportResult;
    try {
      result = await completeVisitWithOfficeReport({ ...input, requestId });
    } catch (err) {
      if (err instanceof OfficeReportOutcomeUnknownError) {
        // It may have been saved: keep everything exactly as sent (locked, same request id, files and device copy kept) - only a re-send.
        setError(err.message);
        setStage('uncertain');
        void queryClient.invalidateQueries({ queryKey: ['officePending'] });
        return;
      }
      // The server definitely refused, so nothing was saved (its transaction rolled back - and had this request id saved anything before,
      // the database would have returned that instead). The device copy is no longer needed.
      await clearPending();
      setError(err instanceof Error ? err.message : 'The report couldn’t be saved.');
      if (resumed) {
        setStage('refused');
      } else {
        setStage('editing');
        setFrozen(null);
        setKept(null);
      }
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['jobRows'] });
    void queryClient.invalidateQueries({ queryKey: ['visits'] });
    void queryClient.invalidateQueries({ queryKey: ['buildingRows'] });
    setSaved(result);
    if (keptRef.current && keptRef.current !== 'none') {
      persistChain.current = persistChain.current.then(() => updatePendingSubmission(requestId, { stage: 'saved', result }));
      // Recorded as saved BEFORE any file is sent, so a reload mid-upload resumes the files - never re-sends the save as "unconfirmed".
      await persistChain.current;
    }
    if (pendingMedia(itemsRef.current).length === 0) finish(itemsRef.current, wasCompleted);
    else void addMedia(result, wasCompleted);
  };

  const requestClose = () => {
    if (stage === 'saving' || stage === 'uploading') {
      setWaitNote(true);
      return;
    }
    if (stage === 'editing' && (touched || items.length > 0)) {
      setConfirmClose('discard');
      return;
    }
    if (stage === 'uncertain') {
      // Kept on this device: it can simply be finished later. Not kept: say plainly what closing means.
      if (kept === 'all' || kept === 'withoutFiles') {
        void queryClient.invalidateQueries({ queryKey: ['officePending'] });
        onClose();
      } else setConfirmClose('leaveUncertain');
      return;
    }
    if (stage === 'partial') {
      if (pendingMedia(items).length > 0) setConfirmClose('leaveFailed');
      else finish(items, frozen?.wasCompleted ?? false);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['officePending'] });
    onClose();
  };

  const pending = pendingMedia(items);
  const busy = stage === 'saving' || stage === 'uploading';
  const primaryLabel = visit?.status === 'completed' ? 'Save report' : 'Complete & save report';
  const keptNote =
    kept === 'none'
      ? ' This browser couldn’t keep a copy on this device, so if you close this window it can’t be recovered here.'
      : kept === 'withoutFiles'
        ? ' It’s kept on this device, but the photos and videos didn’t fit, so they would be lost if you close.'
        : kept === 'all'
          ? ' It’s kept on this device: you can close this window and finish it later from All live jobs.'
          : '';

  const chooser = frozen ? (
    <div className="text-[12.5px] text-ink" data-testid="office-report-chosen">
      {frozen.label}
    </div>
  ) : (
    <fieldset className="flex flex-col gap-1.5" data-testid="office-report-target">
      <legend className="mb-1 text-[11px] text-neutral-600">Which visit?</legend>
      {targets.available.map((v) => (
        <label key={v.id} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink">
          <input type="radio" name={`${formId}-target`} checked={selected === v.id} onChange={() => setSelected(v.id)} />
          {visitLabel(v)}
        </label>
      ))}
      {targets.canRecordNew && (
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink">
          <input type="radio" name={`${formId}-target`} checked={selected === NEW_VISIT} onChange={() => setSelected(NEW_VISIT)} />
          {NEW_VISIT_LABEL}
        </label>
      )}
      {targets.blocked.map(({ visit: v, reason }) => (
        <div key={v.id} className="pl-5 text-[11.5px] text-neutral-500">
          {visitLabel(v)} — {reason}
        </div>
      ))}
    </fieldset>
  );

  const status = (() => {
    if (stage === 'uncertain')
      return (
        <span role="alert" className="text-due-fg" data-testid="office-report-uncertain">
          {error} Nothing will be saved twice: “Try again” sends the same save, and if it already went through you get that report back.
          {keptNote}
        </span>
      );
    if (stage === 'refused')
      return (
        <span role="alert" className="text-missed-fg" data-testid="office-report-refused">
          Nothing was saved: {error} This unfinished report has been cleared from this device — close this window and start again.
        </span>
      );
    if (error) return <span role="alert" className="text-missed-fg">{error}</span>;
    if (waitNote && busy) return <span role="status">Please wait — closing now could leave the photos and videos off the report.</span>;
    if (stage === 'saving') return <span role="status">Saving the report…</span>;
    if (stage === 'uploading') {
      const total = items.length;
      const done = items.filter((m) => m.status === 'added' || m.status === 'failed').length;
      return <span role="status">Report saved and approved. Adding photos and videos… ({Math.min(done + 1, total)} of {total})</span>;
    }
    if (stage === 'partial')
      return (
        <span role="alert" className="text-missed-fg" data-testid="office-report-partial">
          The report is saved and approved, but {plural(pending.length, 'file')} {pending.length === 1 ? 'hasn’t' : 'haven’t'} been added yet. Try again,
          or remove {pending.length === 1 ? 'it' : 'them'} and close.
        </span>
      );
    if (checkingPending) return <span className="text-neutral-500">Checking for an unfinished report on this device…</span>;
    return <span className="text-neutral-500">Saved as approved, so it goes straight to Ready for client and Ready for accounts.</span>;
  })();

  const confirmText =
    confirmClose === 'discard'
      ? `Discard this report? Nothing has been saved yet${items.length ? `, and the ${plural(items.length, 'chosen file')} will be dropped` : ''}.`
      : confirmClose === 'leaveUncertain'
        ? 'We still don’t know whether this report was saved, and this browser couldn’t keep a copy. If you close now, check Ready for client before recording this work again — a new attempt can’t be matched to this one. Close anyway?'
        : confirmClose === 'discardPending'
          ? 'Discard this unfinished report? Only do this if you’re sure it wasn’t saved — check Ready for client first. If it was saved and you record the work again, it will be there twice.'
          : `${plural(pending.length, 'file')} won’t be on the report if you close now, and an approved report has nowhere else to add photos or videos. Close anyway?`;
  const confirmGo = () => {
    if (confirmClose === 'discard' || confirmClose === 'leaveUncertain') onClose();
    else if (confirmClose === 'discardPending') void clearPending().then(onClose);
    else finish(items, frozen?.wasCompleted ?? false);
  };

  const footer = nothing ? (
    <div className="flex justify-end">
      <button type="button" onClick={onClose} className={secondary}>
        Close
      </button>
    </div>
  ) : confirmClose ? (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="office-report-confirm-close">
      <span role="alert" className="flex-1 text-[12px] text-ink">
        {confirmText}
      </span>
      <div className="flex gap-1.5">
        <button type="button" autoFocus onClick={() => setConfirmClose(null)} className={secondary}>
          {confirmClose === 'discard' ? 'Keep editing' : 'Keep open'}
        </button>
        <button type="button" onClick={confirmGo} className={`${btn} border border-missed bg-white font-semibold text-missed-fg hover:bg-missed/10`}>
          {confirmClose === 'discard' || confirmClose === 'discardPending' ? 'Discard' : confirmClose === 'leaveUncertain' ? 'Close anyway' : 'Close without them'}
        </button>
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 text-[11.5px]" data-testid="office-report-status">
        {status}
      </div>
      <div className="flex flex-none justify-end gap-1.5">
        {stage === 'uncertain' ? (
          <>
            <button type="button" onClick={() => setConfirmClose('discardPending')} className={`${btn} text-missed-fg hover:underline`}>
              Discard…
            </button>
            <button type="button" onClick={requestClose} className={secondary}>
              Close
            </button>
            <button type="button" onClick={() => sentInput && void send(sentInput, false)} className={primary}>
              Try again
            </button>
          </>
        ) : stage === 'refused' ? (
          <button type="button" onClick={onClose} className={secondary}>
            Close
          </button>
        ) : stage === 'partial' ? (
          <>
            <button type="button" onClick={requestClose} className={secondary}>
              Close
            </button>
            {pending.length > 0 && (
              <button type="button" onClick={() => saved && void addMedia(saved, frozen?.wasCompleted ?? false)} className={primary}>
                Try again
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" onClick={requestClose} disabled={busy} className={secondary}>
              Cancel
            </button>
            <button type="submit" form={formId} disabled={busy || checkingPending} className={primary}>
              {stage === 'saving' ? 'Saving…' : stage === 'uploading' ? 'Adding files…' : primaryLabel}
            </button>
          </>
        )}
      </div>
    </div>
  );

  const mediaSection = (
    <OfficeReportMedia
      items={items}
      existingVideoCount={existingVideos.length}
      editable={stage === 'editing'}
      pickError={pickError}
      moveTargets={(m) => moveTargets(m, items, existingVideos)}
      onPickPhotos={onPickPhotos}
      onPickVideo={(phase, file) => void onPickVideo(phase, file)}
      onRemove={onRemove}
      onToggleInclude={(id, include) => {
        patch(id, { include });
        if (stage === 'partial') persistMedia(itemsRef.current.map((m) => (m.id === id ? { ...m, include } : m)));
      }}
      onMove={(id, phase) => {
        patch(id, { phase });
        if (stage === 'partial') persistMedia(itemsRef.current.map((m) => (m.id === id ? { ...m, phase } : m)));
      }}
    />
  );

  return (
    <FormDialog
      eyebrow="Complete & write report"
      title={`${job.buildingName} · ${job.jobSummary}`}
      onClose={confirmClose ? () => setConfirmClose(null) : requestClose}
      testId="office-report-dialog"
      width={760}
      footer={footer}
    >
      {checkingPending ? (
        <div className="text-[12.5px] text-neutral-600" data-testid="office-report-checking">
          Checking for an unfinished report on this device…
        </div>
      ) : resumed ? (
        <PendingSummary record={resumed.record} missing={resumed.missing} media={mediaSection} />
      ) : nothing ? (
        <div className="flex flex-col gap-2 text-[12.5px] text-neutral-700" data-testid="office-report-nothing">
          <p>There is no visit here the office can complete and report on.</p>
          {targets.blocked.map(({ visit: v, reason }) => (
            <p key={v.id} className="text-[11.5px] text-neutral-500">
              {visitLabel(v)} — {reason}
            </p>
          ))}
        </div>
      ) : (
        <div onInput={() => setTouched(true)}>
          {pendingQuery.isError && (
            <p className="mb-2 text-[11px] text-neutral-500" data-testid="office-report-pending-unreadable">
              This browser couldn’t check for unfinished reports kept on this device.
            </p>
          )}
          {selected && (
            <OfficeReportForm
              job={job}
              visit={visit}
              formId={formId}
              chooser={chooser}
              locked={stage !== 'editing'}
              checkBeforeSave={() => {
                if (items.some((m) => m.status === 'checking')) return 'A video is still being checked — wait a moment, then try again.';
                if (visit && existingVideosQuery.isLoading) return 'Still checking this visit’s videos — try again in a moment.';
                return stagedVideoProblem(items, existingVideos);
              }}
              onSubmit={(input) => {
                setStartedFresh(true);
                void send(input, true);
              }}
              onError={setError}
              media={mediaSection}
            />
          )}
        </div>
      )}
    </FormDialog>
  );
}

const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** An unfinished submission taken over from this device: what was sent (read-only - it is re-sent exactly as it was) and its files. */
function PendingSummary({ record, missing, media }: { record: PendingOfficeReport; missing: number; media: ReactNode }) {
  const i = record.input;
  const rows: [string, string][] = [
    ['Visit', record.visitLabel],
    ['Finished', new Date(i.completedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })],
    ['Price charged', money(i.priceCharged)],
    ['Work carried out', i.workCarriedOut ?? '—'],
    ['Notes / issues', i.issues ?? '—'],
    ['Optional notes', i.technicianNotes ?? '—'],
    ['Specification', i.specMet ? 'Everything as specified' : 'Something not done'],
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="office-report-resumed">
      <div className="border border-due/50 bg-due/5 px-3 py-2 text-[12px] text-due-fg">
        {record.stage === 'saved'
          ? 'This report was saved and approved earlier, but not all of its photos and videos were added. They were kept on this device.'
          : `You started this report on ${new Date(record.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} and it was sent, but no confirmation came back. It is shown exactly as it was sent; it can’t be changed, only finished.`}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-500">{k}</dt>
            <dd className="whitespace-pre-wrap text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {record.filesNotKept && (
        <p className="text-[11.5px] text-missed-fg">The photos and videos chosen for it couldn’t be kept on this device (not enough space), so it will be finished without them.</p>
      )}
      {missing > 0 && (
        <p className="text-[11.5px] text-missed-fg">
          {plural(missing, 'chosen file')} couldn’t be read back from this device and won’t be added.
        </p>
      )}
      {record.media.length > 0 && media}
    </div>
  );
}
