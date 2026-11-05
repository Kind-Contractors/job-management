// What a file's tile says - one honest state per file, kept free of React so the wording can be tested.
import type { WasteMedia } from './offline/wasteDb';

export type WasteMediaTone = 'ok' | 'busy' | 'wait' | 'bad';

export interface WasteMediaDisplay {
  /** Short label under the tile. */
  label: string;
  /** A longer explanation (the last error, what to do), or null. */
  detail: string | null;
  tone: WasteMediaTone;
  /** "Try now" makes sense (a file waiting out a retry pause). */
  canRetry: boolean;
}

export interface WasteMediaLive {
  /** 0..1 while this file is being sent, else null. */
  fraction: number | null;
  /** A video's bytes sent and size while it is being sent, else null. */
  bytes: { sent: number; total: number } | null;
  /** The phone has no connection. */
  online: boolean;
}

export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function at(iso: string | null | undefined): string {
  if (!iso) return '';
  return ` at ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }).format(new Date(iso))}`;
}

export function describeWasteMedia(m: WasteMedia, live: WasteMediaLive): WasteMediaDisplay {
  if (m.status === 'ready') return { label: '✓ Uploaded', detail: null, tone: 'ok', canRetry: false };
  if (m.status === 'failed' && m.permanentFailure) {
    if (m.failureKind === 'unreadable') return { label: 'Can’t be read', detail: m.lastError ?? 'This file can’t be read from your phone. Remove it and add it again.', tone: 'bad', canRetry: false };
    return { label: 'Not accepted', detail: m.lastError ? `${m.lastError} Remove it to send the report.` : 'Remove it to send the report.', tone: 'bad', canRetry: false };
  }
  if (m.status === 'checking' && live.fraction == null) return { label: 'Checking…', detail: null, tone: 'busy', canRetry: false };
  if (m.status === 'uploading' && (live.fraction != null || live.bytes)) {
    if (live.bytes && m.kind === 'video') return { label: `Uploading ${formatMb(live.bytes.sent)} of ${formatMb(live.bytes.total)} MB`, detail: null, tone: 'busy', canRetry: false };
    return { label: `Uploading ${Math.round((live.fraction ?? 0) * 100)}%`, detail: null, tone: 'busy', canRetry: false };
  }
  if (m.status === 'uploading') return { label: 'Uploading…', detail: null, tone: 'busy', canRetry: false };
  const confirmed = m.kind === 'video' && (m.bytesConfirmed ?? 0) > 0 ? ` ${formatMb(m.bytesConfirmed ?? 0)} of ${formatMb(m.sizeBytes)} MB sent.` : '';
  if (m.pausedForTurn) return { label: 'Paused', detail: `Another report’s video is uploading; this one carries on after it.${confirmed}`, tone: 'wait', canRetry: false };
  // A file stopped by an older version of the app (not refused) is retried when this version starts: shown as waiting.
  if (m.lastError || (m.status === 'failed' && !m.permanentFailure)) {
    const attempt = m.attempts > 0 ? ` · attempt ${m.attempts}` : '';
    return {
      label: `${live.online ? 'Waiting to retry' : 'Waiting for signal'}${attempt}`,
      detail: `${m.lastError ?? 'It will carry on by itself.'}${at(m.lastErrorAt)}${confirmed}`,
      tone: 'wait',
      canRetry: true,
    };
  }
  if (!live.online) return { label: 'Waiting for signal', detail: confirmed.trim() || null, tone: 'wait', canRetry: false };
  return { label: 'Waiting…', detail: confirmed.trim() || null, tone: 'busy', canRetry: false };
}
