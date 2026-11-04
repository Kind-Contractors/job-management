-- Waste report videos: the limit is STRICTLY 60 seconds (agreed 2026-11-03), replacing the 1-second rounding allowance of the first
-- version. The waste-media-check Edge Function now rejects anything measured over 60 s (it only absorbs floating-point noise of a
-- millionth of a second, never a real extra fraction), and the database refuses anything over 60.00 as well.
alter table public.waste_report_media drop constraint waste_report_media_shape_check;
alter table public.waste_report_media add constraint waste_report_media_shape_check check (
  (kind = 'photo' and mime_type in ('image/jpeg', 'image/png') and duration_seconds is null and thumbnail_path is null)
  or (kind = 'video' and mime_type in ('video/mp4', 'video/quicktime', 'video/webm') and duration_seconds is not null
      and duration_seconds > 0 and duration_seconds <= 60)
);

-- waste_submit_report(): identical to 20261103100000 except the per-video check, now "> 60" (was "> 61").
create or replace function public.waste_submit_report(
  p_report_id uuid,
  p_address text,
  p_work_start_date date,
  p_work_end_date date,
  p_description text,
  p_media jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me uuid := private.current_waste_reporter_id();
  v_name text;
  v_existing_owner uuid;
  v_today date := (now() at time zone 'Europe/London')::date;
  v_item jsonb;
  v_kind text;
  v_phase text;
  v_path text;
  v_thumb text;
  v_check public.waste_media_checks%rowtype;
  v_thumb_check public.waste_media_checks%rowtype;
  v_object_created timestamptz;
  v_prefix text;
  v_ids uuid[] := '{}';
  v_paths text[] := '{}';
  v_photos_before integer := 0;
  v_photos_after integer := 0;
  v_videos_before integer := 0;
  v_videos_after integer := 0;
begin
  if v_me is null then
    raise exception 'Not authorized.';
  end if;
  if p_report_id is null then
    raise exception 'The report has no id.';
  end if;

  -- The lock comes BEFORE anything is read (see 20261103100000).
  perform pg_advisory_xact_lock(hashtextextended('waste_report:' || p_report_id::text, 0));

  select reporter_user_id into v_existing_owner from public.waste_reports where id = p_report_id;
  if found then
    if v_existing_owner = v_me then
      return jsonb_build_object('id', p_report_id, 'created', false);
    end if;
    raise exception 'This report is not available to you.';
  end if;

  if p_address is null or length(btrim(p_address)) = 0 then
    raise exception 'Enter the job address.';
  end if;
  if length(btrim(p_address)) > 500 then
    raise exception 'The address is too long (500 characters at most).';
  end if;
  if p_work_start_date is null or p_work_end_date is null then
    raise exception 'Enter the start and end dates.';
  end if;
  if p_work_end_date < p_work_start_date then
    raise exception 'The end date cannot be before the start date.';
  end if;
  if p_work_end_date > v_today + 1 then
    raise exception 'The end date cannot be in the future.';
  end if;
  if p_work_end_date - p_work_start_date > 366 then
    raise exception 'The work cannot span more than a year.';
  end if;
  if length(coalesce(p_description, '')) > 10000 then
    raise exception 'The description is too long (10,000 characters at most).';
  end if;
  if p_media is null or jsonb_typeof(p_media) <> 'array' then
    raise exception 'The list of photos and videos is missing.';
  end if;

  v_prefix := v_me::text || '/' || p_report_id::text || '/';

  for v_item in select * from jsonb_array_elements(p_media) loop
    v_kind := v_item->>'kind';
    v_phase := v_item->>'phase';
    v_path := v_item->>'storage_path';
    v_thumb := nullif(v_item->>'thumbnail_path', '');

    if v_kind is null or v_kind not in ('photo', 'video') then
      raise exception 'Every file must be a photo or a video.';
    end if;
    if v_phase is null or v_phase not in ('before', 'after') then
      raise exception 'Every file must be in the Before or After section.';
    end if;
    if (v_item->>'id') is null or (v_item->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Every file must have an id.';
    end if;
    if (v_item->>'id')::uuid = any (v_ids) then
      raise exception 'A file is listed twice.';
    end if;
    v_ids := v_ids || (v_item->>'id')::uuid;

    if v_path is null or not private.waste_media_object_name_ok(v_path) or v_path not like v_prefix || v_phase || '/%' or v_path like '%.thumb.jpg' then
      raise exception 'A file is not stored in this report''s % section.', v_phase;
    end if;
    if (v_kind = 'photo') <> (v_path ~ '\.(jpg|png)$') then
      raise exception 'A file''s type does not match its name.';
    end if;
    if v_path = any (v_paths) then
      raise exception 'A file is listed twice.';
    end if;
    v_paths := v_paths || v_path;

    select * into v_check from public.waste_media_checks where storage_path = v_path;
    if not found or v_check.owner_user_id <> v_me then
      raise exception 'A file has not been checked yet. Wait for it to finish uploading.';
    end if;
    if not v_check.ok then
      raise exception 'A file was rejected: %', coalesce(v_check.reason, 'it did not pass the check.');
    end if;
    if v_check.kind <> v_kind then
      raise exception 'A file''s type does not match its check.';
    end if;
    select o.created_at into v_object_created from storage.objects o
    where o.bucket_id = 'waste-report-media' and o.name = v_path and o.owner_id = v_me::text
      and (o.metadata->>'size')::bigint = v_check.size_bytes;
    if not found then
      raise exception 'A file is missing from storage. Remove it and add it again.';
    end if;
    if v_object_created > v_check.checked_at then
      raise exception 'A file changed after it was checked. Remove it and add it again.';
    end if;

    if v_thumb is not null then
      if v_kind <> 'video' or not private.waste_media_object_name_ok(v_thumb) or v_thumb not like v_prefix || v_phase || '/%.thumb.jpg' then
        raise exception 'A video''s poster is not stored with it.';
      end if;
      if v_thumb = any (v_paths) then
        raise exception 'A file is listed twice.';
      end if;
      v_paths := v_paths || v_thumb;
      select * into v_thumb_check from public.waste_media_checks where storage_path = v_thumb;
      if not found or v_thumb_check.owner_user_id <> v_me or not v_thumb_check.ok or v_thumb_check.kind <> 'thumbnail' then
        raise exception 'A video''s poster has not passed its check.';
      end if;
      select o.created_at into v_object_created from storage.objects o
      where o.bucket_id = 'waste-report-media' and o.name = v_thumb and o.owner_id = v_me::text
        and (o.metadata->>'size')::bigint = v_thumb_check.size_bytes;
      if not found or v_object_created > v_thumb_check.checked_at then
        raise exception 'A video''s poster is missing or changed. Remove the video and add it again.';
      end if;
    end if;

    if v_kind = 'photo' then
      if v_phase = 'before' then v_photos_before := v_photos_before + 1; else v_photos_after := v_photos_after + 1; end if;
    else
      if v_check.duration_seconds is null or v_check.duration_seconds > 60 then
        raise exception 'A video is longer than 60 seconds.';
      end if;
      if v_phase = 'before' then v_videos_before := v_videos_before + 1; else v_videos_after := v_videos_after + 1; end if;
    end if;
  end loop;

  if v_photos_before > 30 or v_photos_after > 30 then
    raise exception 'A section can hold at most 30 photos.';
  end if;
  if v_videos_before > 5 or v_videos_after > 5 then
    raise exception 'A section can hold at most 5 videos.';
  end if;

  select coalesce(nullif(btrim(display_name), ''), 'Waste reporter') into v_name from public.app_users where id = v_me;

  insert into public.waste_reports (id, reporter_user_id, reporter_name, address, work_start_date, work_end_date, description)
  values (p_report_id, v_me, v_name, btrim(p_address), p_work_start_date, p_work_end_date, coalesce(p_description, ''));

  insert into public.waste_report_media (id, waste_report_id, kind, phase, storage_path, thumbnail_path, mime_type, size_bytes, duration_seconds, sort_order)
  select (m->>'id')::uuid, p_report_id, m->>'kind', m->>'phase', m->>'storage_path', nullif(m->>'thumbnail_path', ''),
         c.detected_mime, c.size_bytes, case when m->>'kind' = 'video' then c.duration_seconds end,
         coalesce((m->>'sort_order')::integer, 0)
  from jsonb_array_elements(p_media) m
  join public.waste_media_checks c on c.storage_path = m->>'storage_path';

  insert into public.waste_report_events (waste_report_id, event_type, actor, actor_user_id)
  values (p_report_id, 'submitted', v_name, v_me);

  return jsonb_build_object('id', p_report_id, 'created', true);
end;
$$;

revoke execute on function public.waste_submit_report(uuid, text, date, date, text, jsonb) from public, anon;
grant execute on function public.waste_submit_report(uuid, text, date, date, text, jsonb) to authenticated;
