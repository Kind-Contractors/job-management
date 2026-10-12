-- Deactivated technician logins must not be treated as technicians.
--
-- THE PROBLEM. private.current_technician_id() returned the technician linked to the signed-in login WITHOUT looking
-- at whether that login is still active. Three existing functions guard themselves with
--     if private.current_app_role() <> 'technician' or v_technician_id is null then raise ... end if;
-- For a deactivated login current_app_role() is NULL, so `NULL <> 'technician'` is NULL, `NULL OR false` is NULL, and an
-- IF on NULL does not raise: the call carried on, because the id was still returned. Confirmed on DEV: a login
-- deactivated exactly as the admin screen does it (app_users.is_active = false) could still call
--   technician_submit_report, technician_resubmit_report and technician_delete_photo
-- for the visits it was already assigned to. (Every read function, the storage policies and the activity function were
-- already safe.) The admin screen does not revoke the person's session, so their token keeps working.
--
-- THE FIX. One helper, nothing else. The id is now returned only while the linked login (app_users) is active, so the
-- existing `or v_technician_id is null` condition in those three functions - and in every other caller - now fires.
-- The bodies of those functions are NOT edited (no copy-drift risk). A technician whose login is active gets exactly
-- the same answer as before; a missing or inactive login now gets NULL, the same as "not a technician".
--
-- Callers reviewed before writing this (all run in technician context): the technician_* functions (today / upcoming /
-- past / day items / shared visits / visit detail / needs correction / whoami / my photos / submit / resubmit / delete
-- photo / set activity done), private.is_visit_participant's callers, private.visit_belongs_to_current_technician,
-- private.technician_photos_editable, private.technician_submitted_photos_deletable and, through them, the storage
-- policies for visit-photos and report-videos. No trigger, view or column default uses it.
--
-- CREATE OR REPLACE keeps the existing privileges (unchanged on purpose).
create or replace function private.current_technician_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select t.id
  from public.technicians t
  join public.app_users a on a.id = t.app_user_id
  where t.app_user_id = auth.uid() and a.is_active
$$;
