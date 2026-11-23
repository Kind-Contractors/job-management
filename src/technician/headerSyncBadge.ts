// The technician header's one sync badge - the only place photo/report status and video status are shown together (the report code
// itself never knows about videos: see tests/technicianVideoIndependence.test.ts).
import type { SyncStatus } from './offline/syncEngine';

/** The header badge: one short, accurate label, most serious first. Null = nothing to show. */
export function headerSyncBadge(sync: SyncStatus, videos: { pending: number; failed: number }): { tone: 'bad' | 'busy'; text: string } | null {
  if (!sync.online) return { tone: 'bad', text: 'Offline' };
  if (sync.failedDraftCount > 0) return { tone: 'bad', text: sync.failedDraftCount === 1 ? 'Report not sent' : `${sync.failedDraftCount} reports not sent` };
  if (sync.failedPhotoCount > 0) return { tone: 'bad', text: `${sync.failedPhotoCount} photo${sync.failedPhotoCount === 1 ? '' : 's'} not uploaded` };
  if (sync.pendingPhotoCount > 0 || videos.pending > 0) {
    const parts = [sync.pendingPhotoCount > 0 ? `${sync.pendingPhotoCount} photo${sync.pendingPhotoCount === 1 ? '' : 's'}` : null, videos.pending > 0 ? `${videos.pending} video${videos.pending === 1 ? '' : 's'}` : null].filter(Boolean);
    return { tone: 'busy', text: `Uploading ${parts.join(' + ')}` };
  }
  if (sync.waitingReportCount > 0) return { tone: 'busy', text: 'Sending report' };
  return null;
}
