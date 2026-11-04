// The manager's data access for waste reports (Jack's standalone reports - no client, building, job or visit). Reads go through RLS
// (manager_read on waste_reports / waste_report_media / waste_report_events and the waste-report-media bucket); every change goes
// through a manager-only database function that records who and when, and an event in the report's history
// (migration 20261103110000_waste_reports_manager). Nothing here can edit or delete a report's content.
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

export const WASTE_MEDIA_BUCKET = 'waste-report-media';

export type WasteStatusFilter = 'active' | 'unsent' | 'sent' | 'archived' | 'all';

export interface WasteListFilters {
  /** Part of the address (case-insensitive). */
  search: string;
  /** yyyy-mm-dd: reports whose work dates overlap [from, to]. Empty = open-ended. */
  from: string;
  to: string;
  status: WasteStatusFilter;
}

export interface WasteReportListRow {
  id: string;
  address: string;
  startDate: string;
  endDate: string;
  submittedAt: string;
  reporterName: string;
  photoCount: number;
  videoCount: number;
  sentAt: string | null;
  sentBy: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
}

export interface WasteReportMedia {
  id: string;
  kind: 'photo' | 'video';
  phase: 'before' | 'after';
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  sortOrder: number;
}

export type WasteEventType = 'submitted' | 'marked_sent' | 'unmarked_sent' | 'archived' | 'restored';

export interface WasteReportEvent {
  id: string;
  type: WasteEventType;
  actor: string;
  occurredAt: string;
}

export interface WasteReportDetail extends WasteReportListRow {
  description: string;
  media: WasteReportMedia[];
  events: WasteReportEvent[];
}

/** The most rows one list shows; the page says so when there are more. */
export const WASTE_LIST_LIMIT = 300;

/** A typed search is matched literally: % and _ (the database's wildcards) and the escape character are escaped. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type Row = Record<string, unknown>;

function toListRow(r: Row): WasteReportListRow {
  const media = (r.waste_report_media ?? []) as { kind: string }[];
  return {
    id: r.id as string,
    address: r.address as string,
    startDate: r.work_start_date as string,
    endDate: r.work_end_date as string,
    submittedAt: r.submitted_at as string,
    reporterName: r.reporter_name as string,
    photoCount: media.filter((m) => m.kind === 'photo').length,
    videoCount: media.filter((m) => m.kind === 'video').length,
    sentAt: (r.sent_to_client_at as string | null) ?? null,
    sentBy: (r.sent_to_client_by as string | null) ?? null,
    archivedAt: (r.archived_at as string | null) ?? null,
    archivedBy: (r.archived_by as string | null) ?? null,
  };
}

const LIST_COLUMNS = 'id, address, work_start_date, work_end_date, submitted_at, reporter_name, sent_to_client_at, sent_to_client_by, archived_at, archived_by, waste_report_media(kind)';

export async function listWasteReports(filters: WasteListFilters): Promise<{ rows: WasteReportListRow[]; truncated: boolean }> {
  let q = supabase.from('waste_reports').select(LIST_COLUMNS).order('submitted_at', { ascending: false }).limit(WASTE_LIST_LIMIT + 1);
  const search = filters.search.trim();
  if (search) q = q.ilike('address', `%${escapeLike(search)}%`);
  if (filters.from) q = q.gte('work_end_date', filters.from);
  if (filters.to) q = q.lte('work_start_date', filters.to);
  if (filters.status === 'active') q = q.is('archived_at', null);
  if (filters.status === 'unsent') q = q.is('archived_at', null).is('sent_to_client_at', null);
  if (filters.status === 'sent') q = q.is('archived_at', null).not('sent_to_client_at', 'is', null);
  if (filters.status === 'archived') q = q.not('archived_at', 'is', null);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to load waste reports: ${error.message}`);
  const rows = (data ?? []).map((r) => toListRow(r as Row));
  return { rows: rows.slice(0, WASTE_LIST_LIMIT), truncated: rows.length > WASTE_LIST_LIMIT };
}

/** For the left rail: reports not yet marked as sent (archived ones excluded). */
export async function countUnsentWasteReports(): Promise<number> {
  const { count, error } = await supabase
    .from('waste_reports')
    .select('id', { count: 'exact', head: true })
    .is('archived_at', null)
    .is('sent_to_client_at', null);
  if (error) throw new Error(`Failed to count waste reports: ${error.message}`);
  return count ?? 0;
}

