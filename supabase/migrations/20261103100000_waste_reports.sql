-- Waste reports: a standalone reporting module for one restricted kind of user (the "waste reporter" - Jack).
--
-- WHAT IT IS. A waste reporter signs in and can do exactly one thing: submit waste-removal reports (a typed address, start/end
-- dates, a description, before/after photos and videos) and read back his OWN submitted reports. The manager reads every report.
-- Nothing here refers to clients, buildings, jobs, visits or job reports, and no existing table, policy or function is changed
-- except the one CHECK constraint that lists the allowed roles.
--
-- WHY THE REST OF THE APP STAYS CLOSED TO HIM. Every existing policy, RPC and Edge Function admits only `manager` or `technician`
-- (verified against the live DEV and production catalogues on 2026-11-03). A waste reporter has no `technicians` row, so
-- private.current_technician_id() is NULL for him and every technician check fails too. Nothing below grants him anything outside
-- the waste_* objects and his own folder of the waste-report-media bucket.
--
-- HOW A REPORT IS SUBMITTED.
--   1. The phone gives the report an id (uuid) when the draft is started, and uploads each file to
--        waste-report-media/{his user id}/{report id}/{before|after}/{file id}.{jpg|png|mp4|mov|webm}   (+ {file id}.thumb.jpg posters)
--      Storage policies only let him write under his own user folder, never into a report that is already submitted.
--   2. After each upload the phone calls the waste-media-check Edge Function. It reads the file itself (type from its first bytes,
--      size, and a video's real length from its container header) and records the result in waste_media_checks. Only the service
--      role can write that table, so the phone cannot vouch for its own files.
--   3. waste_submit_report() takes a lock on the report id FIRST, then: if the report already exists for him it returns it unchanged
--      (a repeated or concurrent submit can never create a duplicate); otherwise it checks every file has a passing check that is
--      newer than the file itself, and inserts the report, its media and a "submitted" event in one transaction.
--
-- Submitted reports are never edited or deleted: there are no INSERT/UPDATE/DELETE policies on any waste_* table, rows only come
-- from waste_submit_report(), foreign keys are ON DELETE RESTRICT, and nobody may delete a stored file a report uses.

-- 1. The new role -----------------------------------------------------------------------------------------------------------------
alter table public.app_users drop constraint app_users_role_check;
alter table public.app_users add constraint app_users_role_check check (role in ('manager', 'technician', 'waste_reporter'));

-- The signed-in user's id when, and only when, they are an ACTIVE waste reporter; NULL for everyone else (managers included).
create or replace function private.current_waste_reporter_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select a.id from public.app_users a where a.id = auth.uid() and a.is_active and a.role = 'waste_reporter'
$$;
revoke execute on function private.current_waste_reporter_id() from public;
grant execute on function private.current_waste_reporter_id() to authenticated;

-- 2. Tables -----------------------------------------------------------------------------------------------------------------------
create table public.waste_reports (
  id uuid primary key,                                    -- chosen by the phone when the draft starts: the duplicate guard
  reporter_user_id uuid not null references public.app_users(id) on delete restrict,
  reporter_name text not null,
  address text not null,
  work_start_date date not null,
  work_end_date date not null,
  description text not null default '',
  submitted_at timestamptz not null default now(),
  sent_to_client_at timestamptz,
  sent_to_client_by text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz not null default now(),
  constraint waste_reports_address_check check (length(btrim(address)) between 1 and 500),
  constraint waste_reports_description_check check (length(description) <= 10000),
  constraint waste_reports_dates_check check (work_end_date >= work_start_date),
  constraint waste_reports_sent_pair_check check ((sent_to_client_at is null) = (sent_to_client_by is null)),
  constraint waste_reports_archived_pair_check check ((archived_at is null) = (archived_by is null))
);
create index waste_reports_submitted_at_idx on public.waste_reports (submitted_at desc);
create index waste_reports_reporter_idx on public.waste_reports (reporter_user_id, submitted_at desc);

create table public.waste_report_media (
  id uuid primary key,
  waste_report_id uuid not null references public.waste_reports(id) on delete restrict,
  kind text not null,
  phase text not null,
  storage_path text not null unique,
  thumbnail_path text unique,
  mime_type text not null,
  size_bytes bigint not null,
  duration_seconds numeric(7,2),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint waste_report_media_kind_check check (kind in ('photo', 'video')),
  constraint waste_report_media_phase_check check (phase in ('before', 'after')),
  constraint waste_report_media_size_check check (size_bytes > 0 and size_bytes <= 157286400),
  constraint waste_report_media_shape_check check (
    (kind = 'photo' and mime_type in ('image/jpeg', 'image/png') and duration_seconds is null and thumbnail_path is null)
    or (kind = 'video' and mime_type in ('video/mp4', 'video/quicktime', 'video/webm') and duration_seconds is not null
        and duration_seconds > 0 and duration_seconds <= 61)
  )
);
create index waste_report_media_report_idx on public.waste_report_media (waste_report_id, phase, sort_order);

-- What the server measured about one uploaded file. Written ONLY by the waste-media-check Edge Function (service role).
create table public.waste_media_checks (
  storage_path text primary key,
  owner_user_id uuid not null,
  kind text not null,
  detected_mime text,
  size_bytes bigint,
  duration_seconds numeric(7,2),
  ok boolean not null,
  reason text,
  checked_at timestamptz not null default now(),
  constraint waste_media_checks_kind_check check (kind in ('photo', 'video', 'thumbnail'))
);

create table public.waste_report_events (
  id uuid primary key default gen_random_uuid(),
  waste_report_id uuid not null references public.waste_reports(id) on delete restrict,
  event_type text not null,
  actor text not null,
  actor_user_id uuid,
  occurred_at timestamptz not null default now(),
  constraint waste_report_events_type_check check (event_type in ('submitted', 'marked_sent', 'unmarked_sent', 'archived', 'restored'))
);
create index waste_report_events_report_idx on public.waste_report_events (waste_report_id, occurred_at);

-- 3. Row level security: read-only through the API; every write goes through a checked function ------------------------------------
alter table public.waste_reports enable row level security;
alter table public.waste_report_media enable row level security;
alter table public.waste_media_checks enable row level security;
alter table public.waste_report_events enable row level security;

revoke all on public.waste_reports, public.waste_report_media, public.waste_media_checks, public.waste_report_events from anon, authenticated;
grant select on public.waste_reports, public.waste_report_media, public.waste_report_events to authenticated;
-- waste_media_checks: no grant and no policy for anyone but the service role.

create policy manager_read on public.waste_reports for select to authenticated
  using (private.current_app_role() = 'manager');
create policy reporter_read_own on public.waste_reports for select to authenticated
  using (reporter_user_id = private.current_waste_reporter_id());

create policy manager_read on public.waste_report_media for select to authenticated
  using (private.current_app_role() = 'manager');
create policy reporter_read_own on public.waste_report_media for select to authenticated
  using (exists (
    select 1 from public.waste_reports r
    where r.id = waste_report_id and r.reporter_user_id = private.current_waste_reporter_id()
  ));

create policy manager_read on public.waste_report_events for select to authenticated
  using (private.current_app_role() = 'manager');

-- 4. Storage ----------------------------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('waste-report-media', 'waste-report-media', false, 157286400,
        array['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do nothing;

-- {user uuid}/{report uuid}/{before|after}/{file uuid}.{ext}, or {file uuid}.thumb.jpg for a video's poster. Lower-case uuids only.
create or replace function private.waste_media_object_name_ok(p_name text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(before|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.(jpg|png|mp4|mov|webm)|\.thumb\.jpg)$', false)
$$;

-- True when no submitted report uses the object (as its file or its poster).
create or replace function private.waste_media_object_unreferenced(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select not exists (select 1 from public.waste_report_media m where m.storage_path = p_name or m.thumbnail_path = p_name)
$$;

-- Most files a reporter may have uploaded but not yet submitted (several drafts' worth: 2 sections x (30 photos + 5 videos + 5 posters)
-- is 80 per report). Stops an account filling the bucket with files no report will ever use.
create or replace function private.waste_unsubmitted_object_limit()
returns integer
language sql
immutable
as $$ select 300 $$;

create or replace function private.waste_can_upload_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_me uuid := private.current_waste_reporter_id();
  v_report uuid;
  v_unsubmitted integer;
begin
  -- The name is checked before any part of it is cast.
  if v_me is null or not private.waste_media_object_name_ok(p_name) then
    return false;
  end if;
  if split_part(p_name, '/', 1) <> v_me::text then
    return false;
  end if;
  v_report := split_part(p_name, '/', 2)::uuid;
  if exists (select 1 from public.waste_reports where id = v_report) then
    return false; -- a submitted report never gains files
  end if;
  select count(*) into v_unsubmitted
  from storage.objects o
  where o.bucket_id = 'waste-report-media'
    and o.name like v_me::text || '/%'
    and private.waste_media_object_unreferenced(o.name);
  return v_unsubmitted < private.waste_unsubmitted_object_limit();
end;
$$;

revoke execute on function private.waste_media_object_name_ok(text) from public;
revoke execute on function private.waste_media_object_unreferenced(text) from public;
revoke execute on function private.waste_unsubmitted_object_limit() from public;
revoke execute on function private.waste_can_upload_object(text) from public;
grant execute on function private.waste_media_object_name_ok(text) to authenticated;
grant execute on function private.waste_media_object_unreferenced(text) to authenticated;
grant execute on function private.waste_unsubmitted_object_limit() to authenticated;
grant execute on function private.waste_can_upload_object(text) to authenticated;

-- The reporter: upload only under his own folder, read only his own files, remove only his own files no report uses (a discarded
-- draft). There is no UPDATE policy for anyone, so a stored file is never overwritten in place.
create policy waste_reporter_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'waste-report-media' and private.waste_can_upload_object(name));

create policy waste_reporter_media_select on storage.objects for select to authenticated
  using (
    bucket_id = 'waste-report-media'
    and private.current_waste_reporter_id() is not null
    and split_part(name, '/', 1) = private.current_waste_reporter_id()::text
  );

create policy waste_reporter_unsubmitted_media_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'waste-report-media'
    and private.current_waste_reporter_id() is not null
    and owner_id = auth.uid()::text
    and split_part(name, '/', 1) = private.current_waste_reporter_id()::text
    and private.waste_media_object_unreferenced(name)
  );

-- The manager reads every waste file (to view and play them). No manager insert, update or delete.
create policy manager_waste_media_select on storage.objects for select to authenticated
  using (bucket_id = 'waste-report-media' and private.current_app_role() = 'manager');

-- 5. Submission -------------------------------------------------------------------------------------------------------------------
-- p_media: [{ "id": uuid, "kind": "photo"|"video", "phase": "before"|"after", "storage_path": text, "thumbnail_path": text|null,
--             "sort_order": int }]
-- Returns { "id": report id, "created": true } for a new report, or "created": false when this reporter had already submitted it.
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

  -- The lock comes BEFORE anything is read, so two submissions of the same report run one after the other and the second one
  -- sees the first one's report (and returns it) instead of acting on what it read before waiting.
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

    -- The server's own check of this file, made after the file was stored (a file replaced since its check does not count).
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
      if v_check.duration_seconds is null or v_check.duration_seconds > 61 then
        raise exception 'A video is longer than 1:00.';
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
