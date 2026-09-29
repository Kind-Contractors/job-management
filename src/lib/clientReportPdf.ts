import { GState, jsPDF } from 'jspdf';
import type { ClientReportModel } from './clientReportModel';
import kindContractorsLogo from '../assets/kind_Contractors_logo.png';
import kindLeaf from '../assets/kind_leaf.png';
import { fitInside, prepareImageForPdf, type PdfImage } from './pdfImage';
import {
  PHOTO_CELL_ASPECT,
  PHOTO_GRID_COLUMNS,
  photoTag,
  planPhotoLayout,
  type OrderedPhotoEntry,
  type PhotoPhase,
} from './clientReportPhotoLayout';

type Rgb = [number, number, number];

// Kind Contractors brand palette (CLAUDE.md section 10). The logo artwork is
// pale green lettering + a green leaf — it is designed for a DARK background
// and all but disappears on white, so it always sits on the Dark Teal header.
// Body text stays dark for print/greyscale legibility.
const DARK_TEAL: Rgb = [30, 84, 75]; // #1E544B
/** A shade lighter than the header, for the facts strip beneath it. */
const TEAL_BAND: Rgb = [44, 98, 87];
const BAND_DIVIDER: Rgb = [92, 138, 128];
const BAND_LABEL: Rgb = [192, 217, 198];
const MEDIUM_GREEN: Rgb = [115, 193, 127]; // #73C17F
const LIGHT_GREEN: Rgb = [228, 240, 195]; // #E4F0C3
const WHITE: Rgb = [255, 255, 255];
const TEXT_DARK: Rgb = [28, 40, 28]; // Near-Black Green #1C281C
const TEXT_MED: Rgb = [84, 94, 86];
const TEXT_LIGHT: Rgb = [132, 140, 133];
const HAIRLINE: Rgb = [216, 220, 212];
const CARD: Rgb = [241, 244, 239];
/** Soft mat behind a photo whose shape doesn't match its frame. */
const PHOTO_MAT: Rgb = [232, 236, 229];
const AMBER: Rgb = [214, 146, 40];
const AMBER_TINT: Rgb = [251, 244, 228];
const AMBER_TEXT: Rgb = [138, 102, 36];

/**
 * Contact line shown under "Thank you for choosing Kind Contractors" on the
 * last page of every report and in the preview. Supplied by Luke.
 */
export const FOOTER_CONTACT_LINE = '0203 038 4692  |  luke@kindcontractors.co.uk  |  Mon - Fri: 9am - 5.30pm';

/** Sits under a "Flagged for your attention" issue — copy for the client, kept in one place so it's easy to change. */
export const ISSUE_HELPER_TEXT = "We spotted this while on site. Get in touch if you'd like us to arrange a fix.";

/** Fetches an (already-signed, or same-origin bundled) URL and converts it to a data URL — jsPDF's addImage needs the actual image bytes, not a remote URL. */
async function toDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image.'));
    reader.readAsDataURL(blob);
  });
}

/** Reads an image's natural pixel size so a bundled asset can be placed at a fixed height without distorting its aspect ratio. */
function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to read image dimensions.'));
    img.src = dataUrl;
  });
}

function imageFormatFromDataUrl(dataUrl: string): 'PNG' | 'WEBP' | 'JPEG' {
  if (dataUrl.startsWith('data:image/png')) return 'PNG';
  if (dataUrl.startsWith('data:image/webp')) return 'WEBP';
  return 'JPEG';
}

/** How many photos are fetched, decoded and resized at once — each decoded original can be tens of MB of pixels, so this stays small. */
const PHOTO_PREPARE_CONCURRENCY = 3;

export interface PreparedReportPhoto {
  id: string;
  phase: PhotoPhase;
  image: PdfImage;
}

