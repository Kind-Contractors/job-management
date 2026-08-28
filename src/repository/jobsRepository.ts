// Isolated data-access layer for jobs. Backed by mock data for now; the
// exported function signatures are the seam a real Supabase-backed
// implementation swaps in behind later without changing any component that
// calls listJobRows() — see CLAUDE.md section 12.

import type { JobRow } from '../domain/types';
import { denormalizeJobRows } from '../mock/jobsData';

const SIMULATED_LATENCY_MS = 150;

export function listJobRows(): Promise<JobRow[]> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(denormalizeJobRows()), SIMULATED_LATENCY_MS);
  });
}
