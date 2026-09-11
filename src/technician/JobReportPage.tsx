import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { getVisitDetail, retryUnlessOffline, type PhotoPhase } from './api';
import {
  enqueuePhoto,
  getOrInitDraft,
  getVisitPhotos,
  markReadyToSubmit,
  retryPhoto,
  subscribeSyncEngine,
  trySubmitIfReady,
  updateDraftFields,
  useSyncStatus,
} from './offline/syncEngine';
import type { PendingPhoto } from './offline/db';

/** See JobFilePage.tsx's identical constant — same query key, same value, so the two screens never disagree about how long this visit stays fresh-enough-to-skip-a-refetch. */
const VISIT_DETAIL_STALE_TIME_MS = 5 * 60 * 1000;

const PHASES: { key: PhotoPhase; label: string }[] = [
  { key: 'before', label: 'Before' },
  { key: 'during', label: 'During' },
  { key: 'after', label: 'After' },
];

const ISSUE_CHIPS = ['Lighting fault', 'Fly-tipping', 'No access'];

const PHOTO_STATUS_LABEL: Record<PendingPhoto['status'], string> = {
  pending: 'Saved locally',
  uploading: 'Uploading…',
  uploaded: 'Uploaded',
  failed: 'Failed — tap to retry',
};

const PHOTO_STATUS_STYLE: Record<PendingPhoto['status'], string> = {
  pending: 'border-neutral-400 text-neutral-600',
  uploading: 'border-due text-due-fg',
  uploaded: 'border-teal text-teal-700',
  failed: 'border-missed text-missed-fg',
};

/**
 * `PendingPhoto.status === 'failed'` is honest — an upload attempt really
 * did fail — but while the device is currently offline, that's expected
 * and already being retried automatically (offline/syncEngine.ts's
 * retryEverything() retries every 'failed' photo unconditionally,
 * online or not), not a stuck failure needing attention. Presentation
 * only: never changes `PendingPhoto.status`, `retryPhoto()`, or any
 * retry/upload logic — a genuinely persistent failure while online still
 * shows exactly the same red "Failed — tap to retry" state as before.
 */
function photoDisplay(photo: PendingPhoto, online: boolean): { label: string; style: string; retryable: boolean } {
  if (photo.status === 'failed' && !online) {
    return {
      label: 'Saved offline · uploading automatically once reconnected',
      style: PHOTO_STATUS_STYLE.pending,
      retryable: false,
    };
  }
  return { label: PHOTO_STATUS_LABEL[photo.status], style: PHOTO_STATUS_STYLE[photo.status], retryable: photo.status === 'failed' };
}

/**
 * Photo capture/report submission now goes entirely through the offline
 * sync engine (src/technician/offline/) — see that module's own header
 * for the full rationale. This page's job is just: rehydrate whatever's
 * already queued for this visit on mount, persist every edit to the
 * durable draft as it happens, and let "Complete job" be an immediate
 * local action (mark ready, navigate) rather than something that waits on
 * the network. The one localStorage-based onSiteStart mechanism this page
 * used to own is gone — the draft record (in IndexedDB) is now the single
 * source of truth for on-site timing too, seeded once when the draft is
 * first created and left untouched on every later rehydration.
 */
