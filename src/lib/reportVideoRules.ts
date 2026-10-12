// Rules for report videos, kept in one place and free of React / network so they can be tested directly.
//
// These mirror the database (migration 20261012130000_report_videos_foundation: private.report_video_limits(), the
// report_videos CHECK constraints and the guard trigger) and the `report-videos` bucket settings. They are here so the
// manager gets an immediate, readable answer BEFORE a 150 MB upload starts - the database and Storage still enforce every
// one of them themselves, and are the only things that count for security.

export type VideoPhase = 'before' | 'during' | 'after';

export const VIDEO_PHASES: VideoPhase[] = ['before', 'during', 'after'];
export const VIDEO_PHASE_LABEL: Record<VideoPhase, string> = { before: 'Before', during: 'During', after: 'After' };

export const REPORT_VIDEO_LIMITS = {
  /** 150 MiB - equal to the bucket's file_size_limit and report_videos_size_check. */
  maxBytes: 157_286_400,
  /** Advertised limit in seconds. The database allows 1 second more, as a rounding allowance for what a phone reports. */
  maxSeconds: 60,
  maxPerPhase: 3,
  maxPerVisit: 8,
  /** Thumbnails are JPEGs of at most 1 MiB (checked by the database trigger). */
  maxThumbnailBytes: 1_048_576,
} as const;

/** The only video types the bucket and database accept, and the file extension each one is stored under. */
export const VIDEO_TYPES = [
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/quicktime', ext: 'mov' },
  { mime: 'video/webm', ext: 'webm' },
] as const;
export type VideoMime = (typeof VIDEO_TYPES)[number]['mime'];
export type VideoExt = (typeof VIDEO_TYPES)[number]['ext'];

/** For the file picker's `accept` attribute (extensions are listed too, because some browsers report no type for .mov). */
export const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm';

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** m:ss, for a video's length. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Works out the stored type of a picked file: its reported type when that is one we accept, otherwise the type implied by its
 * extension (Windows often reports no type for .mov). Returns null for anything else.
 */
export function resolveVideoType(file: { name: string; type: string }): { mime: VideoMime; ext: VideoExt } | null {
  const byMime = VIDEO_TYPES.find((t) => t.mime === file.type.toLowerCase());
  if (byMime) return { mime: byMime.mime, ext: byMime.ext };
  const m = /\.([a-z0-9]+)$/i.exec(file.name);
  const byExt = m ? VIDEO_TYPES.find((t) => t.ext === m[1].toLowerCase()) : undefined;
  return byExt ? { mime: byExt.mime, ext: byExt.ext } : null;
}

export interface VideoCounts {
  /** Active (not removed) videos in the phase being added to. */
  inPhase: number;
  /** Active videos on the whole visit. */
  inVisit: number;
}

export function countVideos(videos: { phase: VideoPhase }[], phase: VideoPhase): VideoCounts {
  return { inPhase: videos.filter((v) => v.phase === phase).length, inVisit: videos.length };
}

export type VideoSelectionCheck =
  | { ok: true; mime: VideoMime; ext: VideoExt }
  | { ok: false; message: string };

/** The checks that need only the file and the counts - done the moment a file is picked. */
export function checkVideoSelection(file: { name: string; type: string; size: number }, phase: VideoPhase, counts: VideoCounts): VideoSelectionCheck {
  const type = resolveVideoType(file);
  if (!type) return { ok: false, message: 'That file type isn’t accepted. Use an MP4, MOV or WebM video.' };
  if (file.size <= 0) return { ok: false, message: 'That file is empty.' };
  if (file.size > REPORT_VIDEO_LIMITS.maxBytes) {
    return { ok: false, message: `That video is ${formatBytes(file.size)}. The limit is ${formatBytes(REPORT_VIDEO_LIMITS.maxBytes)}.` };
  }
  if (counts.inPhase >= REPORT_VIDEO_LIMITS.maxPerPhase) {
    return { ok: false, message: `The ${VIDEO_PHASE_LABEL[phase]} section already has ${REPORT_VIDEO_LIMITS.maxPerPhase} videos, which is the most it can hold. Remove one first.` };
  }
  if (counts.inVisit >= REPORT_VIDEO_LIMITS.maxPerVisit) {
    return { ok: false, message: `This report already has ${REPORT_VIDEO_LIMITS.maxPerVisit} videos, which is the most it can hold. Remove one first.` };
  }
  return { ok: true, mime: type.mime, ext: type.ext };
}

/** Duration is only known once the browser has read the file; null means it could not be read (it is then left to the server). */
export function checkVideoDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds > REPORT_VIDEO_LIMITS.maxSeconds + 1) {
    return `That video is ${formatDuration(seconds)} long. The limit is ${formatDuration(REPORT_VIDEO_LIMITS.maxSeconds)}.`;
  }
  return null;
}

export const COMPLETED_VIDEOS_MESSAGE =
  'This report is marked Completed, so videos can’t be added or changed. Reopen it first (Ready for client, then the Completed tab, then Reopen). A video can still be removed.';

/**
 * Turns whatever the upload / database / Storage said into one plain sentence for the manager. Messages the database raised on
 * purpose (limits, Completed, etc.) are already readable and are passed through; the technical ones are translated.
 */
export function explainVideoError(error: unknown): string {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : NaN;
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw.replace(/^(Failed to [a-z ]+:\s*)/i, '');
  if (status === 413 || /payload too large|exceeded the maximum allowed size|too large/i.test(text)) {
    return `That video is larger than the ${formatBytes(REPORT_VIDEO_LIMITS.maxBytes)} limit.`;
  }
  if (status === 415 || /mime type .* is not supported|unsupported.*type|invalid_mime/i.test(text)) {
    return 'That file type isn’t accepted. Use an MP4, MOV or WebM video.';
  }
  if (/row-level security|permission denied|not authorized|unauthorized/i.test(text) || status === 401 || status === 403) {
    return 'You don’t have permission to do that. If this report is marked Completed, reopen it first.';
  }
  if (/marked Completed/i.test(text)) return COMPLETED_VIDEOS_MESSAGE;
  if (/network|failed to fetch|load failed|offline|timeout|aborted/i.test(text) && !/limit|Only \d/.test(text)) {
    return 'The upload was interrupted. Check your connection and try again.';
  }
  return text || 'Something went wrong. Please try again.';
}
