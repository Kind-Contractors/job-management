// Resumable (TUS) upload of one file to Supabase Storage, with the signed-in user's own session token.
//
// Why TUS and not a single request: a video can be 150 MB. A single-request upload that drops at 90% starts again from zero;
// TUS sends 6 MB chunks and carries on from the last accepted chunk, which is what Supabase recommends above 6 MB.
//
// Security: only the signed-in user's access token and the public anon key are ever used - never a service-role key. The token
// is read fresh for every request, so a long upload keeps working when the session refreshes. What the user may upload is
// decided by the Storage policies on the `report-videos` bucket, not by this code.
//
// tus-js-client is loaded on demand, so the (large) library is only downloaded when someone actually uploads a video.

export interface ResumableUploadArgs {
  /** Full resumable endpoint - see resumableEndpoint(). */
  endpoint: string;
  /** The public anon key (the `apikey` header). */
  apiKey: string;
  bucket: string;
  objectName: string;
  file: Blob;
  contentType: string;
  /** Returns the CURRENT access token; called before every request. */
  getAccessToken: () => Promise<string>;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
  /** Aborting cancels the upload and asks the server to discard what it already received. */
  signal?: AbortSignal;
  /**
   * Continue an earlier, unfinished upload of THIS file from where the server stopped (the URL a previous attempt reported through
   * onUploadUrl). Used by the technician queue so a dropped connection or a restarted app does not start a 150 MB video again.
   * Resumable uploads stay valid for 24 hours; if the server no longer knows the URL the upload fails with status 404/410/403.
   */
  uploadUrl?: string | null;
  /** Called once the server has created the upload, with the URL to pass as uploadUrl next time. */
  onUploadUrl?: (url: string) => void;
}

export type ResumableUploader = (args: ResumableUploadArgs) => Promise<void>;

/** Raised when the upload ends in an error; `status` is the HTTP status of the server's answer, when there was one. */
export class UploadError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

/** Raised when the caller aborted the upload (not an error to show). */
export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'UploadCancelledError';
  }
}

/**
 * The resumable endpoint for a project URL. Hosted projects serve it from the dedicated storage host
 * (`https://<ref>.storage.supabase.co`), which is what Supabase recommends for large uploads; any other URL (a local stack,
 * a custom domain) uses the standard path on the same host.
 */
export function resumableEndpoint(supabaseUrl: string): string {
  const url = new URL(supabaseUrl);
  const m = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
  if (m) return `https://${m[1]}.storage.supabase.co/storage/v1/upload/resumable`;
  return `${url.origin}/storage/v1/upload/resumable`;
}

const CHUNK_BYTES = 6 * 1024 * 1024; // Supabase requires exactly 6 MB chunks

export const resumableUpload: ResumableUploader = async (args) => {
  const { Upload } = await import('tus-js-client');
  return new Promise<void>((resolve, reject) => {
    if (args.signal?.aborted) {
      reject(new UploadCancelledError());
      return;
    }
    const upload: InstanceType<typeof Upload> = new Upload(args.file, {
      endpoint: args.endpoint,
      uploadUrl: args.uploadUrl ?? null,
      // Automatic retries with growing pauses for a dropped connection; each retry continues from the last accepted chunk.
      retryDelays: [0, 3000, 5000, 10000, 20000],
      chunkSize: CHUNK_BYTES,
      uploadDataDuringCreation: true,
      // An upload is never resumed from a previous page load or a different file with the same name.
      storeFingerprintForResuming: false,
      removeFingerprintOnSuccess: true,
      headers: { apikey: args.apiKey },
      metadata: { bucketName: args.bucket, objectName: args.objectName, contentType: args.contentType, cacheControl: '3600' },
      onBeforeRequest: async (req) => {
        req.setHeader('authorization', `Bearer ${await args.getAccessToken()}`);
      },
      onUploadUrlAvailable: () => {
        if (upload.url) args.onUploadUrl?.(upload.url);
      },
      onProgress: (uploaded, total) => args.onProgress?.(uploaded, total),
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
        reject(new UploadError(detail || error.message, status));
      },
      onSuccess: () => resolve(),
    });
    args.signal?.addEventListener('abort', () => {
      void upload.abort(true).finally(() => reject(new UploadCancelledError()));
    });
    upload.start();
  });
};
