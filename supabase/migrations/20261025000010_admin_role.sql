-- =====================================================================
-- CLA Quote Portal: new role "admin" (part 2 of 2: rules, policies, RPCs)
-- Migration 10 (new file; migrations 1-9 are untouched). Safe to run twice.
-- Needs migration 9 (the enum value) to have been committed first; see the note in that file.
--
-- WHAT AN "ADMIN" IS
--   Sees and does everything a super admin does in the dashboard (all users, all quotes, assignments,
--   audit log, invitations, reassigning clients) but only to REPS and CLIENTS. An admin can never create,
--   change, disable or demote an admin or a super admin, and cannot touch their own role or status.
--   Only a super admin can do those things. (Full matrix: portal/README.md, "Roles".)
--
-- HOW (one place per idea, so nothing drifts)
--   private.is_admin()          "may use the admin dashboard": super_admin OR admin (+ the MFA switch, as before).
--                               Every existing admin RLS policy calls this, so they keep working unchanged.
--   private.is_super_admin()    NEW. super_admin only (+ the same MFA switch). Gates the privileged RPCs.
--   private.can_manage_user(id) NEW. "may this caller change THAT person": a super admin anyone; an admin
--                               only reps and clients. Used by the profile-edit policy and the photo/storage
--                               delete policies (an admin cannot edit or delete the photo of a super admin or admin).
--   private.is_rep()            "also works as a rep" now applies to admin as well as super_admin (profiles.is_rep).
--                               Same rules as before: CLA email only, only a super admin can switch it.
--   private.guard_last_super_admin()  NEW trigger: no operation (RPC, SQL editor, service role, a cascade from
--                               deleting the auth user) may leave zero ACTIVE super admins.
-- Roles in the policies of migrations 2 and 3 that say private.is_admin() therefore mean "super admin or admin".
-- Places that compared role = 'super_admin' directly (migrations 5 and 6) were reviewed: is_rep, rep_of,
-- assignments_before, quotes_set_expiry, handle_new_user, profiles.is_complete and the rep triggers all key off
-- the flag (is_rep), not the role text, so an admin who also reps needs no change there.
-- =====================================================================

-- ---------- 1. constraints that listed the admin roles ----------
-- "also works as a rep" can be set on both admin roles; a client never, a rep always (trigger keeps it so).
alter table public.profiles drop constraint if exists profiles_is_rep_role;
alter table public.profiles add constraint profiles_is_rep_role
  check ((role = 'client' and not is_rep) or (role = 'rep' and is_rep) or role in ('super_admin', 'admin'));
alter table public.invitations drop constraint if exists invitations_is_rep_role;
alter table public.invitations add constraint invitations_is_rep_role
  check ((role = 'client' and not is_rep) or (role = 'rep' and is_rep) or role in ('super_admin', 'admin'));
-- (profiles_rep_cla_email / invitations_rep_cla_email already key off is_rep, so an admin who also reps needs @clatitle.com)

-- ---------- 2. the helpers ----------
-- "may use the admin dashboard": super admin or admin. With app_settings.require_admin_mfa = 'true' also needs aal2.
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() in ('super_admin', 'admin'), false)
     and (
       coalesce((select value from public.app_settings where key = 'require_admin_mfa'), 'false') <> 'true'
       or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     )
$$;

-- super admin only (same MFA switch)
create or replace function private.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() = 'super_admin', false)
     and (
       coalesce((select value from public.app_settings where key = 'require_admin_mfa'), 'false') <> 'true'
       or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     )
$$;

-- may the caller change THIS person (edit their profile, remove their photo)?  super admin: anyone.
-- admin: reps and clients only. (Their own row is covered by the "self" policies, not by this.)
create or replace function private.can_manage_user(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_super_admin()
      or (private.is_admin() and exists (select 1 from public.profiles t where t.id = target and t.role in ('rep', 'client')))
$$;
-- same, for a storage folder name (text): anything that is not a uuid is simply "no"
create or replace function private.can_manage_user_text(target text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then private.can_manage_user(target::uuid) else false end
$$;

-- "is a rep": a rep, or an admin / super admin with the also-works-as-a-rep switch on
create or replace function private.is_rep() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.role = 'rep' or (p.role in ('super_admin', 'admin') and p.is_rep)
       from public.profiles p where p.id = auth.uid() and p.status = 'active'),
    false)
$$;

