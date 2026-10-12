-- Video support: HARDENING after the security review of 20261012130000_report_videos_foundation.
--
-- Additive on top of the foundation. Replaces (CREATE OR REPLACE / drop + create) only objects introduced by the
-- foundation, plus ONE existing function (cancel_job_work) that gains one branch. The photos table, the visit-photos
-- bucket, every photo function and every photo policy are untouched.
--
-- 1. Cancelling work no longer orphans videos. cancel_job_work keeps a due/booked visit that has an ACTIVE video and no
--    report / invoice, returning it in kept_visits with reason 'has_video' (the existing reasons are 'has_report' and
--    'has_invoice', checked first). Its cancellation of everything else is unchanged. The visit is not cancelled, so the
--    technician's queued report submission can still complete it (submit is not blocked by cancellation).
-- 2. Unattached uploads are capped: a technician may hold at most 16 report-videos objects per visit that no
--    report_videos row references yet (8 videos + 8 thumbnails). Before this, 40 x 150 MiB were accepted for one visit.
-- 3. Managers can no longer hard-delete or overwrite video files. They keep read and upload; they may delete only an
--    object that no report_videos row references (their own failed upload). Removing a video is the soft delete
--    (deleted_at), which revokes its links and keeps the file. Uploaded files are therefore immutable for everyone but the
--    service role.
-- 4. Client links only work while the report is APPROVED. A report returned for correction (or awaiting review again)
--    stops serving its videos at once; when it is approved again the same links work again (nothing is revoked or
--    re-issued). Combined with the existing live checks (video not removed, video shared, report include_videos on).
-- 5. include_videos cannot be changed on a Completed report (reopen first), so the per-video freeze cannot be bypassed
--    through the report-level switch. Changing it in the same statement that reopens the report is allowed.
-- 6. The video trigger now (a) authorises the caller before any storage lookup (no more existence probing by a
--    technician), (b) takes the per-visit lock before reading the visit status (no race with cancellation), and
--    (c) stamps deleted_by from the session when a video is removed.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. cancel_job_work: keep visits that have active videos
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.cancel_job_work(
  p_job_id uuid,
  p_scope text,
  p_from_visit_id uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jobs%rowtype;
  v_from visits%rowtype;
  v_target record;
  v_actor text;
  v_now timestamptz := now();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_cancelled uuid[] := '{}';
  v_kept jsonb := '[]'::jsonb;
  v_ends date;
  v_already boolean := false;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.' using errcode = 'P0001';
  end if;
  if p_scope is null or p_scope not in ('visit', 'this_and_future', 'job') then
    raise exception 'Unknown cancellation scope.' using errcode = 'P0001';
  end if;

  -- The signed-in manager's email, from their own session token (the same value the app records as the actor elsewhere).
  v_actor := coalesce(nullif(auth.jwt() ->> 'email', ''), 'unknown');

  select * into v_job from jobs where id = p_job_id for update;
  if not found then
    raise exception 'This job no longer exists.' using errcode = 'P0001';
  end if;

  if p_scope = 'job' then
    if v_job.lifecycle_status = 'cancelled' then
      return jsonb_build_object(
        'scope', p_scope, 'already_done', true, 'cancelled_visit_ids', '[]'::jsonb, 'kept_visits', '[]'::jsonb,
        'service_ends_on', v_job.service_ends_on, 'lifecycle_status', v_job.lifecycle_status
      );
    end if;
    if v_job.lifecycle_status not in ('active', 'on_hold') then
      raise exception 'This job is already closed (%).', v_job.lifecycle_status using errcode = 'P0001';
    end if;
  else
    if v_job.lifecycle_status <> 'active' then
      raise exception 'This job is no longer active.' using errcode = 'P0001';
    end if;
    if p_from_visit_id is null then
      raise exception 'Choose the visit to cancel from.' using errcode = 'P0001';
    end if;
    select * into v_from from visits where id = p_from_visit_id and job_id = p_job_id for update;
    if not found then
      raise exception 'That visit does not belong to this job.' using errcode = 'P0001';
    end if;
    if v_from.status = 'cancelled' and p_scope = 'visit' then
      v_already := true;
    elsif v_from.status not in ('due', 'booked', 'cancelled') then
      raise exception 'Only a due or booked visit can be cancelled.' using errcode = 'P0001';
    end if;
    if p_scope = 'this_and_future' and v_from.scheduled_date is null then
      raise exception 'This visit has no date, so "this and all future visits" cannot be used. Cancel this visit only.' using errcode = 'P0001';
    end if;
  end if;

  -- Visits to consider, locked in a fixed order. Each is checked under the same advisory lock the technician report
  -- submission takes, so a report being submitted at this moment is either seen here (visit kept) or accepted after.
  if not v_already then
    for v_target in
      select v.id, v.scheduled_date
      from visits v
      where v.job_id = p_job_id
        and v.status in ('due', 'booked')
        and (
          (p_scope = 'visit' and v.id = p_from_visit_id)
          or (p_scope = 'this_and_future' and (v.id = p_from_visit_id or v.scheduled_date is null or v.scheduled_date > v_from.scheduled_date))
          or p_scope = 'job'
        )
      order by v.id
      for update
    loop
      perform pg_advisory_xact_lock(hashtextextended('report:' || v_target.id::text, 0));
      -- Same per-visit lock a video attach takes: an attach in flight is either seen below (visit kept) or refused afterwards
      -- by the video trigger, which re-reads the visit status under this lock.
      perform pg_advisory_xact_lock(hashtextextended('video:' || v_target.id::text, 0));

      if exists (select 1 from reports r where r.visit_id = v_target.id) then
        v_kept := v_kept || jsonb_build_object('id', v_target.id, 'scheduled_date', v_target.scheduled_date, 'reason', 'has_report');
      elsif exists (select 1 from invoice_line_items li where li.visit_id = v_target.id) then
        v_kept := v_kept || jsonb_build_object('id', v_target.id, 'scheduled_date', v_target.scheduled_date, 'reason', 'has_invoice');
      elsif exists (select 1 from report_videos rv where rv.visit_id = v_target.id and rv.deleted_at is null) then
        v_kept := v_kept || jsonb_build_object('id', v_target.id, 'scheduled_date', v_target.scheduled_date, 'reason', 'has_video');
      else
        update visits set status = 'cancelled' where id = v_target.id and status in ('due', 'booked');
        v_cancelled := v_cancelled || v_target.id;
        insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
        values ('visit', v_target.id, 'visit_cancelled', v_reason, v_actor, v_now);
      end if;
    end loop;
  end if;

  v_ends := v_job.service_ends_on;

  if p_scope = 'this_and_future' then
    -- Never push an earlier end date later.
    if v_ends is null or v_ends > v_from.scheduled_date then
      v_ends := v_from.scheduled_date;
      update jobs set service_ends_on = v_ends where id = p_job_id;
      insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
      values ('job', p_job_id, 'job_service_ended', 'Service ends ' || to_char(v_ends, 'DD/MM/YYYY'), v_actor, v_now);
    end if;
  elsif p_scope = 'job' then
    update jobs set lifecycle_status = 'cancelled', lost_reason = v_reason where id = p_job_id;
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values ('job', p_job_id, 'job_lifecycle_changed', 'Status changed to cancelled', v_actor, v_now);
  end if;

  return jsonb_build_object(
    'scope', p_scope,
    'already_done', v_already,
    'cancelled_visit_ids', to_jsonb(v_cancelled),
    'kept_visits', v_kept,
    'service_ends_on', v_ends,
    'lifecycle_status', case when p_scope = 'job' then 'cancelled' else v_job.lifecycle_status end
  );
end;
$$;

comment on function public.cancel_job_work(uuid, text, uuid, text) is
  'Manager-only, atomic. Scopes: visit | this_and_future | job. Cancels only due/booked visits that have no report, no invoice line and no active video (those are returned in kept_visits with reason has_report | has_invoice | has_video). Sets jobs.service_ends_on (this_and_future) or jobs.lifecycle_status = cancelled (job). Never deletes anything; completed/missed visits, reports, photos, videos, invoices and activities are untouched.';

revoke execute on function public.cancel_job_work(uuid, text, uuid, text) from public, anon;
grant execute on function public.cancel_job_work(uuid, text, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Cap on unattached uploads
-- ---------------------------------------------------------------------------------------------------------------
create function private.report_video_unattached_limit()
returns integer language sql immutable set search_path to 'public' as $$ select 16 $$;
revoke execute on function private.report_video_unattached_limit() from public, anon, authenticated;

create or replace function private.technician_can_upload_video_object(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select case
    when private.report_video_object_name_ok(p_name)
    then private.visit_belongs_to_current_technician((storage.foldername(p_name))[1])
         and not exists (select 1 from visits v where v.id = ((storage.foldername(p_name))[1])::uuid and v.status = 'cancelled')
         and not exists (select 1 from reports r where r.visit_id = ((storage.foldername(p_name))[1])::uuid and r.completed_at is not null)
         -- uploads of THIS login in THIS visit that no report_videos row uses yet: capped (a soft cap under simultaneous uploads)
         and (select count(*) from storage.objects o
              where o.bucket_id = 'report-videos'
                and o.owner_id = auth.uid()::text
                and o.name like (storage.foldername(p_name))[1] || '/%'
                and not exists (select 1 from report_videos rv where rv.storage_path = o.name or rv.thumbnail_path = o.name)
             ) < private.report_video_unattached_limit()
    else false
  end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Managers: read + upload, delete only an unreferenced object, no overwrite
-- ---------------------------------------------------------------------------------------------------------------
create function private.report_video_object_unreferenced(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select not exists (select 1 from report_videos rv where rv.storage_path = p_name or rv.thumbnail_path = p_name)
$$;
revoke execute on function private.report_video_object_unreferenced(text) from public, anon;
grant execute on function private.report_video_object_unreferenced(text) to authenticated;   -- called from a Storage RLS policy
-- a pure name-shape check, now also used by a manager Storage policy
grant execute on function private.report_video_object_name_ok(text) to authenticated;

drop policy manager_report_videos_all on storage.objects;

create policy manager_report_videos_select on storage.objects for select to authenticated
  using (bucket_id = 'report-videos' and private.current_app_role() = 'manager');

create policy manager_report_videos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'report-videos' and private.current_app_role() = 'manager' and private.report_video_object_name_ok(name));

create policy manager_report_videos_delete_unattached on storage.objects for delete to authenticated
  using (bucket_id = 'report-videos' and private.current_app_role() = 'manager' and private.report_video_object_unreferenced(name));
-- (No manager UPDATE policy: an uploaded file cannot be overwritten or renamed, so a recorded size/type stays true.)

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Client links: only while the report is approved
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.resolve_report_video_link(p_token_hash bytea)
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
    and r.include_videos
    and r.review_status = 'approved';
  if not found then return; end if;

  update report_video_links
  set open_count = open_count + 1, last_opened_at = now(), first_opened_at = coalesce(first_opened_at, now())
  where id = v_link;

  storage_path := v_path; mime_type := v_mime;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. include_videos is frozen while the report is Completed
-- ---------------------------------------------------------------------------------------------------------------
create function private.reports_include_videos_guard()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.include_videos is distinct from old.include_videos and old.completed_at is not null and new.completed_at is not null then
    raise exception 'This report has been marked Completed; reopen it before changing whether videos are included.';
  end if;
  return new;
end;
$$;
revoke execute on function private.reports_include_videos_guard() from public, anon, authenticated;

create trigger reports_include_videos_guard before update of include_videos on public.reports
  for each row execute function private.reports_include_videos_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- 6. The video trigger function (same name, same trigger; replaced in place)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.report_videos_guard()
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
  v_completed := exists (select 1 from reports r where r.visit_id = new.visit_id and r.completed_at is not null);
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
  -- Removal records WHO did it from the session (not from whatever the caller typed); the service role keeps what it sent.
  if old.deleted_at is null and new.deleted_at is not null then
    new.deleted_by := coalesce(nullif(nullif(private.current_actor_name(), 'System'), ''), new.deleted_by);
  end if;
  return new;
end;
$$;
