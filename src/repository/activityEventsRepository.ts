// A small shared helper for logging real activity_events — used by every
// visit/report mutation in reportsRepository.ts. Never fabricates an event;
// only called from the exact moment a real transition happens, with the
// same timestamp used for that transition (not a separately-drifting now()).

import { supabase } from '../lib/supabaseClient';

export type ActivityEntityType = 'building' | 'job' | 'visit' | 'report';

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
