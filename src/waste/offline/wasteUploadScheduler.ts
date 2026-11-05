// Which file the waste upload queue works on next - plain functions, no network or storage, so the rules can be tested directly.
//
// TWO LANES run side by side (wasteSyncEngine.ts):
//   * the PHOTO lane - photos (each with its server check);
//   * the VIDEO lane - one video at a time (its poster, the resumable upload, its check).
// Photos come first: the video lane only STARTS a video when no photo is waiting. Reports take turns in both lanes (oldest report
// first, then the next one round), so one report's files - or one slow video - can't keep another report waiting. A file waiting out
// its retry pause is simply skipped. A file already being worked on ("claimed") is never picked again.
import type { WasteMedia } from './wasteDb';

export type UploadLane = 'photo' | 'video';

export function laneOf(m: Pick<WasteMedia, 'kind'>): UploadLane {
  return m.kind === 'video' ? 'video' : 'photo';
}

/** Can be worked on now: not finished, not stopped for good, not waiting out a pause, not already being worked on. */
export function isEligible(m: WasteMedia, now: number, claimed: ReadonlySet<string>): boolean {
  if (claimed.has(m.id)) return false;
  if (m.status === 'ready' || m.status === 'failed') return false;
  if (m.nextAttemptAt && Date.parse(m.nextAttemptAt) > now) return false;
  return true;
}

/** Reports in turn order: the drafts' own order (oldest first), then any other report with files, by its first file. */
export function reportOrder(media: WasteMedia[], draftOrder: string[]): string[] {
  const order = [...draftOrder];
  const extra = [...media].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((m) => m.reportId);
  for (const id of extra) if (!order.includes(id)) order.push(id);
  return order;
}

/**
 * The next file for `lane`, or null. Reports take turns: the search starts with the report AFTER `lastServedReport`. Within a report,
 * files go in the order they were added - except that a video already started (resumable upload under way, or paused for another
 * report's turn) carries on before a new one is begun.
 */
export function pickNext(
  lane: UploadLane,
  media: WasteMedia[],
  draftOrder: string[],
  lastServedReport: string | null,
  now: number,
  claimed: ReadonlySet<string>,
): WasteMedia | null {
  // Photos first: no video is started while a photo is waiting to be uploaded.
  if (lane === 'video' && media.some((m) => laneOf(m) === 'photo' && isEligible(m, now, claimed))) return null;
  const candidates = media.filter((m) => laneOf(m) === lane && isEligible(m, now, claimed));
  if (candidates.length === 0) return null;
  const order = reportOrder(media, draftOrder);
  const start = lastServedReport ? order.indexOf(lastServedReport) + 1 : 0;
  for (let i = 0; i < order.length; i++) {
    const reportId = order[(start + i) % order.length];
    const mine = candidates.filter((m) => m.reportId === reportId);
    if (mine.length === 0) continue;
    const started = (m: WasteMedia) => (m.tusUrl || m.pausedForTurn || (m.bytesConfirmed ?? 0) > 0 ? 0 : 1);
    return [...mine].sort((a, b) => started(a) - started(b) || a.createdAt.localeCompare(b.createdAt))[0];
  }
  return null;
}

/** Whether a video of ANOTHER report is waiting for the video lane (then a long-running video gives up its turn at a chunk boundary). */
export function otherReportHasWaitingVideo(media: WasteMedia[], reportId: string, now: number, claimed: ReadonlySet<string>): boolean {
  return media.some((m) => m.kind === 'video' && m.reportId !== reportId && isEligible(m, now, claimed));
}
