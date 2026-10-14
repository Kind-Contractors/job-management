-- Let a MANAGER move a video between the Before / During / After sections, the way photos can already be moved.
--
-- Applied to DEV on 2026-10-14 (recorded as version 20261014111446). NOT applied to production.
-- on DEV first (see docs and the session notes).
--
-- Why a migration is needed at all
-- --------------------------------
-- A video's section is held in three places that the database keeps in step, so the application cannot simply write a new
-- phase the way it does for a photo:
--   1. report_videos.phase;
--   2. report_videos_storage_path_shape_check      - storage_path must match '^{visit_id}/{phase}/{uuid}.(mp4|mov|webm)$';
--   3. report_videos_thumbnail_path_shape_check    - the same shape for the thumbnail;
--   and private.report_videos_guard() refuses ANY update that changes phase: "A video's file details cannot be changed."
--
-- What this migration decides
-- ---------------------------
-- The FILE STAYS WHERE IT IS. Only the phase column moves. The two shape checks are relaxed so that a path must still live
-- under its own visit and under one of the three section folders, but no longer under the section the row currently names.
-- After a move the path keeps the old section's folder name - exactly as a moved photo's path does. Nothing reads a
-- section from a path: the guard only compares them when a video is first created, and the client links never look at the
-- phase at all (resolve_report_video_link does not mention it).
--
-- The alternative - renaming the objects in Storage - was rejected: it is two copies plus two deletes per move, it cannot
-- be made atomic with this update, and a half-finished rename would leave a video whose row and file disagree (the
-- storage_path UNIQUE constraint makes recovering from that worse, not better).
--
-- What stays exactly as it was
-- ----------------------------
--   * Only a manager can do it (report_videos has one policy, manager_full_access; technicians reach videos only through
--     the SECURITY DEFINER RPCs, which this migration does not touch).
--   * A REMOVED video cannot be moved.
--   * A COMPLETED report cannot have its videos moved - the same rule that already blocks inclusion changes.
--   * The per-section cap (3) is enforced on a move as well as on an upload, so a move cannot overfill a section.
--   * Every other "file detail" (visit, storage path, thumbnail, type, size, duration, source, technician, creator,
--     created_at) remains immutable.
--   * Client links, their issuing, revocation and the watch endpoint are untouched.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The path shape checks no longer tie the path to the CURRENT phase - only to the visit and a valid section folder.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.report_videos drop constraint report_videos_storage_path_shape_check;
alter table public.report_videos add constraint report_videos_storage_path_shape_check
  check (storage_path ~ ('^' || visit_id::text || '/(before|during|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm)$'));

alter table public.report_videos drop constraint report_videos_thumbnail_path_shape_check;
alter table public.report_videos add constraint report_videos_thumbnail_path_shape_check
  check (thumbnail_path is null or thumbnail_path ~ ('^' || visit_id::text || '/(before|during|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'));

comment on column public.report_videos.phase is
  'Which section (Before / During / After) the video belongs to. A manager can move a video between sections; the file is never moved, so storage_path keeps the folder it was first uploaded under. Nothing derives the section from the path.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The guard: phase may change, under the same rules that govern the inclusion tick.
--    Everything else in this function is unchanged from 20261012140100_report_videos_hardening.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.report_videos_guard()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_lim record;
  v_status visit_status;
  v_obj record;
  v_thumb record;
  v_completed boolean;
  n_phase integer;
  n_visit integer;
