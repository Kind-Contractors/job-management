-- Waste reports, the manager's side: mark / unmark as sent to the client, archive / restore (each recorded with who and when, and as an
-- event in the report's history), and secure shareable links for the report's videos that work without a JMS login.
--
-- ISOLATION FROM JOB-REPORT VIDEO LINKS. Waste links have their own table (waste_video_links), their own issue / plan / register /
-- resolve functions, their own Edge Functions (issue-waste-video-links, watch-waste-video), their own token prefix and secret
-- (WASTE_VIDEO_LINK_SECRET), and they only ever resolve to files in the waste-report-media bucket. Nothing in report_video_links,
-- resolve_report_video_link or watch-report-video is touched, and a token from one system can never open a file of the other.
--
-- The links follow the same design as the job-report ones (docs/client-video-links.md): the database stores only sha256(token); the
-- token is HMAC(secret, prefix + link id) made in the Edge Function, so a database leak yields no usable link and the same video keeps
-- the same link across PDF downloads. Links last 365 days (agreed). ARCHIVING A REPORT DOES NOT STOP ITS LINKS: a client may still hold
-- the PDF, and archived reports remain fully retrievable.

-- 1. Who marked / archived, as well as their display name and the time -----------------------------------------------------------
alter table public.waste_reports add column sent_to_client_by_user_id uuid;
alter table public.waste_reports add column archived_by_user_id uuid;
create index waste_reports_unsent_idx on public.waste_reports (submitted_at desc) where sent_to_client_at is null and archived_at is null;

-- The calling manager's name for the record (display name, else email).
create or replace function private.current_manager_label()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(nullif(btrim(a.display_name), ''), u.email, 'Manager')
  from public.app_users a left join auth.users u on u.id = a.id
  where a.id = auth.uid()
$$;
revoke execute on function private.current_manager_label() from public;
grant execute on function private.current_manager_label() to authenticated;