-- ---------- 3. policies: where an admin must NOT act on a more privileged person ----------
-- profile edits (names, phones, company fields; role/status/email/is_rep are not in the column grant anyway)
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (private.can_manage_user(id)) with check (private.can_manage_user(id));

-- moderation: removing someone's photo
drop policy if exists photos_delete on public.photos;
create policy photos_delete on public.photos
  for delete to authenticated using (
    private.is_active() and (owner_id = auth.uid() or private.can_manage_user(owner_id)));
drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'avatars' and private.is_active() and (
      (storage.foldername(name))[1] = auth.uid()::text or private.can_manage_user_text((storage.foldername(name))[1])));
-- Everything else that said private.is_admin() (read all profiles / invitations / assignments / photos / quotes / audit log,
-- write assignments, delete quotes, read storage) is intentionally open to an admin: it is the "full dashboard".
-- public.app_settings has no API grants at all, so settings stay with whoever has SQL / dashboard access (see README).

-- ---------- 4. the last-active-super-admin guard (trigger = covers every path) ----------
create or replace function private.guard_last_super_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'super_admin' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'super_admin' or new.status <> 'active') then
    -- serialize concurrent demotions: two super admins disabling each other at the same moment must not both succeed
    perform pg_advisory_xact_lock(hashtext('cla.super_admin_guard'));
    if not exists (select 1 from public.profiles p where p.role = 'super_admin' and p.status = 'active' and p.id <> old.id) then
      raise exception 'there must always be at least one active super admin' using errcode = '55000';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists profiles_last_super_admin_trg on public.profiles;
create trigger profiles_last_super_admin_trg before update of role, status or delete on public.profiles
  for each row execute function private.guard_last_super_admin();

-- friendly pre-check used by the RPCs (the trigger above is the real guard)
create or replace function private.other_active_super_admin(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.role = 'super_admin' and p.status = 'active' and p.id <> p_user)
$$;

-- ---------- 5. RPCs ----------
-- change a role (never a direct UPDATE).
--   super admin: any role for anyone, except their own, and never leaving zero active super admins
--   admin:       rep <-> client only, and only for people who are currently a rep or a client
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
    if t.role not in ('rep', 'client') then
      raise exception 'only a super admin can change the role of an admin or super admin' using errcode = '42501';
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
--   admin:       reps and clients only
create or replace function public.admin_set_status(p_user uuid, p_status public.user_status)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'you cannot disable yourself' using errcode = '42501'; end if;
  if p_status is null then raise exception 'status is required' using errcode = '22023'; end if;
  select * into t from public.profiles where id = p_user;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  if not private.is_super_admin() and t.role not in ('rep', 'client') then
    raise exception 'only a super admin can disable or re-enable an admin or super admin' using errcode = '42501';
  end if;
  if t.role = 'super_admin' and t.status = 'active' and p_status = 'disabled' and not private.other_active_super_admin(p_user) then
    raise exception 'there must always be at least one active super admin' using errcode = '55000';
  end if;
  update public.profiles set status = p_status where id = p_user;
  perform private.audit(case when p_status = 'disabled' then 'user_disabled' else 'user_enabled' end,
    'profile', p_user, jsonb_build_object('before', t.status, 'after', p_status));
end $$;

