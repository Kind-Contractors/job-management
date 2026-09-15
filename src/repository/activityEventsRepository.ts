// A small shared helper for logging real activity_events — used by every
// visit/report mutation in reportsRepository.ts. Never fabricates an event;
// only called from the exact moment a real transition happens, with the
// same timestamp used for that transition (not a separately-drifting now()).

import { supabase } from '../lib/supabaseClient';

export type ActivityEntityType = 'building' | 'job' | 'visit' | 'report';

/**
 * Same insert as logActivityEvent, but resolves the actor from the current
 * session itself rather than requiring the caller to plumb one through.
 * reportsRepository.ts's callers already have `actor` on hand (from
 * useAuth()) for their OTHER mutations too, so passing it explicitly there
 * makes sense — but building/job/contact/visit mutations are called from
 * many small components that don't otherwise touch auth at all, and
 * threading a new parameter through every one of them just for logging
 * would be a much larger, riskier change than resolving it once here.
 * getSession() reads the already-cached local session (no network round
 * trip, unlike getUser()). Best-effort in the same way as
 * logActivityEvent — a failed session lookup logs as 'unknown', never
 * throws, and never blocks the real mutation that already succeeded.
 */
export async function logCurrentUserActivity(
  entityType: ActivityEntityType,
  entityId: string,
  eventType: string,
  detail: string | null = null,
): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const actor = data.session?.user.email ?? 'unknown';
  await logActivityEvent(entityType, entityId, eventType, actor, detail);
}

/**
 * Best-effort: a failed audit-log write should not fail the primary mutation
 * that triggered it (the visit/report state change is the source of truth),
 * but it's still surfaced via console.error rather than silently swallowed.
 */
export async function logActivityEvent(
  entityType: ActivityEntityType,
  entityId: string,
  eventType: string,
  actor: string,
  detail: string | null = null,
  occurredAt: string = new Date().toISOString(),
): Promise<void> {
  const { error } = await supabase.from('activity_events').insert({
    entity_type: entityType,
    entity_id: entityId,
    event_type: eventType,
    detail,
    actor,
    occurred_at: occurredAt,
  });

  if (error) {
    console.error(`Failed to log activity event "${eventType}":`, error.message);
  }
}
