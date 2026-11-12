// The Client and Building choices of the Schedule's "Add booking" form (ScheduleDayDrawer), kept free of React so they can be tested.
//
// They come from the BUILDINGS list, so a building with no live job yet (a new building, or one whose jobs are all completed or
// lost) can still be chosen - otherwise its first job could never be added from here ("+ Add new job for this building" needs a
// building selected). The live jobs list is merged in as well, so nothing that was offered before disappears - in particular while
// the buildings list is still loading. The Job choice itself stays the building's live jobs.
import type { BuildingRow, JobRow } from '../domain/types';

export interface BookingClientOption {
  id: string;
  name: string;
}

export interface BookingBuildingOption {
  id: string;
  name: string;
  postcode: string;
  /** False when the building has no live job: the Job list is empty and "+ Add new job for this building" adds its first one. */
  hasLiveJobs: boolean;
}

type BuildingSource = Pick<BuildingRow, 'id' | 'clientId' | 'clientName' | 'buildingName' | 'postcode'>;
type JobSource = Pick<JobRow, 'clientId' | 'clientName' | 'buildingId' | 'buildingName'>;

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** Every client that has a building (from the buildings list) or a live job (from the jobs list), each once, by name. */
export function bookingClients(buildings: BuildingSource[], jobs: JobSource[]): BookingClientOption[] {
  const seen = new Map<string, string>();
  for (const b of buildings) if (b.clientId) seen.set(b.clientId, b.clientName);
  for (const j of jobs) if (!seen.has(j.clientId)) seen.set(j.clientId, j.clientName);
  return Array.from(seen, ([id, name]) => ({ id, name })).sort(byName);
}

/** Every building of the client - with or without live jobs - each once, by name. */
export function bookingBuildings(buildings: BuildingSource[], jobs: JobSource[], clientId: string): BookingBuildingOption[] {
  if (!clientId) return [];
  const withLiveJobs = new Set(jobs.filter((j) => j.clientId === clientId).map((j) => j.buildingId));
  const seen = new Map<string, BookingBuildingOption>();
  for (const b of buildings) {
    if (b.clientId === clientId) seen.set(b.id, { id: b.id, name: b.buildingName, postcode: b.postcode, hasLiveJobs: withLiveJobs.has(b.id) });
  }
  // A building known only from the jobs list (the buildings list not loaded yet): still offered, exactly as before.
  for (const j of jobs) {
    if (j.clientId === clientId && !seen.has(j.buildingId)) seen.set(j.buildingId, { id: j.buildingId, name: j.buildingName, postcode: '', hasLiveJobs: true });
  }
  return Array.from(seen.values()).sort(byName);
}

/** The small grey line under a building in the dropdown: its postcode, and a note when it has no live job yet. */
export function bookingBuildingSublabel(b: BookingBuildingOption): string | undefined {
  const parts = [b.postcode, b.hasLiveJobs ? '' : 'no live jobs yet'].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
