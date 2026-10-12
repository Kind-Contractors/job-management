-- Client video links: REUSE of an existing valid link instead of minting a new one every time a PDF is generated.
--
-- Why this exists. report_video_links stores only the SHA-256 hash of each token (so a database leak yields no usable link), which means a
-- link can never be read back and put into a second PDF. To allow reuse WITHOUT storing anything recoverable, the issuing Edge Function
-- (issue-report-video-links) derives a link's token from its id with an HMAC whose secret lives ONLY in that function's environment
-- (VIDEO_LINK_SECRET) - never in this database. Given a link id it can recompute the same token, compare sha256(token) with the stored
-- hash, and reuse the link; if the secret ever changes the hashes no longer match and fresh links are issued automatically.
--
-- Purely additive: one new column, two new manager-only functions. The existing functions (including manager_issue_report_video_links,
-- which still mints random tokens inside the database) and resolve_report_video_link are NOT changed; links they created keep working
-- ('random' scheme) but are never reused, because their token cannot be recomputed.

alter table public.report_video_links add column token_scheme text not null default 'random';
alter table public.report_video_links add constraint report_video_links_token_scheme_check check (token_scheme in ('random', 'hmac-v1'));
comment on column public.report_video_links.token_scheme is
  '''random'' = token minted inside the database (not recoverable, never reused); ''hmac-v1'' = token derived from the link id by the issuing Edge Function (reusable: it can recompute the token and compare its hash).';

-- What the issuing function needs for one report: every video that is currently SHAREABLE (not removed, its own flag on, the report's
-- include_videos on) and, for each, the best link that can be REUSED - an hmac-v1 link that is not revoked and still has at least
-- p_min_remaining_days of life (so a PDF is never sent with a link about to expire). The stored hash is returned so the function can
-- confirm it can still derive that exact token before reusing it.
create function public.manager_report_video_link_plan(p_report_id uuid, p_min_remaining_days integer default 30)
returns table(video_id uuid, link_id uuid, token_hash bytea, expires_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
#variable_conflict use_column
declare
  v_report reports%rowtype;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.';
  end if;
  if p_min_remaining_days is null or p_min_remaining_days < 0 or p_min_remaining_days > 730 then
    raise exception 'The minimum remaining days must be between 0 and 730.';
  end if;
  select * into v_report from reports where id = p_report_id;
  if not found then raise exception 'Report not found.'; end if;
  if not v_report.include_videos then return; end if;

  return query
    select rv.id, l.id, l.token_hash, l.expires_at
    from report_videos rv
    left join lateral (
      select x.id, x.token_hash, x.expires_at
      from report_video_links x
      where x.video_id = rv.id and x.token_scheme = 'hmac-v1' and x.revoked_at is null
        and x.expires_at > now() + make_interval(days => p_min_remaining_days)
      order by x.expires_at desc, x.created_at desc
      limit 1
    ) l on true
    where rv.visit_id = v_report.visit_id and rv.deleted_at is null and rv.include_in_client_report
    order by rv.phase, rv.sort_order, rv.created_at, rv.id;
end;
$$;

-- Registers NEW links whose tokens the issuing function derived itself. The caller supplies, per link, a fresh uuid, the video and the
-- SHA-256 (hex) of the token; the token itself never reaches the database. Only a manager, only for videos that are shareable right now
-- on this report. Does not touch the report (no status, completion or send fields).
create function public.manager_register_report_video_links(p_report_id uuid, p_links jsonb, p_valid_days integer default 365)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare
  v_report reports%rowtype;
  v_actor text := private.current_actor_name();
  v_item jsonb;
  v_video report_videos%rowtype;
  v_id uuid;
  v_hash bytea;
  n integer := 0;
begin
  if private.current_app_role() is distinct from 'manager' then
    raise exception 'Not authorized.';
  end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 730 then
    raise exception 'Links must be valid for between 1 and 730 days.';
  end if;
  if p_links is null or jsonb_typeof(p_links) <> 'array' then
    raise exception 'The links must be a list.';
  end if;
  if jsonb_array_length(p_links) > 20 then
    raise exception 'Too many links in one request.';
  end if;
  select * into v_report from reports where id = p_report_id;
  if not found then raise exception 'Report not found.'; end if;
  if not v_report.include_videos then raise exception 'Videos are switched off for this report.'; end if;

  for v_item in select * from jsonb_array_elements(p_links) loop
    if (v_item ->> 'token_hash') is null or (v_item ->> 'token_hash') !~ '^[0-9a-f]{64}$' then
      raise exception 'A link has an invalid token hash.';
    end if;
    if (v_item ->> 'id') is null or (v_item ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'A link has an invalid id.';
    end if;
    if (v_item ->> 'video_id') is null or (v_item ->> 'video_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'A link has an invalid video id.';
    end if;
    v_id := (v_item ->> 'id')::uuid;
    v_hash := decode(v_item ->> 'token_hash', 'hex');
    select * into v_video from report_videos where id = (v_item ->> 'video_id')::uuid;
    if not found or v_video.visit_id <> v_report.visit_id or v_video.deleted_at is not null or not v_video.include_in_client_report then
      raise exception 'A video is not available to share on this report.';
    end if;
    insert into report_video_links (id, video_id, token_hash, expires_at, created_by, token_scheme)
    values (v_id, v_video.id, v_hash, now() + make_interval(days => p_valid_days), v_actor, 'hmac-v1');
    n := n + 1;
  end loop;

  if n > 0 then
    insert into activity_events (entity_type, entity_id, event_type, detail, actor, occurred_at)
    values ('report', p_report_id, 'report_video_links_issued', n || ' link(s), valid ' || p_valid_days || ' days', v_actor, now());
  end if;
  return n;
end;
$$;

revoke execute on function public.manager_report_video_link_plan(uuid, integer) from public, anon;
grant execute on function public.manager_report_video_link_plan(uuid, integer) to authenticated, service_role;
revoke execute on function public.manager_register_report_video_links(uuid, jsonb, integer) from public, anon;
grant execute on function public.manager_register_report_video_links(uuid, jsonb, integer) to authenticated, service_role;
