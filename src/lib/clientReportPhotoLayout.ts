/**
 * Photo-section layout rules shared by the generated PDF (clientReportPdf.ts)
 * and the on-screen preview (ReadyForClientPage.tsx's ClientReportPreview),
 * so the two can't drift apart: same phase order, same per-phase numbering,
 * same grid shape. Pure presentation constants/helpers — no data of its own,
 * so it can't widen what the client-safe ClientReportModel already allows.
 */

export type PhotoPhase = 'before' | 'during' | 'after';

export const PHOTO_PHASE_ORDER: readonly PhotoPhase[] = ['before', 'during', 'after'];

export const PHOTO_PHASE_LABEL: Record<PhotoPhase, string> = {
  before: 'Before',
  during: 'During',
  after: 'After',
};

export const PHOTO_GRID_COLUMNS = 3;

/** Width / height of a grid cell (4:3). Photos are fitted inside it with "contain" — never cropped. */
export const PHOTO_CELL_ASPECT = 4 / 3;

/** "Before 2" — numbered per phase, starting at 1. */
export function photoLabel(phase: PhotoPhase, number: number): string {
  return `${PHOTO_PHASE_LABEL[phase]} ${number}`;
}

export interface NumberedPhoto<T> {
  photo: T;
  /** 1-based position within its own phase. */
  number: number;
}

export interface PhotoPhaseGroup<T> {
  phase: PhotoPhase;
  label: string;
  items: NumberedPhoto<T>[];
}

/** Groups photos by phase in PHOTO_PHASE_ORDER (empty phases omitted), keeping each phase's incoming order and numbering it from 1. */
export function groupPhotosByPhase<T extends { phase: PhotoPhase }>(photos: readonly T[]): PhotoPhaseGroup<T>[] {
  const groups: PhotoPhaseGroup<T>[] = [];
  for (const phase of PHOTO_PHASE_ORDER) {
    const inPhase = photos.filter((p) => p.phase === phase);
    if (inPhase.length === 0) continue;
    groups.push({
      phase,
      label: PHOTO_PHASE_LABEL[phase],
      items: inPhase.map((photo, i) => ({ photo, number: i + 1 })),
    });
  }
  return groups;
}

export interface OrderedPhotoEntry<T> {
  photo: T;
  phase: PhotoPhase;
  /** 1-based position within its own phase ("Before 2" -> 2). */
  number: number;
  /** How many photos that phase has in total. */
  count: number;
}

/** Every photo as ONE flat list in Before -> During -> After order, each still numbered within its own phase — what the single continuous photo grid (PDF and preview) and the large-photo pages are both built from, so they can never disagree about order. */
export function orderedPhotoEntries<T extends { phase: PhotoPhase }>(photos: readonly T[]): OrderedPhotoEntry<T>[] {
  return groupPhotosByPhase(photos).flatMap((group) =>
    group.items.map((item) => ({ photo: item.photo, phase: group.phase, number: item.number, count: group.items.length })),
  );
}

/** "Before" for a phase with one photo, "Before 2" when the phase has several — the tag shown on a photo. */
export function photoTag<T>(entry: OrderedPhotoEntry<T>): string {
  return entry.count > 1 ? photoLabel(entry.phase, entry.number) : PHOTO_PHASE_LABEL[entry.phase];
}

export interface PhotoLayoutPlan<T> {
  /** The first Before and first After photo, shown large side by side — null unless the report has both. */
  hero: { before: OrderedPhotoEntry<T>; after: OrderedPhotoEntry<T> } | null;
  /** Every other photo, in Before -> During -> After order, for the compact grid. */
  rest: OrderedPhotoEntry<T>[];
}

/**
 * How the photographs are laid out — shared by the PDF and the preview so they
 * can't disagree. A report with both a Before and an After leads with that
 * pair as a large side-by-side "Before and after"; everything else goes in
 * the grid beneath. Otherwise every photo goes in the grid.
 */
export function planPhotoLayout<T extends { phase: PhotoPhase }>(photos: readonly T[]): PhotoLayoutPlan<T> {
  const entries = orderedPhotoEntries(photos);
  const before = entries.find((e) => e.phase === 'before');
  const after = entries.find((e) => e.phase === 'after');
  if (!before || !after) return { hero: null, rest: entries };
  return { hero: { before, after }, rest: entries.filter((e) => e !== before && e !== after) };
}
