import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** A web link drawn over a page, positioned in percent of the page so it follows the page's displayed size. */
export interface PdfPageLink {
  url: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A box on a page in PDF points, measured from the page's top-left corner. */
export interface PdfBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A photo on a page that can be opened larger: its box in points, and the photo's own pixel width (for a sharp enlargement). */
export interface PdfPhotoBox extends PdfBox {
  pixelWidth: number;
}

interface RenderedPage {
  /** The page drawn to an image (PNG data URL). */
  image: string;
  /** Width / height of the page, so the image keeps its shape. */
  aspect: number;
  /** The page's size in points (for converting boxes to percentages). */
  size: { width: number; height: number };
  links: PdfPageLink[];
  photos: PdfPhotoBox[];
}

type PageBox = { x0?: number; y0?: number; width: number; height: number };

/**
 * Converts one PDF link annotation's rectangle (PDF points, origin bottom-left) to percentages of the page (origin top-left).
 * Only http(s) links are kept: anything else in a PDF (internal jumps, javascript:, file:) is not made clickable.
 */
export function pdfLinkToPageLink(annotation: { subtype?: string; url?: string; rect?: number[] }, page: PageBox): PdfPageLink | null {
  if (annotation.subtype !== 'Link' || typeof annotation.url !== 'string' || !/^https?:\/\//i.test(annotation.url)) return null;
  const box = rectToBox(annotation.rect, page);
  if (!box) return null;
  return { url: annotation.url, ...toPercent(box, page) };
}

/** A PDF rectangle [x1, y1, x2, y2] (bottom-left origin) as a top-left box in points, or null when malformed. */
function rectToBox(rect: number[] | undefined, page: PageBox): PdfBox | null {
  const [x1, y1, x2, y2] = rect ?? [];
  if (![x1, y1, x2, y2].every((n) => typeof n === 'number' && Number.isFinite(n)) || page.width <= 0 || page.height <= 0) return null;
  const x0 = page.x0 ?? 0;
  const y0 = page.y0 ?? 0;
  const left = Math.min(x1, x2) - x0;
  const top = page.height - (Math.max(y1, y2) - y0);
  return { left, top, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function toPercent(box: PdfBox, page: { width: number; height: number }): PdfBox {
  return { left: (box.left / page.width) * 100, top: (box.top / page.height) * 100, width: (box.width / page.width) * 100, height: (box.height / page.height) * 100 };
}

/** The operator codes this file reads (pdf.js `OPS`). */
export interface PdfImageOps {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
}

/**
 * Where each image on a page is drawn, from the page's pdf.js operator list: follows the transformation matrix through
 * save / restore / transform, and maps each painted image's unit square to the page. Boxes are in points from the top-left.
 */
export function imageBoxesFromOperatorList(
  fnArray: number[],
  argsArray: unknown[][],
  ops: PdfImageOps,
  page: PageBox,
): (PdfBox & { pixelWidth: number })[] {
  type M = [number, number, number, number, number, number];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const out: (PdfBox & { pixelWidth: number })[] = [];
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i] ?? [];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === ops.transform) {
      const [a, b, c, d, e, f] = args as number[];
      ctm = [a * ctm[0] + b * ctm[2], a * ctm[1] + b * ctm[3], c * ctm[0] + d * ctm[2], c * ctm[1] + d * ctm[3], e * ctm[0] + f * ctm[2] + ctm[4], e * ctm[1] + f * ctm[3] + ctm[5]];
    } else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [u * ctm[0] + v * ctm[2] + ctm[4], u * ctm[1] + v * ctm[3] + ctm[5]]);
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      const box = rectToBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], page);
      // paintImageXObject's arguments are [id, width, height] in the image's own pixels; an inline image carries an object.
      const pixelWidth = typeof args[1] === 'number' ? args[1] : ((args[0] as { width?: number } | undefined)?.width ?? 0);
      if (box) out.push({ ...box, pixelWidth });
    }
  }
  return out;
}

