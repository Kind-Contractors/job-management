import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PhotoFileCleanupError,
  deleteSubmittedPhoto,
  listMyReportPhotos,
  removePhotoObject,
  signPhotoUrls,
  type PhotoPhase,
  type TechnicianOwnPhoto,
} from './api';
import { technicianKeys } from './queryKeys';
import PhotoDeleteButton from './PhotoDeleteButton';

const PHASE_LABEL: Record<PhotoPhase, string> = { before: 'Before', during: 'During', after: 'After' };

interface ExistingReportPhotosProps {
  userId: string;
  visitId: string;
  /** Greys out deletion while the report is being completed. */
  disabled?: boolean;
}

/**
 * The technician OWN photos that are already part of their report, shown only while their part has
 * been returned for correction (that is when the database lets them be removed). Each one has a
 * delete action with a confirmation. The list comes from the database, so another technician
 * photos on a shared visit never appear here.
 *
 * Deleting removes the database record first and then the file. If only the file step fails, the
 * photo is already out of the report and a "tap to retry" row stays until the file is gone.
 */
export default function ExistingReportPhotos({ userId, visitId, disabled }: ExistingReportPhotosProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<string[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);

  const { data: photos = [] } = useQuery({
    queryKey: technicianKeys.myPhotos(userId, visitId),
    queryFn: () => listMyReportPhotos(visitId),
    enabled: userId !== '',
  });
  const deletable = photos.filter((p) => p.canDelete);

  const paths = photos.map((p) => p.storagePath);
  const { data: urls = {} } = useQuery({
    queryKey: [...technicianKeys.myPhotos(userId, visitId), 'urls', paths.join('|')],
    queryFn: () => signPhotoUrls(paths),
    enabled: paths.length > 0,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: technicianKeys.myPhotos(userId, visitId) });
    void queryClient.invalidateQueries({ queryKey: technicianKeys.visitDetail(userId, visitId) });
  };

  const handleDelete = async (photo: TechnicianOwnPhoto) => {
    setError(null);
    try {
      await deleteSubmittedPhoto(photo.storagePath);
    } catch (err) {
      if (err instanceof PhotoFileCleanupError) {
        // The record is gone, only the file is left: say so explicitly and keep a retry.
        setCleanup((prev) => [...prev, photo.storagePath]);
        setError(err.message);
        refresh();
        return;
      }
      throw err; // PhotoDeleteButton shows it and the photo stays
    }
    refresh();
  };

  const retryCleanup = async (path: string) => {
    setRetrying(path);
    try {
      await removePhotoObject(path);
      setCleanup((prev) => prev.filter((p) => p !== path));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The photo file could not be deleted.');
    } finally {
      setRetrying(null);
    }
  };

  if (photos.length === 0 && cleanup.length === 0) return null;

  return (
    <div className="mb-2 border border-neutral-300 bg-neutral-50 p-2">
      <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
        Your photos already in the report
      </div>
      {deletable.length === 0 && photos.length > 0 && (
        <div className="mb-1 text-[11px] text-neutral-500">These cannot be removed right now.</div>
      )}
      <div className="flex flex-wrap gap-2">
        {photos.map((p) => (
          <div key={p.storagePath} className="relative flex flex-col items-center gap-0.5">
            <div
              className="h-14 w-14 flex-none border border-neutral-300 bg-neutral-200"
              style={urls[p.storagePath] ? { backgroundImage: `url(${urls[p.storagePath]})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
            />
            <span className="text-center text-[8.5px] leading-tight text-neutral-500">{PHASE_LABEL[p.phase]}</span>
            {p.canDelete && (
              <PhotoDeleteButton
                needsConfirm
                disabled={disabled}
                ariaLabel={`Delete ${PHASE_LABEL[p.phase].toLowerCase()} photo from the report`}
                onDelete={() => handleDelete(p)}
                onError={setError}
              />
            )}
          </div>
        ))}
      </div>
      {cleanup.map((path) => (
        <div key={path} className="mt-1.5 flex items-center gap-2 border border-due bg-due/10 p-1.5 text-[11px] text-due-fg">
          <span className="flex-1">A deleted photo&apos;s file is still to be cleaned up.</span>
          <button
            type="button"
            disabled={retrying === path}
            onClick={() => void retryCleanup(path)}
            className="cursor-pointer border border-due px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50"
          >
            {retrying === path ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ))}
      {error && <div className="mt-1.5 border border-missed bg-missed/10 p-1.5 text-[11px] text-missed-fg">{error}</div>}
    </div>
  );
}
