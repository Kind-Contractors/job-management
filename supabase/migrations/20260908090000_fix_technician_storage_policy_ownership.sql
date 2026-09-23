-- Fixes a real, previously-undetected bug found during the live E2E test:
-- the two technician Storage policies checked ownership via a direct
-- `EXISTS (SELECT 1 FROM visits ...)` — but Storage RLS predicates run
-- under the CALLING role's own privileges, not SECURITY DEFINER, so a
-- technician session (which has no RLS grant on `visits` at all — only
-- manager_full_access exists) saw zero rows there, making the check always
-- false, even for the technician's own visit. Confirmed live: the identical
-- query returned true for the manager identity and false for the
-- technician identity on the very same row.
--
-- Fix: a new SECURITY DEFINER helper, mirroring current_technician_id()'s
-- own pattern exactly, so ownership is verified with elevated privilege
-- (bypassing visits' RLS safely, the same way current_technician_id()
-- already bypasses technicians'/app_users' RLS) — without adding any RLS
-- policy to visits itself, and without broadening any technician table
-- grant.

create or replace function private.visit_belongs_to_current_technician(p_visit_id_text text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from visits v
    where v.id::text = p_visit_id_text
      and v.technician_id = private.current_technician_id()
  )
$$;

drop policy if exists technician_own_visit_photos_insert on storage.objects;
create policy technician_own_visit_photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'visit-photos'
    and private.current_app_role() = 'technician'
    and private.visit_belongs_to_current_technician((storage.foldername(name))[1])
  );

drop policy if exists technician_own_visit_photos_select on storage.objects;
create policy technician_own_visit_photos_select on storage.objects for select to authenticated
  using (
    bucket_id = 'visit-photos'
    and private.current_app_role() = 'technician'
    and private.visit_belongs_to_current_technician((storage.foldername(name))[1])
  );
