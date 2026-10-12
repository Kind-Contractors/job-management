// The technician app's access to videos. Like every other technician call it goes ONLY through the database functions made for it
// (technician_attach_video / technician_my_videos / technician_delete_video) and the private `report-videos` bucket under the
// technician's OWN session - technicians have no table access to report_videos at all, and nothing here uses a service key.
//
// What the database enforces (migrations 20261012130000 and 20261012140100) and this app relies on, never re-implements:
//   * you must be on the visit (an inactive login is refused); the visit must not be cancelled; the report must not be Completed;
//   * the file must really exist in the bucket, uploaded by YOU, with exactly the size and type claimed; limits (150 MiB, 60 s,
//     3 per section, 8 per visit) are checked again; attaching the same file twice is a harmless repeat;
//   * you may remove your own video only until the office approves the report; removal is a soft delete.
import { supabase } from '../lib/supabaseClient';
import type { VideoMime, VideoPhase } from '../lib/reportVideoRules';
import { RpcError } from './api';

const REPORT_VIDEO_BUCKET = 'report-videos';

export interface TechnicianOwnVideo {
  id: string;
  phase: VideoPhase;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  createdAt: string;
  /** False once the office has approved the report: the video can no longer be removed from here. */
  canDelete: boolean;
}

interface RpcMyVideoRow {
  id: string;
  phase: VideoPhase;
  storage_path: string;
  thumbnail_path: string | null;
  mime_type: string;
  size_bytes: number | string;
  duration_seconds: number | string | null;
  created_at: string;
  can_delete: boolean;
}

/** The technician's OWN videos already recorded for this visit (not removed). Throws on failure so the screen can say so. */
export async function listMyVideos(visitId: string): Promise<TechnicianOwnVideo[]> {
  const { data, error } = await supabase.rpc('technician_my_videos', { p_visit_id: visitId });
  if (error) throw new Error(`Couldn't load your videos: ${error.message}`);
  return ((data ?? []) as RpcMyVideoRow[]).map((r) => ({
    id: r.id,
    phase: r.phase,
    storagePath: r.storage_path,
    thumbnailPath: r.thumbnail_path,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
    createdAt: r.created_at,
    canDelete: r.can_delete,
  }));
}

export interface AttachVideoInput {
  visitId: string;
  phase: VideoPhase;
  videoPath: string;
  thumbnailPath: string | null;
  mime: VideoMime;
  sizeBytes: number;
  durationSeconds: number | null;
}

/** Records an uploaded video against the visit. Returns the new (or, on a repeat, the existing) video id. Throws RpcError with the SQLSTATE code. */
export async function attachVideo(input: AttachVideoInput): Promise<string> {
  const { data, error } = await supabase.rpc('technician_attach_video', {
    p_visit_id: input.visitId,
    p_phase: input.phase,
    p_storage_path: input.videoPath,
    p_thumbnail_path: input.thumbnailPath,
    p_mime_type: input.mime,
    p_size_bytes: input.sizeBytes,
    p_duration_seconds: input.durationSeconds,
  });
  if (error) throw new RpcError(error.message, error.code);
  return data as string;
}

/** Removes one of the technician's own videos (soft delete; the file is kept). Throws RpcError. */
export async function deleteMyVideo(videoId: string): Promise<void> {
  const { error } = await supabase.rpc('technician_delete_video', { p_video_id: videoId });
  if (error) throw new RpcError(error.message, error.code);
}

/** The file names for one new video: {visit}/{phase}/{uuid}.{ext} and its poster {visit}/{phase}/{uuid}.jpg (lower-case UUIDs, as the database requires). */
export function newVideoPaths(visitId: string, phase: VideoPhase, ext: 'mp4' | 'mov' | 'webm', withThumbnail: boolean): { videoPath: string; thumbPath: string | null } {
  const videoPath = `${visitId}/${phase}/${crypto.randomUUID()}.${ext}`;
  const thumbPath = withThumbnail ? `${visitId}/${phase}/${crypto.randomUUID()}.jpg` : null;
  return { videoPath, thumbPath };
}

/**
 * Uploads the poster. Idempotent for a retry: if an earlier attempt already stored it, nothing is sent again (the existence check is
 * covered by the technician's SELECT policy; an upsert would need an UPDATE policy technicians deliberately do not have).
 */
export async function uploadVideoThumbnail(path: string, blob: Blob): Promise<void> {
  const { data: exists } = await supabase.storage.from(REPORT_VIDEO_BUCKET).exists(path);
  if (exists) return;
  const { error } = await supabase.storage.from(REPORT_VIDEO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
  if (error) throw new Error(`Failed to upload the video thumbnail: ${error.message}`);
}

/** Best effort: removes files that no video record points at (allowed for the uploader). Never throws. */
export async function removeUnattachedVideoObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(REPORT_VIDEO_BUCKET).remove(paths);
  } catch {
    // The files are small leftovers the office can clear; nothing the technician needs to be told about.
  }
}

/** The signed-in technician's access token for a resumable upload; refuses clearly when signed out. */
export async function currentTechnicianAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('You are signed out. Sign in again to upload.');
  return data.session.access_token;
}

/** A 10-minute link to watch one of the technician's own videos (they may read only files they uploaded). */
export async function signOwnVideoUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(REPORT_VIDEO_BUCKET).createSignedUrl(storagePath, 600);
  if (error || !data?.signedUrl) throw new Error(`Couldn't open the video: ${error?.message ?? 'no link returned'}`);
  return data.signedUrl;
}

/** Poster links for videos already on the server; any that cannot be signed are left out (the card shows a placeholder). */
export async function signOwnVideoThumbs(videos: TechnicianOwnVideo[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    videos
      .filter((v) => v.thumbnailPath)
      .map(async (v) => {
        const { data } = await supabase.storage.from(REPORT_VIDEO_BUCKET).createSignedUrl(v.thumbnailPath!, 600);
        if (data?.signedUrl) out[v.id] = data.signedUrl;
      }),
  );
  return out;
}
