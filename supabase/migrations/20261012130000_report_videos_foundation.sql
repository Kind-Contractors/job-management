-- Video support for job reports: DATABASE FOUNDATION ONLY (no frontend, no Edge Function in this migration).
--
-- Purely additive. Nothing that exists today is altered except ONE new column on public.reports
-- (include_videos, default true, mirrors include_photos). The photos table, the visit-photos bucket, every photo RPC
-- and every photo policy are untouched; no existing function or trigger is replaced.
--
-- Design (agreed with Luke, see the video design notes):
--  * Videos live in their own table (report_videos) and their own PRIVATE Storage bucket (report-videos). They are
--    linked to the VISIT (not the report) because an offline technician can finish a video before the report exists;
--    reports.visit_id is unique, so visit <-> report is 1:1 and the join is trivial.
--  * A video never replaces the "at least one photo" rule and never blocks submitting a report: videos attach
--    independently, through their own functions, before or after the report is submitted.
--  * Technicians have NO table access (same as photos): they use the SECURITY DEFINER functions below. Managers get
--    manager_full_access (select/insert/update; hard deletes are not granted - removal is a soft delete).
--  * Client access is NEVER direct. report_video_links stores only a SHA-256 hash of a random token; the planned Edge
--    Function (a later phase) hashes the token it receives and calls resolve_report_video_link, which only the
--    service role may execute. Anonymous users get no table, function or storage access.
--  * Limits and metadata are validated by a trigger on report_videos, so they hold for EVERY caller (technician
--    function, manager UI, service role), not just the app.
--
-- Limits (change only by replacing private.report_video_limits()): 150 MiB per video (equal to the bucket limit),
-- 60 s (+1 s rounding allowance), 3 videos per phase and 8 per visit (soft-deleted videos do not count), 1 MiB per
-- thumbnail.

-- ---------------------------------------------------------------------------------------------------------------
-- 0. The private bucket. DEV already has it (created in the dashboard) - ON CONFLICT DO NOTHING leaves every setting
--    of an existing bucket untouched. On a project that does not have it yet this creates it private, with the same
--    limit and MIME list. (The project-wide upload limit is a separate dashboard setting: it must be >= 150 MiB.)
-- ---------------------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-videos', 'report-videos', false, 157286400,
        array['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Small private helpers
-- ---------------------------------------------------------------------------------------------------------------
create function private.report_video_limits()
returns table(max_bytes bigint, max_seconds numeric, max_per_phase integer, max_per_visit integer, max_thumbnail_bytes bigint)
language sql immutable set search_path to 'public' as $$
  select 157286400::bigint, 61::numeric, 3, 8, 1048576::bigint
$$;

-- "<visit uuid>/<before|during|after>/<uuid>.<mp4|mov|webm|jpg>" - the ONLY object name shape allowed in report-videos.
create function private.report_video_object_name_ok(p_name text)
returns boolean language sql immutable set search_path to 'public' as $$
  select coalesce(p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(before|during|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm|jpg)$', false)
$$;

-- Who to record in the audit trail: the technician's name, else the signed-in manager's email, else 'System'.
create function private.current_actor_name()
returns text language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select name from technicians where id = private.current_technician_id()),
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''),
    'System')
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. reports.include_videos - the report-level switch (a video reaches the client only if BOTH this and the
--    per-video flag are on). Same shape as include_photos / include_notes / include_issues.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.reports add column include_videos boolean not null default true;
comment on column public.reports.include_videos is
  'Report-level switch for videos in the client report (mirrors include_photos). A video is shown to the client only if this is true AND the video''s own include_in_client_report is true.';

