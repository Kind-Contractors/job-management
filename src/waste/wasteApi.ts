// Every network call the waste reporter's screens make. Only the signed-in user's own session and the public anon key are used;
// what he may do is decided by the database and the bucket policies (migration 20261103100000_waste_reports), never by this code.
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import { resumableEndpoint, resumableUpload } from '../lib/reportVideoUpload';
import { WASTE_BUCKET, type WasteMediaKind, type WastePhase } from './wasteRules';

/** A database refusal (with its Postgres code) or a failed call - the code tells a permanent refusal from a dropped connection. */
export class WasteRpcError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'WasteRpcError';
    this.code = code;
  }
}

export async function currentAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('You are signed out. Sign in again to upload.');
  return data.session.access_token;
}

/** A photo or a video poster: one ordinary request. A file already there from an earlier attempt counts as uploaded. */
export async function uploadSmallFile(path: string, blob: Blob, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from(WASTE_BUCKET).upload(path, blob, { upsert: false, contentType });
  if (!error) return;
  const status = Number((error as { statusCode?: string | number }).statusCode ?? NaN);
  if (status === 409 || /already exists|duplicate/i.test(error.message)) return;
  throw Object.assign(new Error(error.message), { status: Number.isFinite(status) ? status : null });
}

export interface VideoUploadOptions {
  tusUrl: string | null;
  onUploadUrl: (url: string) => void;
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}

/** A video: resumable (TUS), so a dropped connection carries on from the last accepted 6 MB chunk instead of starting again. */
export async function uploadVideoFile(path: string, blob: Blob, contentType: string, options: VideoUploadOptions): Promise<void> {
  await resumableUpload({
    endpoint: resumableEndpoint(import.meta.env.VITE_SUPABASE_URL as string),
    apiKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    bucket: WASTE_BUCKET,
    objectName: path,
    file: blob,
    contentType,
    getAccessToken: currentAccessToken,
    uploadUrl: options.tusUrl,
    onUploadUrl: options.onUploadUrl,
    onProgress: (sent, total) => options.onProgress(total > 0 ? sent / total : 0),
    signal: options.signal,
  });
}

export type FileCheckOutcome =
  /** sizeBytes: the stored file's size as the server measured it (null if it did not say). */
  | { result: 'ok'; durationSeconds: number | null; sizeBytes: number | null }
  | { result: 'rejected'; reason: string }
  /** Not in storage: upload it again. */
  | { result: 'missing' }
  /** Could not be checked just now (or no connection): try again later. */
  | { result: 'retry'; message: string };

/** Asks the server to check one uploaded file (waste-media-check). */
export async function checkUploadedFile(path: string): Promise<FileCheckOutcome> {
  const { data, error } = await supabase.functions.invoke<{ ok?: boolean; reason?: string; durationSeconds?: number | null; sizeBytes?: number | null; error?: string }>(
    'waste-media-check',
    { body: { path } },
  );
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      let message = 'The file could not be checked just now.';
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // keep the generic message
      }
      if (res.status === 409) return { result: 'missing' };
      // 423: the file belongs to a report that has already been sent - it can't be checked or changed any more.
      if (res.status === 423) return { result: 'rejected', reason: message };
      if (res.status === 403) return { result: 'rejected', reason: 'You are not allowed to upload here. Sign out and back in.' };
      if (res.status === 400) return { result: 'rejected', reason: 'This file can’t be checked. Remove it and add it again.' };
      return { result: 'retry', message };
    }
    return { result: 'retry', message: 'No connection to the server.' };
  }
  if (data?.ok) return { result: 'ok', durationSeconds: data.durationSeconds ?? null, sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : null };
  return { result: 'rejected', reason: data?.reason ?? 'The file was not accepted.' };
}

/** Removes files that no submitted report uses (a discarded draft or a removed file). The bucket refuses anything else. */
export async function removeUnsubmittedFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(WASTE_BUCKET).remove(paths);
  if (error) throw new Error(error.message);
}

export interface SubmitMediaInput {
  id: string;
  kind: WasteMediaKind;
  phase: WastePhase;
  storagePath: string;
  thumbnailPath: string | null;
  sortOrder: number;
}

export interface SubmitWasteReportInput {
  reportId: string;
  address: string;
  startDate: string;
  endDate: string;
  description: string;
  media: SubmitMediaInput[];
}

/** waste_submit_report: creates the report, or - if this report id was already submitted by him - returns it unchanged. */
export async function submitWasteReport(input: SubmitWasteReportInput): Promise<{ created: boolean }> {
  const { data, error } = await supabase.rpc('waste_submit_report', {
    p_report_id: input.reportId,
    p_address: input.address,
    p_work_start_date: input.startDate,
    p_work_end_date: input.endDate,
    p_description: input.description,
    p_media: input.media.map((m) => ({
      id: m.id,
      kind: m.kind,
      phase: m.phase,
      storage_path: m.storagePath,
      thumbnail_path: m.thumbnailPath,
      sort_order: m.sortOrder,
    })),
  });
  if (error) throw new WasteRpcError(error.message, error.code || null);
  return { created: !!(data as { created?: boolean } | null)?.created };
}

/** His own name, for the header (a user may only ever read his own app_users row). */
export async function getMyDisplayName(): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;
  const { data } = await supabase.from('app_users').select('display_name').eq('id', auth.user.id).maybeSingle();
  return (data?.display_name as string | null) ?? null;
}

export interface MySubmittedWasteReport {
  id: string;
  address: string;
  startDate: string;
  endDate: string;
  submittedAt: string;
  photoCount: number;
  videoCount: number;
}

/** His own submitted reports, newest first (the database only ever returns his own). */
export async function listMyWasteReports(): Promise<MySubmittedWasteReport[]> {
  const { data, error } = await supabase
    .from('waste_reports')
    .select('id, address, work_start_date, work_end_date, submitted_at, waste_report_media(kind)')
    .order('submitted_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => {
    const media = (r.waste_report_media ?? []) as { kind: string }[];
    return {
      id: r.id as string,
      address: r.address as string,
      startDate: r.work_start_date as string,
      endDate: r.work_end_date as string,
      submittedAt: r.submitted_at as string,
      photoCount: media.filter((m) => m.kind === 'photo').length,
      videoCount: media.filter((m) => m.kind === 'video').length,
    };
  });
}
