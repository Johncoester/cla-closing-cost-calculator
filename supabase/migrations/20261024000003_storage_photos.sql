-- =====================================================================
-- CLA Quote Portal: private photo bucket + storage policies
-- Migration 3 of 4.   [SUPABASE] storage schema (storage.buckets / storage.objects)
--
-- Bucket 'avatars': PRIVATE, JPEG/PNG only, 2 MB max (enforced here AND by
-- the client-side check). One file per person at  <user uuid>/avatar
-- (re-upload replaces it). Photos are viewed through short-lived signed URLs.
-- Who can read: the owner, super admin, and the owner's assigned rep/client.
-- Who can write: the owner, in their own folder only. Delete: owner or admin.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg', 'image/png'];

drop policy if exists avatars_select on storage.objects;
create policy avatars_select on storage.objects
  for select to authenticated using (
    bucket_id = 'avatars' and private.is_active() and (
      (storage.foldername(name))[1] = auth.uid()::text
      or private.is_admin()
      or private.are_paired(auth.uid(), (storage.foldername(name))[1])));

drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'avatars' and private.is_active()
    and name = auth.uid()::text || '/avatar');

drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects
  for update to authenticated
  using      (bucket_id = 'avatars' and private.is_active() and name = auth.uid()::text || '/avatar')
  with check (bucket_id = 'avatars' and private.is_active() and name = auth.uid()::text || '/avatar');

drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'avatars' and private.is_active() and (
      (storage.foldername(name))[1] = auth.uid()::text or private.is_admin()));
