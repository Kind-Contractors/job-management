// The server's own check of an uploaded waste-report file (supabase/functions/_shared/mediaProbe.ts): real type from the bytes, and a
// video's real length from its container header, read with small reads only. The files are built byte by byte here; the live DEV
// run also checks real phone-style files made with ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMediaFile, kindFromPath, mp4DurationSeconds, sniff, webmInfo, type Reader } from '../supabase/functions/_shared/mediaProbe';

const enc = new TextEncoder();
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
function u64(n: number): Uint8Array {
  return cat(u32(Math.floor(n / 2 ** 32)), u32(n >>> 0));
}
function box(type: string, payload: Uint8Array): Uint8Array {
  return cat(u32(8 + payload.length), enc.encode(type), payload);
}
function mvhd0(timescale: number, duration: number): Uint8Array {
  return box('mvhd', cat(new Uint8Array([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(duration), new Uint8Array(80)));
}
function mvhd1(timescale: number, duration: number): Uint8Array {
  return box('mvhd', cat(new Uint8Array([1, 0, 0, 0]), u64(0), u64(0), u32(timescale), u64(duration), new Uint8Array(80)));
}
const ftyp = (brand: string) => box('ftyp', cat(enc.encode(brand), u32(0), enc.encode('isommp42')));
const mdat = (n: number) => box('mdat', new Uint8Array(n));

/** A reader that also counts how many bytes were read - the check must never read the whole video. */
function readerOf(bytes: Uint8Array) {
  const stats = { bytesRead: 0, calls: 0 };
  const read: Reader = async (o, l) => {
    stats.calls++;
    const part = bytes.subarray(o, o + l);
    stats.bytesRead += part.length;
    return part;
  };
  return { read, stats };
}

test('MP4 with moov first: length from mvhd (version 0)', async () => {
  const file = cat(ftyp('isom'), box('moov', mvhd0(1000, 42_500)), mdat(5000));
  assert.equal(await mp4DurationSeconds(readerOf(file).read, file.length), 42.5);
});

test('MOV with moov AFTER the media data (as phones often write it): found by walking box headers, without reading the media', async () => {
  const media = mdat(2_000_000);
  const file = cat(ftyp('qt  '), media, box('moov', mvhd0(600, 600 * 59)));
  const { read, stats } = readerOf(file);
  assert.equal(await mp4DurationSeconds(read, file.length), 59);
  assert.ok(stats.bytesRead < 1000, `read ${stats.bytesRead} bytes of a ${file.length}-byte file`);
});

test('version-1 mvhd (64-bit duration) and a 64-bit box size are understood', async () => {
  const big = cat(u32(1), enc.encode('mdat'), u64(16 + 100), new Uint8Array(100));
  const file = cat(ftyp('isom'), big, box('moov', mvhd1(90_000, 90_000 * 12)));
  assert.equal(await mp4DurationSeconds(readerOf(file).read, file.length), 12);
});

test('a fragmented MP4 (duration 0) or one with no moov gives no length', async () => {
  const fragmented = cat(ftyp('isom'), box('moov', mvhd0(1000, 0)), mdat(10));
  assert.equal(await mp4DurationSeconds(readerOf(fragmented).read, fragmented.length), null);
  const noMoov = cat(ftyp('isom'), mdat(10));
  assert.equal(await mp4DurationSeconds(readerOf(noMoov).read, noMoov.length), null);
});

// ---- WebM -----------------------------------------------------------------------------------------------------------------------
function el(id: number[], payload: Uint8Array): Uint8Array {
  const size = payload.length;
  return cat(new Uint8Array(id), new Uint8Array([0x01, 0, 0, (size / 2 ** 32) & 255, (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255]), payload);
}
function f64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return b;
}
function f32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n);
  return b;
}
function webm(opts: { docType?: string; duration?: Uint8Array | null; scale?: number }): Uint8Array {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], enc.encode(opts.docType ?? 'webm')));
  const infoChildren = [el([0x2a, 0xd7, 0xb1], u32(opts.scale ?? 1_000_000))];
  if (opts.duration) infoChildren.push(el([0x44, 0x89], opts.duration));
  const segmentBody = cat(el([0x11, 0x4d, 0x9b, 0x74], new Uint8Array(20)), el([0x15, 0x49, 0xa9, 0x66], cat(...infoChildren)), el([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(50)));
  const unknownSize = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  return cat(header, new Uint8Array([0x18, 0x53, 0x80, 0x67]), unknownSize, segmentBody);
}

test('WebM: document type and length from Segment/Info (float64 and float32 durations, custom timecode scale)', async () => {
  const a = webm({ duration: f64(12_345) });
  assert.deepEqual(await webmInfo(readerOf(a).read, a.length), { docType: 'webm', durationSeconds: 12.345 });
  const b = webm({ duration: f32(30) , scale: 1_000_000_000 });
  assert.equal((await webmInfo(readerOf(b).read, b.length)).durationSeconds, 30);
});

