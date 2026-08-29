import type { Frequency, JobRow } from '../domain/types';

export type GroupBy = 'client' | 'frequency';

export type GridBlock =
  | { kind: 'band'; id: string; title: string; subtitle: string; rightLabel: string }
  | { kind: 'row'; id: string; job: JobRow };

const FREQUENCY_ORDER: Frequency[] = [
  'Weekly',
  'Fortnightly',
  'Monthly',
  'Quarterly',
  'Biannual',
  'Annual',
  'Ask / ad-hoc',
  'One-off',
  'Unknown',
];

const VISITS_PER_YEAR: Record<Frequency, number> = {
  Weekly: 52,
  Fortnightly: 26,
  Monthly: 12,
  Quarterly: 4,
  Biannual: 2,
  Annual: 1,
  'Ask / ad-hoc': 0,
  'One-off': 0,
  Unknown: 0,
};

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}

/**
 * Jobs with variable pricing or unknown frequency have yearlyValue === null
 * (see mapJobRow.ts) and must never be silently counted as £0 — the total is
 * summed over only the computable jobs, and the excluded count is surfaced
 * alongside it so the number is never read as complete when it isn't.
 */
function summarizeYearlyValue(rows: JobRow[]): string {
  const total = rows.reduce((a, b) => a + (b.yearlyValue ?? 0), 0);
  const excluded = rows.filter((r) => r.yearlyValue === null).length;
  return excluded > 0 ? `${money(total)}/yr (${excluded} variable, excluded)` : `${money(total)}/yr`;
}

/**
 * AG Grid Community has no built-in collapsible row grouping (that's
 * Enterprise) — the approved design's grouped/banded look is instead built
 * as a flat array of band + job rows, rendered with AG Grid's full-width row
 * feature (see JobsGrid.tsx). This mirrors the design canvas's own
 * `gridBlocks` construction.
 */
export function buildGridBlocks(rows: JobRow[], groupBy: GroupBy): GridBlock[] {
  const blocks: GridBlock[] = [];

  if (groupBy === 'client') {
    const seen = new Set<string>();
    const order = rows.map((r) => r.clientId).filter((id) => (seen.has(id) ? false : seen.add(id)));
    for (const clientId of order) {
      const set = rows.filter((r) => r.clientId === clientId);
      const buildingCount = new Set(set.map((r) => r.buildingId)).size;
      blocks.push({
        kind: 'band',
        id: `band-client-${clientId}`,
        title: set[0].clientName,
        subtitle: `Invoice · ${set[0].clientInvoiceAddress}`,
        rightLabel: `${buildingCount} building${buildingCount === 1 ? '' : 's'} · ${set.length} job${set.length === 1 ? '' : 's'} · ${summarizeYearlyValue(set)}`,
      });
      set.forEach((job) => blocks.push({ kind: 'row', id: job.id, job }));
    }
  } else {
    for (const freq of FREQUENCY_ORDER) {
      const set = rows.filter((r) => r.frequency === freq);
      if (!set.length) continue;
      blocks.push({
        kind: 'band',
        id: `band-freq-${freq}`,
        title: freq,
        subtitle: `${VISITS_PER_YEAR[freq]} visit${VISITS_PER_YEAR[freq] === 1 ? '' : 's'} a year per job`,
        rightLabel: `${set.length} job${set.length === 1 ? '' : 's'} · ${summarizeYearlyValue(set)}`,
      });
      set.forEach((job) => blocks.push({ kind: 'row', id: job.id, job }));
    }
  }

  return blocks;
}