export interface PreparedReportPhotos {
  /** Successfully resized photos, in the model's own order. */
  photos: PreparedReportPhoto[];
  /** How many of the model's photos could NOT be fetched/decoded/resized and are therefore missing from the PDF. */
  skippedCount: number;
}

/**
 * Fetches and resizes every photo in the model (upright JPEG, at most 1600px
 * on the long edge — see pdfImage.ts) so the caller can learn how many
 * photos can't be included BEFORE anything is downloaded or sent. Pass the
 * result to generateClientReportPdf so the work isn't repeated. Reads only
 * `model.photos`, so it can't pull in anything the client-safe model didn't
 * already allow.
 */
export async function prepareClientReportPhotos(model: ClientReportModel): Promise<PreparedReportPhotos> {
  const results: (PreparedReportPhoto | null)[] = new Array(model.photos.length).fill(null);
  let next = 0;

  const worker = async () => {
    while (next < model.photos.length) {
      const index = next;
      next += 1;
      const photo = model.photos[index];
      try {
        results[index] = { id: photo.id, phase: photo.phase, image: await prepareImageForPdf(photo.url) };
      } catch {
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PHOTO_PREPARE_CONCURRENCY, model.photos.length) }, worker));

  const photos = results.filter((r): r is PreparedReportPhoto => r !== null);
  return { photos, skippedCount: model.photos.length - photos.length };
}

interface BrandImage {
  dataUrl: string;
  aspect: number;
}

/** A bundled brand asset (logo, leaf) — best-effort only. A broken/unreachable asset must never block generating the rest of the report (same rule as a broken photo). */
async function loadBrandImage(url: string): Promise<BrandImage | null> {
  try {
    const dataUrl = await toDataUrl(url);
    const size = await loadImageSize(dataUrl);
    return { dataUrl, aspect: size.height > 0 ? size.width / size.height : 1 };
  } catch {
    return null;
  }
}

/** Everything the drawing helpers below share — page geometry plus the document itself. */
interface Ctx {
  doc: jsPDF;
  model: ClientReportModel;
  logo: BrandImage | null;
  leaf: BrandImage | null;
  marginX: number;
  pageWidth: number;
  pageHeight: number;
  contentWidth: number;
  /** Where content stops on every page (the footer sits below this). */
  pageBottom: number;
  /** Top of the writing area on pages 2+ of the report (below the slim running header). */
  continuationTop: number;
}

/** Letter-spaced text. jsPDF's own `align` ignores charSpace, so alignment is computed here. */
function spacedText(ctx: Ctx, text: string, x: number, y: number, charSpace: number, align: 'left' | 'right' | 'center' = 'left'): void {
  const width = ctx.doc.getTextWidth(text) + charSpace * text.length;
  const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
  ctx.doc.text(text, left, y, { charSpace });
}

