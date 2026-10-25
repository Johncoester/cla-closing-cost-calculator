-- =====================================================================
-- CLA Quote Portal: a super admin who ALSO works as a sales rep
-- Migration 6 (new file; migrations 1-5 are untouched). Safe to run twice.
--
-- Design: `profiles.role` stays exactly as it is (super_admin | rep | client). A new boolean
-- `profiles.is_rep` says "this login can also act as a rep".
--   * role = 'rep'          -> is_rep is always true  (a trigger keeps it so)
--   * role = 'client'       -> is_rep is always false (CHECK + trigger): a client can never be a rep
--   * role = 'super_admin'  -> is_rep is false until a super admin switches it on
-- Only the RPC admin_set_is_rep() (super admin only) or the invitation can set it for a super admin.
-- The column is NOT in the per-column UPDATE grant, so nobody can flip it through the API.
--
-- "Is a rep" is now: role = 'rep'  OR  (role = 'super_admin' AND is_rep). It lives in ONE place,
-- private.is_rep(), which every rep RLS policy and helper already calls, so those need no edits:
--   rep_has_client(), rep_has_client_email(), assignments_select_rep / insert_rep,
--   invitations_select_rep, quotes_select_rep, profiles_select_rep_clients ...
-- This file additionally updates the places that tested the role text directly:
--   private.rep_of() (-> get_my_rep / get_my_rep_contact), private.assignments_before() (who can be a rep),
--   private.quotes_set_expiry() (quote.rep_id for a rep-capable owner), private.handle_new_user(),
--   profiles.is_complete, the @clatitle.com checks, create_invitation().
-- Super admin keeps the admin policies (see everything). Where an admin+rep acts "as a rep"
-- (the rep dashboard, inviting from it) the app passes p_as_rep so the rep rules apply, not the admin ones.
-- If require_admin_mfa is on and the admin is at aal1, is_admin() is false but is_rep() is still true, so
-- that session gets exactly rep-level access (own clients only), never more.
-- =====================================================================

-- ---------- 1. columns, backfill ----------
alter table public.profiles    add column if not exists is_rep boolean not null default false;
alter table public.invitations add column if not exists is_rep boolean not null default false;
update public.profiles    set is_rep = true where role = 'rep' and not is_rep;      -- every existing rep is a rep
update public.invitations set is_rep = true where role = 'rep' and not is_rep;

-- ---------- 2. constraints ----------
alter table public.profiles drop constraint if exists profiles_is_rep_role;
alter table public.profiles add constraint profiles_is_rep_role
  check ((role = 'client' and not is_rep) or (role = 'rep' and is_rep) or role = 'super_admin');
alter table public.invitations drop constraint if exists invitations_is_rep_role;
alter table public.invitations add constraint invitations_is_rep_role
  check ((role = 'client' and not is_rep) or (role = 'rep' and is_rep) or role = 'super_admin');

-- anyone who is a rep (by role or by flag) needs a CLA address
alter table public.profiles drop constraint if exists profiles_rep_cla_email;
alter table public.profiles add constraint profiles_rep_cla_email
  check (not (role = 'rep' or is_rep) or email like '%@clatitle.com');
alter table public.invitations drop constraint if exists invitations_rep_cla_email;
alter table public.invitations add constraint invitations_rep_cla_email
  check (not (role = 'rep' or is_rep) or email like '%@clatitle.com');

-- profile completeness: rep-capable people need a phone (generated column, so it is dropped and re-added once)
do $$ begin
  if not exists (
    select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.profiles'::regclass and a.attname = 'is_complete'
      and pg_get_expr(d.adbin, d.adrelid) like '%is_rep%') then
    alter table public.profiles drop column if exists is_complete;
    alter table public.profiles add column is_complete boolean generated always as (
      length(btrim(first_name)) > 0
      and length(btrim(last_name)) > 0
      and (not (role = 'rep' or is_rep) or length(btrim(coalesce(phone, ''))) > 0)
    ) stored;
  end if;
end $$;

-- audit: one new action
alter table public.audit_log drop constraint if exists audit_action_known;
alter table public.audit_log add constraint audit_action_known check (action in (
  'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
  'export_run', 'profile_created', 'rep_flag_changed'));

-- ---------- 3. keep is_rep consistent with role ----------
create or replace function private.profiles_rep_flag() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.role = 'rep' then new.is_rep := true;          -- reps are always reps
  elsif new.role = 'client' then new.is_rep := false;   -- clients never are
  end if;                                               -- super_admin: keep whatever was set
  return new;
end $$;
drop trigger if exists profiles_rep_flag_trg on public.profiles;
create trigger profiles_rep_flag_trg before insert or update of role, is_rep on public.profiles
  for each row execute function private.profiles_rep_flag();

-- ---------- 4. the one definition of "is a rep" ----------
create or replace function private.is_rep() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.role = 'rep' or (p.role = 'super_admin' and p.is_rep)
       from public.profiles p where p.id = auth.uid() and p.status = 'active'),
    false)
$$;

