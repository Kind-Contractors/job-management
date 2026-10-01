-- Technician photo deletion.
-- Lets a technician delete a photo they uploaded - but only their OWN photos, and only
-- while their part of the report is still editable. Enforced here, not just in the app.
--
-- How photos work (so the two cases below make sense):
--  * An uploaded photo is a Storage object (visit-photos/<visit>/<phase>/<uuid>.<ext>,
--    owner_id = the uploading login). It has NO row in public.photos until the report
--    (or the technician contribution) is SUBMITTED - the submit RPC creates the rows.
--  * So "delete an uploaded photo before submitting" = delete the Storage object. That has
--    to go through the Storage API (a raw SQL delete leaves the file behind), which is
--    governed by the Storage policy added below.
--  * "Delete a photo that is already part of a report" is only allowed while the
--    technician's part has been RETURNED for correction. Technicians have no table
--    access, so that is a small SECURITY DEFINER function; the app then removes the file
--    through the Storage API (the policy allows it once the row is gone).

-- 1. Can the current technician still change the photos they upload for this visit?
create function private.technician_photos_editable(p_visit_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select case
      when r.id is null then true   -- nothing submitted yet by anyone
      when exists (select 1 from report_contributions x where x.report_id = r.id)
        or exists (select 1 from visit_technicians vt where vt.visit_id = v.id)
      then r.review_status <> 'approved'   -- shared visit: locked once THIS technician submitted (and not sent back), or once approved
        and not exists (select 1 from report_contributions rc where rc.report_id = r.id
          and rc.technician_id = private.current_technician_id() and rc.submitted_at is not null and not rc.needs_correction)
      else v.technician_id = private.current_technician_id() and r.review_status = 'returned_for_correction'   -- single-technician report
    end
    from visits v left join reports r on r.visit_id = v.id
    where v.id = p_visit_id and private.is_visit_participant(v.id, private.current_technician_id())
  ), false)
$$;

-- 2. May this (unreferenced) Storage object be removed by the current technician? (used by the Storage policy)
create function private.technician_can_remove_photo_object(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select case
    when (storage.foldername(p_name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then private.technician_photos_editable(((storage.foldername(p_name))[1])::uuid)
         and not exists (select 1 from photos p where p.storage_path = p_name)
    else false
  end
$$;

-- 3. Are the current technician's already-submitted photos on this report deletable right now? (only when returned for correction)
create function private.technician_submitted_photos_deletable(p_report_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select case
    when exists (select 1 from report_contributions where report_id = p_report_id)
    then exists (select 1 from report_contributions rc where rc.report_id = p_report_id
      and rc.technician_id = private.current_technician_id() and rc.needs_correction)
    else exists (select 1 from reports r join visits v on v.id = r.visit_id where r.id = p_report_id
      and v.technician_id = private.current_technician_id() and r.review_status = 'returned_for_correction')
  end
$$;

revoke execute on function private.technician_photos_editable(uuid) from public, anon, authenticated;
revoke execute on function private.technician_submitted_photos_deletable(uuid) from public, anon, authenticated;
revoke execute on function private.technician_can_remove_photo_object(text) from public, anon;
grant execute on function private.technician_can_remove_photo_object(text) to authenticated;  -- called from a Storage RLS policy

-- 4. Storage policy: delete only an object the technician UPLOADED, in a visit they are on,
--    not part of a submitted report, while their part is still editable.
create policy technician_own_unsubmitted_photos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'visit-photos'
    and private.current_app_role() = 'technician'
    and owner_id = auth.uid()::text
    and private.technician_can_remove_photo_object(name)
  );

-- 5. The technician's OWN photos already in the report for a visit (shown in correction mode) + whether each can be deleted now.
create function public.technician_my_photos(p_visit_id uuid)
returns table(storage_path text, phase photo_phase, can_delete boolean)
language sql stable security definer set search_path to 'public' as $$
  select p.storage_path, p.phase, private.technician_submitted_photos_deletable(r.id)
  from photos p join reports r on r.id = p.report_id join visits v on v.id = r.visit_id
  where private.current_app_role() = 'technician' and v.id = p_visit_id
    and private.is_visit_participant(v.id, private.current_technician_id())
    and (case when exists (select 1 from report_contributions rc where rc.report_id = r.id)
         then p.technician_id = private.current_technician_id()
         else v.technician_id = private.current_technician_id() and (p.technician_id is null or p.technician_id = private.current_technician_id())
         end)
  order by p.uploaded_at, p.id
$$;

-- 6. Removes the DATABASE record of one of the technician's OWN submitted photos, only while their part
--    is returned for correction. The app then removes the file through the Storage API.
create function public.technician_delete_photo(p_storage_path text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_me uuid; v_visit uuid; v_matches int; v_photo photos%rowtype; v_report reports%rowtype; v_primary uuid; v_contribution_mode boolean;
begin
  v_me := private.current_technician_id();
  if private.current_app_role() <> 'technician' or v_me is null then raise exception 'Not authorized.'; end if;
  -- Only to learn WHICH visit to lock: this reads no photo data and decides nothing.
  select r.visit_id into v_visit from photos p join reports r on r.id = p.report_id where p.storage_path = p_storage_path limit 1;
  if v_visit is null then raise exception 'Photo not found.'; end if;
  -- Same per-visit lock as submit / resubmit, taken BEFORE the photo is read, so nothing below can be stale.
  perform pg_advisory_xact_lock(hashtextextended('report:' || v_visit::text, 0));
  -- Re-read after the lock. photos.storage_path is not unique: if more than one row uses this path the
  -- deletion would be ambiguous, so refuse (never delete several rows, never just the first match).
  select count(*) into v_matches from photos where storage_path = p_storage_path;
  if v_matches = 0 then raise exception 'Photo not found.'; end if;
  if v_matches > 1 then
    raise exception 'This photo cannot be removed automatically because more than one record uses the same file. Please ask the office.';
  end if;
  select * into v_photo from photos where storage_path = p_storage_path for update;
  if not found then raise exception 'Photo not found.'; end if;
  select * into v_report from reports where id = v_photo.report_id;
  select technician_id into v_primary from visits where id = v_report.visit_id;
  v_contribution_mode := exists (select 1 from report_contributions where report_id = v_report.id);
  if v_contribution_mode then
    if v_photo.technician_id is distinct from v_me then raise exception 'You can only remove your own photos.'; end if;
  else
    if v_primary is distinct from v_me or (v_photo.technician_id is not null and v_photo.technician_id <> v_me) then
      raise exception 'You can only remove your own photos.';
    end if;
  end if;
  if not private.technician_submitted_photos_deletable(v_report.id) then
    raise exception 'A photo that is already part of the report can only be removed while your part is returned for correction.';
  end if;
  delete from photos where id = v_photo.id;
  insert into activity_events (entity_type, entity_id, event_type, actor, occurred_at)
  select 'report', v_report.id, 'report_photo_removed', name, now() from technicians where id = v_me;
end;
$$;

revoke execute on function public.technician_my_photos(uuid) from public, anon;
grant execute on function public.technician_my_photos(uuid) to authenticated, service_role;
revoke execute on function public.technician_delete_photo(text) from public, anon;
grant execute on function public.technician_delete_photo(text) to authenticated, service_role;