/** The text cut to fit `maxWidth` on ONE line at the font currently set, ending in "..." when it had to be shortened — never silently drops the end. */
function fitLine(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.doc.getTextWidth(text) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.doc.getTextWidth(`${cut}...`) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

/** At most `maxLines` wrapped lines at the font currently set; the last kept line ends in "..." if text was cut. */
function wrapClamped(ctx: Ctx, text: string, maxWidth: number, maxLines: number): string[] {
  const lines = ctx.doc.splitTextToSize(text, maxWidth) as string[];
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fitLine(ctx, `${kept[maxLines - 1]} ${lines[maxLines]}`, maxWidth);
  return kept;
}

function setFont(ctx: Ctx, style: 'bold' | 'normal', size: number, color: Rgb): void {
  ctx.doc.setFont('helvetica', style);
  ctx.doc.setFontSize(size);
  ctx.doc.setTextColor(...color);
}

function addBrandImage(ctx: Ctx, image: BrandImage | null, alias: string, x: number, y: number, height: number): void {
  if (!image) return;
  try {
    ctx.doc.addImage(image.dataUrl, imageFormatFromDataUrl(image.dataUrl), x, y, height * image.aspect, height, alias, 'FAST');
  } catch {
    // Skip — a corrupt brand image must never block the rest of the report.
  }
}

/** Runs `draw` with everything it paints clipped to a rounded rectangle. */
function withRoundedClip(ctx: Ctx, x: number, y: number, w: number, h: number, radius: number, draw: () => void): void {
  const { doc } = ctx;
  doc.saveGraphicsState();
  doc.roundedRect(x, y, w, h, radius, radius, null);
  doc.clip();
  doc.discardPath();
  draw();
  doc.restoreGraphicsState();
}

/** A round icon: a check mark when `ok`, otherwise an exclamation mark. */
function drawStatusIcon(ctx: Ctx, cx: number, cy: number, ok: boolean): void {
  const { doc } = ctx;
  doc.setFillColor(...(ok ? MEDIUM_GREEN : AMBER));
  doc.circle(cx, cy, 16, 'F');
  doc.setLineCap('round');
  doc.setLineJoin('round');
  if (ok) {
    doc.setDrawColor(...DARK_TEAL);
    doc.setLineWidth(2.4);
    doc.lines([[4.6, 4.8], [8.6, -9.6]], cx - 7, cy + 0.6, [1, 1], 'S', false);
  } else {
    doc.setDrawColor(...WHITE);
    doc.setLineWidth(2.8);
    doc.line(cx, cy - 8, cx, cy + 2);
    doc.setFillColor(...WHITE);
    doc.circle(cx, cy + 7.6, 1.6, 'F');
  }
  doc.setLineCap('butt');
  doc.setLineJoin('miter');
  doc.setLineWidth(1);
}

/** An outlined warning triangle with an exclamation mark. */
function drawWarningIcon(ctx: Ctx, x: number, y: number): void {
  const { doc } = ctx;
  doc.setDrawColor(...AMBER);
  doc.setLineWidth(1.3);
  doc.setLineJoin('round');
  doc.triangle(x + 8, y, x + 16, y + 14, x, y + 14, 'S');
  doc.setLineCap('round');
  doc.line(x + 8, y + 5, x + 8, y + 9);
  doc.setFillColor(...AMBER);
  doc.circle(x + 8, y + 11.6, 0.8, 'F');
  doc.setLineCap('butt');
  doc.setLineJoin('miter');
  doc.setLineWidth(1);
}

/** The page-1 header (with its facts strip). Returns the y just below the strip. */
function drawHeader(ctx: Ctx, photoCount: number): number {
  const { doc, model, marginX, pageWidth, contentWidth } = ctx;

  setFont(ctx, 'bold', 28, WHITE);
  const titleLines = wrapClamped(ctx, model.buildingName, contentWidth, 2);
  const titleLineHeight = 33;
  const kickerY = 116;
  const titleTop = 148;
  const subtitleY = titleTop + (titleLines.length - 1) * titleLineHeight + 24;
  const headerHeight = subtitleY + 30;

  doc.setFillColor(...DARK_TEAL);
  doc.rect(0, 0, pageWidth, headerHeight, 'F');

  // A large, faint oak leaf bleeding off the top-right — clipped to the header.
  if (ctx.leaf) {
    doc.saveGraphicsState();
    doc.rect(0, 0, pageWidth, headerHeight, null);
    doc.clip();
    doc.discardPath();
    doc.setGState(new GState({ opacity: 0.1 }));
    addBrandImage(ctx, ctx.leaf, 'brand-leaf', pageWidth - 190, -34, 310);
    doc.restoreGraphicsState();
  }

  addBrandImage(ctx, ctx.logo, 'brand-logo', marginX, 30, 56);
  setFont(ctx, 'bold', 12, WHITE);
  doc.text('Service report', pageWidth - marginX, 52, { align: 'right' });

  setFont(ctx, 'bold', 11, MEDIUM_GREEN);
  doc.text(fitLine(ctx, model.jobSummary, contentWidth), marginX, kickerY);

  setFont(ctx, 'bold', 28, WHITE);
  titleLines.forEach((line, i) => doc.text(line, marginX, titleTop + i * titleLineHeight));

  setFont(ctx, 'normal', 12, LIGHT_GREEN);
  doc.text(fitLine(ctx, `Prepared for ${model.clientName}`, contentWidth), marginX, subtitleY);

  // Facts strip: only facts the client-safe model really holds.
  const facts: [string, string][] = [
    ['Visit date', model.visitDateLabel],
    ['Service', model.jobSummary],
  ];
  if (photoCount > 0) facts.push(['Photos', `${photoCount} ${photoCount === 1 ? 'photo' : 'photos'}`]);

  const bandHeight = 58;
  doc.setFillColor(...TEAL_BAND);
  doc.rect(0, headerHeight, pageWidth, bandHeight, 'F');
  const colWidth = contentWidth / facts.length;
  facts.forEach(([label, value], i) => {
    const colX = marginX + i * colWidth;
    const textX = colX + (i > 0 ? 18 : 0);
    if (i > 0) {
      doc.setDrawColor(...BAND_DIVIDER);
      doc.setLineWidth(0.8);
      doc.line(colX, headerHeight + 13, colX, headerHeight + bandHeight - 13);
      doc.setLineWidth(1);
    }
    setFont(ctx, 'normal', 8.5, BAND_LABEL);
    doc.text(label, textX, headerHeight + 22);
    setFont(ctx, 'bold', 12, WHITE);
    doc.text(fitLine(ctx, value, colWidth - 24), textX, headerHeight + 40);
  });

  return headerHeight + bandHeight;
}

/** "Specification completed as agreed" (or the part-completed variant) as a rounded card with an icon. Returns the y below it. */
function drawStatus(ctx: Ctx, y: number): number {
  const { doc, model, marginX, contentWidth } = ctx;
  const height = 52;
  doc.setFillColor(...(model.specMet ? CARD : AMBER_TINT));
  doc.roundedRect(marginX, y, contentWidth, height, 8, 8, 'F');
  drawStatusIcon(ctx, marginX + 34, y + height / 2, model.specMet);
  setFont(ctx, 'bold', 13, model.specMet ? TEXT_DARK : AMBER_TEXT);
  doc.text(
    model.specMet ? 'Specification completed as agreed.' : 'Part of the specification was not fully completed.',
    marginX + 66,
    y + height / 2 + 4.5,
  );
  return y + height;
}

/** A slim running header for pages 2+ of the report, so a continuation page is still recognisably this report. */
function drawRunningHeader(ctx: Ctx): void {
  const { doc, model, marginX, pageWidth } = ctx;
  setFont(ctx, 'bold', 7.5, TEXT_LIGHT);
  spacedText(ctx, 'SERVICE REPORT', marginX, 34, 1.8);
  setFont(ctx, 'normal', 8.5, TEXT_LIGHT);
  doc.text(fitLine(ctx, model.buildingName, 300), pageWidth - marginX, 34, { align: 'right' });
  doc.setDrawColor(...MEDIUM_GREEN);
  doc.setLineWidth(1.4);
  doc.line(marginX, 42, pageWidth - marginX, 42);
  doc.setLineWidth(1);
}

/** The Before / During / After tag laid over a photo's top-left corner. */
function drawPhotoTag(ctx: Ctx, entry: OrderedPhotoEntry<unknown>, x: number, y: number, size: 'large' | 'small'): void {
  const { doc } = ctx;
  const large = size === 'large';
  const text = photoTag(entry);
  const fontSize = large ? 9 : 7;
  const padding = large ? 11 : 7;
  const height = large ? 20 : 14;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(fontSize);
  const width = doc.getTextWidth(text) + padding * 2;
  const fill: Rgb = entry.phase === 'after' ? MEDIUM_GREEN : entry.phase === 'during' ? LIGHT_GREEN : WHITE;
  doc.setFillColor(...fill);
  doc.roundedRect(x, y, width, height, height / 2, height / 2, 'F');
  doc.setTextColor(...DARK_TEAL);
  doc.text(text, x + padding, y + height / 2 + fontSize * 0.34);
}

/** One photo inside a rounded frame, fitted whole ("contain") on a soft mat — never cropped or stretched — with its phase tag on top. */
function drawPhoto(ctx: Ctx, entry: OrderedPhotoEntry<PreparedReportPhoto>, x: number, y: number, w: number, h: number, size: 'large' | 'small'): void {
  const { doc } = ctx;
  const radius = size === 'large' ? 10 : 6;
  const image = entry.photo.image;
  withRoundedClip(ctx, x, y, w, h, radius, () => {
    doc.setFillColor(...PHOTO_MAT);
    doc.rect(x, y, w, h, 'F');
    const fitted = fitInside(image.width, image.height, w, h);
    // The alias makes jsPDF store each photo's bytes once.
    doc.addImage(image.dataUrl, 'JPEG', x + (w - fitted.width) / 2, y + (h - fitted.height) / 2, fitted.width, fitted.height, `photo-${entry.photo.id}`, 'FAST');
  });
  drawPhotoTag(ctx, entry, x + (size === 'large' ? 12 : 7), y + (size === 'large' ? 12 : 7), size);
}

/**
 * Builds a client-facing PDF from the same ClientReportModel the on-screen
 * preview renders — never re-reads ReportDetail/ReportPhoto/JobRow itself,
 * so it can only ever contain what the model already decided is client-
 * safe. Runs entirely in the Manager's browser (no server round trip) —
 * the browser-specific steps are toDataUrl() above (the bundled brand
 * images) and pdfImage.ts (each already-signed photo URL); a future
 * server-side reuse of this same function would only need to supply those
 * differently, not change anything below.
 *
 * Layout: a Dark Teal header (the logo artwork needs a dark background) with
 * the building as the title and a facts strip; a specification-status card;
 * the written sections (work carried out and notes side by side when both
 * are short); an issues call-out; then the photographs — a report with both a
 * Before and an After leads with that pair large and side by side, and any
 * other photos follow in a 3-column grid. Photos are fitted whole, never
 * cropped or stretched, and each is embedded once (jsPDF alias). Nothing
 * photo-identifying beyond its phase tag ever reaches the PDF.
 *
 * `prepared` — the result of prepareClientReportPhotos(model). Callers that
 * want to warn about skipped photos before proceeding should prepare first
 * and pass it in; if omitted it is prepared here and any skipped photos are
 * silently left out (the same behaviour as before this option existed).
 *
 * The logo and leaf follow the old rule: if either can't be fetched or
 * decoded, the header simply renders without it rather than failing the PDF.
 */
export async function generateClientReportPdf(model: ClientReportModel, prepared?: PreparedReportPhotos): Promise<Blob> {
  const preparedPhotos = (prepared ?? (await prepareClientReportPhotos(model))).photos;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 48;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const footerReserve = 66;
  const [logo, leaf] = await Promise.all([loadBrandImage(kindContractorsLogo), loadBrandImage(kindLeaf)]);
  const ctx: Ctx = {
    doc,
    model,
    logo,
    leaf,
    marginX,
    pageWidth,
    pageHeight,
    contentWidth: pageWidth - marginX * 2,
    pageBottom: pageHeight - footerReserve,
    continuationTop: 74,
  };
  const { contentWidth, pageBottom } = ctx;

  let y = drawHeader(ctx, preparedPhotos.length) + 24;
  y = drawStatus(ctx, y) + 30;

  /** Starts a new report page (with the running header) if `needed` more points won't fit on this one. */
  const ensureSpace = (needed: number) => {
    if (y + needed > pageBottom) {
      doc.addPage();
      drawRunningHeader(ctx);
      y = ctx.continuationTop;
    }
  };

  const BODY_SIZE = 11;
  const BODY_LEADING = 16;
  const wrapBody = (text: string, width: number): string[] => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(BODY_SIZE);
    return doc.splitTextToSize(text, width) as string[];
  };

  /** Bold heading with a short green underline exactly as wide as the heading. Doesn't move y. */
  const drawHeading = (title: string, x: number) => {
    setFont(ctx, 'bold', 13, TEXT_DARK);
    doc.text(title, x, y);
    doc.setFillColor(...MEDIUM_GREEN);
    doc.rect(x, y + 7, doc.getTextWidth(title), 2.6, 'F');
  };

  const HEADING_HEIGHT = 30;

  /** Body text flowing down the page from the current y, breaking onto a new page when needed. */
  const flowBody = (lines: string[], x: number) => {
    setFont(ctx, 'normal', BODY_SIZE, TEXT_DARK);
    for (const line of lines) {
      if (y + BODY_LEADING > pageBottom) {
        doc.addPage();
        drawRunningHeader(ctx);
        y = ctx.continuationTop;
        setFont(ctx, 'normal', BODY_SIZE, TEXT_DARK);
      }
      doc.text(line, x, y);
      y += BODY_LEADING;
    }
  };

  const addSection = (title: string, body: string) => {
    ensureSpace(HEADING_HEIGHT + BODY_LEADING * 2);
    drawHeading(title, marginX);
    y += HEADING_HEIGHT - 4;
    flowBody(wrapBody(body, contentWidth), marginX);
    y += 22;
  };

  // Work carried out + Notes: side by side when both are present and short; otherwise stacked.
  const columnGap = 28;
  const columnWidth = (contentWidth - columnGap) / 2;
  const workLines = model.workCarriedOut ? wrapBody(model.workCarriedOut, columnWidth) : [];
  const notesLines = model.notes ? wrapBody(model.notes, columnWidth) : [];
  const sideBySide = workLines.length > 0 && notesLines.length > 0 && Math.max(workLines.length, notesLines.length) <= 12;
  if (sideBySide) {
    const bodyHeight = Math.max(workLines.length, notesLines.length) * BODY_LEADING;
    ensureSpace(HEADING_HEIGHT + bodyHeight);
    drawHeading('Work carried out', marginX);
    drawHeading('Notes', marginX + columnWidth + columnGap);
    y += HEADING_HEIGHT - 4;
    setFont(ctx, 'normal', BODY_SIZE, TEXT_DARK);
    workLines.forEach((line, i) => doc.text(line, marginX, y + i * BODY_LEADING));
    notesLines.forEach((line, i) => doc.text(line, marginX + columnWidth + columnGap, y + i * BODY_LEADING));
    y += bodyHeight + 22;
  } else {
    if (model.workCarriedOut) addSection('Work carried out', model.workCarriedOut);
    if (model.notes) addSection('Notes', model.notes);
  }

  // Issues: a warm call-out card. A very long one falls back to flowing plain text rather than a box that can't fit a page.
  if (model.issues) {
    const inset = 16;
    const textX = marginX + inset + 28;
    const issueLines = wrapBody(model.issues, contentWidth - inset - 28 - inset);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    const helperLines = doc.splitTextToSize(ISSUE_HELPER_TEXT, contentWidth - inset - 28 - inset) as string[];
    const cardHeight = 16 + 16 + issueLines.length * BODY_LEADING + 6 + helperLines.length * 12 + 14;
    if (issueLines.length > 24) {
      addSection('Flagged for your attention', model.issues);
    } else {
      ensureSpace(cardHeight + 8);
      withRoundedClip(ctx, marginX, y, contentWidth, cardHeight, 8, () => {
        doc.setFillColor(...AMBER_TINT);
        doc.rect(marginX, y, contentWidth, cardHeight, 'F');
        doc.setFillColor(...AMBER);
        doc.rect(marginX, y, 4, cardHeight, 'F');
      });
      drawWarningIcon(ctx, marginX + inset + 4, y + 17);
      setFont(ctx, 'bold', 11, AMBER_TEXT);
      doc.text('Flagged for your attention', textX, y + 26);
      setFont(ctx, 'normal', BODY_SIZE, TEXT_DARK);
      issueLines.forEach((line, i) => doc.text(line, textX, y + 44 + i * BODY_LEADING));
      setFont(ctx, 'normal', 8.5, TEXT_MED);
      helperLines.forEach((line, i) => doc.text(line, textX, y + 44 + issueLines.length * BODY_LEADING + 8 + i * 12));
      y += cardHeight + 30;
    }
  }

  // --- Photographs ---
  const plan = planPhotoLayout(preparedPhotos);

  /** Section heading (bold + green underline) with a small grey note at the right edge. */
  const drawPhotoSectionHeading = (title: string, note: string) => {
    setFont(ctx, 'normal', 9, TEXT_LIGHT);
    doc.text(note, pageWidth - marginX, y, { align: 'right' });
    drawHeading(title, marginX);
    y += HEADING_HEIGHT + 2;
  };

  if (plan.hero) {
    const gap = 16;
    const frameWidth = (contentWidth - gap) / 2;
    const frameHeight = frameWidth / PHOTO_CELL_ASPECT;
    ensureSpace(HEADING_HEIGHT + 2 + frameHeight);
    drawPhotoSectionHeading('Before and after', 'Photos taken on site');
    drawPhoto(ctx, plan.hero.before, marginX, y, frameWidth, frameHeight, 'large');
    drawPhoto(ctx, plan.hero.after, marginX + frameWidth + gap, y, frameWidth, frameHeight, 'large');
    y += frameHeight + 30;
  }

  if (plan.rest.length > 0) {
    const gap = 12;
    const cellWidth = (contentWidth - gap * (PHOTO_GRID_COLUMNS - 1)) / PHOTO_GRID_COLUMNS;
    const cellHeight = cellWidth / PHOTO_CELL_ASPECT;
    const rowHeight = cellHeight + gap;
    ensureSpace(HEADING_HEIGHT + 2 + cellHeight);
    drawPhotoSectionHeading(plan.hero ? 'More photos' : 'Site photographs', 'Photos taken on site');
    for (let rowStart = 0; rowStart < plan.rest.length; rowStart += PHOTO_GRID_COLUMNS) {
      ensureSpace(cellHeight);
      for (let col = 0; col < PHOTO_GRID_COLUMNS && rowStart + col < plan.rest.length; col += 1) {
        drawPhoto(ctx, plan.rest[rowStart + col], marginX + col * (cellWidth + gap), y, cellWidth, cellHeight, 'small');
      }
      y += rowHeight;
    }
  }

  // --- Footer, stamped on every page once the full page count is known. ---
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    const isLast = page === pageCount;
    const ruleY = pageHeight - footerReserve + 16;
    doc.setDrawColor(...HAIRLINE);
    doc.setLineWidth(0.75);
    doc.line(marginX, ruleY, pageWidth - marginX, ruleY);
    doc.setLineWidth(1);
    setFont(ctx, 'bold', isLast ? 11 : 8.5, DARK_TEAL);
    doc.text(isLast ? 'Thank you for choosing Kind Contractors' : 'Kind Contractors', marginX, ruleY + 19);
    if (isLast) {
      setFont(ctx, 'normal', 8.5, TEXT_MED);
      doc.text(FOOTER_CONTACT_LINE, marginX, ruleY + 33);
    }
    setFont(ctx, 'normal', 8.5, TEXT_LIGHT);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - marginX, ruleY + 19, { align: 'right' });
  }

  return doc.output('blob');
}