export default function JobReportPage() {
  const navigate = useNavigate();
  const { visitId } = useParams<{ visitId: string }>();

  const {
    data: visit,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['technician', 'visitDetail', visitId],
    queryFn: () => getVisitDetail(visitId!),
    enabled: !!visitId,
    staleTime: VISIT_DETAIL_STALE_TIME_MS,
    retry: retryUnlessOffline,
  });
  const { online } = useSyncStatus();
  // Same reasoning as JobFilePage.tsx's identical check — this page is
  // reached almost immediately after that one already loaded the same
  // visit, so this should be rare in practice; it's the one case where a
  // technician landing here with nothing cached deserves an honest
  // "offline" message instead of a raw fetch error or an infinite spinner.
  const offlineWithNoData = !visit && !online;

  const isResubmitMode = !!visit?.reportId && visit.reportReviewStatus === 'returned_for_correction';
  const isLocked = !!visit?.reportId && visit.reportReviewStatus !== 'returned_for_correction';

  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [draftReady, setDraftReady] = useState(false);
  const [workCarriedOut, setWorkCarriedOut] = useState<string | null>(null);
  const [technicianNotes, setTechnicianNotes] = useState<string | null>(null);
  const [issues, setIssues] = useState<string | null>(null);
  const [specMet, setSpecMet] = useState(true);
  const [isCompleting, setIsCompleting] = useState(false);
  const fileInputRefs = useRef<Record<PhotoPhase, HTMLInputElement | null>>({ before: null, during: null, after: null });
  const previewUrlsRef = useRef<Map<string, string>>(new Map());
  const workCarriedOutRef = useRef<HTMLTextAreaElement | null>(null);

  const defaultWorkCarriedOut = visit ? (isResubmitMode ? (visit.reportWorkCarriedOut ?? '') : visit.jobSummary) : '';
  const defaultTechnicianNotes = isResubmitMode ? (visit?.reportTechnicianNotes ?? '') : '';
  const defaultIssues = isResubmitMode ? (visit?.reportIssues ?? '') : '';

  // Rehydrate (or create) the draft for this visit the moment we know its
  // real mode/reportId — runs once per visit, not on every render.
  useEffect(() => {
    if (!visit || !visitId) return;
    let cancelled = false;

    (async () => {
      const initialized = await getOrInitDraft(visitId, {
        mode: isResubmitMode ? 'resubmit' : 'submit',
        reportId: isResubmitMode ? visit.reportId : null,
        onSiteStart: isResubmitMode ? null : new Date().toISOString(),
        specMet: isResubmitMode ? (visit.reportSpecMet ?? true) : true,
      });
      const existingPhotos = await getVisitPhotos(visitId);
      if (cancelled) return;

      // Already completed locally and just waiting on background sync —
      // this screen has nothing further for the technician to do; send
      // them straight to Completed, which shows the live sync state.
      if (initialized.readyToSubmit) {
        navigate(`/technician/visits/${visitId}/completed`, { replace: true });
        return;
      }

      setPhotos(existingPhotos);
      setWorkCarriedOut(initialized.workCarriedOut);
      setTechnicianNotes(initialized.technicianNotes);
      setIssues(initialized.issues);
      setSpecMet(initialized.specMet);
      setDraftReady(true);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit, visitId]);

  // Live status updates (upload progress, retries) — refetch this visit's
  // queued photos whenever the sync engine reports a change anywhere.
  useEffect(() => {
    if (!visitId) return;
    return subscribeSyncEngine(() => {
      void getVisitPhotos(visitId).then(setPhotos);
    });
  }, [visitId]);

  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const previewUrlFor = (photo: PendingPhoto): string => {
    const existing = previewUrlsRef.current.get(photo.id);
    if (existing) return existing;
    const url = URL.createObjectURL(photo.blob);
    previewUrlsRef.current.set(photo.id, url);
    return url;
  };

  const handleFilesSelected = async (phase: PhotoPhase, files: FileList | null) => {
    if (!files || files.length === 0 || !visitId) return;
    for (const file of Array.from(files)) {
      const photo = await enqueuePhoto(visitId, phase, file);
      setPhotos((prev) => [...prev, photo]);
    }
  };

  const addIssueChip = (phrase: string) => {
    setIssues((prev) => {
      const base = (prev ?? defaultIssues ?? '').trim();
      const next = base ? `${base}; ${phrase}` : phrase;
      if (visitId) void updateDraftFields(visitId, { issues: next });
      return next;
    });
  };

  /**
   * "Add to this" — makes room to append additional work detail without
   * ever overwriting what's already there. Purely additive: appends a
   * newline (only if the existing text doesn't already end in one) and
   * moves focus/cursor to the end so the technician keeps typing in the
   * same field — same "one tap, then keep typing" pattern as the issue
   * chips above, generalized from a fixed phrase to "make space to type."
   */
  const handleAddToThis = () => {
    const current = (workCarriedOut ?? defaultWorkCarriedOut ?? '').replace(/\s+$/, '');
    const next = current ? `${current}\n` : current;
    setWorkCarriedOut(next);
    if (visitId) void updateDraftFields(visitId, { workCarriedOut: next });
    requestAnimationFrame(() => {
      const el = workCarriedOutRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  /** "Something not done" — a real structured field (reports.spec_met), not text. Freely toggleable right up until submission; never itself blocks submitting/resubmitting either way. */
  const handleSpecMetChange = (value: boolean) => {
    setSpecMet(value);
    if (visitId) void updateDraftFields(visitId, { specMet: value });
  };

  const canSubmit = draftReady && !isCompleting && (isResubmitMode || photos.length > 0);

  const handleComplete = async () => {
    if (!visitId || isCompleting) return;
    setIsCompleting(true);
    try {
      // Persist whatever's currently typed one last time before marking
      // ready, in case a field changed since its own last onChange fired.
      // workCarriedOut falls back to defaultWorkCarriedOut here — the
      // textarea shows that default (the job summary, or the existing
      // report's text on a resubmission) whenever the technician hasn't
      // touched the field, but the underlying state stays null until they
      // do. Without this fallback, a technician who reasonably takes the
      // pre-filled description as "already filled in" and never edits it
      // would submit a genuinely blank Work Carried Out, even though real,
      // visible text was on screen the whole time (confirmed against a
      // real submitted report — technicianNotes/issues, which have no such
      // default, saved correctly; only this field, which does, came back
      // null). Committing whatever's actually visible, not the possibly-
      // still-null internal state, is the fix — never touches
      // technicianNotes/issues, the draft seed, or resubmission's own
      // distinct default.
      await updateDraftFields(visitId, { workCarriedOut: workCarriedOut ?? defaultWorkCarriedOut, technicianNotes, issues });
      const readyDraft = await markReadyToSubmit(visitId);
      void trySubmitIfReady(visitId); // fire immediately in case we're already online — never awaited, navigation doesn't wait on it
      navigate(`/technician/visits/${visitId}/completed`, {
        state: { photoCount: photos.length, onSiteStart: readyDraft.onSiteStart, onSiteEnd: readyDraft.onSiteEnd },
      });
    } catch (err) {
      setIsCompleting(false);
      // eslint-disable-next-line no-console
      console.error('Failed to complete job locally:', err);
    }
  };

  const photoSection = visit && (
    <div className="border-b border-divider px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
        Photos
        <span className="text-neutral-400 normal-case">
          {isResubmitMode && visit.reportPhotoCount > 0 && `${visit.reportPhotoCount} already added · `}
          {photos.length} new
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {PHASES.map(({ key, label }) => {
          const phasePhotos = photos.filter((p) => p.phase === key);
          return (
            <div key={key}>
              <div className="mb-1 font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                {label} ({phasePhotos.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {phasePhotos.map((p) => {
                  const display = photoDisplay(p, online);
                  return (
                    <div key={p.id} className="flex flex-col items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => display.retryable && void retryPhoto(p)}
                        title={p.lastError ?? display.label}
                        className={`h-14 w-14 flex-none border object-cover ${display.retryable ? 'cursor-pointer' : 'cursor-default'} ${display.style}`}
                        style={{ backgroundImage: `url(${previewUrlFor(p)})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                      />
                      <span className={`text-center text-[8.5px] leading-tight ${display.style.split(' ')[1]}`}>{display.label}</span>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => fileInputRefs.current[key]?.click()}
                  className="flex h-14 w-14 flex-none cursor-pointer flex-col items-center justify-center border border-dashed border-neutral-400 text-[10px] text-neutral-500 hover:border-teal hover:text-teal-700"
                >
                  + Add
                </button>
                <input
                  ref={(el) => {
                    fileInputRefs.current[key] = el;
                  }}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  hidden
                  onChange={(e) => {
                    void handleFilesSelected(key, e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {!isResubmitMode && <div className="mt-2 text-[11.5px] text-due-fg">At least one photo is required to complete the job.</div>}
      <div className="mt-1 text-[10.5px] leading-snug text-neutral-500">
        Photos are saved on this device the instant you take them, even with no signal — they'll upload automatically
        once you're back online.
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-divider bg-neutral-200 px-4 py-2.5">
        <button onClick={() => navigate(`/technician/visits/${visitId}`)} className="cursor-pointer text-[12.5px] text-teal-700 hover:underline">
          ‹ Job
        </button>
      </div>

      {offlineWithNoData ? (
        <div className="p-4">
          <div className="border border-neutral-300 bg-neutral-100 p-4">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">You're offline</div>
            <div className="mt-1.5 text-[13px] text-ink">
              This job hasn't been saved on this device yet, so it can't be shown without a connection.
            </div>
            <button
              onClick={() => void refetch()}
              className="mt-3 cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            >
              Try again
            </button>
          </div>
        </div>
      ) : isLoading ? (
        <div className="p-4">
          <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
        </div>
      ) : isError || !visit ? (
        <div className="p-4">
          <div className="border border-missed bg-missed/10 p-4">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">Couldn't load this job</div>
            <div className="mt-1.5 text-[13px] text-ink">{error instanceof Error ? error.message : 'This visit is not available.'}</div>
          </div>
        </div>
      ) : isLocked ? (
        <div className="p-4">
          <div className="border border-neutral-300 bg-neutral-100 px-5 py-10 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">Report submitted</div>
            <div className="mt-1.5 text-[13px] text-neutral-600">This visit's report has already been sent to the office.</div>
            <button
              onClick={() => navigate(`/technician/visits/${visitId}`)}
              className="mt-3 cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            >
              Back to job file
            </button>
          </div>
        </div>
      ) : !draftReady ? (
        <div className="p-4">
          <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto bg-white">
          <div className="border-b border-divider px-4 py-3">
            <h1 className="font-heading text-lg leading-tight font-semibold">{visit.buildingName ?? visit.buildingAddress}</h1>
            <div className="text-[12.5px] text-neutral-600">
              {visit.buildingAddress} · {visit.jobSummary}
            </div>
          </div>

          {isResubmitMode && (
            <div className="m-3.5 border border-due bg-due/10 p-3">
              <div className="font-heading text-[11px] font-semibold tracking-[0.11em] text-due-fg uppercase">Returned for correction</div>
              {visit.reportReturnReason && <div className="mt-1 text-[12.5px] leading-snug text-due-fg">{visit.reportReturnReason}</div>}
            </div>
          )}

          <div className="border-b border-divider px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                Works carried out
              </div>
              <button
                type="button"
                onClick={handleAddToThis}
                className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100"
              >
                + Add to this
              </button>
            </div>
            <textarea
              ref={workCarriedOutRef}
              value={workCarriedOut ?? defaultWorkCarriedOut}
              onChange={(e) => {
                setWorkCarriedOut(e.target.value);
                if (visitId) void updateDraftFields(visitId, { workCarriedOut: e.target.value });
              }}
              rows={4}
              className="w-full border border-neutral-300 px-2 py-1.5 text-[13.5px] text-ink outline-none focus:border-teal"
            />
          </div>

          <div className="border-b border-divider px-4 py-3">
            <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              Specification
            </div>
            <div className="flex border border-neutral-300">
              <button
                type="button"
                onClick={() => handleSpecMetChange(true)}
                className={`flex-1 cursor-pointer px-2 py-1.5 text-[12.5px] ${
                  specMet ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
                }`}
              >
                Everything as specified
              </button>
              <button
                type="button"
                onClick={() => handleSpecMetChange(false)}
                className={`flex-1 cursor-pointer border-l border-neutral-300 px-2 py-1.5 text-[12.5px] ${
                  !specMet ? 'bg-due font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
                }`}
              >
                Something not done
              </button>
            </div>
            {!specMet && (
              <div className="mt-1.5 text-[11.5px] leading-snug text-due-fg">
                The office will see that part of the specification wasn't completed. You can still add details in
                Notes/issues below, and change this before you submit.
              </div>
            )}
          </div>

          {photoSection}

          <div className="border-b border-divider px-4 py-3">
            <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              Notes / issues
            </div>
            <textarea
              value={issues ?? defaultIssues}
              onChange={(e) => {
                setIssues(e.target.value);
                if (visitId) void updateDraftFields(visitId, { issues: e.target.value });
              }}
              rows={3}
              placeholder="Anything to flag…"
              className="w-full border border-neutral-300 px-2 py-1.5 text-[13.5px] text-ink outline-none focus:border-teal"
            />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {ISSUE_CHIPS.map((phrase) => (
                <button
                  key={phrase}
                  type="button"
                  onClick={() => addIssueChip(phrase)}
                  className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100"
                >
                  + {phrase}
                </button>
              ))}
            </div>
            <textarea
              value={technicianNotes ?? defaultTechnicianNotes}
              onChange={(e) => {
                setTechnicianNotes(e.target.value);
                if (visitId) void updateDraftFields(visitId, { technicianNotes: e.target.value });
              }}
              rows={2}
              placeholder="Any other notes (optional)…"
              className="mt-2 w-full border border-neutral-300 px-2 py-1.5 text-[13.5px] text-ink outline-none focus:border-teal"
            />
          </div>

          <div className="mt-auto p-4">
            <button
              onClick={() => void handleComplete()}
              disabled={!canSubmit}
              title={!isResubmitMode && photos.length === 0 ? 'Add a photo first' : undefined}
              className={`w-full cursor-pointer px-3 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${
                isResubmitMode ? 'bg-due' : 'bg-teal'
              }`}
            >
              {isCompleting ? 'Completing…' : isResubmitMode ? 'Resubmit' : 'Complete job'}
            </button>
            {!isResubmitMode && photos.length === 0 && (
              <div className="mt-1.5 text-center text-[11.5px] text-neutral-500">Add a photo first</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}