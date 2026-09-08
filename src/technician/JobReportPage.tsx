import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { getVisitDetail, resubmitReport, submitReport, uploadVisitPhoto, type PhotoPhase, type UploadedPhoto } from './api';

const PHASES: { key: PhotoPhase; label: string }[] = [
  { key: 'before', label: 'Before' },
  { key: 'during', label: 'During' },
  { key: 'after', label: 'After' },
];

const ISSUE_CHIPS = ['Lighting fault', 'Fly-tipping', 'No access'];

function onSiteStartKey(visitId: string): string {
  return `technician:onSiteStart:${visitId}`;
}

/**
 * Reads the persisted arrival time for this visit, recording it now if this
 * is the first time the report screen has been opened for it — never a
 * typed value. Falls back to an unpersisted timestamp if localStorage
 * itself is unavailable (private browsing, blocked storage, etc.) — arrival
 * must still be established even then, just without surviving a reload.
 */
function ensureOnSiteStart(visitId: string): string {
  try {
    const key = onSiteStartKey(visitId);
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const now = new Date().toISOString();
    localStorage.setItem(key, now);
    return now;
  } catch {
    return new Date().toISOString();
  }
}

interface LocalPhoto extends UploadedPhoto {
  id: string;
  previewUrl: string;
}

export default function JobReportPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { visitId } = useParams<{ visitId: string }>();

  const { data: visit, isLoading, isError, error } = useQuery({
    queryKey: ['technician', 'visitDetail', visitId],
    queryFn: () => getVisitDetail(visitId!),
    enabled: !!visitId,
  });

  const isResubmitMode = !!visit?.reportId && visit.reportReviewStatus === 'returned_for_correction';
  const isLocked = !!visit?.reportId && visit.reportReviewStatus !== 'returned_for_correction';

  // Established synchronously on the very first render — before any user
  // interaction (including uploading a photo) is even possible — so there
  // is no race between opening the report and the arrival time being set.
  // Harmless to compute even in resubmit/locked mode (submitMutation is the
  // only place this value is ever used, and that path is unreachable in
  // those modes); a correction never re-captures on-site timing, per
  // technician_flow.pdf/CLAUDE.md section 7: a return is corrected, not
  // re-visited.
  const [onSiteStart] = useState<string>(() => ensureOnSiteStart(visitId ?? 'unknown-visit'));

  const [workCarriedOut, setWorkCarriedOut] = useState<string | null>(null);
  const [technicianNotes, setTechnicianNotes] = useState<string | null>(null);
  const [issues, setIssues] = useState<string | null>(null);
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<PhotoPhase, HTMLInputElement | null>>({ before: null, during: null, after: null });

  // Free the object URLs created for photo previews when the screen unmounts.
  useEffect(() => {
    return () => {
      for (const p of photos) URL.revokeObjectURL(p.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const defaultWorkCarriedOut = visit ? (isResubmitMode ? (visit.reportWorkCarriedOut ?? '') : visit.jobSummary) : '';
  const defaultTechnicianNotes = isResubmitMode ? (visit?.reportTechnicianNotes ?? '') : '';
  const defaultIssues = isResubmitMode ? (visit?.reportIssues ?? '') : '';

  const submitMutation = useMutation({
    mutationFn: () =>
      submitReport({
        visitId: visitId!,
        workCarriedOut: workCarriedOut ?? visit?.jobSummary ?? null,
        technicianNotes: technicianNotes ?? null,
        issues: issues ?? null,
        onSiteStart,
        onSiteEnd: new Date().toISOString(),
        photos: photos.map((p) => ({ storagePath: p.storagePath, phase: p.phase })),
      }),
    onSuccess: () => {
      localStorage.removeItem(onSiteStartKey(visitId!));
      queryClient.invalidateQueries({ queryKey: ['technician', 'todayVisits'] });
      queryClient.invalidateQueries({ queryKey: ['technician', 'visitDetail', visitId] });
      navigate(`/technician/visits/${visitId}/completed`, {
        state: { photoCount: photos.length, onSiteStart, onSiteEnd: new Date().toISOString() },
      });
    },
    onError: (err) => setSubmitError(err instanceof Error ? err.message : 'Failed to submit report.'),
  });

  const resubmitMutation = useMutation({
    mutationFn: () =>
      resubmitReport({
        reportId: visit!.reportId!,
        workCarriedOut: workCarriedOut ?? defaultWorkCarriedOut,
        technicianNotes: technicianNotes ?? defaultTechnicianNotes ?? null,
        issues: issues ?? defaultIssues ?? null,
        additionalPhotos: photos.map((p) => ({ storagePath: p.storagePath, phase: p.phase })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['technician', 'todayVisits'] });
      queryClient.invalidateQueries({ queryKey: ['technician', 'needsCorrection'] });
      queryClient.invalidateQueries({ queryKey: ['technician', 'visitDetail', visitId] });
      navigate(`/technician/visits/${visitId}/completed`);
    },
    onError: (err) => setSubmitError(err instanceof Error ? err.message : 'Failed to resubmit report.'),
  });

  const handleFilesSelected = async (phase: PhotoPhase, files: FileList | null) => {
    if (!files || files.length === 0 || !visitId) return;
    setUploadError(null);
    setPendingUploads((n) => n + files.length);
    for (const file of Array.from(files)) {
      try {
        const uploaded = await uploadVisitPhoto(visitId, phase, file);
        setPhotos((prev) => [...prev, { ...uploaded, id: uploaded.storagePath, previewUrl: URL.createObjectURL(file) }]);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Failed to upload photo.');
      } finally {
        setPendingUploads((n) => n - 1);
      }
    }
  };

  const addIssueChip = (phrase: string) => {
    setIssues((prev) => {
      const base = (prev ?? defaultIssues ?? '').trim();
      return base ? `${base}; ${phrase}` : phrase;
    });
  };

  // A first submission requires at least one photo; a resubmission never
  // does — the report already has photos from its original submission, so
  // zero additional photos is a valid, complete correction (e.g. a
  // text-only fix). onSiteStart no longer appears here — it's established
  // synchronously above and is always a real string by the time this runs.
  const canSubmit = isResubmitMode
    ? pendingUploads === 0 && !resubmitMutation.isPending
    : photos.length > 0 && pendingUploads === 0 && !submitMutation.isPending;

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
                {phasePhotos.map((p) => (
                  <img key={p.id} src={p.previewUrl} alt="" className="h-14 w-14 flex-none border border-neutral-300 object-cover" />
                ))}
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
      {uploadError && <div className="mt-2 text-[11.5px] text-missed-fg">{uploadError}</div>}
      {!isResubmitMode && <div className="mt-2 text-[11.5px] text-due-fg">At least one photo is required to complete the job.</div>}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-divider bg-neutral-200 px-4 py-2.5">
        <button onClick={() => navigate(`/technician/visits/${visitId}`)} className="cursor-pointer text-[12.5px] text-teal-700 hover:underline">
          ‹ Job
        </button>
      </div>

      {isLoading ? (
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
        // A report already exists and isn't awaiting correction — never
        // render the editable form or allow further photo uploads, on
        // direct navigation/reload as much as normal in-app navigation.
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
            <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              Works carried out
            </div>
            <textarea
              value={workCarriedOut ?? defaultWorkCarriedOut}
              onChange={(e) => setWorkCarriedOut(e.target.value)}
              rows={4}
              className="w-full border border-neutral-300 px-2 py-1.5 text-[13.5px] text-ink outline-none focus:border-teal"
            />
          </div>

          {photoSection}

          <div className="border-b border-divider px-4 py-3">
            <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              Notes / issues
            </div>
            <textarea
              value={issues ?? defaultIssues}
              onChange={(e) => setIssues(e.target.value)}
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
              onChange={(e) => setTechnicianNotes(e.target.value)}
              rows={2}
              placeholder="Any other notes (optional)…"
              className="mt-2 w-full border border-neutral-300 px-2 py-1.5 text-[13.5px] text-ink outline-none focus:border-teal"
            />
          </div>

          {submitError && (
            <div className="border-b border-divider px-4 py-2">
              <div className="text-[12px] text-missed-fg">{submitError}</div>
            </div>
          )}

          <div className="mt-auto p-4">
            <button
              onClick={() => (isResubmitMode ? resubmitMutation.mutate() : submitMutation.mutate())}
              disabled={!canSubmit}
              title={
                !isResubmitMode && photos.length === 0
                  ? 'Add a photo first'
                  : pendingUploads > 0
                    ? 'Waiting for photo upload to finish'
                    : undefined
              }
              className={`w-full cursor-pointer px-3 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${
                isResubmitMode ? 'bg-due' : 'bg-teal'
              }`}
            >
              {isResubmitMode
                ? resubmitMutation.isPending
                  ? 'Resubmitting…'
                  : 'Resubmit'
                : submitMutation.isPending
                  ? 'Submitting…'
                  : 'Complete job'}
            </button>
            {!isResubmitMode && photos.length === 0 ? (
              <div className="mt-1.5 text-center text-[11.5px] text-neutral-500">Add a photo first</div>
            ) : (
              pendingUploads > 0 && (
                <div className="mt-1.5 text-center text-[11.5px] text-neutral-500">Waiting for photo upload to finish…</div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