-- ---------------------------------------------------------------------------------------------------------------
-- 3. report_videos
-- ---------------------------------------------------------------------------------------------------------------
create table public.report_videos (
  id                      uuid primary key default gen_random_uuid(),
  visit_id                uuid not null references public.visits (id) on delete restrict,
  phase                   public.photo_phase not null,
  storage_path            text not null,
  thumbnail_path          text,
  mime_type               text not null,
  size_bytes              bigint not null,
  duration_seconds        numeric(7, 2),
  source                  text not null,
  technician_id           uuid references public.technicians (id) on delete restrict,
  include_in_client_report boolean not null default false,
  sort_order              integer not null default 0,
  created_by_user         uuid default auth.uid(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  deleted_by              text,

  constraint report_videos_storage_path_key unique (storage_path),
  constraint report_videos_mime_type_check check (mime_type in ('video/mp4', 'video/quicktime', 'video/webm')),
  constraint report_videos_size_check check (size_bytes > 0 and size_bytes <= 157286400),
  constraint report_videos_duration_check check (duration_seconds is null or duration_seconds > 0),
  constraint report_videos_source_check check (
    (source = 'technician' and technician_id is not null) or (source = 'manager' and technician_id is null)
  ),
  -- the object lives under this visit and phase, named by a uuid, with an extension that matches the MIME type
  constraint report_videos_storage_path_shape_check check (
    storage_path ~ ('^' || visit_id::text || '/' || phase::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm)$')
  ),
  constraint report_videos_mime_extension_check check (
    (mime_type = 'video/mp4' and storage_path like '%.mp4')
    or (mime_type = 'video/quicktime' and storage_path like '%.mov')
    or (mime_type = 'video/webm' and storage_path like '%.webm')
  ),
  constraint report_videos_thumbnail_path_shape_check check (
    thumbnail_path is null
    or thumbnail_path ~ ('^' || visit_id::text || '/' || phase::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$')
  ),
  constraint report_videos_deleted_pair_check check ((deleted_at is null) = (deleted_by is null))
);

create unique index report_videos_thumbnail_path_key on public.report_videos (thumbnail_path) where thumbnail_path is not null;
create index report_videos_visit_active_idx on public.report_videos (visit_id, phase, sort_order, created_at) where deleted_at is null;
create index report_videos_technician_idx on public.report_videos (technician_id) where technician_id is not null;

comment on table public.report_videos is
  'Videos taken during a visit, shown inside the Before/During/After sections of the report. Linked to the visit (reports.visit_id is unique). Never hard-deleted: removal sets deleted_at/deleted_by and revokes the video''s links; the Storage object is kept. Technicians have no table access (RPCs only).';
comment on column public.report_videos.include_in_client_report is
  'Opt-in: false until a manager ticks it. A video is client-visible only if this AND reports.include_videos are true and it is not deleted.';
comment on column public.report_videos.created_by_user is
  'The login (auth.uid()) that created the row; null for service-role/system inserts.';

create trigger jms_set_updated_at before update on public.report_videos
  for each row execute function public.jms_set_updated_at();

-- 3a. Validation that holds for EVERY caller. Runs before the CHECK constraints so the messages are readable.
create function private.report_videos_guard()
returns trigger language plpgsql security definer set search_path to 'public' as $$
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
  v_completed := exists (select 1 from reports r where r.visit_id = new.visit_id and r.completed_at is not null);

  if tg_op = 'INSERT' then
    if new.deleted_at is not null or new.deleted_by is not null then
      raise exception 'A new video cannot be created as deleted.';
    end if;
    select status into v_status from visits where id = new.visit_id;
    if not found then raise exception 'Visit not found.'; end if;
    if v_status = 'cancelled' then
      raise exception 'This visit has been cancelled; videos can no longer be added to it.';
    end if;
    if v_completed then
      raise exception 'This report has been marked Completed, so videos can no longer be added. Ask the office to reopen it.';
    end if;
    if not private.report_video_object_name_ok(new.storage_path) then
      raise exception 'The video file name is not valid.';
    end if;
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

    -- Counts. One lock per visit so two simultaneous uploads cannot both slip past the cap.
    perform pg_advisory_xact_lock(hashtextextended('video:' || new.visit_id::text, 0));
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
  if new.visit_id is distinct from old.visit_id or new.phase is distinct from old.phase
     or new.storage_path is distinct from old.storage_path or new.thumbnail_path is distinct from old.thumbnail_path
     or new.mime_type is distinct from old.mime_type or new.size_bytes is distinct from old.size_bytes
     or new.duration_seconds is distinct from old.duration_seconds or new.source is distinct from old.source
     or new.technician_id is distinct from old.technician_id or new.created_by_user is distinct from old.created_by_user
     or new.created_at is distinct from old.created_at then
    raise exception 'A video''s file details cannot be changed.';
  end if;
  if old.deleted_at is not null and (new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by
       or new.include_in_client_report is distinct from old.include_in_client_report or new.sort_order is distinct from old.sort_order) then
    raise exception 'This video has been removed and cannot be changed.';
  end if;
  if v_completed and (new.include_in_client_report is distinct from old.include_in_client_report
       or new.sort_order is distinct from old.sort_order) then
    raise exception 'This report has been marked Completed; reopen it before changing its videos.';
  end if;
  return new;
end;
$$;

create trigger report_videos_guard before insert or update on public.report_videos
  for each row execute function private.report_videos_guard();

-- 3b. Audit trail + link revocation. Removing a video permanently kills every link to it.
create function private.report_videos_audit()
returns trigger language plpgsql security definer set search_path to 'public' as $$
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
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. report_video_links (created after report_videos because it references it; the audit trigger above only runs
--    at row time, by which point this table exists)
-- ---------------------------------------------------------------------------------------------------------------
create table public.report_video_links (
  id              uuid primary key default gen_random_uuid(),
  video_id        uuid not null references public.report_videos (id) on delete restrict,
  token_hash      bytea not null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  created_by      text,
  revoked_at      timestamptz,
  revoked_by      text,
  first_opened_at timestamptz,
  last_opened_at  timestamptz,
  open_count      integer not null default 0,

  constraint report_video_links_token_hash_key unique (token_hash),
  constraint report_video_links_token_hash_length_check check (octet_length(token_hash) = 32),
  constraint report_video_links_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '731 days'),
  constraint report_video_links_revoked_pair_check check ((revoked_at is null) = (revoked_by is null)),
  constraint report_video_links_open_count_check check (open_count >= 0)
);
create index report_video_links_video_idx on public.report_video_links (video_id);
create index report_video_links_active_idx on public.report_video_links (video_id) where revoked_at is null;

comment on table public.report_video_links is
  'One row per issued client link. Only the SHA-256 hash of the token is stored (the token itself is shown once, to the manager, and put in the PDF). Resolved only by resolve_report_video_link, which only the service role can execute. A link is revoked by setting revoked_at, never deleted.';

create trigger report_videos_audit after insert or update on public.report_videos
  for each row execute function private.report_videos_audit();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Table access: RLS on, managers only. Anonymous gets nothing; technicians get nothing (functions only).
-- ---------------------------------------------------------------------------------------------------------------
alter table public.report_videos enable row level security;
alter table public.report_video_links enable row level security;

create policy manager_full_access on public.report_videos for all
  using (private.current_app_role() = 'manager') with check (private.current_app_role() = 'manager');
-- Managers can READ link activity (opens, expiry, revoked); every change goes through the functions below.
create policy manager_read_links on public.report_video_links for select
  using (private.current_app_role() = 'manager');

revoke all on public.report_videos from anon, authenticated;
grant select, insert, update on public.report_videos to authenticated;      -- no DELETE: videos are soft-deleted
revoke all on public.report_video_links from anon, authenticated;
grant select on public.report_video_links to authenticated;                  -- row-filtered to managers by the policy

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Storage policies for the private report-videos bucket (storage.objects)
-- ---------------------------------------------------------------------------------------------------------------
-- May the current technician add this object? Their visit, a valid name, visit not cancelled, report not Completed.
create function private.technician_can_upload_video_object(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select case
    when private.report_video_object_name_ok(p_name)
    then private.visit_belongs_to_current_technician((storage.foldername(p_name))[1])
         and not exists (select 1 from visits v where v.id = ((storage.foldername(p_name))[1])::uuid and v.status = 'cancelled')
         and not exists (select 1 from reports r where r.visit_id = ((storage.foldername(p_name))[1])::uuid and r.completed_at is not null)
    else false
  end
$$;

-- May the current technician remove this object? Their visit, and no report_videos row (even a removed one) uses it.
create function private.technician_can_remove_video_object(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select case
    when private.report_video_object_name_ok(p_name)
    then private.visit_belongs_to_current_technician((storage.foldername(p_name))[1])
         and not exists (select 1 from report_videos rv where rv.storage_path = p_name or rv.thumbnail_path = p_name)
    else false
  end
$$;

revoke execute on function private.technician_can_upload_video_object(text) from public, anon;
revoke execute on function private.technician_can_remove_video_object(text) from public, anon;
grant execute on function private.technician_can_upload_video_object(text) to authenticated;   -- called from Storage RLS policies
grant execute on function private.technician_can_remove_video_object(text) to authenticated;

create policy manager_report_videos_all on storage.objects for all to authenticated
  using (bucket_id = 'report-videos' and private.current_app_role() = 'manager')
  with check (bucket_id = 'report-videos' and private.current_app_role() = 'manager');

create policy technician_own_report_videos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'report-videos'
    and private.current_app_role() = 'technician'
    and private.technician_can_upload_video_object(name)
  );

-- Only the objects THEY uploaded (a colleague's video on a shared visit is not visible to them).
create policy technician_own_report_videos_select on storage.objects for select to authenticated
  using (
    bucket_id = 'report-videos'
    and private.current_app_role() = 'technician'
    and owner_id = auth.uid()::text
    and private.visit_belongs_to_current_technician((storage.foldername(name))[1])
  );

-- Clean up an upload that was never attached. Once a report_videos row exists (even a removed one) the object stays.
create policy technician_own_unattached_report_videos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'report-videos'
    and private.current_app_role() = 'technician'
    and owner_id = auth.uid()::text
    and private.technician_can_remove_video_object(name)
  );
-- (No technician UPDATE policy: an upload cannot be overwritten, same as photos.)

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Technician functions (SECURITY DEFINER, fixed search_path; anonymous revoked)
-- ---------------------------------------------------------------------------------------------------------------
-- Is the current visit's report still open to the technician removing a video? Not once the office has approved it.
create function private.technician_videos_deletable(p_visit_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select not exists (
    select 1 from reports r where r.visit_id = p_visit_id and (r.review_status = 'approved' or r.completed_at is not null)
  )
$$;
revoke execute on function private.technician_videos_deletable(uuid) from public, anon, authenticated;

-- Attach an uploaded video to a visit. Idempotent: the same path attached again by the same technician returns the
-- existing id. Size, type, limits, completed-report and cancelled-visit rules are enforced by the table trigger.
create function public.technician_attach_video(
  p_visit_id uuid, p_phase text, p_storage_path text, p_thumbnail_path text,
  p_mime_type text, p_size_bytes bigint, p_duration_seconds numeric
) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  v_me uuid;
  v_existing report_videos%rowtype;
  v_id uuid;
begin
  v_me := private.current_technician_id();
  if private.current_app_role() is distinct from 'technician' or v_me is null then
    raise exception 'Not authorized.';
  end if;
  if p_visit_id is null or not private.is_visit_participant(p_visit_id, v_me) then
    raise exception 'This visit is not assigned to you.';
  end if;
  if p_phase is null or p_phase not in ('before', 'during', 'after') then
    raise exception 'A video must be in the Before, During or After section.';
  end if;
  if p_storage_path is null or length(trim(p_storage_path)) = 0 then
    raise exception 'Every video must have a storage path.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('video:' || p_visit_id::text, 0));

  select * into v_existing from report_videos where storage_path = p_storage_path;
  if found then
    if v_existing.visit_id = p_visit_id and v_existing.technician_id = v_me and v_existing.deleted_at is null then
      return v_existing.id;   -- already attached: a retried sync is a success
    end if;
    raise exception 'This video cannot be attached.';
  end if;

  -- Only the login that uploaded the file may claim it (a visit can be shared by several technicians).
  if not exists (select 1 from storage.objects where bucket_id = 'report-videos' and name = p_storage_path) then
    raise exception 'The video file was not found in storage.';
  end if;
  if not exists (
    select 1 from storage.objects where bucket_id = 'report-videos' and name = p_storage_path and owner_id = auth.uid()::text
  ) then
    raise exception 'This video was not uploaded by you.';
  end if;
  if p_thumbnail_path is not null and not exists (
    select 1 from storage.objects where bucket_id = 'report-videos' and name = p_thumbnail_path and owner_id = auth.uid()::text
  ) then
    raise exception 'The video thumbnail was not uploaded by you.';
  end if;

  insert into report_videos (visit_id, phase, storage_path, thumbnail_path, mime_type, size_bytes, duration_seconds, source, technician_id)
  values (p_visit_id, p_phase::photo_phase, p_storage_path, p_thumbnail_path, p_mime_type, p_size_bytes, p_duration_seconds, 'technician', v_me)
  returning id into v_id;
  return v_id;
end;
$$;

-- The technician's OWN videos for a visit, and whether each can still be removed.
create function public.technician_my_videos(p_visit_id uuid)
returns table(id uuid, phase photo_phase, storage_path text, thumbnail_path text, mime_type text,
              size_bytes bigint, duration_seconds numeric, created_at timestamptz, can_delete boolean)
language sql stable security definer set search_path to 'public' as $$
  select rv.id, rv.phase, rv.storage_path, rv.thumbnail_path, rv.mime_type, rv.size_bytes, rv.duration_seconds,
         rv.created_at, private.technician_videos_deletable(rv.visit_id)
  from report_videos rv
  where private.current_app_role() = 'technician'
    and rv.visit_id = p_visit_id
    and rv.technician_id = private.current_technician_id()
    and rv.deleted_at is null
    and private.is_visit_participant(rv.visit_id, private.current_technician_id())
  order by rv.created_at, rv.id
$$;

-- Remove one of the technician's OWN videos (soft delete; the file is kept; its links are revoked by the trigger).
create function public.technician_delete_video(p_video_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_me uuid;
  v_video report_videos%rowtype;
begin
  v_me := private.current_technician_id();
  if private.current_app_role() is distinct from 'technician' or v_me is null then
    raise exception 'Not authorized.';
  end if;
  select * into v_video from report_videos where id = p_video_id for update;
  if not found or v_video.deleted_at is not null
     or v_video.technician_id is distinct from v_me
     or not private.is_visit_participant(v_video.visit_id, v_me) then
    raise exception 'Video not found.';
  end if;
  if not private.technician_videos_deletable(v_video.visit_id) then
    raise exception 'A video can only be removed before the office has approved the report. Please ask the office.';
  end if;
  update report_videos set deleted_at = now(), deleted_by = (select name from technicians where id = v_me)
  where id = v_video.id;
end;
$$;

revoke execute on function public.technician_attach_video(uuid, text, text, text, text, bigint, numeric) from public, anon;
grant execute on function public.technician_attach_video(uuid, text, text, text, text, bigint, numeric) to authenticated, service_role;
revoke execute on function public.technician_my_videos(uuid) from public, anon;
grant execute on function public.technician_my_videos(uuid) to authenticated, service_role;
revoke execute on function public.technician_delete_video(uuid) from public, anon;
grant execute on function public.technician_delete_video(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Manager link functions + server-side resolution
-- ---------------------------------------------------------------------------------------------------------------
-- Issue a fresh link for every included, non-deleted video of a report. Returns the plain tokens ONCE (only their
-- hashes are stored). Returns nothing when the report's include_videos switch is off.
create function public.manager_issue_report_video_links(p_report_id uuid, p_valid_days integer default 365)
returns table(video_id uuid, token text, link_expires_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
#variable_conflict use_column
declare
  v_report reports%rowtype;
  v_vid record;
  v_token text;
  v_expires timestamptz;
  v_actor text := private.current_actor_name();
  n integer := 0;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.';
  end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 730 then
    raise exception 'Links must be valid for between 1 and 730 days.';
  end if;
  select * into v_report from reports where id = p_report_id;
  if not found then raise exception 'Report not found.'; end if;
  if not v_report.include_videos then return; end if;

  v_expires := now() + make_interval(days => p_valid_days);
  for v_vid in
    select rv.id from report_videos rv
    where rv.visit_id = v_report.visit_id and rv.deleted_at is null and rv.include_in_client_report
    order by rv.phase, rv.sort_order, rv.created_at, rv.id
  loop
    -- 256 random bits, URL-safe base64 (43 characters)
    v_token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
    insert into report_video_links (video_id, token_hash, expires_at, created_by)
    values (v_vid.id, sha256(convert_to(v_token, 'UTF8')), v_expires, v_actor);
    video_id := v_vid.id; token := v_token; link_expires_at := v_expires;
    n := n + 1;
    return next;
  end loop;

  if n > 0 then
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values ('report', p_report_id, 'report_video_links_issued', n || ' link(s), valid ' || p_valid_days || ' days', v_actor, now());
  end if;
end;
$$;

-- Revoke the links of ONE video, or of every video of ONE report (exactly one argument). Returns how many were revoked.
create function public.manager_revoke_report_video_links(p_video_id uuid default null, p_report_id uuid default null)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare
  v_actor text := private.current_actor_name();
  v_visit uuid;
  v_report uuid;
  n integer;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.';
  end if;
  if (p_video_id is null) = (p_report_id is null) then
    raise exception 'Give either a video or a report, not both.';
  end if;

  if p_video_id is not null then
    select visit_id into v_visit from report_videos where id = p_video_id;
    if not found then raise exception 'Video not found.'; end if;
    update report_video_links set revoked_at = now(), revoked_by = v_actor
    where video_id = p_video_id and revoked_at is null;
  else
    select visit_id into v_visit from reports where id = p_report_id;
    if not found then raise exception 'Report not found.'; end if;
    update report_video_links set revoked_at = now(), revoked_by = v_actor
    where video_id in (select id from report_videos where visit_id = v_visit) and revoked_at is null;
  end if;
  get diagnostics n = row_count;

  select id into v_report from reports where visit_id = v_visit;
  if n > 0 and v_report is not null then
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values ('report', v_report, 'report_video_links_revoked', n || ' link(s)', v_actor, now());
  end if;
  return n;
end;
$$;

-- Called ONLY by the server-side Edge Function (service role), with the SHA-256 of the token from the URL.
-- Returns one row (where the file is) when the link is valid, expired/revoked-free, AND the video is still shared
-- right now (not removed, its own flag on, the report's include_videos on). Returns nothing in every other case,
-- so the caller cannot tell why. Counts the open.
create function public.resolve_report_video_link(p_token_hash bytea)
returns table(storage_path text, mime_type text)
language plpgsql security definer set search_path to 'public' as $$
#variable_conflict use_column
declare
  v_link uuid;
  v_path text;
  v_mime text;
begin
  select l.id, v.storage_path, v.mime_type into v_link, v_path, v_mime
  from report_video_links l
  join report_videos v on v.id = l.video_id
  join reports r on r.visit_id = v.visit_id
  where l.token_hash = p_token_hash
    and l.revoked_at is null and l.expires_at > now()
    and v.deleted_at is null and v.include_in_client_report
    and r.include_videos;
  if not found then return; end if;

  update report_video_links
  set open_count = open_count + 1, last_opened_at = now(), first_opened_at = coalesce(first_opened_at, now())
  where id = v_link;

  storage_path := v_path; mime_type := v_mime;
  return next;
end;
$$;

revoke execute on function public.manager_issue_report_video_links(uuid, integer) from public, anon;
grant execute on function public.manager_issue_report_video_links(uuid, integer) to authenticated, service_role;
revoke execute on function public.manager_revoke_report_video_links(uuid, uuid) from public, anon;
grant execute on function public.manager_revoke_report_video_links(uuid, uuid) to authenticated, service_role;
revoke execute on function public.resolve_report_video_link(bytea) from public, anon, authenticated;
grant execute on function public.resolve_report_video_link(bytea) to service_role;

-- Internal-only helpers: nobody but the definer functions / triggers / policies that use them.
revoke execute on function private.report_videos_guard() from public, anon, authenticated;
revoke execute on function private.report_videos_audit() from public, anon, authenticated;
revoke execute on function private.report_video_limits() from public, anon, authenticated;
revoke execute on function private.report_video_object_name_ok(text) from public, anon, authenticated;
revoke execute on function private.current_actor_name() from public, anon, authenticated;
