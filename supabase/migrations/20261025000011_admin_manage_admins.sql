-- =====================================================================
-- CLA Quote Portal: an ADMIN may now also manage OTHER ADMINS
-- Migration 11 (new file; migrations 1-10 are live and untouched). Safe to run twice. Plain transaction, no enum changes.
--
-- RULE CHANGE (migration 10 -> 11)
--   BEFORE  an admin could act only on reps and clients.
--   NOW     an admin can act on reps, clients AND OTHER ADMINS:
--             disable / re-enable another admin, change another admin's role DOWN to rep or client,
--             edit another admin's profile fields, remove another admin's photo, reassign (unchanged).
--   STILL REFUSED for an admin (super admin only, exactly as before):
--             * touching a super admin in ANY way (status, role, profile, photo)
--             * promoting anybody to admin or super admin (any role change whose NEW role is admin / super_admin)
--             * inviting an admin or super admin (create_invitation: unchanged, not touched here)
--             * switching "also works as a rep" for an admin (admin_set_is_rep: unchanged, not touched here)
--             * disabling or changing themselves (unchanged self rules), and nobody may remove the last active super admin
--   Super admin powers: unchanged.
--
-- WHAT THIS FILE REPLACES (CREATE OR REPLACE, same signatures; every policy that calls can_manage_user follows automatically)
--   private.can_manage_user(uuid)   admin: rep / client / ADMIN targets (was: rep / client)
--   public.admin_set_role           admin: target may be an admin; new role must still be rep or client
--   public.admin_set_status         admin: target may be an admin
--   (profiles_update_admin, photos_delete and avatars_delete keep their definitions: they call can_manage_user.)
-- =====================================================================

-- may the caller change THIS person (edit their profile, remove their photo)?
--   super admin: anyone.   admin: reps, clients and other admins, never a super admin.
create or replace function private.can_manage_user(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_super_admin()
      or (private.is_admin() and exists (select 1 from public.profiles t where t.id = target and t.role in ('rep', 'client', 'admin')))
$$;

-- change a role (never a direct UPDATE).
--   super admin: any role for anyone, except their own, and never leaving zero active super admins
--   admin:       the target must currently be a rep, a client or an admin (never a super admin) and the NEW role
--                must be rep or client: an admin can demote an admin, never promote anybody to admin / super admin
create or replace function public.admin_set_role(p_user uuid, p_role public.user_role)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'you cannot change your own role' using errcode = '42501'; end if;
  if p_role is null then raise exception 'role is required' using errcode = '22023'; end if;
  select * into t from public.profiles where id = p_user;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  if not private.is_super_admin() then
    if t.role = 'super_admin' then
      raise exception 'only a super admin can change the role of a super admin' using errcode = '42501';
    end if;
    if p_role not in ('rep', 'client') then
      raise exception 'only a super admin can make someone an admin or super admin' using errcode = '42501';
    end if;
  end if;
  if t.role = 'super_admin' and p_role <> 'super_admin' and t.status = 'active' and not private.other_active_super_admin(p_user) then
    raise exception 'there must always be at least one active super admin' using errcode = '55000';
  end if;
  update public.profiles set role = p_role where id = p_user;
  perform private.audit('role_changed', 'profile', p_user, jsonb_build_object('before', t.role, 'after', p_role));
end $$;

-- disable / re-enable (the set-user-status Edge Function ALSO bans the auth user after this succeeds).
--   super admin: anyone except themselves; never the last active super admin
--   admin:       reps, clients and other admins (never a super admin, never themselves)
create or replace function public.admin_set_status(p_user uuid, p_status public.user_status)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'you cannot disable yourself' using errcode = '42501'; end if;
  if p_status is null then raise exception 'status is required' using errcode = '22023'; end if;
  select * into t from public.profiles where id = p_user;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  if not private.is_super_admin() and t.role = 'super_admin' then
    raise exception 'only a super admin can disable or re-enable a super admin' using errcode = '42501';
  end if;
  if t.role = 'super_admin' and t.status = 'active' and p_status = 'disabled' and not private.other_active_super_admin(p_user) then
    raise exception 'there must always be at least one active super admin' using errcode = '55000';
  end if;
  update public.profiles set status = p_status where id = p_user;
  perform private.audit(case when p_status = 'disabled' then 'user_disabled' else 'user_enabled' end,
    'profile', p_user, jsonb_build_object('before', t.status, 'after', p_status));
end $$;

-- privileges: same as migration 10 (CREATE OR REPLACE keeps existing grants, restated so this file stands alone)
revoke execute on function private.can_manage_user(uuid) from public, anon, authenticated;
grant  execute on function private.can_manage_user(uuid) to authenticated;    -- called from RLS policies
revoke execute on function public.admin_set_role(uuid, public.user_role), public.admin_set_status(uuid, public.user_status) from public, anon;
grant  execute on function public.admin_set_role(uuid, public.user_role), public.admin_set_status(uuid, public.user_status) to authenticated;
