// Photos and videos chosen in "Complete & report" (OfficeReportDialog) BEFORE the report exists. They stay in the browser until the
// office report is saved (one database call: visit completed, report created and approved), and are then added to it one by one with
// the SAME functions Report review uses - addReportPhoto / uploadReportVideo - each told the manager's "Include for client" choice, so the
// row is CREATED with it: a file the manager excluded is never, even for a moment, included (there is no second "untick" call that could
// fail or be cut off). Nothing here talks to the database itself, and nothing is ever saved twice:
//   * an item that was added keeps its new id, so a retry never adds it again;
//   * the report and visit are saved once, before any of this runs (OfficeReportForm, idempotent per request id), and are never re-sent
//     by a media retry.
// Pure apart from the injected upload functions, so the whole sequence can be tested without a network.
import { REPORT_VIDEO_LIMITS, VIDEO_PHASE_LABEL, checkVideoSelection, countVideos, type VideoPhase } from './reportVideoRules';
import type { VideoMime, VideoExt } from './reportVideoRules';

export type MediaPhase = VideoPhase;
export const MEDIA_PHASES: MediaPhase[] = ['before', 'during', 'after'];
export const MEDIA_PHASE_LABEL = VIDEO_PHASE_LABEL;

/**
 * 'checking' - a video whose length and poster are still being read; 'ready' - chosen, not sent yet; 'adding' - being added now;
 * 'added' - on the report; 'failed' - not added, see `error` (nothing of it is on the report).
 */
export type StagedStatus = 'checking' | 'ready' | 'adding' | 'added' | 'failed';

export interface StagedMedia {
  id: string;
  kind: 'photo' | 'video';
  phase: MediaPhase;
  file: File;
  /** A local preview (the photo itself, or the video's poster frame) - an object URL the dialog revokes when it is done with it. */
  previewUrl: string | null;
  /** "Include for client" - on by default, as everywhere else. */
  include: boolean;
  status: StagedStatus;
  /** 0..1 while a video is being sent. */
  progress?: number;
  error?: string;
  /** The new photo / video id once it is on the report. Set = never added again (and its inclusion was fixed when it was created). */
  savedId?: string;
  /** Video only: from checkVideoSelection / readVideoMetadata at the moment it was chosen. */
  video?: { mime: VideoMime; ext: VideoExt; durationSeconds: number | null; thumbnail: Blob | null };
}

/** Items still to send: not yet added (chosen, or a failed attempt). */
export function pendingMedia(items: StagedMedia[]): StagedMedia[] {
  return items.filter((m) => m.status === 'ready' || m.status === 'failed' || m.status === 'adding');
}

/**
 * Video limits with what is already on the visit (a technician may have added videos to a visit that has no report yet) plus what is
 * chosen here. Null when everything fits. Checked again just before saving, because choosing a different visit changes the first part.
 */
export function stagedVideoProblem(items: StagedMedia[], existing: { phase: MediaPhase }[]): string | null {
  const videos = [...existing, ...items.filter((m) => m.kind === 'video')];
  if (videos.length > REPORT_VIDEO_LIMITS.maxPerVisit) {
    return `A report can have at most ${REPORT_VIDEO_LIMITS.maxPerVisit} videos${existing.length ? ` (this visit already has ${existing.length})` : ''}. Remove some first.`;
  }
  for (const phase of MEDIA_PHASES) {
    const n = videos.filter((v) => v.phase === phase).length;
    if (n > REPORT_VIDEO_LIMITS.maxPerPhase) {
      return `The ${VIDEO_PHASE_LABEL[phase]} section can have at most ${REPORT_VIDEO_LIMITS.maxPerPhase} videos${existing.length ? ' (counting the ones already on this visit)' : ''}. Remove or move some first.`;
    }
  }
  return null;
}

/** The pick-time check for one more video in `phase` (type, size, per-section and per-report limits). */
export function checkStagedVideo(file: File, phase: MediaPhase, items: StagedMedia[], existing: { phase: MediaPhase }[]) {
  return checkVideoSelection(file, phase, countVideos([...existing, ...items.filter((m) => m.kind === 'video')], phase));
}

/** Sections a video could move to: the other two, minus any that is already full. Photos can always move. */
export function moveTargets(item: StagedMedia, items: StagedMedia[], existing: { phase: MediaPhase }[]): MediaPhase[] {
  const others = MEDIA_PHASES.filter((p) => p !== item.phase);
  if (item.kind === 'photo') return others;
  const videos = [...existing, ...items.filter((m) => m.kind === 'video')];
  return others.filter((p) => videos.filter((v) => v.phase === p).length < REPORT_VIDEO_LIMITS.maxPerPhase);
}

export interface MediaUploadDeps {
  addPhoto: (input: { reportId: string; visitId: string; phase: MediaPhase; file: File; actor: string; includeInClientReport: boolean }) => Promise<{ id: string }>;
  addVideo: (input: {
    visitId: string;
    phase: MediaPhase;
    file: File;
    mime: VideoMime;
    ext: VideoExt;
    durationSeconds: number | null;
    thumbnail: Blob | null;
    includeInClientReport: boolean;
    onProgress?: (sent: number, total: number) => void;
  }) => Promise<{ id: string }>;
  explainPhotoError: (e: unknown) => string;
  explainVideoError: (e: unknown) => string;
}

/**
 * Adds every pending item to the saved report, one at a time (photos first, then videos, in the order they were chosen), reporting each
 * change through `onChange`. Never throws: a failure is recorded on that item and the next one still goes. Returns the final list.
 */
export async function uploadStagedMedia(
  items: StagedMedia[],
  target: { reportId: string; visitId: string; actor: string },
  deps: MediaUploadDeps,
  onChange: (id: string, patch: Partial<StagedMedia>) => void,
): Promise<StagedMedia[]> {
  const result = new Map(items.map((m) => [m.id, m]));
  const set = (id: string, patch: Partial<StagedMedia>) => {
    result.set(id, { ...result.get(id)!, ...patch });
    onChange(id, patch);
  };
  const queue = pendingMedia(items)
    .filter((m) => !m.savedId)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'photo' ? -1 : 1));
  for (const item of queue) {
    const explain = item.kind === 'photo' ? deps.explainPhotoError : deps.explainVideoError;
    set(item.id, { status: 'adding', error: undefined, progress: 0 });
    try {
      // The inclusion choice goes INTO the insert: the row never exists with any other value.
      const savedId =
        item.kind === 'photo'
          ? (await deps.addPhoto({ reportId: target.reportId, visitId: target.visitId, phase: item.phase, file: item.file, actor: target.actor, includeInClientReport: item.include })).id
          : (
              await deps.addVideo({
                visitId: target.visitId,
                phase: item.phase,
                file: item.file,
                mime: item.video!.mime,
                ext: item.video!.ext,
                durationSeconds: item.video!.durationSeconds,
                thumbnail: item.video!.thumbnail,
                includeInClientReport: item.include,
                onProgress: (sent, total) => onChange(item.id, { progress: total > 0 ? sent / total : 0 }),
              })
            ).id;
      set(item.id, { status: 'added', savedId, progress: 1 });
    } catch (e) {
      set(item.id, { status: 'failed', error: explain(e) });
    }
  }
  return [...result.values()];
}