-- 2. Mark as sent / unmark ---------------------------------------------------------------------------------------------------------
-- Repeating the same action (a double click, two tabs) changes nothing and records nothing.
create or replace function public.manager_waste_set_sent(p_report_id uuid, p_sent boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.waste_reports%rowtype;
  v_by text;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.';
  end if;
  if p_sent is null then
    raise exception 'Say whether the report was sent.';
  end if;
  select * into v_row from public.waste_reports where id = p_report_id for update;
  if not found then
    raise exception 'This waste report does not exist.';
  end if;
  v_by := private.current_manager_label();

  if p_sent and v_row.sent_to_client_at is null then
    update public.waste_reports
    set sent_to_client_at = now(), sent_to_client_by = v_by, sent_to_client_by_user_id = auth.uid()
    where id = p_report_id;
    insert into public.waste_report_events (waste_report_id, event_type, actor, actor_user_id) values (p_report_id, 'marked_sent', v_by, auth.uid());
  elsif not p_sent and v_row.sent_to_client_at is not null then
    update public.waste_reports
    set sent_to_client_at = null, sent_to_client_by = null, sent_to_client_by_user_id = null
    where id = p_report_id;
    insert into public.waste_report_events (waste_report_id, event_type, actor, actor_user_id) values (p_report_id, 'unmarked_sent', v_by, auth.uid());
  end if;

  return (select jsonb_build_object('sent_to_client_at', sent_to_client_at, 'sent_to_client_by', sent_to_client_by)
          from public.waste_reports where id = p_report_id);
end;
$$;

-- 3. Archive / restore (an archived report stays readable, searchable and its video links keep working) --------------------------------
create or replace function public.manager_waste_set_archived(p_report_id uuid, p_archived boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.waste_reports%rowtype;
  v_by text;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.';
  end if;
  if p_archived is null then
    raise exception 'Say whether to archive the report.';
  end if;
  select * into v_row from public.waste_reports where id = p_report_id for update;
  if not found then
    raise exception 'This waste report does not exist.';
  end if;
  v_by := private.current_manager_label();

  if p_archived and v_row.archived_at is null then
    update public.waste_reports set archived_at = now(), archived_by = v_by, archived_by_user_id = auth.uid() where id = p_report_id;
    insert into public.waste_report_events (waste_report_id, event_type, actor, actor_user_id) values (p_report_id, 'archived', v_by, auth.uid());
  elsif not p_archived and v_row.archived_at is not null then
    update public.waste_reports set archived_at = null, archived_by = null, archived_by_user_id = null where id = p_report_id;
    insert into public.waste_report_events (waste_report_id, event_type, actor, actor_user_id) values (p_report_id, 'restored', v_by, auth.uid());
  end if;

  return (select jsonb_build_object('archived_at', archived_at, 'archived_by', archived_by) from public.waste_reports where id = p_report_id);
end;
$$;

revoke execute on function public.manager_waste_set_sent(uuid, boolean) from public, anon;
revoke execute on function public.manager_waste_set_archived(uuid, boolean) from public, anon;
grant execute on function public.manager_waste_set_sent(uuid, boolean) to authenticated;
grant execute on function public.manager_waste_set_archived(uuid, boolean) to authenticated;

-- 4. Shareable video links -----------------------------------------------------------------------------------------------------------
create table public.waste_video_links (
  id uuid primary key,
  media_id uuid not null references public.waste_report_media(id) on delete restrict,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  constraint waste_video_links_hash_check check (octet_length(token_hash) = 32),
  constraint waste_video_links_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '731 days')
);
create index waste_video_links_media_idx on public.waste_video_links (media_id, expires_at desc);

alter table public.waste_video_links enable row level security;
revoke all on public.waste_video_links from anon, authenticated;
grant select on public.waste_video_links to authenticated;
create policy manager_read on public.waste_video_links for select to authenticated
  using (private.current_app_role() = 'manager');

-- For each video of the report (Before first, then After, in order): its newest link that is still usable for at least
-- p_min_remaining_days, or null - the issuing function then re-derives that link's token, or creates a new link.
create or replace function public.manager_waste_video_link_plan(p_report_id uuid, p_min_remaining_days integer default 30)
returns table(video_id uuid, link_id uuid, token_hash bytea, expires_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select m.id, l.id, l.token_hash, l.expires_at
  from public.waste_report_media m
  left join lateral (
    select x.id, x.token_hash, x.expires_at
    from public.waste_video_links x
    where x.media_id = m.id and x.revoked_at is null
      and x.expires_at > now() + make_interval(days => greatest(coalesce(p_min_remaining_days, 30), 0))
    order by x.expires_at desc
    limit 1
  ) l on true
  where private.current_app_role() = 'manager'
    and m.waste_report_id = p_report_id
    and m.kind = 'video'
  order by (m.phase = 'after'), m.sort_order, m.id
$$;

-- p_links: [{ "id": uuid, "video_id": uuid, "token_hash": 64 hex chars }]
create or replace function public.manager_register_waste_video_links(p_report_id uuid, p_links jsonb, p_valid_days integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item jsonb;
  v_count integer := 0;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.';
  end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 730 then
    raise exception 'A link must last between 1 and 730 days.';
  end if;
  if p_links is null or jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) > 20 then
    raise exception 'Invalid list of links.';
  end if;
  for v_item in select * from jsonb_array_elements(p_links) loop
    if (v_item->>'token_hash') is null or (v_item->>'token_hash') !~ '^[0-9a-f]{64}$' then
      raise exception 'Invalid link.';
    end if;
    if not exists (
      select 1 from public.waste_report_media
      where id = (v_item->>'video_id')::uuid and waste_report_id = p_report_id and kind = 'video'
    ) then
      raise exception 'A video is not part of this report.';
    end if;
    insert into public.waste_video_links (id, media_id, token_hash, expires_at)
    values ((v_item->>'id')::uuid, (v_item->>'video_id')::uuid, decode(v_item->>'token_hash', 'hex'), now() + make_interval(days => p_valid_days));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Used only by the public watch-waste-video function (service role). A link resolves while it is not revoked and not expired, to its
-- video in the waste bucket - whether or not the report is archived. Counts the open (informational only).
create or replace function public.resolve_waste_video_link(p_token_hash bytea)
returns table(storage_path text, mime_type text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_link public.waste_video_links%rowtype;
begin
  select * into v_link from public.waste_video_links where token_hash = p_token_hash;
  if not found or v_link.revoked_at is not null or v_link.expires_at <= now() then
    return;
  end if;
  update public.waste_video_links set open_count = open_count + 1, last_opened_at = now() where id = v_link.id;
  return query
    select m.storage_path, m.mime_type
    from public.waste_report_media m
    where m.id = v_link.media_id and m.kind = 'video';
end;
$$;

revoke execute on function public.manager_waste_video_link_plan(uuid, integer) from public, anon;
revoke execute on function public.manager_register_waste_video_links(uuid, jsonb, integer) from public, anon;
grant execute on function public.manager_waste_video_link_plan(uuid, integer) to authenticated;
grant execute on function public.manager_register_waste_video_links(uuid, jsonb, integer) to authenticated;
revoke execute on function public.resolve_waste_video_link(bytea) from public, anon, authenticated;
grant execute on function public.resolve_waste_video_link(bytea) to service_role;
