// Data-access layer for the MANAGER adding and removing photos on a report (Report Review). Technicians add photos through the
// offline queue and the submit RPCs (src/technician/); this is the office's direct path, using the signed-in manager's own session.
//
// What the database already allows (no migration needed): the manager has full access to public.photos (policy manager_full_access)
// and to the private `visit-photos` bucket (policy manager_visit_photos_all). Nothing at the database level stops a manager changing the
// photos of a Completed report, so the screen disables the controls for a Completed report - that rule lives in the UI only.
//
// A photo is two things that must agree: a file in the bucket and a row in `photos`. Adding uploads the file first and then creates the
// row (and removes the file again if the row cannot be created, so a failure leaves nothing behind). Removing deletes the row first and
// then the file (a file left behind after a failed cleanup is no longer referenced by anything, so nothing is lost or exposed).
import { supabase } from '../lib/supabaseClient';
import { preparePhotoForUpload } from '../technician/offline/photoCompression';
import { logActivityEvent } from './activityEventsRepository';
import type { ReportPhoto } from './reportsRepository';

export const VISIT_PHOTOS_BUCKET = 'visit-photos';
/** Larger originals are refused before anything is uploaded (the bucket's own limit is 50 MiB). */
export const PHOTO_MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;

export type PhotoPhase = ReportPhoto['phase'];

/** Why a picked file cannot be added, in plain words; null when it is fine. */
export function checkPhotoFile(file: { name: string; type: string; size: number }): string | null {
  if (file.type && !file.type.startsWith('image/')) return `“${file.name}” is not a photo. Choose an image file.`;
  if (!file.type && !/\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name)) return `“${file.name}” is not a photo. Choose an image file.`;
  if (file.size <= 0) return `“${file.name}” is empty.`;
  if (file.size > PHOTO_MAX_ORIGINAL_BYTES) return `“${file.name}” is too large (the limit is 50 MB).`;
  return null;
}

/** Turns a storage / database failure into something a manager can act on. */
export function explainPhotoError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = raw.toLowerCase();
  if (text.includes('row-level security') || text.includes('row level security') || text.includes('permission denied') || text.includes('not authorized') || text.includes('unauthorized')) {
    return 'You don’t have permission to change photos on this report.';
  }
  if (text.includes('exceeded the maximum') || text.includes('payload too large') || text.includes('too large') || text.includes('413')) {
    return 'This photo is too large to upload.';
  }
  if (text.includes('failed to fetch') || text.includes('networkerror') || text.includes('network request failed') || text.includes('load failed')) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (text.includes('already been removed') || text.includes('not found')) return 'That photo has already been removed.';
  return raw ? `Something went wrong: ${raw}` : 'Something went wrong. Please try again.';
}

function extensionOf(filename: string): string {
  const ext = filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : '';
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg';
}

interface PhotoRow {
  id: string;
  phase: PhotoPhase;
  storage_path: string;
  upload_status: ReportPhoto['uploadStatus'];
  include_in_client_report: boolean;
}

const PHOTO_SELECT = 'id, phase, storage_path, upload_status, include_in_client_report';

function mapPhoto(row: PhotoRow): ReportPhoto {
  return { id: row.id, phase: row.phase, storagePath: row.storage_path, uploadStatus: row.upload_status, includeInClientReport: row.include_in_client_report };
}

export interface AddReportPhotoInput {
  reportId: string;
  visitId: string;
  phase: PhotoPhase;
  file: File;
  actor: string;
}

/**
 * Adds one photo to a report as the signed-in manager. The photo is shrunk to at most 1600 px (JPEG) like technicians' photos, saved
 * under {visit}/{phase}/{new uuid}, and recorded as an uploaded photo included for the client (the manager can untick it). The row has
 * no technician (technician_id stays empty): it belongs to the office, not to anyone's submission.
 */
export async function addReportPhoto(input: AddReportPhotoInput): Promise<ReportPhoto> {
  const problem = checkPhotoFile(input.file);
  if (problem) throw new Error(problem);

  const prepared = await preparePhotoForUpload(input.file);
  const extension = prepared.resized ? 'jpg' : extensionOf(prepared.filename);
  const path = `${input.visitId}/${input.phase}/${crypto.randomUUID()}.${extension}`;
  const contentType = prepared.blob.type || input.file.type || 'image/jpeg';

  const { error: uploadError } = await supabase.storage.from(VISIT_PHOTOS_BUCKET).upload(path, prepared.blob, { upsert: false, contentType });
  if (uploadError) throw new Error(uploadError.message);

  const { data, error } = await supabase
    .from('photos')
    .insert({
      report_id: input.reportId,
      phase: input.phase,
      storage_path: path,
      upload_status: 'uploaded',
      uploaded_at: new Date().toISOString(),
      include_in_client_report: true,
      technician_id: null,
    })
    .select(PHOTO_SELECT)
    .single();
  if (error || !data) {
    // The record was never created, so the file is unreferenced: take it away again (best effort).
    await supabase.storage.from(VISIT_PHOTOS_BUCKET).remove([path]).catch(() => undefined);
    throw new Error(error?.message ?? 'The photo could not be saved.');
  }

  await logActivityEvent('report', input.reportId, 'report_photo_added', input.actor, input.phase);
  return mapPhoto(data as unknown as PhotoRow);
}

export interface RemoveReportPhotoResult {
  /** True when the record was removed but its file could not be deleted (nothing references it any more; it is only wasted space). */
  fileCleanupFailed: boolean;
}

/** Permanently removes a photo from a report: the record first, then its file. The removal is written to the report's history. */
export async function removeReportPhoto(photo: Pick<ReportPhoto, 'id' | 'phase' | 'storagePath'>, reportId: string, actor: string): Promise<RemoveReportPhotoResult> {
  const { data, error } = await supabase.from('photos').delete().eq('id', photo.id).eq('report_id', reportId).select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('That photo has already been removed.');

  let fileCleanupFailed = false;
  try {
    const { error: removeError } = await supabase.storage.from(VISIT_PHOTOS_BUCKET).remove([photo.storagePath]);
    if (removeError) fileCleanupFailed = true;
  } catch {
    fileCleanupFailed = true;
  }

  await logActivityEvent('report', reportId, 'report_photo_removed', actor, photo.phase);
  return { fileCleanupFailed };
}
