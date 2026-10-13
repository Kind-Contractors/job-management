// Photos in Report review: one column per section (Before / During / After), each with its photos and an "Add photo" button - the
// same layout and rules as videos (ReportVideos.tsx).
//
// What a manager can do here:
//   * add photos (several at once; each is shrunk to 1600 px like a technician's) - not on a Completed report;
//   * tick / untick "Include for client" per photo (photos are included by default) - not on a Completed report;
//   * remove a photo, after a confirmation popup (permanent: the record and its file) - not on a Completed report.
// The database does not itself stop photo changes on a Completed report (it does for videos), so that rule is enforced here only.
// Orchestration lives in ReportPhotos; ReportPhotosView is presentational so it can be rendered and checked on its own.
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listPhotosForReport, signReportPhotoUrls, updatePhotoClientInclusion, type ReportPhoto } from '../../repository/reportsRepository';
import { addReportPhoto, checkPhotoFile, explainPhotoError, removeReportPhoto } from '../../repository/reportPhotosRepository';
import PhotoDeleteButton from '../../technician/PhotoDeleteButton';

const PHASES = ['before', 'during', 'after'] as const;
const PHASE_LABEL: Record<ReportPhoto['phase'], string> = { before: 'Before', during: 'During', after: 'After' };

export interface ReportPhotosViewProps {
  photos: ReportPhoto[];
  urls: Record<string, string>;
  completed: boolean;
  /** Which section is currently receiving photos, and how far it has got. */
  adding: { phase: ReportPhoto['phase']; done: number; total: number } | null;
  /** A refusal or failure to show under a section. */
  phaseError: { phase: ReportPhoto['phase']; message: string } | null;
  /** A note shown above the sections (for example a removed photo whose file could not be deleted). */
  notice: string | null;
  rowError: { id: string; message: string } | null;
  includePendingId: string | null;
  onPick: (phase: ReportPhoto['phase'], files: FileList | null) => void;
  onToggleInclude: (photo: ReportPhoto, included: boolean) => void;
  onDelete: (photo: ReportPhoto) => Promise<void>;
  onDeleteError: (photo: ReportPhoto, message: string) => void;
  /** Lets the container attach the hidden file inputs to its "Add photo" buttons. */
  inputRef: (phase: ReportPhoto['phase'], el: HTMLInputElement | null) => void;
  onAddClick: (phase: ReportPhoto['phase']) => void;
}

