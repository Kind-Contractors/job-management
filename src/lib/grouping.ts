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
];

const VISITS_PER_YEAR: Record<Frequency, number> = {
  Weekly: 52,
  Fortnightly: 26,
  Monthly: 12,
  Quarterly: 4,
  Biannual: 2,
  Annual: 1,
  'Ask / ad-hoc': 0,
};

function money(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
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
        rightLabel: `${buildingCount} building${buildingCount === 1 ? '' : 's'} · ${set.length} job${set.length === 1 ? '' : 's'} · ${money(set.reduce((a, b) => a + b.yearlyValue, 0))}/yr`,
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
        rightLabel: `${set.length} job${set.length === 1 ? '' : 's'} · ${money(set.reduce((a, b) => a + b.yearlyValue, 0))}/yr`,
      });
      set.forEach((job) => blocks.push({ kind: 'row', id: job.id, job }));
    }
  }

  return blocks;
}
