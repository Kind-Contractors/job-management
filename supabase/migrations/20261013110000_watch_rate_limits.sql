-- Rate limiting for the PUBLIC client video-link endpoint (Edge Function watch-report-video).
--
-- Why in the database. Edge Function instances do not share memory and are recycled at will, so a counter held in the function cannot
-- limit anything reliably (this was tested live: 17 consecutive failures from one address were never throttled). A tiny counter table that
-- every instance reaches through the service role is shared by all of them.
--
-- What it counts, per client address (the key the function derives from the gateway's forwarded header):
--   'req'  - every request,              fixed window (default 60 s)
--   'fail' - requests that found no link, fixed window (default 600 s)
-- The function asks watch_rate_check() BEFORE any lookup; it returns false (=> HTTP 429) when the address has used up either allowance.
-- A failed lookup is then reported with watch_rate_fail(). A valid link never counts as a failure.
--
-- Safety. Purely additive: one table + two functions, nothing existing is touched. The table has RLS on, no policies and no grants to
-- anon/authenticated; the functions are SECURITY DEFINER with a fixed search_path and are executable by service_role ONLY. Keys are
-- length-capped, rows older than an hour are pruned opportunistically, and the function fails OPEN (a database problem never blocks clients).

create table public.watch_rate_limits (
  kind text not null check (kind in ('req', 'fail')),
  key text not null check (char_length(key) between 1 and 64),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  primary key (kind, key, window_start)
);
alter table public.watch_rate_limits enable row level security;
revoke all on table public.watch_rate_limits from public, anon, authenticated;
comment on table public.watch_rate_limits is 'Per-address counters for the public video-link endpoint. Service role only (through watch_rate_check / watch_rate_fail).';

-- Counts one request and answers whether it may proceed: false when the address is over its request allowance for this window OR has
-- already failed p_fail_limit lookups in the failure window.
create function public.watch_rate_check(
  p_key text, p_req_limit integer default 60, p_req_window_seconds integer default 60,
  p_fail_limit integer default 10, p_fail_window_seconds integer default 600
) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare
  v_req_start timestamptz;
  v_fail_start timestamptz;
  v_hits integer;
  v_fails integer;
begin
  if p_key is null or char_length(p_key) not between 1 and 64 then return true; end if;
  if p_req_limit not between 1 and 100000 or p_fail_limit not between 1 and 100000
     or p_req_window_seconds not between 1 and 86400 or p_fail_window_seconds not between 1 and 86400 then
    return true;
  end if;
  v_req_start := to_timestamp(floor(extract(epoch from now()) / p_req_window_seconds) * p_req_window_seconds);
  v_fail_start := to_timestamp(floor(extract(epoch from now()) / p_fail_window_seconds) * p_fail_window_seconds);

  -- Throttled addresses do not keep growing the counter, and an address that is already over its failure allowance is refused first.
  select hits into v_fails from watch_rate_limits where kind = 'fail' and key = p_key and window_start = v_fail_start;
  if coalesce(v_fails, 0) >= p_fail_limit then return false; end if;

  insert into watch_rate_limits (kind, key, window_start, hits) values ('req', p_key, v_req_start, 1)
  on conflict (kind, key, window_start) do update set hits = watch_rate_limits.hits + 1
  returning hits into v_hits;

  if random() < 0.02 then
    delete from watch_rate_limits where window_start < now() - interval '1 hour';
  end if;
  return v_hits <= p_req_limit;
end;
$$;

-- Records one failed lookup for the address.
create function public.watch_rate_fail(p_key text, p_fail_window_seconds integer default 600)
returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_start timestamptz;
begin
  if p_key is null or char_length(p_key) not between 1 and 64 or p_fail_window_seconds not between 1 and 86400 then return; end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_fail_window_seconds) * p_fail_window_seconds);
  insert into watch_rate_limits (kind, key, window_start, hits) values ('fail', p_key, v_start, 1)
  on conflict (kind, key, window_start) do update set hits = watch_rate_limits.hits + 1;
end;
$$;

revoke execute on function public.watch_rate_check(text, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.watch_rate_check(text, integer, integer, integer, integer) to service_role;
revoke execute on function public.watch_rate_fail(text, integer) from public, anon, authenticated;
grant execute on function public.watch_rate_fail(text, integer) to service_role;