begin
  select * into v_lim from private.report_video_limits();

  if tg_op = 'INSERT' then
    -- Who is asking is decided BEFORE any lookup, so nobody can use this trigger (which runs before row-level security)
    -- to find out whether a storage object exists. The service role / database owner (no auth.uid()) is trusted.
    if auth.uid() is not null and not (
         private.current_app_role() = 'manager'
         or (private.current_app_role() = 'technician'
             and private.is_visit_participant(new.visit_id, private.current_technician_id()))
       ) then
      raise exception 'Not authorized.';
    end if;
    if new.deleted_at is not null or new.deleted_by is not null then
      raise exception 'A new video cannot be created as deleted.';
    end if;
    -- The per-visit lock is taken BEFORE the visit status is read (cancel_job_work takes the same lock), so a video can
    -- never be added to a visit that is being cancelled at the same moment.
    perform pg_advisory_xact_lock(hashtextextended('video:' || new.visit_id::text, 0));
    select status into v_status from visits where id = new.visit_id;
    if not found then raise exception 'Visit not found.'; end if;
    v_completed := exists (select 1 from reports r where r.visit_id = new.visit_id and r.completed_at is not null);
    if v_status = 'cancelled' then
      raise exception 'This visit has been cancelled; videos can no longer be added to it.';
    end if;
    if v_completed then
      raise exception 'This report has been marked Completed, so videos can no longer be added. Ask the office to reopen it.';
    end if;
    if not private.report_video_object_name_ok(new.storage_path) then
      raise exception 'The video file name is not valid.';
    end if;
    -- On creation the file must still be uploaded under the section it is being filed in (a move may later change the
    -- phase without touching the file, but a NEW video always starts out consistent).
    if (storage.foldername(new.storage_path))[1] is distinct from new.visit_id::text
       or (storage.foldername(new.storage_path))[2] is distinct from new.phase::text then
      raise exception 'The video file does not belong to this visit and phase.';
    end if;
    if new.thumbnail_path is not null and (
         not private.report_video_object_name_ok(new.thumbnail_path)
         or new.thumbnail_path !~ '\.jpg$'
         or (storage.foldername(new.thumbnail_path))[1] is distinct from new.visit_id::text
         or (storage.foldername(new.thumbnail_path))[2] is distinct from new.phase::text) then
      raise exception 'The video thumbnail file name is not valid.';
    end if;
    if new.mime_type is null or new.mime_type not in ('video/mp4', 'video/quicktime', 'video/webm') then
      raise exception 'Unsupported video type. Use MP4, MOV or WebM.';
    end if;
    if (new.mime_type = 'video/mp4' and new.storage_path !~ '\.mp4$')
       or (new.mime_type = 'video/quicktime' and new.storage_path !~ '\.mov$')
       or (new.mime_type = 'video/webm' and new.storage_path !~ '\.webm$') then
      raise exception 'The video file extension does not match its type.';
    end if;
    if new.size_bytes is null or new.size_bytes <= 0 or new.size_bytes > v_lim.max_bytes then
      raise exception 'The video is too large (the limit is % MB).', v_lim.max_bytes / 1048576;
    end if;
    if new.duration_seconds is not null and new.duration_seconds > v_lim.max_seconds then
      raise exception 'The video is too long (the limit is 60 seconds).';
    end if;

    -- The Storage object must really exist, in the right bucket, with exactly the size and type being claimed.
    select (o.metadata ->> 'size')::bigint as size, lower(o.metadata ->> 'mimetype') as mime into v_obj
    from storage.objects o where o.bucket_id = 'report-videos' and o.name = new.storage_path;
    if not found then
      raise exception 'The video file was not found in storage.';
    end if;
    if v_obj.size is distinct from new.size_bytes then
      raise exception 'The video size does not match the uploaded file.';
    end if;
    if v_obj.mime is distinct from new.mime_type then
      raise exception 'The video type does not match the uploaded file.';
    end if;
    if new.thumbnail_path is not null then
      select (o.metadata ->> 'size')::bigint as size, lower(o.metadata ->> 'mimetype') as mime into v_thumb
      from storage.objects o where o.bucket_id = 'report-videos' and o.name = new.thumbnail_path;
      if not found then raise exception 'The video thumbnail was not found in storage.'; end if;
      if v_thumb.mime is distinct from 'image/jpeg' then raise exception 'The video thumbnail must be a JPEG.'; end if;
      if v_thumb.size is null or v_thumb.size <= 0 or v_thumb.size > v_lim.max_thumbnail_bytes then
        raise exception 'The video thumbnail is too large.';
      end if;
    end if;

    -- Counts (the per-visit lock was taken above, so two simultaneous uploads cannot exceed the cap).
    select count(*) filter (where phase = new.phase), count(*) into n_phase, n_visit
    from report_videos where visit_id = new.visit_id and deleted_at is null;
    if n_phase >= v_lim.max_per_phase then
      raise exception 'Only % videos can be added to each section (Before / During / After).', v_lim.max_per_phase;
    end if;
    if n_visit >= v_lim.max_per_visit then
      raise exception 'Only % videos can be added to one report.', v_lim.max_per_visit;
    end if;
    return new;
  end if;

  -- UPDATE: the file facts never change, a removed video stays removed, and a Completed report only allows removal.
  -- The section (phase) is the ONE exception: a manager may move a video between Before / During / After. The file is
  -- deliberately left where it is, so storage_path and thumbnail_path still must not change.
  v_completed := exists (select 1 from reports r where r.visit_id = new.visit_id and r.completed_at is not null);
  if new.visit_id is distinct from old.visit_id
     or new.storage_path is distinct from old.storage_path or new.thumbnail_path is distinct from old.thumbnail_path
     or new.mime_type is distinct from old.mime_type or new.size_bytes is distinct from old.size_bytes
     or new.duration_seconds is distinct from old.duration_seconds or new.source is distinct from old.source
     or new.technician_id is distinct from old.technician_id or new.created_by_user is distinct from old.created_by_user
     or new.created_at is distinct from old.created_at then
    raise exception 'A video''s file details cannot be changed.';
  end if;
  if old.deleted_at is not null and (new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by
       or new.include_in_client_report is distinct from old.include_in_client_report or new.sort_order is distinct from old.sort_order
       or new.phase is distinct from old.phase) then
    raise exception 'This video has been removed and cannot be changed.';
  end if;
  if v_completed and (new.include_in_client_report is distinct from old.include_in_client_report
       or new.sort_order is distinct from old.sort_order
       or new.phase is distinct from old.phase) then
    raise exception 'This report has been marked Completed; reopen it before changing its videos.';
  end if;
  -- A move must respect the same per-section cap as an upload. The per-visit total cannot change, so it is not re-checked.
  if new.phase is distinct from old.phase then
    if new.deleted_at is not null then
      raise exception 'A removed video cannot be moved to another section.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('video:' || new.visit_id::text, 0));
    select count(*) into n_phase
    from report_videos where visit_id = new.visit_id and deleted_at is null and phase = new.phase and id <> new.id;
    if n_phase >= v_lim.max_per_phase then
      raise exception 'The % section already holds % videos, which is the most it can take.', new.phase, v_lim.max_per_phase;
    end if;
  end if;
  -- Removal records WHO did it from the session (not from whatever the caller typed); the service role keeps what it sent.
  if old.deleted_at is null and new.deleted_at is not null then
    new.deleted_by := coalesce(nullif(nullif(private.current_actor_name(), 'System'), ''), new.deleted_by);
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. A move is written to the report's history, like adding and removing a video already are.
--    Only the new branch is added; the INSERT and removal branches are unchanged.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.report_videos_audit()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_entity_type activity_entity_type;
  v_entity_id uuid;
  v_actor text := private.current_actor_name();
begin
  select r.id into v_entity_id from reports r where r.visit_id = new.visit_id;
  if v_entity_id is not null then v_entity_type := 'report'; else v_entity_type := 'visit'; v_entity_id := new.visit_id; end if;

  if tg_op = 'INSERT' then
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values (v_entity_type, v_entity_id, 'report_video_added', new.phase::text, v_actor, now());
  elsif old.deleted_at is null and new.deleted_at is not null then
    update report_video_links set revoked_at = now(), revoked_by = 'system: video removed'
    where video_id = new.id and revoked_at is null;
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values (v_entity_type, v_entity_id, 'report_video_removed', new.phase::text, v_actor, now());
  elsif new.phase is distinct from old.phase then
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values (v_entity_type, v_entity_id, 'report_video_moved', old.phase::text || ':' || new.phase::text, v_actor, now());
  end if;
  return null;
end;
$function$;
