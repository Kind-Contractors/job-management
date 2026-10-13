// Data-access layer for report videos (manager side). Videos are linked to the VISIT (reports.visit_id is unique), live in the
// private `report-videos` bucket, and are described by the `report_videos` table - see migration
// 20261012130000_report_videos_foundation and 20261012140100_report_videos_hardening.
//
// Everything here uses the signed-in manager's own session; the database and Storage policies are the real authority:
//   * a video row is validated by a trigger (size, type, extension, limits, the file must really exist with that size);
//   * a Completed report refuses new videos and any inclusion change (a video can still be removed);
//   * a manager can never hard-delete a video row or the file of an attached video - removing a video is a SOFT delete that
//     the database turns into "revoke every link to it, keep the file, write an audit event".
// This code only ever sends well-formed requests and passes the database's own readable refusals through to the manager.
import { supabase } from '../lib/supabaseClient';
import type { VideoMime, VideoPhase } from '../lib/reportVideoRules';
import { resumableEndpoint, resumableUpload, type ResumableUploader } from '../lib/reportVideoUpload';

export const REPORT_VIDEO_BUCKET = 'report-videos';

export interface ReportVideo {
  id: string;
  visitId: string;
  phase: VideoPhase;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  source: 'technician' | 'manager';
  /** The technician's name for a technician's video; null for one added by the office. */
  uploadedByName: string | null;
  /** True by default (the manager unticks a video to keep it from the client). The client report shows a video only while this is on. */
  includeInClientReport: boolean;
  createdAt: string;
}

interface ReportVideoRow {
  id: string;
  visit_id: string;
  phase: VideoPhase;
  storage_path: string;
  thumbnail_path: string | null;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | string | null;
  source: 'technician' | 'manager';
  include_in_client_report: boolean;
  created_at: string;
  technicians?: { name: string } | { name: string }[] | null;
}

const VIDEO_SELECT =
  'id, visit_id, phase, storage_path, thumbnail_path, mime_type, size_bytes, duration_seconds, source, include_in_client_report, created_at, technicians ( name )';

function mapVideo(row: ReportVideoRow): ReportVideo {
  const tech = Array.isArray(row.technicians) ? row.technicians[0] : row.technicians;
  return {
    id: row.id,
    visitId: row.visit_id,
    phase: row.phase,
    storagePath: row.storage_path,
    thumbnailPath: row.thumbnail_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    // numeric columns come back as strings from some clients
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    source: row.source,
    uploadedByName: tech?.name ?? null,
    includeInClientReport: row.include_in_client_report,
    createdAt: row.created_at,
  };
}

