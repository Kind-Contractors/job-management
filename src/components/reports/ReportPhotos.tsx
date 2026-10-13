// Photos in Report review: one column per section (Before / During / After), each with its photos and an "Add photo" button - the
// same layout and rules as videos (ReportVideos.tsx).
//
// What a manager can do here:
//   * add photos (several at once; each is shrunk to 1600 px like a technician's) - not on a Completed report;
//   * tick / untick "Include for client" per photo (photos are included by default) - not on a Completed report;
//   * remove a photo, after a confirmation popup (permanent: the record and its file) - not on a Completed report;
//   * move a photo to another section, for when a technician filed everything under one heading - not on a Completed report.
// The database does not itself stop photo changes on a Completed report (it does for videos), so that rule is enforced here only.
// Orchestration lives in ReportPhotos; ReportPhotosView is presentational so it can be rendered and checked on its own.
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listPhotosForReport, signReportPhotoUrls, updatePhotoClientInclusion, type ReportPhoto } from '../../repository/reportsRepository';
import { addReportPhoto, checkPhotoFile, explainPhotoError, moveReportPhoto, removeReportPhoto } from '../../repository/reportPhotosRepository';
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
  /** The photo whose move is still being saved: its "Move to" control is locked until it finishes. */
  movePendingId: string | null;
  onMove: (photo: ReportPhoto, toPhase: ReportPhoto['phase']) => void;
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
          This report is Completed, so photos can’t be added, removed, moved or unticked. Reopen it first (Ready for client → Completed → Reopen).
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
                    {!p.completed && (
                      <label className="flex items-center gap-1 text-[10px] text-neutral-600">
                        <span className="sr-only">Move {PHASE_LABEL[phase].toLowerCase()} photo to another section</span>
                        {/* A plain select: compact, and it opens as the native picker on a phone. */}
                        <select
                          value=""
                          disabled={p.movePendingId === photo.id}
                          onChange={(e) => {
                            const to = e.target.value as ReportPhoto['phase'] | '';
                            e.target.value = '';
                            if (to) p.onMove(photo, to);
                          }}
                          aria-label={`Move ${PHASE_LABEL[phase].toLowerCase()} photo to another section`}
                          className="w-full cursor-pointer border border-neutral-300 bg-white px-1 py-0.5 text-[10px] text-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="">{p.movePendingId === photo.id ? 'Moving…' : 'Move to…'}</option>
                          {PHASES.filter((other) => other !== phase).map((other) => (
                            <option key={other} value={other}>
                              {PHASE_LABEL[other]}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
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
      <div className="text-[10.5px] text-neutral-500">Photos are shown to the client unless you untick them. “Move to” puts a photo in a different section. Deleting a photo removes it permanently.</div>
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
  const [movePendingId, setMovePendingId] = useState<string | null>(null);
  const moving = useRef(new Set<string>());
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

  /**
   * Moves a photo to another section. The screen shows it in its new place straight away; if the save fails the photo goes back where it
   * was and the reason is shown under it. A second move of the SAME photo is ignored while the first is still saving.
   */
  const onMove = async (photo: ReportPhoto, toPhase: ReportPhoto['phase']) => {
    if (completed || toPhase === photo.phase || moving.current.has(photo.id)) return;
    moving.current.add(photo.id);
    setRowError(null);
    setMovePendingId(photo.id);
    const key = ['reportPhotos', reportId];
    const previous = queryClient.getQueryData<ReportPhoto[]>(key);
    queryClient.setQueryData<ReportPhoto[]>(key, (old) => (old ?? []).map((x) => (x.id === photo.id ? { ...x, phase: toPhase } : x)));
    try {
      await moveReportPhoto(photo, toPhase, reportId, actor);
      await refresh();
    } catch (e) {
      if (previous) queryClient.setQueryData(key, previous);
      else await refresh();
      setRowError({ id: photo.id, message: explainPhotoError(e) });
    } finally {
      moving.current.delete(photo.id);
      setMovePendingId(null);
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
      movePendingId={movePendingId}
      onMove={(photo, toPhase) => void onMove(photo, toPhase)}
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
