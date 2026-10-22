import type { Frequency, JobRow } from '../domain/types';

export type GroupBy = 'client' | 'frequency';

export type GridBlock =
  | {
      kind: 'band';
      id: string;
      title: string;
      subtitle: string;
      rightLabel: string;
      /** How many job rows this band holds — still the real total when the band is collapsed and they are hidden. */
      rowCount: number;
      /** Set by `collapseBlocks`; `buildGridBlocks` always produces expanded bands. */
      collapsed?: boolean;
    }
  | { kind: 'row'; id: string; job: JobRow };

const FREQUENCY_ORDER: Frequency[] = [
  'Weekly',
  'Fortnightly',
  '6 weekly',
  'Monthly',
  'Bi-monthly',
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
  '6 weekly': 52 / 6,
  Monthly: 12,
  'Bi-monthly': 6,
  Quarterly: 4,
  Biannual: 2,
  Annual: 1,
  'Ask / ad-hoc': 0,
  'One-off': 0,
  Unknown: 0,
};

/** "12 visits a year per job"; a fractional count (6 weekly: 52 / 6) reads "about 8.7 visits a year per job". */
export function visitsPerYearLabel(n: number): string {
  if (Number.isInteger(n)) return `${n} visit${n === 1 ? '' : 's'} a year per job`;
  return `about ${n.toFixed(1)} visits a year per job`;
}

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
        rowCount: set.length,
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
        subtitle: visitsPerYearLabel(VISITS_PER_YEAR[freq]),
        rightLabel: `${set.length} job${set.length === 1 ? '' : 's'} · ${summarizeYearlyValue(set)}`,
        rowCount: set.length,
      });
      set.forEach((job) => blocks.push({ kind: 'row', id: job.id, job }));
    }
  }

  return blocks;
}

/**
 * Hides the job rows under every collapsed band, and marks those bands so their caret can point the right way.
 *
 * Collapsing is a VIEW state, never a change to the data: `buildGridBlocks` keeps producing every row, this
 * filters a copy, and each band keeps its real `rowCount` and its totals so a collapsed band still tells the
 * truth about what it holds. A band id that is not in `collapsed` is returned exactly as it came in.
 *
 * Pure and shared because the two screens that show bands must behave identically - All Live Jobs renders them
 * through AG Grid's full-width row feature (Community has no built-in grouping, see above), the Monthly Plan
 * renders them itself, and neither should own its own copy of this rule.
 */
export function collapseBlocks(blocks: GridBlock[], collapsed: ReadonlySet<string>): GridBlock[] {
  if (collapsed.size === 0) return blocks;

  const out: GridBlock[] = [];
  let hiding = false;
  for (const block of blocks) {
    if (block.kind === 'band') {
      hiding = collapsed.has(block.id);
      out.push(hiding ? { ...block, collapsed: true } : block);
      continue;
    }
    if (!hiding) out.push(block);
  }
  return out;
}
