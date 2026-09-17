import { jsPDF } from 'jspdf';
import type { ClientReportModel } from './clientReportModel';
import kindContractorsLogo from '../assets/kind_Contractors_logo.png';

const PHASE_LABEL: Record<ClientReportModel['photos'][number]['phase'], string> = {
  before: 'Before',
  during: 'During',
  after: 'After',
};

// Kind Contractors brand palette (CLAUDE.md section 10) — the same Dark
// Teal used throughout the app's own UI, reused here so the PDF reads as
// the same brand rather than a generic document. Chosen dark enough to
// stay legible on a black-and-white printout/photocopy, per the
// print/greyscale requirement.
const BRAND_TEAL: [number, number, number] = [30, 84, 75];
const BRAND_TEAL_TINT: [number, number, number] = [230, 237, 236];
const TEXT_DARK: [number, number, number] = [35, 35, 35];
const TEXT_MED: [number, number, number] = [90, 90, 90];
const TEXT_LIGHT: [number, number, number] = [140, 140, 140];
const DIVIDER: [number, number, number] = [220, 220, 220];
const WARN: [number, number, number] = [150, 60, 40];
const WARN_TINT: [number, number, number] = [250, 236, 231];

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

/** Reads an image's natural pixel size so the logo can be placed at a fixed height without distorting its aspect ratio. */
function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to read logo dimensions.'));
    img.src = dataUrl;
  });
}

function imageFormatFromDataUrl(dataUrl: string): 'PNG' | 'WEBP' | 'JPEG' {
  if (dataUrl.startsWith('data:image/png')) return 'PNG';
  if (dataUrl.startsWith('data:image/webp')) return 'WEBP';
  return 'JPEG';
}

/**
 * Builds a client-facing PDF from the same ClientReportModel the on-screen
 * preview renders — never re-reads ReportDetail/ReportPhoto/JobRow itself,
 * so it can only ever contain what the model already decided is client-
 * safe. Runs entirely in the Manager's browser (no server round trip) —
 * the one browser-specific step is toDataUrl() above, fetching each
 * already-signed photo URL (and, now, the bundled logo asset); a future
 * server-side reuse of this same function (Phase 2B, if wanted) would only
 * need to supply data URLs a different way, not change anything below.
 *
 * A single photo that fails to load is skipped, not fatal — one broken
 * signed URL must never lose the rest of an otherwise-complete report. The
 * logo follows the exact same rule: if it can't be fetched or decoded, the
 * header simply renders without it rather than failing the whole PDF.
 */
