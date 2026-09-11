import { jsPDF } from 'jspdf';
import type { ClientReportModel } from './clientReportModel';

const PHASE_LABEL: Record<ClientReportModel['photos'][number]['phase'], string> = {
  before: 'Before',
  during: 'During',
  after: 'After',
};

/** Fetches an (already-signed) photo URL and converts it to a data URL — jsPDF's addImage needs the actual image bytes, not a remote URL. */
async function toDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read photo.'));
    reader.readAsDataURL(blob);
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
 * already-signed photo URL; a future server-side reuse of this same
 * function (Phase 2B, if wanted) would only need to supply data URLs a
 * different way, not change anything below.
 *
 * A single photo that fails to load is skipped, not fatal — one broken
 * signed URL must never lose the rest of an otherwise-complete report.
 */
export async function generateClientReportPdf(model: ClientReportModel): Promise<Blob> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 48;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - marginX * 2;
  let y = 56;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - 40) {
      doc.addPage();
      y = 56;
    }
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(20);
  doc.text(model.buildingName, marginX, y);
  y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text(`${model.clientName} - ${model.jobSummary}`, marginX, y);
  y += 16;
  doc.text(`Visit date: ${model.visitDateLabel}`, marginX, y);
  y += 20;

  doc.setDrawColor(220);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 22;

  const addSection = (title: string, body: string) => {
    ensureSpace(40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(30);
    doc.text(title, marginX, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(50);
    const lines = doc.splitTextToSize(body, contentWidth) as string[];
    for (const line of lines) {
      ensureSpace(13);
      doc.text(line, marginX, y);
      y += 13;
    }
    y += 12;
  };

  if (model.workCarriedOut) addSection('Work carried out', model.workCarriedOut);

  ensureSpace(20);
  doc.setFont('helvetica', model.specMet ? 'normal' : 'bold');
  doc.setFontSize(10.5);
  if (model.specMet) doc.setTextColor(50);
  else doc.setTextColor(150, 60, 40);
  doc.text(
    model.specMet ? 'Specification completed as agreed.' : 'Part of the specification was not fully completed.',
    marginX,
    y,
  );
  y += 22;

  if (model.notes) addSection('Notes', model.notes);
  if (model.issues) addSection('Issues flagged', model.issues);

  const phases: ClientReportModel['photos'][number]['phase'][] = ['before', 'during', 'after'];
  const thumbSize = 130;
  const gap = 12;
  const perRow = Math.max(1, Math.floor((contentWidth + gap) / (thumbSize + gap)));

  for (const phase of phases) {
    const phasePhotos = model.photos.filter((p) => p.phase === phase);
    if (phasePhotos.length === 0) continue;

    ensureSpace(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(30);
    doc.text(PHASE_LABEL[phase], marginX, y);
    y += 16;

    let col = 0;
    for (const photo of phasePhotos) {
      if (col === 0) ensureSpace(thumbSize + gap);
      try {
        const dataUrl = await toDataUrl(photo.url);
        const x = marginX + col * (thumbSize + gap);
        doc.addImage(dataUrl, imageFormatFromDataUrl(dataUrl), x, y, thumbSize, thumbSize, undefined, 'FAST');
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
    y += 10;
  }

  return doc.output('blob');
}
