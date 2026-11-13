-- Waste Reports: device compatibility checks (temporary; user-initiated).
--
-- A waste reporter can run a "Device compatibility check" on his phone (src/waste/DeviceCheckPage.tsx) and, only if he taps "Send",
-- submit ONE small technical report: browser/device facts and the result of saving a 1 KB test file in the app's storage. It holds no
-- report contents, addresses, client details, file names, photos or videos. This is NOT event tracking: nothing is sent automatically.
--
--   * One table, written ONLY by public.waste_submit_device_check() (SECURITY DEFINER). Nobody can read or write the table through
--     the API (RLS on, no policies, all grants revoked); the office reads it with SQL on the database when looking into a problem.
--   * The function: an ACTIVE waste reporter only (private.current_waste_reporter_id, as waste_submit_report); the report must be a
--     JSON object of at most 16 KB, of kind 'waste-device-check', with only the expected top-level keys; who and when are stamped by
--     the database; at most 20 checks per reporter per day.
--   * Retention: checks older than 30 days are deleted on every submission (no scheduler needed); see MIGRATION_README for the manual
--     clean-up, and for removing the feature (rollback).

create table public.waste_device_checks (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.app_users(id) on delete cascade,
  received_at timestamptz not null default now(),
  app_version text not null check (char_length(app_version) between 1 and 64),
  environment text not null check (environment in ('production', 'dev', 'other')),
  check_result jsonb not null check (jsonb_typeof(check_result) = 'object' and octet_length(check_result::text) <= 16384)
);
comment on table public.waste_device_checks is 'Waste Reports device compatibility checks: one row per check a waste reporter chose to send. Written only by waste_submit_device_check(); kept 30 days. No report contents, file names or media.';
alter table public.waste_device_checks enable row level security;
revoke all on table public.waste_device_checks from public, anon, authenticated;

create function public.waste_submit_device_check(p_check jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me uuid := private.current_waste_reporter_id();
  v_allowed text[] := array['kind', 'version', 'appVersion', 'environment', 'checkedAt', 'device', 'browser', 'storage', 'indexedDb', 'lastMediaSaveError'];
  v_key text;
  v_version text;
  v_env text;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
  if p_check is null or jsonb_typeof(p_check) <> 'object' then
    raise exception 'The check is missing.' using errcode = '22023';
  end if;
  if octet_length(p_check::text) > 16384 then
    raise exception 'The check is too large.' using errcode = '22023';
  end if;
  if p_check ->> 'kind' is distinct from 'waste-device-check' then
    raise exception 'This is not a device compatibility check.' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_check) loop
    if not v_key = any (v_allowed) then
      raise exception 'Unexpected field in the check: %', left(v_key, 40) using errcode = '22023';
    end if;
  end loop;
  v_version := nullif(btrim(coalesce(p_check ->> 'appVersion', '')), '');
  if v_version is null or char_length(v_version) > 64 then
    raise exception 'The app version is missing.' using errcode = '22023';
  end if;
  v_env := p_check ->> 'environment';
  if v_env is null or v_env not in ('production', 'dev', 'other') then
    raise exception 'The environment is missing.' using errcode = '22023';
  end if;
  if (select count(*) from public.waste_device_checks where reporter_id = v_me and received_at > now() - interval '1 day') >= 20 then
    raise exception 'Too many checks today. Try again tomorrow.' using errcode = '54000';
  end if;

  insert into public.waste_device_checks (reporter_id, app_version, environment, check_result)
  values (v_me, v_version, v_env, p_check)
  returning id into v_id;

  -- Retention: 30 days.
  delete from public.waste_device_checks where received_at < now() - interval '30 days';

  return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.waste_submit_device_check(jsonb) from public, anon, authenticated;
grant execute on function public.waste_submit_device_check(jsonb) to authenticated;
comment on function public.waste_submit_device_check(jsonb) is 'Waste Reports: stores one device compatibility check the CALLER (an active waste reporter) chose to send; validated, 20 per day, kept 30 days.';
