// The upload status shown on a job card on My day: is this job's report (its photos, then the report itself) and its videos still on
// the way to the office? Read from the two existing local queues - the photo/report engine (offline/syncEngine.ts) and the video queue
// (offline/videoSyncEngine.ts) - which are separate by design (a video never holds up a report); this is the one place both are shown
// together for a job, like the header badge (headerSyncBadge.ts). Nothing new is stored or fetched.
import { useEffect, useState } from 'react';
import { subscribeCurrentUser, getCurrentUserId } from '../auth/currentUser';
import { listPhotoUploadsByVisit, subscribeSyncEngine, type VisitPhotoUpload } from './offline/syncEngine';
import { getVideoProgress, subscribeVideoQueue } from './offline/videoSyncEngine';
import { listAllVideos, type QueuedVideo } from './offline/videoDb';

/** One job's videos still on this phone (a video leaves the queue once the server has it, so there is no "of how many" for videos). */
export interface VisitVideoUpload {
  /** Waiting or being sent. */
  pending: number;
  /** Stopped - needs the technician (open the job). */
  failed: number;
  /** 0..1 for the video being sent right now, else null. */
  sendingFraction: number | null;
}

export interface DayUploadStatus {
  /** bad = needs attention, waiting = paused (no connection / retrying / its turn), busy = going. */
  tone: 'busy' | 'waiting' | 'bad';
  label: string;
  /** A short supporting line, or null. */
  detail: string | null;
  /** Photos uploaded out of the report's photos (the bar), or null when there is nothing to count. */
  progress: { done: number; total: number } | null;
  /** A line about the job's videos, or null. */
  videos: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function videoLine(v: VisitVideoUpload | undefined, online: boolean): string | null {
  if (!v || v.pending + v.failed === 0) return null;
  if (v.failed > 0 && v.pending === 0) return `${plural(v.failed, 'video')} not uploaded — open the job`;
  if (!online) return `${plural(v.pending, 'video')} waiting for connection`;
  if (v.sendingFraction != null) return `Uploading video · ${Math.round(v.sendingFraction * 100)}%${v.pending > 1 ? ` · ${v.pending - 1} more waiting` : ''}`;
  return `${plural(v.pending, 'video')} waiting to upload`;
}

/**
 * The card's status for one job, or null when nothing of it is still on its way (the card is then exactly as before). Photos decide
 * the main line (they hold the report back); videos get their own line (they never hold the report back).
 *  - offline: "Waiting for connection" - never shown as progressing;
 *  - a photo sending: "Uploading photos · 3 of 10";
 *  - photos failed/retrying and none sending: "Retrying upload…";
 *  - photos waiting their turn (another job's photo is sending): "Waiting to upload · 3 of 10";
 *  - all photos up: the report itself - sending / not sent yet (retrying) / couldn't be sent (contact the office).
 */
export function dayUploadStatus(photos: VisitPhotoUpload | undefined, videos: VisitVideoUpload | undefined, online: boolean): DayUploadStatus | null {
  const vLine = videoLine(videos, online);
  if (!photos) {
    if (!vLine) return null;
    const failedOnly = !!videos && videos.failed > 0 && videos.pending === 0;
    return { tone: failedOnly ? 'bad' : online ? 'busy' : 'waiting', label: failedOnly ? 'Video not uploaded' : online ? 'Uploading videos' : 'Waiting for connection', detail: null, progress: null, videos: vLine };
  }
  const progress = photos.total > 0 ? { done: photos.uploaded, total: photos.total } : null;
  const of = progress ? ` · ${progress.done} of ${progress.total}` : '';
  const photosLeft = photos.total - photos.uploaded;
  if (photos.report === 'refused') {
    return { tone: 'bad', label: 'Report couldn’t be sent', detail: 'Contact the office about this job.', progress, videos: vLine };
  }
  if (!online) {
    return { tone: 'waiting', label: `Waiting for connection${photosLeft > 0 ? of : ''}`, detail: photosLeft > 0 ? 'Photos upload automatically when you’re back online.' : 'The report is sent automatically when you’re back online.', progress, videos: vLine };
  }
  if (photosLeft > 0) {
    if (photos.uploading > 0) return { tone: 'busy', label: `Uploading photos${of}`, detail: null, progress, videos: vLine };
    if (photos.retrying > 0) return { tone: 'waiting', label: `Retrying upload…${of}`, detail: 'Weak signal — trying again automatically.', progress, videos: vLine };
    return { tone: 'waiting', label: `Waiting to upload${of}`, detail: 'Photos upload one at a time.', progress, videos: vLine };
  }
  if (photos.report === 'send-failed') {
    return { tone: 'waiting', label: 'Report not sent yet', detail: 'Photos uploaded — sending the report again automatically.', progress, videos: vLine };
  }
  return { tone: 'busy', label: 'Sending report…', detail: null, progress, videos: vLine };
}

/** Each job's videos still on this phone, by visit. */
export function videosByVisit(videos: QueuedVideo[], progressOf: (id: string) => number | null = getVideoProgress): Map<string, VisitVideoUpload> {
  const out = new Map<string, VisitVideoUpload>();
  for (const v of videos) {
    const entry = out.get(v.visitId) ?? { pending: 0, failed: 0, sendingFraction: null };
    if (v.status === 'failed') entry.failed += 1;
    else {
      entry.pending += 1;
      const f = v.status === 'uploading' ? progressOf(v.id) : null;
      if (f != null) entry.sendingFraction = f;
    }
    out.set(v.visitId, entry);
  }
  return out;
}

/** The upload status of every job that has one, by visit - kept current by the queues' own change notifications. */
export function useDayUploadStatuses(online: boolean): Map<string, DayUploadStatus> {
  const [statuses, setStatuses] = useState<Map<string, DayUploadStatus>>(new Map());
  // Syncs React state with the two local queues (external stores): re-read on every queue change and when the signed-in user changes.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      const ownerId = getCurrentUserId();
      void Promise.all([listPhotoUploadsByVisit(), ownerId ? listAllVideos(ownerId) : Promise.resolve([])])
        .then(([photos, videos]) => {
          if (cancelled) return;
          const vids = videosByVisit(videos);
          const next = new Map<string, DayUploadStatus>();
          for (const visitId of new Set([...photos.map((p) => p.visitId), ...vids.keys()])) {
            const s = dayUploadStatus(photos.find((p) => p.visitId === visitId), vids.get(visitId), online);
            if (s) next.set(visitId, s);
          }
          setStatuses(next);
        })
        .catch(() => {}); // a failed local read leaves the last known status
    };
    refresh();
    const a = subscribeSyncEngine(refresh);
    const b = subscribeVideoQueue(refresh);
    const c = subscribeCurrentUser(refresh);
    return () => {
      cancelled = true;
      a();
      b();
      c();
    };
  }, [online]);
  return statuses;
}