export async function generateClientReportPdf(model: ClientReportModel): Promise<Blob> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 48;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - marginX * 2;
  const topMargin = 50;
  const footerReserve = 46;
  let y = topMargin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - footerReserve) {
      doc.addPage();
      y = topMargin;
    }
  };

  // Logo — best-effort only. A broken/unreachable asset must never block
  // generating the rest of the report (same rule as a broken photo below).
  let logoDataUrl: string | null = null;
  let logoAspect = 1;
  try {
    logoDataUrl = await toDataUrl(kindContractorsLogo);
    const size = await loadImageSize(logoDataUrl);
    logoAspect = size.height > 0 ? size.width / size.height : 1;
  } catch {
    logoDataUrl = null;
  }

  // --- Header: logo (if available) + a small report-title kicker. ---
  const logoHeight = 26;
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, imageFormatFromDataUrl(logoDataUrl), marginX, y - 6, logoHeight * logoAspect, logoHeight, undefined, 'FAST');
    } catch {
      // Skip — a corrupt logo image must never block the rest of the report.
    }
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(...BRAND_TEAL);
  doc.text('SERVICE REPORT', pageWidth - marginX, y + 6, { align: 'right' });
  y += logoHeight + 16;

  doc.setDrawColor(...BRAND_TEAL);
  doc.setLineWidth(1.4);
  doc.line(marginX, y, pageWidth - marginX, y);
  doc.setLineWidth(1);
  y += 20;

  // --- Client / site information card. ---
  const infoStartY = y;
  const infoHeight = 74;
  ensureSpace(infoHeight + 20);
  doc.setFillColor(...BRAND_TEAL_TINT);
  doc.rect(marginX, y, contentWidth, infoHeight, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(...BRAND_TEAL);
  doc.text(model.buildingName, marginX + 14, y + 26);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...TEXT_MED);
  doc.text(`${model.clientName} - ${model.jobSummary}`, marginX + 14, y + 44);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...BRAND_TEAL);
  doc.text('VISIT DATE', marginX + 14, y + 61);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...TEXT_MED);
  doc.text(model.visitDateLabel, marginX + 78, y + 61);

  y = infoStartY + infoHeight + 24;

  // A small teal square marker before each section title — echoes the
  // app's own square-corners visual language (CLAUDE.md section 4) rather
  // than a generic bullet or rule.
  const addSection = (title: string, body: string) => {
    ensureSpace(44);
    doc.setFillColor(...BRAND_TEAL);
    doc.rect(marginX, y - 9, 8, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BRAND_TEAL);
    doc.text(title.toUpperCase(), marginX + 14, y);
    y += 17;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(...TEXT_DARK);
    const lines = doc.splitTextToSize(body, contentWidth) as string[];
    for (const line of lines) {
      ensureSpace(14);
      doc.text(line, marginX, y);
      y += 14;
    }
    y += 14;
  };

  if (model.workCarriedOut) addSection('Work carried out', model.workCarriedOut);
  if (model.notes) addSection('Notes', model.notes);
  if (model.issues) addSection('Issues flagged', model.issues);

  // --- Specification status banner. ---
  const bannerHeight = 26;
  ensureSpace(bannerHeight + 16);
  const bannerTint = model.specMet ? BRAND_TEAL_TINT : WARN_TINT;
  const bannerAccent = model.specMet ? BRAND_TEAL : WARN;
  doc.setFillColor(...bannerTint);
  doc.rect(marginX, y, contentWidth, bannerHeight, 'F');
  doc.setFillColor(...bannerAccent);
  doc.rect(marginX, y, 4, bannerHeight, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(...bannerAccent);
  doc.text(
    model.specMet ? 'Specification completed as agreed.' : 'Part of the specification was not fully completed.',
    marginX + 14,
    y + bannerHeight / 2 + 4,
  );
  y += bannerHeight + 20;

  // --- Photos, grouped by phase. ---
  const phases: ClientReportModel['photos'][number]['phase'][] = ['before', 'during', 'after'];
  const thumbSize = 128;
  const gap = 12;
  const perRow = Math.max(1, Math.floor((contentWidth + gap) / (thumbSize + gap)));

  for (const phase of phases) {
    const phasePhotos = model.photos.filter((p) => p.phase === phase);
    if (phasePhotos.length === 0) continue;

    ensureSpace(32);
    doc.setFillColor(...BRAND_TEAL);
    doc.rect(marginX, y - 9, 8, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...BRAND_TEAL);
    doc.text(`${PHASE_LABEL[phase].toUpperCase()} (${phasePhotos.length})`, marginX + 14, y);
    y += 18;

    let col = 0;
    for (const photo of phasePhotos) {
      if (col === 0) ensureSpace(thumbSize + gap);
      const x = marginX + col * (thumbSize + gap);
      try {
        const dataUrl = await toDataUrl(photo.url);
        doc.addImage(dataUrl, imageFormatFromDataUrl(dataUrl), x, y, thumbSize, thumbSize, undefined, 'FAST');
        doc.setDrawColor(...DIVIDER);
        doc.setLineWidth(0.75);
        doc.rect(x, y, thumbSize, thumbSize);
        doc.setLineWidth(1);
      } catch {
        // Skip a single unreachable/corrupt photo rather than abort the whole PDF.
      }
      col += 1;
      if (col >= perRow) {
        col = 0;
        y += thumbSize + gap;
      }
    }
    if (col !== 0) y += thumbSize + gap;
    y += 8;
  }

  // --- Footer, stamped on every page once the full page count is known. ---
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    const footerY = pageHeight - footerReserve + 20;
    doc.setDrawColor(...DIVIDER);
    doc.setLineWidth(0.75);
    doc.line(marginX, footerY - 14, pageWidth - marginX, footerY - 14);
    doc.setLineWidth(1);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...BRAND_TEAL);
    doc.text('KIND CONTRACTORS', marginX, footerY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...TEXT_LIGHT);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - marginX, footerY, { align: 'right' });
  }

  return doc.output('blob');
}
