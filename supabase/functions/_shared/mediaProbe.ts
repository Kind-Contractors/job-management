// Reads what an uploaded file really is - from its own bytes, never from its name or the type the uploader claimed - and, for a video,
// its real length from the container header. Pure code (no Deno, no network): the caller supplies `read(offset, length)`, so the
// waste-media-check Edge Function reads a stored file with small HTTP Range requests and the tests feed it in-memory bytes.
//
// Video length without downloading the video:
//   * MP4 / MOV (ISO base media / QuickTime): the top-level boxes are walked by their headers only (a few bytes each) until `moov`;
//     inside it, `mvhd` holds timescale + duration. Phones put `moov` either first or after the media data - both are handled.
//     A fragmented MP4 (duration 0 in mvhd) gives no usable length.
//   * WebM (Matroska/EBML): the EBML header names the document type; inside the Segment, `Info` holds TimecodeScale + Duration.
//     Some browser-recorded WebM files have no Duration at all.
// When the length cannot be read, the result says so and the file is REJECTED (agreed rule: a video whose length cannot be verified
// is not accepted). The limit is strictly 60 seconds.

export type Reader = (offset: number, length: number) => Promise<Uint8Array>;

export type MediaKind = 'photo' | 'video' | 'thumbnail';

export const WASTE_MEDIA_LIMITS = {
  /** 150 MiB - equal to the bucket's file_size_limit. */
  maxVideoBytes: 157_286_400,
  /** Photos are shrunk on the phone to ~1600 px (well under 1 MB); this only stops something that is plainly not a photo. */
  maxPhotoBytes: 25 * 1024 * 1024,
  maxThumbnailBytes: 1_048_576,
  /** STRICTLY 60 s (agreed 2026-11-03): a video measured over 60 s is rejected - 60.01 s included. */
  maxVideoSeconds: 60,
} as const;

/** The extension each stored type uses, and the type stored for it. */
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export type Sniffed = 'jpeg' | 'png' | 'isobmff' | 'ebml' | null;

/** The container family from a file's first bytes. */
export function sniff(head: Uint8Array): Sniffed {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return 'png';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'ebml';
  if (head.length >= 8) {
    const type = ascii(head, 4, 4);
    // Modern files start with `ftyp`; older QuickTime files may start straight with one of these.
    if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(type)) return 'isobmff';
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = offset; i < offset + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}

const MAX_BOXES = 256;
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/** Length in seconds of an MP4 / MOV, from moov/mvhd; null when it cannot be read. */
export async function mp4DurationSeconds(read: Reader, size: number): Promise<number | null> {
  let offset = 0;
  for (let n = 0; n < MAX_BOXES && offset + 8 <= size; n++) {
    const header = await read(offset, Math.min(16, size - offset));
    if (header.length < 8) return null;
    let boxSize = u32(header, 0);
    const type = ascii(header, 4, 4);
    let headerSize = 8;
    if (boxSize === 1) {
      if (header.length < 16) return null;
      boxSize = u64(header, 8);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset; // runs to the end of the file
    }
    if (boxSize < headerSize) return null;
    if (type === 'moov') {
      const length = Math.min(boxSize, size - offset);
      if (length > MAX_MOOV_BYTES) return null;
      const moov = await read(offset, length);
      return mvhdSeconds(moov, headerSize);
    }
    offset += boxSize;
  }
  return null;
}

