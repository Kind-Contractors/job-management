// Optional time of day for a job visit or an activity: no time, a start time only, or a start + end range.
// A time is DISPLAY-ONLY: it never decides an item's position in the day (that is sort_order).
// Times are local wall-clock 'HH:MM' on the item's own date - no time zone, matching the database `time` columns.

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/;

/**
 * Normalises a time from the database ('09:00:00'), an <input type="time"> ('09:00') or an empty
 * box ('') to 'HH:MM', or null when there is no time. Anything that is not a valid time becomes null
 * rather than throwing, so a stale or malformed cached value can never crash a screen.
 */
export function normalizeTime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const m = HH_MM.exec(trimmed);
  return m ? `${m[1]}:${m[2]}` : null;
}

/** The label shown next to an item: '' (no time), 'from 09:00' (start only), or '09:00–11:00' (a range). */
export function formatTimeRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = normalizeTime(start);
  if (!s) return '';
  const e = normalizeTime(end);
  return e ? `${s}–${e}` : `from ${s}`;
}

/**
 * Why a start/end pair is not allowed, or null when it is fine. The same rules the database enforces
 * (an end needs a start, and must be after it), so the form can say so before the save is attempted.
 * Empty / missing values mean "no time" and are always fine.
 */
export function timeRangeError(start: string | null | undefined, end: string | null | undefined): string | null {
  const rawStart = (start ?? '').trim();
  const rawEnd = (end ?? '').trim();
  if (rawStart !== '' && normalizeTime(rawStart) == null) return 'The start time is not a valid time.';
  if (rawEnd !== '' && normalizeTime(rawEnd) == null) return 'The end time is not a valid time.';
  const s = normalizeTime(rawStart);
  const e = normalizeTime(rawEnd);
  if (e && !s) return 'Add a start time before an end time.';
  if (s && e && e <= s) return 'The end time must be after the start time.';
  return null;
}

/** The value to store: both null when there is no start (an end alone is never stored). */
export function timeRangeForSave(start: string | null | undefined, end: string | null | undefined): { startTime: string | null; endTime: string | null } {
  const s = normalizeTime(start);
  if (!s) return { startTime: null, endTime: null };
  return { startTime: s, endTime: normalizeTime(end) };
}
