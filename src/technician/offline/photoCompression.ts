// Shrinks a technician's photo before it is saved to the offline queue and
// uploaded. A raw iPhone photo is typically 2-5 MB (more in high-resolution
// modes); seven of those uploading at once over mobile data is what made
// individual uploads fail. 1600px on the long edge at JPEG 0.85 is typically a
// few hundred KB, still ~230 dpi across a full A4 page, so the client report
// PDF (which scales photos to 1600px itself) loses nothing.
//
// Safety rule, above all: this must never cost anyone a photo. Any problem —
// an undecodable format, a canvas/memory failure, an encoder that returns
// nothing, a result that isn't smaller — falls back to the ORIGINAL file,
// unchanged. The only thing this module can do is hand back a smaller copy
// or the very file it was given.

/** Longest edge, in pixels, of the copy that gets uploaded. Never enlarged. */
export const UPLOAD_PHOTO_MAX_EDGE = 1600;
export const UPLOAD_PHOTO_JPEG_QUALITY = 0.85;

/** A JPEG already within the edge limit and this small is left exactly as taken — re-encoding it would only lose quality. */
const LEAVE_ALONE_BELOW_BYTES = 600 * 1024;

export interface PreparedPhotoFile {
  /** What gets stored and uploaded: the resized JPEG, or the untouched original. */
  blob: Blob;
  /** The name to derive the storage path's extension from — ends in .jpg when the JPEG copy is used. */
  filename: string;
  /** Size in bytes of the file as picked, before any processing. */
  originalSize: number;
  /** True only when `blob` is the resized copy rather than the original. */
  resized: boolean;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decodes with EXIF orientation applied, so a portrait phone photo (stored
 * sideways plus a "rotate" flag) comes out upright once redrawn on a canvas.
 */
async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall through to the <img> path — some browsers reject the options bag or a specific format here.
    }
  }

  const objectUrl = URL.createObjectURL(file);
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

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', UPLOAD_PHOTO_JPEG_QUALITY));
}

function jpegFilename(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '').trim();
  return `${base || 'photo'}.jpg`;
}

/** Returns the resized copy, or null when the original should be kept as is. Throws on any processing failure (the caller falls back to the original). */
async function resizeToJpeg(file: File): Promise<PreparedPhotoFile | null> {
  const decoded = await decodeImage(file);
  try {
    if (decoded.width <= 0 || decoded.height <= 0) return null;
    const scale = Math.min(1, UPLOAD_PHOTO_MAX_EDGE / Math.max(decoded.width, decoded.height));
    const needsResize = scale < 1;

    if (!needsResize && file.type === 'image/jpeg' && file.size <= LEAVE_ALONE_BELOW_BYTES) return null;

    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // JPEG has no alpha — transparent pixels would otherwise go black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, width, height);

    const blob = await canvasToJpeg(canvas);
    // Free the canvas backing store right away — several photos are processed in a row.
    canvas.width = 0;
    canvas.height = 0;

    if (!blob || blob.size === 0) return null;
    // Not resized and not smaller: re-encoding bought nothing, keep the original untouched.
    if (!needsResize && blob.size >= file.size) return null;

    return { blob, filename: jpegFilename(file.name), originalSize: file.size, resized: true };
  } finally {
    decoded.release();
  }
}

/**
 * The one entry point. Never throws and never loses the photo: on ANY problem
 * it returns the original file untouched.
 */
export async function preparePhotoForUpload(file: File): Promise<PreparedPhotoFile> {
  const original: PreparedPhotoFile = { blob: file, filename: file.name, originalSize: file.size, resized: false };
  try {
    return (await resizeToJpeg(file)) ?? original;
  } catch {
    return original;
  }
}

/** "3.8 MB", "412 KB" — for failure messages. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