-- "also works as a rep" switch. SUPER ADMIN ONLY, for admins and super admins (reps always are, clients never are).
-- An admin cannot switch it for anyone, including themselves (an admin account is changed only by a super admin).
create or replace function public.admin_set_is_rep(p_user uuid, p_is_rep boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles; n int;
begin
  if not private.is_super_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into t from public.profiles where id = p_user;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  if t.role not in ('super_admin', 'admin') then
    raise exception 'only an admin or super admin can be switched: reps are always reps and clients never are' using errcode = '23514';
  end if;
  if p_is_rep is null then raise exception 'p_is_rep is required' using errcode = '22023'; end if;
  if p_is_rep and t.email not like '%@clatitle.com' then
    raise exception 'reps must use an @clatitle.com email' using errcode = '23514';
  end if;
  if t.is_rep = p_is_rep then return; end if;
  if not p_is_rep then
    select count(*) into n from public.assignments a where a.rep_id = p_user and a.active;
    if n > 0 then
      raise exception 'reassign this person''s % active client(s) before switching rep access off', n using errcode = '55006';
    end if;
  end if;
  update public.profiles set is_rep = p_is_rep where id = p_user;
  perform private.audit('rep_flag_changed', 'profile', p_user, jsonb_build_object('before', t.is_rep, 'after', p_is_rep));
end $$;

-- invite. Same signature as migration 6 (so CREATE OR REPLACE swaps it in place; no overloads).
--   super admin: any role (super_admin, admin, rep, client); p_is_rep for the two admin roles
--   admin:       rep and client only (never super_admin or admin, and no p_is_rep)
--   rep (or admin/super admin with p_as_rep): clients only, assigned to themselves
create or replace function public.create_invitation(p_email text, p_role public.user_role, p_rep_id uuid default null,
                                                    p_cell_phone text default null, p_is_rep boolean default false,
                                                    p_as_rep boolean default false)
returns public.invitations
language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(p_email)); inv public.invitations; target_rep uuid; cell text; as_admin boolean;
begin
  if auth.uid() is null or not private.is_active() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_as_rep and not private.is_rep() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  as_admin := private.is_admin() and not coalesce(p_as_rep, false);
  if as_admin then
    if p_role in ('super_admin', 'admin') and not private.is_super_admin() then
      raise exception 'only a super admin can invite an admin or super admin' using errcode = '42501';
    end if;
    target_rep := p_rep_id;
  elsif private.is_rep() then
    if p_role <> 'client' then raise exception 'reps can only invite clients' using errcode = '42501'; end if;
    target_rep := auth.uid();
  else
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(p_is_rep, false) and (not as_admin or p_role not in ('super_admin', 'admin')) then
    raise exception 'only a super admin can invite an admin or super admin who also works as a rep' using errcode = '42501';
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email' using errcode = '22023'; end if;
  if (p_role = 'rep' or coalesce(p_is_rep, false)) and e not like '%@clatitle.com' then
    raise exception 'reps must use an @clatitle.com email' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles where email = e) then
    raise exception 'that email already has an account' using errcode = '23505';
  end if;
  if p_cell_phone is not null and btrim(p_cell_phone) <> '' then
    cell := private.normalize_us_phone(p_cell_phone);
    if cell is null then
      raise exception 'Enter a valid 10-digit US cell phone number, like (240) 555-0142' using errcode = '22023';
    end if;
  end if;

  -- re-inviting replaces a stale pending invitation
  delete from public.invitations where email = e and accepted_at is null;
  insert into public.invitations (email, role, invited_by, cell_phone, is_rep)
  values (e, p_role, auth.uid(), cell,
          p_role = 'rep' or (p_role in ('super_admin', 'admin') and coalesce(p_is_rep, false)))
  returning * into inv;

  if p_role = 'client' and target_rep is not null then
    if exists (select 1 from public.assignments a where a.client_email = e and a.active and a.rep_id <> target_rep)
       and not as_admin then
      raise exception 'that client already belongs to another rep' using errcode = '23505';
    end if;
    if as_admin then
      update public.assignments set active = false where client_email = e and active and rep_id <> target_rep;
    end if;
    insert into public.assignments (client_email, rep_id, assigned_by)
    select e, target_rep, auth.uid()
    where not exists (select 1 from public.assignments a where a.client_email = e and a.active);
  end if;

  perform private.audit('invite_sent', 'invitation', inv.id,
    jsonb_build_object('email', e, 'role', p_role, 'rep_id', target_rep, 'is_rep', inv.is_rep));
  return inv;
end $$;

-- admin_reassign_client, admin_log_quote_view, admin_log_export: unchanged on purpose. They are open to an admin
-- (they act on clients and on the audit trail, not on an admin account), and assignments_before() already refuses
-- anyone who is not rep-capable as the rep.

-- ---------- 6. function privileges (same pattern as migrations 2, 5 and 6) ----------
revoke execute on function private.is_super_admin(), private.can_manage_user(uuid), private.can_manage_user_text(text),
                           private.guard_last_super_admin(), private.other_active_super_admin(uuid)
  from public, anon, authenticated;
grant  execute on function private.is_super_admin(), private.can_manage_user(uuid), private.can_manage_user_text(text)
  to authenticated;      -- called from RLS policies, which run as the logged-in user
revoke execute on function public.admin_set_role(uuid, public.user_role), public.admin_set_status(uuid, public.user_status),
                           public.admin_set_is_rep(uuid, boolean),
                           public.create_invitation(text, public.user_role, uuid, text, boolean, boolean)
  from public, anon;
grant  execute on function public.admin_set_role(uuid, public.user_role), public.admin_set_status(uuid, public.user_status),
                           public.admin_set_is_rep(uuid, boolean),
                           public.create_invitation(text, public.user_role, uuid, text, boolean, boolean)
  to authenticated;
