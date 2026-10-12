// Reads a picked video in the browser: its length (for the 60-second rule) and one frame to use as the poster thumbnail.
// Browser-only (needs <video> and <canvas>); everything here is BEST EFFORT. A video the browser cannot decode (for example a
// phone's HEVC clip in a browser without that codec) still uploads - it just has no thumbnail and its length is left to the
// server - so nothing in this file can ever stop an upload.
import { REPORT_VIDEO_LIMITS } from './reportVideoRules';

export interface VideoMetadata {
  /** Length in seconds, or null when the browser could not read it. */
  durationSeconds: number | null;
  /** A JPEG poster of at most 1 MiB, or null when no frame could be drawn. */
  thumbnail: Blob | null;
}

const READ_TIMEOUT_MS = 10_000;
const THUMBNAIL_WIDTH = 640;

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export async function readVideoMetadata(file: File): Promise<VideoMetadata> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;

  const finish = (): void => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };

  try {
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), READ_TIMEOUT_MS);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve(true);
      };
      video.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      video.src = url;
    });
    if (!loaded) return { durationSeconds: null, thumbnail: null };

    const durationSeconds = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 100) / 100 : null;

    // A frame about one second in (or the middle of a shorter clip) is usually past any black first frame.
    const seeked = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), READ_TIMEOUT_MS);
      video.onseeked = () => {
        clearTimeout(timer);
        resolve(true);
      };
      video.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      video.currentTime = durationSeconds ? Math.min(1, durationSeconds / 2) : 0;
    });
    if (!seeked || !video.videoWidth || !video.videoHeight) return { durationSeconds, thumbnail: null };

    const width = Math.min(THUMBNAIL_WIDTH, video.videoWidth);
    const height = Math.max(1, Math.round((video.videoHeight * width) / video.videoWidth));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { durationSeconds, thumbnail: null };
    ctx.drawImage(video, 0, 0, width, height);

    let thumbnail = await toJpeg(canvas, 0.8);
    if (thumbnail && thumbnail.size > REPORT_VIDEO_LIMITS.maxThumbnailBytes) thumbnail = await toJpeg(canvas, 0.5);
    if (thumbnail && (thumbnail.size === 0 || thumbnail.size > REPORT_VIDEO_LIMITS.maxThumbnailBytes)) thumbnail = null;
    canvas.width = 0;
    canvas.height = 0;
    return { durationSeconds, thumbnail };
  } catch {
    return { durationSeconds: null, thumbnail: null };
  } finally {
    finish();
  }
}
