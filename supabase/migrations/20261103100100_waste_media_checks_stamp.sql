-- waste_media_checks.checked_at is always the DATABASE's time of the (latest) check, never a time sent by the writer.
-- waste_submit_report() compares it with storage.objects.created_at (also database time), so both sides use one clock, and a
-- re-check of the same path always moves it forward.
create or replace function private.waste_media_checks_stamp()
returns trigger
language plpgsql
as $$
begin
  new.checked_at := now();
  return new;
end;
$$;
revoke execute on function private.waste_media_checks_stamp() from public;

create trigger waste_media_checks_stamp
  before insert or update on public.waste_media_checks
  for each row execute function private.waste_media_checks_stamp();
