// The waste reporter's own resumable (TUS) upload of one video - deliberately separate from the shared Job Reports uploader
// (src/lib/reportVideoUpload.ts), which stays exactly as it is.
//
// The difference that matters: this one can be PAUSED. Pausing stops the request in flight but keeps the upload on the server
// (tus abort(false) - the shared uploader's cancel also deletes it), so the next attempt asks the server how far it got (a HEAD
// with the saved upload URL) and carries on from that confirmed offset. Two kinds of pause:
//   * `signal` aborted - at once (a request that stopped making progress, or the file is being removed): the chunk in flight is
//     resent next time (at most 6 MB);
//   * `pauseAtChunkBoundary()` true - checked each time the server has CONFIRMED a chunk, before the next one starts: nothing is
//     lost (used to give another report's video its turn).
// A paused upload rejects with UploadPausedError; it is not a failure.
import { UploadError } from '../lib/reportVideoUpload';

export class UploadPausedError extends Error {
  readonly reason: 'signal' | 'turn';
  constructor(reason: 'signal' | 'turn') {
    super(reason === 'turn' ? 'Paused to give another report a turn.' : 'Upload paused.');
    this.name = 'UploadPausedError';
    this.reason = reason;
  }
}

export interface WasteTusArgs {
  endpoint: string;
  apiKey: string;
  bucket: string;
  objectName: string;
  file: Blob;
  contentType: string;
  /** Read fresh before every request, so a long upload survives a token refresh. */
  getAccessToken: () => Promise<string>;
  /** The saved upload URL of an earlier attempt of THIS file, to resume from the server's confirmed offset. */
  uploadUrl: string | null;
  onUploadUrl: (url: string) => void;
  onProgress: (bytesSent: number, bytesTotal: number) => void;
  /** The server confirmed everything up to `bytesAccepted`. */
  onChunkComplete?: (bytesAccepted: number, bytesTotal: number) => void;
  signal?: AbortSignal;
  pauseAtChunkBoundary?: () => boolean;
}

const CHUNK_BYTES = 6 * 1024 * 1024; // Supabase requires exactly 6 MB chunks

/**
 * The server kept confirming the same offset: the requests arrive without the data (Safari 26 can send an empty body - WebKit bug
 * 319985). tus would otherwise send them again and again forever, each answer looking like a sign of life; this attempt stops instead
 * (the upload stays resumable) and the engine tries again after its usual pause.
 */
export class UploadNoProgressError extends UploadError {
  constructor(offset: number) {
    super(`The server received no data (it stayed at ${offset} bytes)`, null);
  }
}
/** Confirmations in a row without the offset moving before an attempt is stopped. */
export const NO_PROGRESS_LIMIT = 2;

/**
 * Gives tus each chunk as a fresh IN-MEMORY copy of exactly those bytes (read with slice().arrayBuffer()), never a slice of the stored
 * file itself. Safari/WebKit sends a slice of a file kept on disk (a picked file, or one read back from the phone's storage) from the
 * START of the file instead of its offset, so every chunk after the first arrived as the wrong bytes (and could be stored as a
 * "complete" but broken video); a copy in memory is sent correctly. Only one chunk (6 MB) is held at a time. A read that fails rejects,
 * which tus reports as an error and the engine handles as a read problem (checked again, never counted as uploaded).
 */
export const inMemoryChunks = {
  openFile: async (input: Blob) => ({
    size: input.size,
    slice: async (start: number, end: number) => {
      const stop = Math.min(end, input.size);
      const bytes = await input.slice(start, stop).arrayBuffer();
      return { value: new Blob([bytes], { type: input.type }), done: stop >= input.size };
    },
    close: () => undefined,
  }),
};

/** Fed each offset the server confirms; true once it has failed to move NO_PROGRESS_LIMIT times in a row. */
export function noProgressGuard(limit = NO_PROGRESS_LIMIT): (accepted: number) => boolean {
  let last: number | null = null;
  let stuck = 0;
  return (accepted) => {
    stuck = last !== null && accepted <= last ? stuck + 1 : 0;
    last = accepted;
    return stuck >= limit;
  };
}

export async function wasteResumableUpload(args: WasteTusArgs): Promise<void> {
  const { Upload } = await import('tus-js-client');
  return new Promise<void>((resolve, reject) => {
    if (args.signal?.aborted) {
      reject(new UploadPausedError('signal'));
      return;
    }
    let settled = false;
    const noProgress = noProgressGuard();
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const upload: InstanceType<typeof Upload> = new Upload(args.file, {
      endpoint: args.endpoint,
      uploadUrl: args.uploadUrl ?? null,
      // The engine retries with its own pauses; tus only covers a brief blip within one attempt.
      retryDelays: [0, 3000, 5000],
      chunkSize: CHUNK_BYTES,
      fileReader: inMemoryChunks,
      uploadDataDuringCreation: true,
      storeFingerprintForResuming: false,
      removeFingerprintOnSuccess: true,
      headers: { apikey: args.apiKey },
      metadata: { bucketName: args.bucket, objectName: args.objectName, contentType: args.contentType, cacheControl: '3600' },
      onBeforeRequest: async (req) => {
        req.setHeader('authorization', `Bearer ${await args.getAccessToken()}`);
      },
      onUploadUrlAvailable: () => {
        if (upload.url) args.onUploadUrl(upload.url);
      },
      onProgress: (sent, total) => args.onProgress(sent, total),
      onChunkComplete: (_chunk, accepted, total) => {
        if (noProgress(accepted) && accepted < total) {
          void upload.abort(false);
          settle(() => reject(new UploadNoProgressError(accepted)));
          return;
        }
        args.onChunkComplete?.(accepted, total);
        // tus checks for an abort before it starts the next chunk, so this pauses exactly at the confirmed offset.
        if (accepted < total && args.pauseAtChunkBoundary?.()) {
          void upload.abort(false);
          settle(() => reject(new UploadPausedError('turn')));
        }
      },
      onError: (error) => {
        const response = (error as { originalResponse?: { getStatus(): number; getBody(): string } }).originalResponse;
        const status = response ? response.getStatus() : null;
        let detail = '';
        try {
          const body = response?.getBody();
          detail = body ? ((JSON.parse(body) as { message?: string }).message ?? body) : '';
        } catch {
          detail = response?.getBody() ?? '';
        }
        settle(() => reject(new UploadError(detail || error.message, status)));
      },
      onSuccess: () => settle(() => resolve()),
    });
    args.signal?.addEventListener('abort', () => {
      // Stops the request; the upload stays on the server so it can be resumed (never abort(true) here).
      void upload.abort(false);
      settle(() => reject(new UploadPausedError('signal')));
    });
    upload.start();
  });
}