/** Smallest side, in points, of an image that is treated as a photo (the report's logo is 56pt tall, its photos larger). */
export const MIN_PHOTO_SIDE_PT = 60;

/**
 * Which images can be opened larger: the report's photos. Excluded: images not wholly on the page (the decorative leaf),
 * small ones (the logo), and any image under a web link (a video thumbnail: clicking it opens the video, not a photo).
 */
export function zoomablePhotoBoxes(images: (PdfBox & { pixelWidth: number })[], links: PdfBox[], page: { width: number; height: number }): PdfPhotoBox[] {
  const inside = (b: PdfBox) => b.left >= -0.5 && b.top >= -0.5 && b.left + b.width <= page.width + 0.5 && b.top + b.height <= page.height + 0.5;
  const overlaps = (a: PdfBox, b: PdfBox) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
  return images.filter((img) => inside(img) && Math.min(img.width, img.height) >= MIN_PHOTO_SIDE_PT && !links.some((l) => overlaps(img, l)));
}

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/** Draws every page of the document and finds its links and photos. */
async function renderPages(doc: PDFDocumentProxy, ops: PdfImageOps): Promise<RenderedPage[]> {
  const pages: RenderedPage[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    // Sharp on high-density screens without huge images: about 1800px wide.
    const viewport = page.getViewport({ scale: Math.min(3, 1800 / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw the report.');
    await page.render({ canvasContext: context, viewport }).promise;
    const [vx0, vy0, vx1, vy1] = page.view;
    const box: PageBox = { x0: vx0, y0: vy0, width: vx1 - vx0, height: vy1 - vy0 };
    const annotations = (await page.getAnnotations()) as { subtype?: string; url?: string; rect?: number[] }[];
    const links = annotations.map((a) => pdfLinkToPageLink(a, box)).filter((l): l is PdfPageLink => l !== null);
    const linkBoxes = annotations
      .filter((a) => pdfLinkToPageLink(a, box) !== null)
      .map((a) => rectToBox(a.rect, box))
      .filter((b): b is PdfBox => b !== null);
    const operators = await page.getOperatorList();
    const photos = zoomablePhotoBoxes(imageBoxesFromOperatorList(operators.fnArray, operators.argsArray, ops, box), linkBoxes, box);
    pages.push({ image: canvas.toDataURL('image/png'), aspect: base.width / base.height, size: { width: box.width, height: box.height }, links, photos });
  }
  return pages;
}

/** Draws just one photo's area of a page, at about the photo's own resolution (capped), for the enlarged view. */
async function renderPhoto(doc: PDFDocumentProxy, pageNumber: number, photo: PdfPhotoBox): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const scale = Math.max(2, Math.min(8, (photo.pixelWidth || photo.width * 3) / photo.width, 2400 / Math.max(photo.width, photo.height)));
  const viewport = page.getViewport({ scale, offsetX: -photo.left * scale, offsetY: -photo.top * scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(photo.width * scale));
  canvas.height = Math.max(1, Math.round(photo.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw the photo.');
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.92);
}

type Zoom = { status: 'loading' } | { status: 'ready'; image: string } | { status: 'error' };

/**
 * A generated report PDF shown inside the app, page by page. Its web links (the "Watch video" links) open in a NEW tab - the
 * browser's own PDF viewer would open them in place of the report - and its photos can be clicked to see them larger. The
 * PDF itself is unchanged: this only displays it.
 */
export default function PdfDocumentView({ blob, title }: { blob: Blob; title: string }) {
  const [state, setState] = useState<{ blob: Blob; pages: RenderedPage[] | null; error: string | null } | null>(null);
  const [zoom, setZoom] = useState<Zoom | null>(null);
  // The open document, kept while this view is shown so a photo can be redrawn larger; destroyed when it closes.
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const zoomRequest = useRef(0);

  // Drawing the PDF is asynchronous browser work (pdf.js + canvas) tied to which blob is shown: a true side effect, and the
  // open document must be released when the blob changes or the view closes.
  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    (async () => {
      const pdfjs = await loadPdfJs();
      // isEvalSupported: false - never evaluate code from a PDF (the report is our own, but there is no reason to allow it).
      opened = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
      if (cancelled) return;
      docRef.current = opened;
      const pages = await renderPages(opened, pdfjs.OPS);
      if (!cancelled) setState({ blob, pages, error: null });
    })().catch(() => {
      if (!cancelled) setState({ blob, pages: null, error: 'The report could not be displayed here. Use Download PDF to open it instead.' });
    });
    return () => {
      cancelled = true;
      if (docRef.current === opened) docRef.current = null;
      void opened?.destroy();
    };
  }, [blob]);

  const openPhoto = (pageIndex: number, photo: PdfPhotoBox) => {
    const doc = docRef.current;
    if (!doc) return;
    const request = ++zoomRequest.current;
    setZoom({ status: 'loading' });
    renderPhoto(doc, pageIndex + 1, photo).then(
      (image) => request === zoomRequest.current && setZoom({ status: 'ready', image }),
      () => request === zoomRequest.current && setZoom({ status: 'error' }),
    );
  };
  const closePhoto = () => {
    zoomRequest.current += 1;
    setZoom(null);
  };

  const current = state?.blob === blob ? state : null;
  if (!current) return <div className="p-4 text-[12.5px] text-neutral-500">Displaying the report…</div>;
  if (current.error) {
    return (
      <div role="alert" className="m-4 border border-missed bg-missed/10 p-3 text-[12.5px] text-missed-fg">
        {current.error}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4 bg-neutral-200 p-4" aria-label={title}>
      {current.pages!.map((page, i) => (
        <div key={i} className="relative w-full max-w-[820px] bg-white shadow-sm" style={{ aspectRatio: String(page.aspect) }}>
          <img src={page.image} alt={`${title}, page ${i + 1} of ${current.pages!.length}`} className="block h-full w-full" />
          {page.photos.map((photo, j) => {
            const p = toPercent(photo, page.size);
            return (
              <button
                key={`photo-${j}`}
                type="button"
                onClick={() => openPhoto(i, photo)}
                title="View larger"
                aria-label={`View photo ${j + 1} on page ${i + 1} larger`}
                className="absolute block cursor-zoom-in hover:outline hover:outline-2 hover:outline-teal"
                style={{ left: `${p.left}%`, top: `${p.top}%`, width: `${p.width}%`, height: `${p.height}%` }}
              />
            );
          })}
          {page.links.map((link, j) => (
            <a
              key={`link-${j}`}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Opens in a new tab"
              aria-label="Watch video (opens in a new tab)"
              className="absolute block hover:bg-teal/10"
              style={{ left: `${link.left}%`, top: `${link.top}%`, width: `${link.width}%`, height: `${link.height}%` }}
            />
          ))}
        </div>
      ))}
      {zoom && <PhotoLightbox zoom={zoom} onClose={closePhoto} />}
    </div>
  );
}

/** The enlarged photo, over everything. Close, a click outside the photo, or Escape returns to the report. */
export function PhotoLightbox({ zoom, onClose }: { zoom: Zoom; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo, enlarged"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/80 p-6"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <button autoFocus onClick={onClose} className="absolute top-4 right-4 cursor-pointer bg-white px-3 py-1 text-[11.5px] font-semibold text-ink">
        Close
      </button>
      {zoom.status === 'loading' && <div className="text-[13px] text-white">Opening the photo…</div>}
      {zoom.status === 'error' && (
        <div role="alert" className="border border-missed bg-white p-3 text-[12.5px] text-missed-fg">
          The photo could not be shown larger.
        </div>
      )}
      {zoom.status === 'ready' && (
        <img src={zoom.image} alt="Photo from the report, enlarged" onClick={(e) => e.stopPropagation()} className="max-h-[88vh] max-w-[92vw] object-contain shadow-lg" />
      )}
    </div>
  );
}