-- who is this client's rep right now (null if none)
create or replace function private.rep_of(client uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.rep_id from public.assignments a
  join public.profiles r on r.id = a.rep_id and r.status = 'active' and (r.role = 'rep' or r.is_rep)
  where a.active and a.client_user_id = client
  limit 1
$$;

-- ---------- 5. assignments: the rep side must be rep-capable ----------
create or replace function private.assignments_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare rrole public.user_role; risrep boolean; crow public.profiles;
begin
  select p.role, p.is_rep into rrole, risrep from public.profiles p where p.id = new.rep_id;
  if not (rrole = 'rep' or coalesce(risrep, false)) then
    raise exception 'assignments.rep_id must be a rep profile' using errcode = '23514';
  end if;
  new.client_email := lower(btrim(new.client_email));
  select * into crow from public.profiles p where p.email = new.client_email;
  if found then
    if crow.role <> 'client' then
      raise exception 'only client accounts can be assigned to a rep' using errcode = '23514';
    end if;
    new.client_user_id := crow.id;
  end if;
  if tg_op = 'INSERT' then
    new.assigned_by := coalesce(new.assigned_by, auth.uid());
  end if;
  return new;
end $$;

-- ---------- 6. quotes: a rep-capable owner's own quotes carry their own rep_id ----------
create or replace function private.quotes_set_expiry() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.user_role; capable boolean;
begin
  if tg_op = 'INSERT' then
    new.owner_id   := coalesce(new.owner_id, auth.uid());
    -- API callers cannot back-date; only server-side sessions (seed, SQL editor) can.
    if auth.uid() is not null then new.created_at := now(); else new.created_at := coalesce(new.created_at, now()); end if;
    select p.role, p.is_rep into r, capable from public.profiles p where p.id = new.owner_id;
    new.rep_id := case when r = 'rep' or coalesce(capable, false) then new.owner_id
                       when r = 'client' then private.rep_of(new.owner_id)
                       else null end;
  else
    -- immutable after insert, even for admins using the API
    new.owner_id   := old.owner_id;
    new.rep_id     := old.rep_id;
    new.created_at := old.created_at;
  end if;
  -- AUTO-DELETE RULE: 30 days after creation. Change here AND in app_settings text.
  new.expires_at := new.created_at + interval '30 days';
  return new;
end $$;

-- ---------- 7. sign-up: the invitation decides is_rep ----------
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare inv public.invitations;
begin
  select * into inv from public.invitations i
   where i.email = lower(new.email) and i.accepted_at is null
   order by i.created_at desc limit 1;
  if not found then
    raise exception 'Sign-up is by invitation only' using errcode = '42501';
  end if;

  insert into public.profiles (id, role, status, email, invited_by, cell_phone, is_rep)
  values (new.id, inv.role, 'active', lower(new.email), inv.invited_by, inv.cell_phone, inv.role = 'rep' or inv.is_rep);

  update public.invitations set accepted_at = now(), accepted_user_id = new.id where id = inv.id;

  -- connect any assignment that was made by email before the account existed
  update public.assignments set client_user_id = new.id
   where client_email = lower(new.email) and client_user_id is null;

  insert into public.audit_log (actor_id, action, target_type, target_id, details)
  values (new.id, 'profile_created', 'profile', new.id,
          jsonb_build_object('role', inv.role, 'invited_by', inv.invited_by, 'is_rep', inv.role = 'rep' or inv.is_rep));
  return new;
end $$;

-- ---------- 8. create_invitation: + p_is_rep (new super admin who also reps) + p_as_rep ----------
--   p_is_rep  admin only, only with role super_admin ("this new admin also works as a rep"); rep role is always a rep
--   p_as_rep  an admin+rep acting FROM THE REP DASHBOARD: use the rep rules (clients only, assigned to themselves,
--             never takes over another rep's client). Can only reduce privilege; needs the caller to be a rep.
-- Replaces the 4-argument version from migration 5 (dropped so PostgREST never sees two overloads).
-- If migration 5 is ever re-run on its own AFTER this one, drop that 4-argument function again.
drop function if exists public.create_invitation(text, public.user_role, uuid, text);
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
    target_rep := p_rep_id;
  elsif private.is_rep() then
    if p_role <> 'client' then raise exception 'reps can only invite clients' using errcode = '42501'; end if;
    target_rep := auth.uid();
  else
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(p_is_rep, false) and (not as_admin or p_role <> 'super_admin') then
    raise exception 'only a super admin can invite another super admin who also works as a rep' using errcode = '42501';
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
  values (e, p_role, auth.uid(), cell, p_role = 'rep' or (p_role = 'super_admin' and coalesce(p_is_rep, false)))
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

-- ---------- 9. admin: switch "also works as a rep" on / off for a super admin ----------
create or replace function public.admin_set_is_rep(p_user uuid, p_is_rep boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles; n int;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into t from public.profiles where id = p_user;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  if t.role <> 'super_admin' then
    raise exception 'only a super admin can be switched: reps are always reps and clients never are' using errcode = '23514';
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

-- ---------- function privileges (same pattern as migrations 2 and 5) ----------
revoke execute on function private.profiles_rep_flag() from public, anon, authenticated;
revoke execute on function public.create_invitation(text, public.user_role, uuid, text, boolean, boolean),
                           public.admin_set_is_rep(uuid, boolean) from public, anon;
grant  execute on function public.create_invitation(text, public.user_role, uuid, text, boolean, boolean),
                           public.admin_set_is_rep(uuid, boolean) to authenticated;
