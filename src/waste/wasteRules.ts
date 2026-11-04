// Waste reports: the rules the phone applies BEFORE anything is sent, kept free of React and network so they can be tested directly.
// They mirror the database (migration 20261103100000_waste_reports: waste_submit_report(), the bucket and its policies) and the
// waste-media-check Edge Function, which remain the only things that count for security.
import { formatBytes, formatDuration, resolveVideoType, type VideoExt, type VideoMime } from '../lib/reportVideoRules';

export type WastePhase = 'before' | 'after';
export type WasteMediaKind = 'photo' | 'video';

export const WASTE_PHASES: WastePhase[] = ['before', 'after'];
export const WASTE_PHASE_LABEL: Record<WastePhase, string> = { before: 'Before', after: 'After' };

export const WASTE_LIMITS = {
  photosPerPhase: 30,
  videosPerPhase: 5,
  /** 150 MiB - the bucket's file_size_limit. */
  maxVideoBytes: 157_286_400,
  /** STRICTLY 60 s - the server rejects anything measured over 60 s as well. */
  maxVideoSeconds: 60,
  maxAddressLength: 500,
  maxDescriptionLength: 10_000,
} as const;

export const WASTE_BUCKET = 'waste-report-media';

/** Where a file goes: {user}/{report}/{phase}/{file id}.{ext} - the only shape the bucket policies accept. */
export function wasteMediaPath(userId: string, reportId: string, phase: WastePhase, fileId: string, ext: string): string {
  return `${userId}/${reportId}/${phase}/${fileId}.${ext}`;
}

/** A video's poster lives next to it. */
export function wasteThumbPath(userId: string, reportId: string, phase: WastePhase, fileId: string): string {
  return `${userId}/${reportId}/${phase}/${fileId}.thumb.jpg`;
}

/** Today's date (yyyy-mm-dd) in the UK, whatever the phone's time zone - the same "today" the database uses. */
export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface WasteFormFields {
  address: string;
  startDate: string;
  endDate: string;
  description: string;
}

/** Plain-words problems with the typed fields (empty when the form can be sent). */
export function checkWasteForm(fields: WasteFormFields, today: string = londonToday()): string[] {
  const problems: string[] = [];
  const address = fields.address.trim();
  if (!address) problems.push('Enter the job address.');
  else if (address.length > WASTE_LIMITS.maxAddressLength) problems.push('The address is too long.');
  if (!fields.startDate || !fields.endDate) problems.push('Enter the start and end dates.');
  else {
    if (fields.endDate < fields.startDate) problems.push('The end date cannot be before the start date.');
    if (fields.endDate > addDays(today, 1)) problems.push('The end date cannot be in the future.');
  }
  if (fields.description.length > WASTE_LIMITS.maxDescriptionLength) problems.push('The description is too long.');
  return problems;
}

/** The sections with no photo and no video - Jack is asked to confirm before sending a report like that (it is not blocked). */
export function emptySections(media: { phase: WastePhase }[]): WastePhase[] {
  return WASTE_PHASES.filter((phase) => !media.some((m) => m.phase === phase));
}

export function emptySectionsQuestion(empty: WastePhase[]): string | null {
  if (empty.length === 0) return null;
  if (empty.length === 2) return 'There are no photos or videos in this report. Send it anyway?';
  return `The ${WASTE_PHASE_LABEL[empty[0]]} section has no photos or videos. Send it anyway?`;
}

export type MediaPick =
  | { ok: true; kind: 'photo' }
  | { ok: true; kind: 'video'; mime: VideoMime; ext: VideoExt }
  | { ok: false; message: string };

/** Whether one more file of this kind fits in the section, and (for a video) whether its type and size are accepted. */
export function checkWastePick(
  file: { name: string; type: string; size: number },
  kind: WasteMediaKind,
  phase: WastePhase,
  existing: { kind: WasteMediaKind; phase: WastePhase }[],
): MediaPick {
  const inSection = existing.filter((m) => m.phase === phase && m.kind === kind).length;
  const label = WASTE_PHASE_LABEL[phase];
  if (file.size <= 0) return { ok: false, message: 'That file is empty.' };
  if (kind === 'photo') {
    if (inSection >= WASTE_LIMITS.photosPerPhase) return { ok: false, message: `The ${label} section already has ${WASTE_LIMITS.photosPerPhase} photos, the most it can hold.` };
    if (file.type && !file.type.startsWith('image/')) return { ok: false, message: 'That file isn’t a photo.' };
    return { ok: true, kind: 'photo' };
  }
  if (inSection >= WASTE_LIMITS.videosPerPhase) return { ok: false, message: `The ${label} section already has ${WASTE_LIMITS.videosPerPhase} videos, the most it can hold.` };
  const type = resolveVideoType(file);
  if (!type) return { ok: false, message: 'That file type isn’t accepted. Use an MP4, MOV or WebM video.' };
  if (file.size > WASTE_LIMITS.maxVideoBytes) {
    return { ok: false, message: `That video is ${formatBytes(file.size)}. The limit is ${formatBytes(WASTE_LIMITS.maxVideoBytes)} - record at 1080p rather than 4K.` };
  }
  return { ok: true, kind: 'video', mime: type.mime, ext: type.ext };
}

/** A length the phone could read that is clearly over the limit (the server checks every video itself as well). */
export function checkWasteVideoLength(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds > WASTE_LIMITS.maxVideoSeconds + 1e-6) {
    // Same wording as the server (mediaProbe.ts describeVideoLength): never a figure that looks within the limit.
    const length =
      seconds < 61 ? `${(Math.ceil(seconds * 100) / 100).toFixed(2)} seconds` : seconds < 90 ? `${(Math.floor(seconds * 10) / 10).toFixed(1)} seconds` : formatDuration(seconds);
    return `That video is ${length} long. The limit is 60 seconds.`;
  }
  return null;
}

/** A photo after shrinking must be a JPEG or PNG (the only photo types the server accepts). */
export function photoExtFor(mime: string): 'jpg' | 'png' | null {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  return null;
}

/** "3 Nov 2026", or "3 – 4 Nov 2026" for a range. */
export function formatWorkDates(start: string, end: string): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  if (start === end) return fmt(start, true);
  return `${fmt(start, start.slice(0, 4) !== end.slice(0, 4))} – ${fmt(end, true)}`;
}
