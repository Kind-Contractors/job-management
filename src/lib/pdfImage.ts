/** Longest edge, in pixels, of a photo's PDF copy — roughly 230 dpi across a full A4 width, plenty to zoom in on without embedding a multi-megapixel original. */
export const PDF_IMAGE_MAX_EDGE = 1600;
export const PDF_IMAGE_JPEG_QUALITY = 0.82;

export interface PdfImage {
  /** JPEG data URL of the resized copy — never the original upload. */
  dataUrl: string;
  /** Pixel size of the resized copy, AFTER EXIF orientation has been applied — i.e. the shape the photo actually has when viewed upright. */
  width: number;
  height: number;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decodes with EXIF orientation applied. jsPDF embeds JPEG bytes verbatim
 * and ignores the EXIF flag, so a portrait phone photo (stored sideways
 * plus an "rotate 90°" flag) would otherwise render on its side — redrawing
 * through a canvas is what bakes the rotation in. createImageBitmap is asked
 * explicitly; the <img> fallback relies on browsers' default
 * `image-orientation: from-image`, which drawImage honours in every
 * supported browser.
 */
async function decodeBlob(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall through to the <img> path — some browsers reject the options bag or a specific format here.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(objectUrl) };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err instanceof Error ? err : new Error('Failed to decode image.');
  }
}

/** Never enlarges; scales both axes by the same factor so the aspect ratio is preserved (rounding is at most half a pixel per axis). */
function scaledSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PDF_IMAGE_MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Fetches a photo (an already-signed URL) and returns an upright JPEG copy
 * no larger than PDF_IMAGE_MAX_EDGE on its longest edge. Throws if the photo
 * can't be fetched, decoded or re-encoded — the caller decides what a failed
 * photo means (see prepareClientReportPhotos). Only ever reads the photo;
 * the stored original is never touched.
 */
export async function prepareImageForPdf(url: string): Promise<PdfImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Photo request failed (HTTP ${response.status}).`);
  const blob = await response.blob();

  const decoded = await decodeBlob(blob);
  try {
    if (decoded.width <= 0 || decoded.height <= 0) throw new Error('Photo has no readable size.');
    const { width, height } = scaledSize(decoded.width, decoded.height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available.');
    // JPEG has no alpha — transparent PNG/WebP pixels would otherwise go black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', PDF_IMAGE_JPEG_QUALITY);
    // Free the canvas backing store right away — up to a few photos are in flight at once.
    canvas.width = 0;
    canvas.height = 0;
    if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('Failed to re-encode photo.');
    return { dataUrl, width, height };
  } finally {
    decoded.release();
  }
}

/** Largest size that fits inside a box while keeping the image's own aspect ratio ("contain") — never crops, never stretches. May scale up; that's a vector scale in a PDF, not a distortion. */
export function fitInside(imageWidth: number, imageHeight: number, boxWidth: number, boxHeight: number): { width: number; height: number } {
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  return { width: imageWidth * scale, height: imageHeight * scale };
}
