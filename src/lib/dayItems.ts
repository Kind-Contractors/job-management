import type { ScheduleActivity, WeekVisit } from '../domain/types';

/**
 * One entry in a day's running order: a job visit or an activity. Jobs and activities share ONE
 * sequence per day (the database's sort_order on both tables), so the screen merges them here and
 * orders them with compareDayItems. Time (start/end) is deliberately not part of any comparison.
 */
export type DayItem =
  | { kind: 'visit'; id: string; sortOrder: number | null; createdAt: string; visit: WeekVisit }
  | { kind: 'activity'; id: string; sortOrder: number | null; createdAt: string; activity: ScheduleActivity };

/** Row id used for the "Unassigned" row in the technician grid (activities can be unassigned; visits are not shown there). */
export const UNASSIGNED_ROW_ID = '__unassigned__';

export function visitDayItem(visit: WeekVisit): DayItem {
  // `?? null` / `?? ''`: a visit restored from a cache written before these fields existed must not crash the screen.
  return { kind: 'visit', id: visit.id, sortOrder: visit.sortOrder ?? null, createdAt: visit.createdAt ?? '', visit };
}

export function activityDayItem(activity: ScheduleActivity): DayItem {
  return { kind: 'activity', id: activity.id, sortOrder: activity.sortOrder ?? null, createdAt: activity.createdAt ?? '', activity };
}

/**
 * The running order within a day, identical to the database (technician_day_items): manually ordered
 * items first (lowest number first), then unordered ones by creation time; on a complete tie a job comes
 * before an activity, then by id. A start/end time plays no part.
 */
export function compareDayItems(a: DayItem, b: DayItem): number {
  if (a.sortOrder != null && b.sortOrder != null && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.sortOrder != null && b.sortOrder == null) return -1;
  if (a.sortOrder == null && b.sortOrder != null) return 1;
  const byCreated = a.createdAt.localeCompare(b.createdAt);
  if (byCreated !== 0) return byCreated;
  if (a.kind !== b.kind) return a.kind === 'visit' ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Visits and activities merged into one ordered list. Cancelled items are included - callers split them off with isLiveDayItem. */
export function mergeDayItems(visits: WeekVisit[], activities: ScheduleActivity[]): DayItem[] {
  return [...visits.map(visitDayItem), ...activities.map(activityDayItem)].sort(compareDayItems);
}

/** True for an item that is part of someone's day: not a cancelled visit and not a cancelled activity. */
export function isLiveDayItem(item: DayItem): boolean {
  return item.kind === 'visit' ? item.visit.status !== 'cancelled' : (item.activity.cancelledAt ?? null) == null;
}

/** The ordered list the database's set_day_order expects: exactly the day's live items, in order. */
export function toDayOrderPayload(items: DayItem[]): { kind: 'visit' | 'activity'; id: string }[] {
  return items.map((i) => ({ kind: i.kind, id: i.id }));
}

/** True when this technician is the activity's assignee. (An activity has one assignee; an unassigned one belongs to nobody.) */
export function isActivityAssignedTo(activity: ScheduleActivity, technicianId: string): boolean {
  return activity.technicianId === technicianId;
}