test('WebM with no Duration (some browser recordings) gives no length', async () => {
  const file = webm({ duration: null });
  assert.equal((await webmInfo(readerOf(file).read, file.length)).durationSeconds, null);
});

// ---- the decision -----------------------------------------------------------------------------------------------------------------
const JPEG = cat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), new Uint8Array(200));
const PNG = cat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new Uint8Array(200));
const base = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/before/33333333-3333-4333-8333-333333333333';
const check = (ext: string, bytes: Uint8Array, size = bytes.length) => checkMediaFile(`${base}.${ext}`, size, readerOf(bytes).read);

test('the kind comes from the stored name; anything else is not accepted', () => {
  assert.deepEqual(kindFromPath(`${base}.jpg`), { kind: 'photo', ext: 'jpg' });
  assert.deepEqual(kindFromPath(`${base}.thumb.jpg`), { kind: 'thumbnail', ext: 'jpg' });
  assert.deepEqual(kindFromPath(`${base}.mov`), { kind: 'video', ext: 'mov' });
  assert.equal(kindFromPath(`${base}.gif`), null);
  assert.equal(sniff(JPEG), 'jpeg');
  assert.equal(sniff(PNG), 'png');
});

test('photos: the bytes must match the name (a PNG named .jpg, or a video named .jpg, is rejected)', async () => {
  assert.equal((await check('jpg', JPEG)).ok, true);
  assert.equal((await check('png', PNG)).mime, 'image/png');
  assert.equal((await check('jpg', PNG)).ok, false);
  const videoAsPhoto = await check('jpg', cat(ftyp('isom'), box('moov', mvhd0(1000, 1000))));
  assert.equal(videoAsPhoto.ok, false);
  assert.match(videoAsPhoto.reason ?? '', /JPEG or PNG/);
});

test('posters must be JPEGs of at most 1 MiB', async () => {
  assert.equal((await checkMediaFile(`${base}.thumb.jpg`, JPEG.length, readerOf(JPEG).read)).ok, true);
  assert.equal((await checkMediaFile(`${base}.thumb.jpg`, 2_000_000, readerOf(JPEG).read)).ok, false);
});

test('videos: STRICTLY 60 s - exactly 60 passes; 60.01 s and 61 s are rejected, with their length', async () => {
  const mk = (ms: number, timescale = 1000) => cat(ftyp('isom'), box('moov', mvhd0(timescale, (ms * timescale) / 1000)), mdat(100));
  const sixty = await check('mp4', mk(60_000));
  assert.equal(sixty.ok, true);
  assert.equal(sixty.durationSeconds, 60);
  assert.equal(sixty.mime, 'video/mp4');
  // exactly 60 s in a timescale that does not divide evenly (90 kHz video clocks): still exactly 60, passes
  assert.equal((await check('mov', cat(ftyp('qt  '), box('moov', mvhd0(90_000, 5_400_000))))).ok, true);
  const justOver = await check('mp4', mk(60_010));
  assert.equal(justOver.ok, false, '60.01 s is over the limit');
  assert.equal(justOver.durationSeconds, 60.01);
  assert.match(justOver.reason ?? '', /That video is 60\.01 seconds long\. The limit is 60 seconds\./);
  const tiny = await check('mp4', mk(60_004)); // 60.004 s: over the limit, and recorded as 60.01 (never as 60.00)
  assert.equal(tiny.ok, false);
  assert.equal(tiny.durationSeconds, 60.01);
  assert.match(tiny.reason ?? '', /60\.01 seconds long/);
  const sixtyOne = await check('mov', mk(61_000));
  assert.equal(sixtyOne.ok, false, '61 s no longer passes');
  assert.match(sixtyOne.reason ?? '', /61\.0 seconds long/);
  const long = await check('mp4', mk(95_000));
  assert.match(long.reason ?? '', /That video is 1:35 long\. The limit is 60 seconds\./);
});

test('a video whose length cannot be confirmed is rejected (agreed rule)', async () => {
  const r = await check('webm', webm({ duration: null }));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /length of that video couldn’t be confirmed/);
  const frag = await check('mp4', cat(ftyp('isom'), box('moov', mvhd0(1000, 0))));
  assert.equal(frag.ok, false);
});

test('a video over 150 MB is rejected before anything else; a mislabelled container is rejected', async () => {
  const ok = cat(ftyp('isom'), box('moov', mvhd0(1000, 5000)));
  const tooBig = await check('mp4', ok, 157_286_401);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.reason ?? '', /The limit is 150 MB/);
  assert.equal((await check('webm', ok)).ok, false, 'an MP4 named .webm');
  assert.equal((await check('mp4', webm({ duration: f64(1000) }))).ok, false, 'a WebM named .mp4');
  assert.equal((await check('webm', webm({ docType: 'matroska', duration: f64(1000) }))).ok, false, 'Matroska is not WebM');
  assert.equal((await check('mp4', JPEG)).ok, false, 'a photo named .mp4');
});

test('an empty file is rejected', async () => {
  assert.equal((await check('jpg', new Uint8Array(0))).ok, false);
});
