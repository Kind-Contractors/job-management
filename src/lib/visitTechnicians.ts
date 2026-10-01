import type { Technician, WeekVisit } from '../domain/types';

/** Every technician on a visit — the primary first, then additional ones in assignment order. Unknown ids are skipped. */
export function visitTechnicianNames(visit: WeekVisit, technicianById: Map<string, Technician>): string[] {
  const ids = [visit.technicianId, ...visit.additionalTechnicianIds].filter((id): id is string => id != null);
  return ids.flatMap((id) => {
    const t = technicianById.get(id);
    return t ? [t.name] : [];
  });
}

/** Compact label: "Anna" for a single-technician visit (unchanged), "Anna +2" for a multi-technician one, "Unassigned" when nobody is. */
export function visitTechnicianLabel(visit: WeekVisit, technicianById: Map<string, Technician>): string {
  const names = visitTechnicianNames(visit, technicianById);
  if (names.length === 0) return 'Unassigned';
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

/** True when this technician is the primary or one of the additional technicians on the visit. */
export function isVisitParticipant(visit: WeekVisit, technicianId: string): boolean {
  return visit.technicianId === technicianId || visit.additionalTechnicianIds.includes(technicianId);
}
