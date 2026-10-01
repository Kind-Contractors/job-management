import type { Technician } from '../domain/types';

/**
 * A booking's selected technicians, in selection order, reduced to ones that
 * are currently active and unique. The first is stored as the visit's primary
 * (visits.technician_id); the rest go to visit_technicians. A job's default
 * technician who has since been deactivated is dropped here rather than being
 * sent to the database (which would reject the whole booking).
 */
export function activeSelection(selectedIds: string[], technicians: Technician[]): string[] {
  const activeIds = new Set(technicians.filter((t) => t.isActive).map((t) => t.id));
  const seen = new Set<string>();
  return selectedIds.filter((id) => {
    if (!activeIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Splits a selection into the `createVisit()` arguments: [primary | null, additional...]. */
export function splitPrimary(selectedIds: string[]): { primaryId: string | null; additionalIds: string[] } {
  return { primaryId: selectedIds[0] ?? null, additionalIds: selectedIds.slice(1) };
}