export function ReportPhotosView(p: ReportPhotosViewProps) {
  return (
    <div className="flex flex-col gap-2" data-testid="report-photos">
      {p.completed && (
        <div className="text-[11px] text-neutral-500">
          This report is Completed, so photos can’t be added, removed or unticked. Reopen it first (Ready for client → Completed → Reopen).
        </div>
      )}
      {p.notice && (
        <div role="status" className="text-[11px] text-due-fg">
          {p.notice}
        </div>
      )}
      <div className="grid grid-cols-3 items-start gap-3">
        {PHASES.map((phase) => {
          const phasePhotos = p.photos.filter((x) => x.phase === phase);
          const addingHere = p.adding?.phase === phase;
          return (
            <div key={phase} className="flex min-w-0 flex-col gap-1.5" data-testid={`photo-phase-${phase}`}>
              <div className="font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                {PHASE_LABEL[phase]} ({phasePhotos.length})
              </div>
              <div className="flex flex-wrap gap-2">
                {phasePhotos.map((photo) => (
                  <div key={photo.id} className="flex w-20 flex-col gap-0.5" data-testid="report-photo">
                    <div className="relative h-20 w-20">
                      {p.urls[photo.id] ? (
                        <a href={p.urls[photo.id]} target="_blank" rel="noreferrer">
                          <img
                            src={p.urls[photo.id]}
                            alt=""
                            className={`h-20 w-20 border object-cover ${photo.includeInClientReport ? 'border-neutral-300' : 'border-neutral-300 opacity-40'}`}
                          />
                        </a>
                      ) : (
                        <div className="h-20 w-20 animate-shimmer border border-neutral-300 bg-neutral-200" />
                      )}
                      {!p.completed && (
                        <PhotoDeleteButton
                          needsConfirm
                          ariaLabel={`Delete ${PHASE_LABEL[phase].toLowerCase()} photo`}
                          onDelete={() => p.onDelete(photo)}
                          onError={(message) => p.onDeleteError(photo, message)}
                        />
                      )}
                    </div>
                    <label className={`flex items-center gap-1 text-[10px] ${p.completed ? 'cursor-not-allowed text-neutral-400' : 'cursor-pointer text-neutral-600'}`}>
                      <input
                        type="checkbox"
                        checked={photo.includeInClientReport}
                        disabled={p.completed || p.includePendingId === photo.id}
                        onChange={(e) => p.onToggleInclude(photo, e.target.checked)}
                        aria-label={`Include ${PHASE_LABEL[phase].toLowerCase()} photo in the client report`}
                        className="accent-teal"
                      />
                      Include for client
                    </label>
                    {p.rowError?.id === photo.id && (
                      <div role="alert" className="text-[10px] leading-snug text-missed-fg">
                        {p.rowError.message}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {phasePhotos.length === 0 && !addingHere && <div className="text-[11px] text-neutral-400">None</div>}
              {addingHere && (
                <div role="status" className="text-[11px] text-neutral-600">
                  Adding photo {Math.min(p.adding!.done + 1, p.adding!.total)} of {p.adding!.total}…
                </div>
              )}
              {p.phaseError?.phase === phase && (
                <div role="alert" className="text-[11px] text-missed-fg">
                  {p.phaseError.message}
                </div>
              )}
              <input
                ref={(el) => p.inputRef(phase, el)}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                aria-label={`Choose photos for the ${PHASE_LABEL[phase]} section`}
                onChange={(e) => p.onPick(phase, e.target.files)}
              />
              <button
                onClick={() => p.onAddClick(phase)}
                disabled={p.completed || p.adding !== null}
                title={p.completed ? 'This report is Completed' : p.adding ? 'Another upload is in progress' : undefined}
                className="w-fit cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                + Add photo
              </button>
            </div>
          );
        })}
      </div>
      <div className="text-[10.5px] text-neutral-500">Photos are shown to the client unless you untick them. Deleting a photo removes it permanently.</div>
    </div>
  );
}

export interface ReportPhotosProps {
  reportId: string;
  visitId: string;
  /** Completed reports refuse photo changes here. */
  completed: boolean;
  actor: string;
}

export default function ReportPhotos({ reportId, visitId, completed, actor }: ReportPhotosProps) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<ReportPhotosViewProps['adding']>(null);
  const [phaseError, setPhaseError] = useState<ReportPhotosViewProps['phaseError']>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<ReportPhotosViewProps['rowError']>(null);
  const [includePendingId, setIncludePendingId] = useState<string | null>(null);
  const inputs = useRef<Record<ReportPhoto['phase'], HTMLInputElement | null>>({ before: null, during: null, after: null });
  const busy = useRef(false);

  const { data: photos = [] } = useQuery({ queryKey: ['reportPhotos', reportId], queryFn: () => listPhotosForReport(reportId) });
  const { data: urls = {} } = useQuery({
    queryKey: ['reportPhotoUrls', reportId, photos.map((x) => x.id).join(',')],
    queryFn: () => signReportPhotoUrls(photos),
    enabled: photos.length > 0,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['reportPhotos', reportId] });

  const onPick = async (phase: ReportPhoto['phase'], files: FileList | null) => {
    const list = files ? Array.from(files) : [];
    const input = inputs.current[phase];
    if (input) input.value = ''; // picking the same file again must still fire a change
    if (list.length === 0 || busy.current || completed) return;
    busy.current = true;
    setPhaseError(null);
    setNotice(null);
    // Check every file first so a bad one is reported before anything is uploaded.
    const refused = list.map((f) => checkPhotoFile(f)).find((m) => m !== null);
    if (refused) {
      setPhaseError({ phase, message: refused });
      busy.current = false;
      return;
    }
    try {
      for (let i = 0; i < list.length; i += 1) {
        setAdding({ phase, done: i, total: list.length });
        try {
          await addReportPhoto({ reportId, visitId, phase, file: list[i], actor });
          await refresh();
        } catch (e) {
          setPhaseError({ phase, message: explainPhotoError(e) });
          break; // stop at the first failure; photos already added stay
        }
      }
    } finally {
      setAdding(null);
      busy.current = false;
    }
  };

  const onToggleInclude = async (photo: ReportPhoto, included: boolean) => {
    setRowError(null);
    setIncludePendingId(photo.id);
    try {
      await updatePhotoClientInclusion(photo.id, included);
      await refresh();
    } catch (e) {
      setRowError({ id: photo.id, message: explainPhotoError(e) });
    } finally {
      setIncludePendingId(null);
    }
  };

  const onDelete = async (photo: ReportPhoto) => {
    setRowError(null);
    setNotice(null);
    const result = await removeReportPhoto(photo, reportId, actor);
    if (result.fileCleanupFailed) setNotice('A photo was removed from the report, but its file could not be deleted from storage. Nothing uses it any more.');
    await refresh();
  };

  return (
    <ReportPhotosView
      photos={photos}
      urls={urls}
      completed={completed}
      adding={adding}
      phaseError={phaseError}
      notice={notice}
      rowError={rowError}
      includePendingId={includePendingId}
      onPick={(phase, files) => void onPick(phase, files)}
      onToggleInclude={(photo, included) => void onToggleInclude(photo, included)}
      onDelete={onDelete}
      onDeleteError={(photo, message) => setRowError({ id: photo.id, message: explainPhotoError(new Error(message)) })}
      inputRef={(phase, el) => {
        inputs.current[phase] = el;
      }}
      onAddClick={(phase) => inputs.current[phase]?.click()}
    />
  );
}