export async function getWasteReport(id: string): Promise<WasteReportDetail | null> {
  const { data, error } = await supabase
    .from('waste_reports')
    .select(
      'id, address, work_start_date, work_end_date, submitted_at, reporter_name, sent_to_client_at, sent_to_client_by, archived_at, archived_by, description, waste_report_media(id, kind, phase, storage_path, thumbnail_path, mime_type, size_bytes, duration_seconds, sort_order), waste_report_events(id, event_type, actor, occurred_at)',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the waste report: ${error.message}`);
  if (!data) return null;
  const r = data as unknown as Row;
  const media = ((r.waste_report_media ?? []) as Row[])
    .map((m) => ({
      id: m.id as string,
      kind: m.kind as 'photo' | 'video',
      phase: m.phase as 'before' | 'after',
      storagePath: m.storage_path as string,
      thumbnailPath: (m.thumbnail_path as string | null) ?? null,
      mimeType: m.mime_type as string,
      sizeBytes: Number(m.size_bytes),
      durationSeconds: m.duration_seconds == null ? null : Number(m.duration_seconds),
      sortOrder: Number(m.sort_order ?? 0),
    }))
    .sort((a, b) => (a.phase === b.phase ? a.sortOrder - b.sortOrder : a.phase === 'before' ? -1 : 1));
  const events = ((r.waste_report_events ?? []) as Row[])
    .map((e) => ({ id: e.id as string, type: e.event_type as WasteEventType, actor: e.actor as string, occurredAt: e.occurred_at as string }))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return {
    ...toListRow({ ...r, waste_report_media: media.map((m) => ({ kind: m.kind })) }),
    description: (r.description as string) ?? '',
    media,
    events,
  };
}

/** Short-lived links to view files (photos, posters). Missing or unreadable files are simply absent from the result. */
export async function signWasteMediaUrls(paths: string[], seconds = 3600): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(WASTE_MEDIA_BUCKET).createSignedUrls(paths, seconds);
  if (error) throw new Error(`Failed to load the photos: ${error.message}`);
  const out: Record<string, string> = {};
  for (const item of data ?? []) if (item.path && item.signedUrl && !item.error) out[item.path] = item.signedUrl;
  return out;
}

/** A 10-minute link to play one video (asked for only when Play is pressed). */
export async function signWasteVideoPlaybackUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(WASTE_MEDIA_BUCKET).createSignedUrl(storagePath, 600);
  if (error || !data?.signedUrl) throw new Error('The video could not be loaded. Try again.');
  return data.signedUrl;
}

export async function setWasteReportSent(id: string, sent: boolean): Promise<void> {
  const { error } = await supabase.rpc('manager_waste_set_sent', { p_report_id: id, p_sent: sent });
  if (error) throw new Error(error.message);
}

export async function setWasteReportArchived(id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.rpc('manager_waste_set_archived', { p_report_id: id, p_archived: archived });
  if (error) throw new Error(error.message);
}

/** videoId -> secure watch URL (issue-waste-video-links). The same video keeps the same link across downloads. */
export async function issueWasteVideoLinks(reportId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase.functions.invoke<{ links?: { videoId: string; url: string }[]; error?: string }>('issue-waste-video-links', {
    body: { reportId },
  });
  if (error) {
    let message = error.message;
    if (error instanceof FunctionsHttpError) {
      try {
        const body = (await (error.context as Response).json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // keep the generic message
      }
    }
    throw new Error(message);
  }
  const out: Record<string, string> = {};
  for (const l of data?.links ?? []) out[l.videoId] = l.url;
  return out;
}