/** Finds `mvhd` among moov's direct children and returns duration / timescale. */
function mvhdSeconds(moov: Uint8Array, start: number): number | null {
  let o = start;
  while (o + 8 <= moov.length) {
    let size = u32(moov, o);
    const type = ascii(moov, o + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (o + 16 > moov.length) return null;
      size = u64(moov, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = moov.length - o;
    }
    if (size < headerSize) return null;
    if (type === 'mvhd') {
      const p = o + headerSize;
      if (p + 4 > moov.length) return null;
      const version = moov[p];
      let timescale: number;
      let duration: number;
      if (version === 1) {
        if (p + 32 > moov.length) return null;
        timescale = u32(moov, p + 20);
        duration = u64(moov, p + 24);
      } else {
        if (p + 20 > moov.length) return null;
        timescale = u32(moov, p + 12);
        duration = u32(moov, p + 16);
      }
      // 0 means "unknown" (fragmented files); all-ones is QuickTime's "indefinite".
      if (!timescale || !duration || duration === 0xffffffff) return null;
      const seconds = duration / timescale;
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }
    o += size;
  }
  return null;
}

// ---- EBML (WebM) --------------------------------------------------------------------------------------------------------------------
const EBML_WINDOW = 1024 * 1024;
const ID_EBML = 0x1a45dfa3;
const ID_DOCTYPE = 0x4282;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

/** An element id keeps its length-marker bits; a size has them removed. */
function readVint(b: Uint8Array, o: number, keepMarker: boolean): Vint | null {
  if (o >= b.length) return null;
  const first = b[o];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || o + length > b.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[o + i];
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(b: Uint8Array, o: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[o + i];
  return v;
}

function readFloat(b: Uint8Array, o: number, size: number): number | null {
  const view = new DataView(b.buffer, b.byteOffset + o, size);
  if (size === 4) return view.getFloat32(0);
  if (size === 8) return view.getFloat64(0);
  return null;
}

export interface WebmInfo {
  docType: string | null;
  durationSeconds: number | null;
}

/** The document type and the length of a WebM / Matroska file, read from its first megabyte. */
export async function webmInfo(read: Reader, size: number): Promise<WebmInfo> {
  const b = await read(0, Math.min(EBML_WINDOW, size));
  let docType: string | null = null;
  let o = 0;
  const top = readVint(b, o, true);
  if (!top || top.value !== ID_EBML) return { docType: null, durationSeconds: null };
  o += top.length;
  const headerSize = readVint(b, o, false);
  if (!headerSize) return { docType: null, durationSeconds: null };
  o += headerSize.length;
  const headerEnd = o + headerSize.value;
  while (o < headerEnd && o < b.length) {
    const id = readVint(b, o, true);
    const sz = id && readVint(b, o + id.length, false);
    if (!id || !sz) break;
    const data = o + id.length + sz.length;
    if (id.value === ID_DOCTYPE) docType = ascii(b, data, sz.value);
    o = data + sz.value;
  }
  o = headerEnd;

  // The Segment, then its children until Info (stop at the first Cluster: Info always comes before the media).
  const seg = readVint(b, o, true);
  if (!seg || seg.value !== ID_SEGMENT) return { docType, durationSeconds: null };
  o += seg.length;
  const segSize = readVint(b, o, false);
  if (!segSize) return { docType, durationSeconds: null };
  o += segSize.length;
  for (let n = 0; n < 64 && o < b.length; n++) {
    const id = readVint(b, o, true);
    const sz = id && readVint(b, o + id.length, false);
    if (!id || !sz || sz.unknown) return { docType, durationSeconds: null };
    const data = o + id.length + sz.length;
    if (id.value === ID_CLUSTER) return { docType, durationSeconds: null };
    if (id.value === ID_INFO) {
      const end = Math.min(data + sz.value, b.length);
      let scale = 1_000_000;
      let duration: number | null = null;
      let p = data;
      while (p < end) {
        const cid = readVint(b, p, true);
        const csz = cid && readVint(b, p + cid.length, false);
        if (!cid || !csz) break;
        const cdata = p + cid.length + csz.length;
        if (cdata + csz.value > b.length) break;
        if (cid.value === ID_TIMECODE_SCALE) scale = readUint(b, cdata, csz.value);
        if (cid.value === ID_DURATION) duration = readFloat(b, cdata, csz.value);
        p = cdata + csz.value;
      }
      if (duration == null || !Number.isFinite(duration) || duration <= 0 || !scale) return { docType, durationSeconds: null };
      return { docType, durationSeconds: (duration * scale) / 1e9 };
    }
    o = data + sz.value;
  }
  return { docType, durationSeconds: null };
}

// ---- the decision -------------------------------------------------------------------------------------------------------------------
export interface CheckResult {
  ok: boolean;
  kind: MediaKind;
  /** The type that will be stored for the file (from its extension, confirmed by its bytes). */
  mime: string | null;
  sizeBytes: number;
  durationSeconds: number | null;
  /** Plain-words reason, shown to the reporter, when not ok. */
  reason: string | null;
}

/** What the stored name says the file should be. */
export function kindFromPath(path: string): { kind: MediaKind; ext: string } | null {
  if (/\.thumb\.jpg$/.test(path)) return { kind: 'thumbnail', ext: 'jpg' };
  const m = /\.(jpg|png|mp4|mov|webm)$/.exec(path);
  if (!m) return null;
  return { kind: m[1] === 'jpg' || m[1] === 'png' ? 'photo' : 'video', ext: m[1] };
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Only floating-point noise from dividing the container's duration by its timescale (a millionth of a second) - never a real fraction. */
const FLOAT_NOISE_SECONDS = 1e-6;

/** True when a measured length is over the limit. A real 60.01 s is over; 60.0000000001 s (rounding noise for exactly 60) is not. */
export function isOverVideoLimit(seconds: number): boolean {
  return seconds > WASTE_MEDIA_LIMITS.maxVideoSeconds + FLOAT_NOISE_SECONDS;
}

/**
 * How long a rejected video is, in words. Just over the limit m:ss would read "1:00", so it is given in seconds: with 2 decimals rounded
 * UP below 61 s ("60.01 seconds" - never a figure that looks within the limit), 1 decimal up to 90 s, then m:ss.
 */
export function describeVideoLength(seconds: number): string {
  if (seconds < 61) return `${(Math.ceil(seconds * 100) / 100).toFixed(2)} seconds`;
  if (seconds < 90) return `${(Math.floor(seconds * 10) / 10).toFixed(1)} seconds`;
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Checks one stored file. `size` is the stored size; `read` reads its bytes. Never throws for a bad file - only for a failed read. */
export async function checkMediaFile(path: string, size: number, read: Reader): Promise<CheckResult> {
  const expected = kindFromPath(path);
  const base = { sizeBytes: size, durationSeconds: null as number | null };
  if (!expected) return { ok: false, kind: 'photo', mime: null, ...base, reason: 'That file type isn’t accepted.' };
  const { kind, ext } = expected;
  const fail = (reason: string): CheckResult => ({ ok: false, kind, mime: null, ...base, reason });
  if (size <= 0) return fail('The file is empty.');

  const head = await read(0, Math.min(64, size));
  const family = sniff(head);

  if (kind === 'photo' || kind === 'thumbnail') {
    const want = ext === 'png' ? 'png' : 'jpeg';
    if (family !== want) return fail('That photo isn’t a JPEG or PNG image. Take or choose it again.');
    const max = kind === 'thumbnail' ? WASTE_MEDIA_LIMITS.maxThumbnailBytes : WASTE_MEDIA_LIMITS.maxPhotoBytes;
    if (size > max) return fail(`That photo is ${mb(size)}, which is too large.`);
    return { ok: true, kind, mime: EXT_MIME[ext], sizeBytes: size, durationSeconds: null, reason: null };
  }

  if (size > WASTE_MEDIA_LIMITS.maxVideoBytes) return fail(`That video is ${mb(size)}. The limit is ${mb(WASTE_MEDIA_LIMITS.maxVideoBytes)}.`);
  let seconds: number | null;
  if (ext === 'webm') {
    if (family !== 'ebml') return fail('That file isn’t really a WebM video.');
    const info = await webmInfo(read, size);
    if (info.docType !== 'webm') return fail('That file isn’t really a WebM video.');
    seconds = info.durationSeconds;
  } else {
    if (family !== 'isobmff') return fail('That file isn’t really an MP4 or MOV video.');
    seconds = await mp4DurationSeconds(read, size);
  }
  if (seconds == null) return fail('The length of that video couldn’t be confirmed, so it can’t be used. Record it again with the phone’s camera.');
  if (isOverVideoLimit(seconds)) {
    return {
      ok: false,
      kind,
      mime: null,
      sizeBytes: size,
      // Stored with 2 decimals; rounded UP so a rejected 60.004 s is never recorded as 60.00.
      durationSeconds: Math.ceil(seconds * 100) / 100,
      reason: `That video is ${describeVideoLength(seconds)} long. The limit is 60 seconds.`,
    };
  }
  // Within the limit: stored with 2 decimals, never above 60.00 (noise of exactly 60 s stays 60).
  return { ok: true, kind, mime: EXT_MIME[ext], sizeBytes: size, durationSeconds: Math.min(WASTE_MEDIA_LIMITS.maxVideoSeconds, Math.max(0.01, Math.round(seconds * 100) / 100)), reason: null };
}