/** The visit's videos that have not been removed, oldest first. [] for a visit (or an older report) with none. */
export async function listVideosForVisit(visitId: string): Promise<ReportVideo[]> {
  const { data, error } = await supabase
    .from('report_videos')
    .select(VIDEO_SELECT)
    .eq('visit_id', visitId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load videos: ${error.message}`);
  return ((data ?? []) as unknown as ReportVideoRow[]).map(mapVideo);
}

/** Playback links last 10 minutes and are made only when the manager presses Play - they are never stored or shown in the page. */
export const VIDEO_PLAYBACK_URL_SECONDS = 600;
/** Poster links are made with the list and re-made when it reloads. */
export const VIDEO_THUMBNAIL_URL_SECONDS = 600;

export async function signVideoPlaybackUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(REPORT_VIDEO_BUCKET).createSignedUrl(storagePath, VIDEO_PLAYBACK_URL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(`Failed to prepare the video for playback: ${error?.message ?? 'no link returned'}`);
  return data.signedUrl;
}

/** One signed poster link per video that has a thumbnail ('' when signing failed, so one bad file never hides the rest). */
export async function signVideoThumbnailUrls(videos: ReportVideo[]): Promise<Record<string, string>> {
  const withThumb = videos.filter((v) => v.thumbnailPath);
  const entries = await Promise.all(
    withThumb.map(async (v) => {
      const { data } = await supabase.storage.from(REPORT_VIDEO_BUCKET).createSignedUrl(v.thumbnailPath!, VIDEO_THUMBNAIL_URL_SECONDS);
      return [v.id, data?.signedUrl ?? ''] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export interface UploadReportVideoInput {
  visitId: string;
  phase: VideoPhase;
  file: File;
  /** From checkVideoSelection(): the stored type and extension. */
  mime: VideoMime;
  ext: 'mp4' | 'mov' | 'webm';
  durationSeconds: number | null;
  /** A JPEG poster (at most 1 MiB), or null. */
  thumbnail: Blob | null;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
  /** Called when the upload of the video file itself is done and the record is about to be saved. */
  onSaving?: () => void;
  signal?: AbortSignal;
}

export interface UploadReportVideoDeps {
  uploader?: ResumableUploader;
  getAccessToken?: () => Promise<string>;
}

async function currentAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('You are signed out. Sign in again to upload.');
  return data.session.access_token;
}

/**
 * Adds a video to a visit as the signed-in manager:
 *   1. the JPEG poster (small, one request) - if this fails the video still goes ahead without a poster;
 *   2. the video file, resumable, straight to the private bucket under {visit}/{phase}/{new uuid}.{ext};
 *   3. the report_videos record (source 'manager', included for the client by default; the manager can untick it).
 * Every attempt uses fresh names, so a retry can never collide with or reuse a half-finished earlier attempt. If anything after
 * the file upload fails, the files THIS attempt uploaded are removed again (allowed because no record points at them yet), so
 * failed attempts do not leave files behind.
 */
export async function uploadReportVideo(input: UploadReportVideoInput, deps: UploadReportVideoDeps = {}): Promise<ReportVideo> {
  const uploader = deps.uploader ?? resumableUpload;
  const getAccessToken = deps.getAccessToken ?? currentAccessToken;
  const base = `${input.visitId}/${input.phase}/${crypto.randomUUID()}`;
  const videoPath = `${base}.${input.ext}`;
  const thumbPath = `${input.visitId}/${input.phase}/${crypto.randomUUID()}.jpg`;
  const uploaded: string[] = [];

  try {
    let thumbnailPath: string | null = null;
    if (input.thumbnail) {
      const { error } = await supabase.storage
        .from(REPORT_VIDEO_BUCKET)
        .upload(thumbPath, input.thumbnail, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
      if (!error) {
        uploaded.push(thumbPath);
        thumbnailPath = thumbPath;
      }
    }

    const url = import.meta.env.VITE_SUPABASE_URL as string;
    const apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
    await uploader({
      endpoint: resumableEndpoint(url),
      apiKey,
      bucket: REPORT_VIDEO_BUCKET,
      objectName: videoPath,
      file: input.file,
      contentType: input.mime,
      getAccessToken,
      onProgress: input.onProgress,
      signal: input.signal,
    });
    uploaded.push(videoPath);

    input.onSaving?.();
    const { data, error } = await supabase
      .from('report_videos')
      .insert({
        visit_id: input.visitId,
        phase: input.phase,
        storage_path: videoPath,
        thumbnail_path: thumbnailPath,
        mime_type: input.mime,
        size_bytes: input.file.size,
        duration_seconds: input.durationSeconds,
        source: 'manager',
        include_in_client_report: true,
      })
      .select(VIDEO_SELECT)
      .single();
    if (error) throw new Error(error.message);
    return mapVideo(data as unknown as ReportVideoRow);
  } catch (error) {
    if (uploaded.length > 0) {
      // Best effort: the record was never created, so these files are unreferenced and the manager may delete them.
      await supabase.storage.from(REPORT_VIDEO_BUCKET).remove(uploaded).catch(() => undefined);
    }
    throw error;
  }
}

/** Ticks / unticks "Include for client" on one video. Refused by the database on a Completed report. */
export async function setVideoClientInclusion(videoId: string, included: boolean): Promise<void> {
  const { data, error } = await supabase
    .from('report_videos')
    .update({ include_in_client_report: included })
    .eq('id', videoId)
    .is('deleted_at', null)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('That video is no longer available. Refresh and try again.');
}

/**
 * Removes a video: a SOFT delete only. The database records who removed it (from the session), revokes every client link to it
 * and writes the audit event; the file itself is kept (a manager has no way to delete it). Allowed even on a Completed report.
 */
export async function removeReportVideo(videoId: string, actor: string): Promise<void> {
  const { data, error } = await supabase
    .from('report_videos')
    .update({ deleted_at: new Date().toISOString(), deleted_by: actor })
    .eq('id', videoId)
    .is('deleted_at', null)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('That video has already been removed.');
}

// ---- visits that have videos but no report yet -------------------------------------------------------------------------------

/** A visit with at least one video that has not been removed and NO report - so none of the report queues shows it. */
export interface VisitWithVideosNoReport {
  visitId: string;
  scheduledDate: string | null;
  visitStatus: string;
  jobId: string;
  jobSummary: string | null;
  /** Of the job: 'cancelled' means the visit was kept when the job was cancelled, because of its video. */
  jobLifecycleStatus: string | null;
  buildingId: string | null;
  buildingName: string | null;
  buildingAddress: string | null;
  clientName: string | null;
  videos: ReportVideo[];
}

interface BuildingEmbed {
  id: string;
  name: string | null;
  address: string | null;
  clients?: { company_name: string | null } | { company_name: string | null }[] | null;
}

export interface VideoWithVisitRow extends ReportVideoRow {
  visits?: {
    id: string;
    scheduled_date: string | null;
    status: string;
    reports?: { id: string }[] | { id: string } | null;
    jobs?: { id: string; job_summary: string | null; lifecycle_status: string | null; buildings?: BuildingEmbed | BuildingEmbed[] | null } | null;
  } | null;
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * Groups active videos by visit and keeps only the visits WITHOUT a report (the report queues already show the rest). Pure, so it can
 * be tested without a network. Visits sort by date, newest first; a video row with no visit attached is ignored.
 */
export function groupVisitsWithoutReport(rows: VideoWithVisitRow[]): VisitWithVideosNoReport[] {
  const byVisit = new Map<string, VisitWithVideosNoReport>();
  for (const row of rows) {
    const visit = row.visits;
    if (!visit) continue;
    if (one(visit.reports)) continue; // it has a report: Report review / Ready for client own it
    let entry = byVisit.get(visit.id);
    if (!entry) {
      const job = visit.jobs ?? null;
      const building = one(job?.buildings);
      const client = one(building?.clients);
      entry = {
        visitId: visit.id,
        scheduledDate: visit.scheduled_date,
        visitStatus: visit.status,
        jobId: job?.id ?? '',
        jobSummary: job?.job_summary ?? null,
        jobLifecycleStatus: job?.lifecycle_status ?? null,
        buildingId: building?.id ?? null,
        buildingName: building?.name ?? null,
        buildingAddress: building?.address ?? null,
        clientName: client?.company_name ?? null,
        videos: [],
      };
      byVisit.set(visit.id, entry);
    }
    entry.videos.push(mapVideo(row));
  }
  return [...byVisit.values()].sort((a, b) => (b.scheduledDate ?? '').localeCompare(a.scheduledDate ?? ''));
}

/**
 * Every active video whose visit has no report, grouped by visit, with enough to identify the client, building, job and date.
 * Includes visits kept on a cancelled job (cancel_job_work keeps a visit that has a video). Read-only; removing a video from here
 * is the same soft delete as anywhere else (removeReportVideo).
 */
export async function listVisitsWithVideosNoReport(): Promise<VisitWithVideosNoReport[]> {
  const { data, error } = await supabase
    .from('report_videos')
    .select(
      `${VIDEO_SELECT}, visits ( id, scheduled_date, status, reports ( id ), jobs ( id, job_summary, lifecycle_status, buildings ( id, name, address, clients ( company_name ) ) ) )`,
    )
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load videos without a report: ${error.message}`);
  return groupVisitsWithoutReport((data ?? []) as unknown as VideoWithVisitRow[]);
}

// ---------------------------------------------------------------------------
// Client "Watch video" links (see docs/client-video-links.md)
// ---------------------------------------------------------------------------

/**
 * Asks the manager-only issue-report-video-links Edge Function for the client watch URL of every video that is shareable on this report
 * (it reuses a video's valid link, or makes one). Returns videoId -> URL. The URLs contain the link's secret token: callers put them
 * straight into the PDF and must never log, store or display them. Any failure is reported in plain words WITHOUT the server's message.
 */
export async function issueClientVideoLinks(reportId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase.functions.invoke<{ links?: { videoId?: unknown; url?: unknown }[] }>('issue-report-video-links', {
    body: { reportId },
  });
  if (error || !data || !Array.isArray(data.links)) throw new Error('The video links could not be created.');
  const out: Record<string, string> = {};
  for (const link of data.links) {
    if (typeof link.videoId === 'string' && typeof link.url === 'string' && /^https?:\/\//.test(link.url)) out[link.videoId] = link.url;
  }
  return out;
}
