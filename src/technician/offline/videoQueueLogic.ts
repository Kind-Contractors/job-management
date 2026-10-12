// The decisions of the technician video queue, kept free of IndexedDB, React and the network so each one can be tested directly:
// what may be queued, how long to wait between attempts, which failures are worth retrying, and what the screen says about a video.
import { RpcError } from '../api';
import {
  checkVideoDuration,
  checkVideoSelection,
  explainVideoError,
  type VideoExt,
  type VideoMime,
  type VideoPhase,
} from '../../lib/reportVideoRules';
import { UploadCancelledError, UploadError } from '../../lib/reportVideoUpload';
import type { QueuedVideo } from './videoDb';

/** After this many failed attempts (online ones only) the video stops retrying by itself and waits for the technician: "Failed - tap to retry". */
export const MAX_AUTO_ATTEMPTS = 6;

/** Pause before the next automatic attempt, by how many have already failed: 15 s, 1 min, 3 min, 10 min, 30 min. */
export function backoffDelayMs(attemptsSoFar: number): number {
  const steps = [15_000, 60_000, 180_000, 600_000, 1_800_000];
  return steps[Math.min(Math.max(attemptsSoFar, 1), steps.length) - 1];
}

// ---- what may be queued ---------------------------------------------------------------------------------------------------

export interface ServerVideoRef {
  phase: VideoPhase;
}

/** The technician's own videos already on the server plus the ones still queued here (not counting any being removed). */
export function countsForPhase(phase: VideoPhase, server: ServerVideoRef[], queued: { phase: VideoPhase }[]): { inPhase: number; inVisit: number } {
  const all = [...server, ...queued];
  return { inPhase: all.filter((v) => v.phase === phase).length, inVisit: all.length };
}

/** Same file, same section: picked twice (a double tap, or the same clip chosen again) - never queued twice. */
export function sourceKeyOf(file: { name: string; size: number; lastModified?: number }): string {
  return `${file.name}|${file.size}|${file.lastModified ?? 0}`;
}

export type QueueCheck = { ok: true; mime: VideoMime; ext: VideoExt } | { ok: false; message: string };

/**
 * Everything the device can check before a video is accepted into the queue: type, size, length and the counts (own server videos +
 * queued ones; the database counts every technician's videos on the visit and is the final word). Returns a plain sentence on refusal.
 */
export function validateForQueue(input: {
  file: { name: string; type: string; size: number; lastModified?: number };
  phase: VideoPhase;
  durationSeconds: number | null;
  server: ServerVideoRef[];
  queued: Pick<QueuedVideo, 'phase' | 'sourceKey'>[];
}): QueueCheck {
  const check = checkVideoSelection(input.file, input.phase, countsForPhase(input.phase, input.server, input.queued));
  if (!check.ok) return check;
  const tooLong = checkVideoDuration(input.durationSeconds);
  if (tooLong) return { ok: false, message: tooLong };
  const key = sourceKeyOf(input.file);
  if (input.queued.some((q) => q.phase === input.phase && q.sourceKey === key)) {
    return { ok: false, message: 'That video is already waiting to upload in this section.' };
  }
  return check;
}

// ---- failures ---------------------------------------------------------------------------------------------------------------------

export type FailureKind =
  /** The technician cancelled / removed it: nothing to record. */
  | 'cancelled'
  /** The device is offline: not the video's fault - wait for a connection, do not count it. */
  | 'offline'
  /** The server refused for a reason retrying cannot fix (visit cancelled, report Completed, not your visit, a limit...). */
  | 'permanent'
  /** The database could not find the file we believed was uploaded: upload it again under new names. */
  | 'reupload'
  /** The unfinished upload is gone or locked on the server: start the upload again under new names. */
  | 'restart'
  /** Anything else (dropped connection, timeout, server hiccup): try again later. */
  | 'transient';

/** Postgres error classes that are connection/resource problems rather than a refusal (same list the report sync engine uses). */
const TRANSIENT_SQLSTATE_CLASSES = ['08', '40', '53', '54', '55', '57', '58'];

export function classifyVideoFailure(err: unknown, online: boolean): FailureKind {
  if (err instanceof UploadCancelledError) return 'cancelled';
  if (!online) return 'offline';
  if (err instanceof RpcError) {
    if (/not found in storage/i.test(err.message)) return 'reupload';
    // No SQLSTATE means no answer came back from the database at all - a network-level failure.
    if (!err.code) return 'transient';
    return TRANSIENT_SQLSTATE_CLASSES.includes(err.code.slice(0, 2)) ? 'transient' : 'permanent';
  }
  if (err instanceof UploadError) {
    const s = err.status;
    if (s == null) return 'transient';
    if (s === 404 || s === 410 || s === 409 || s === 423) return 'restart';
    if (s === 401 || s === 408 || s === 429 || s >= 500) return 'transient';
    return 'permanent'; // 400 / 403 / 413 / 415 ...: the server looked at it and said no
  }
  return 'transient';
}

/** The sentence stored with a failed video and shown to the technician. */
export function describeVideoFailure(err: unknown): string {
  return explainVideoError(err);
}

// ---- what the screen says -------------------------------------------------------------------------------------------------

export type VideoTone = 'waiting' | 'working' | 'bad';

export interface VideoDisplay {
  label: string;
  tone: VideoTone;
  /** "Tap to retry" is offered. */
  retryable: boolean;
}

export function videoDisplay(video: Pick<QueuedVideo, 'status' | 'attempts' | 'permanentFailure' | 'lastError'>, online: boolean, progress: number | null): VideoDisplay {
  if (video.status === 'failed') {
    if (!online && !video.permanentFailure) {
      return { label: 'Saved on this device · will upload once you are back online', tone: 'waiting', retryable: false };
    }
    return { label: video.permanentFailure ? 'Could not be sent' : 'Failed — tap to retry', tone: 'bad', retryable: true };
  }
  if (video.status === 'attaching') return { label: 'Finishing…', tone: 'working', retryable: false };
  if (video.status === 'uploading') {
    const pct = progress == null ? null : Math.round(progress * 100);
    return { label: pct == null ? 'Uploading…' : `Uploading… ${pct}%`, tone: 'working', retryable: false };
  }
  if (!online) return { label: 'Saved on this device · waiting for a connection', tone: 'waiting', retryable: false };
  if (video.attempts > 0) return { label: 'Will retry shortly…', tone: 'working', retryable: false };
  return { label: 'Saved on this device · waiting to upload', tone: 'waiting', retryable: false };
}
