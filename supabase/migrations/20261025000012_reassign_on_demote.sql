-- =====================================================================
-- CLA Quote Portal: never leave a rep's clients (realtors) without a rep
-- Migration 12 (new file; migrations 1-11 untouched). Safe to run twice. Plain transaction, no enum changes.
--
-- PROBLEM
--   Moving someone who works as a rep (role = rep, or admin / super admin with is_rep) to a role where they cannot be a rep
--   (client), left their active client assignments pointing at a person who can no longer serve them. Turning is_rep off was
--   already refused while they had clients (migration 6) but gave no way to move the clients in the same step.
--
-- RULE
--   admin_set_role(p_user, p_role, p_reassign_to default null)
--   admin_set_is_rep(p_user, p_is_rep, p_reassign_to default null)
--     If the change removes rep capability from someone who has ACTIVE client assignments:
--       * without p_reassign_to           -> refused (55006) with a clear message that says how many clients
--       * with p_reassign_to              -> must be an ACTIVE, rep-capable user (rep, or admin / super admin with is_rep),
--                                            and not the same person (23514 otherwise); then ALL their active assignments are
--                                            moved in the same transaction: the old rows go inactive, new rows are created
--                                            for the new rep (the assignments trigger writes an 'assignment_changed' audit row for
--                                            each), and the role_changed / rep_flag_changed audit row records who took over.
--     No active clients, or the change keeps rep capability (rep -> admin / super admin keeps is_rep; admin+rep -> rep ...):
--     nothing moves and p_reassign_to is ignored. Who may call these is unchanged (migrations 10 / 11): an admin still cannot
--     promote anybody or touch a super admin; admin_set_is_rep is still super admin only.
--
-- COMPATIBILITY
--   A new defaulted parameter changes the function's signature, so the two old signatures are DROPPED (leaving both would make
--   a call by parameter name ambiguous). Calls with the old argument lists (positional or by name) resolve to the new functions.
--   Grants are restated for the new signatures.
-- =====================================================================

-- ---------- helpers (not callable by API users; only by the SECURITY DEFINER RPCs below) ----------
create or replace function private.active_client_count(p_rep uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.assignments a where a.rep_id = p_rep and a.active
$$;

-- move every ACTIVE client of p_from to p_to (history kept). Returns how many moved.
create or replace function private.move_rep_clients(p_from uuid, p_to uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  if p_to is null or p_to = p_from then
    raise exception 'choose a different rep to take over these clients' using errcode = '23514';
  end if;
  if not exists (select 1 from public.profiles p
                  where p.id = p_to and p.status = 'active' and (p.role = 'rep' or (p.role in ('super_admin', 'admin') and p.is_rep))) then
    raise exception 'the rep who takes over must be an active rep (or an active admin who also works as a rep)' using errcode = '23514';
  end if;
  for r in select a.client_email from public.assignments a where a.rep_id = p_from and a.active order by a.created_at, a.id for update loop
    update public.assignments set active = false where client_email = r.client_email and active;
    insert into public.assignments (client_email, rep_id, assigned_by) values (r.client_email, p_to, auth.uid());
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- the old signatures go; the new ones take an optional p_reassign_to ----------
drop function if exists public.admin_set_role(uuid, public.user_role);
drop function if exists public.admin_set_is_rep(uuid, boolean);

-- change a role (never a direct UPDATE). Permission rules are exactly migration 11's; the new part is the clients.
--   super admin: any role for anyone, except their own, and never leaving zero active super admins
--   admin:       target may be a rep, client or admin (never a super admin); the NEW role must be rep or client
--   NEW:         if the change leaves a person with active clients unable to be a rep, p_reassign_to must name their successor
create or replace function public.admin_set_role(p_user uuid, p_role public.user_role, p_reassign_to uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles; n int; capable_after boolean; moved int := 0;
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
  -- clients: will they still have a rep? (the profile trigger keeps is_rep: forced true for rep, false for client, unchanged for admins)
  capable_after := p_role = 'rep' or (p_role in ('super_admin', 'admin') and t.is_rep);
  n := private.active_client_count(p_user);
  if n > 0 and not capable_after then
    if p_reassign_to is null then
      raise exception 'this person has % active client(s): choose another rep to take them over before making this person a client', n using errcode = '55006';
    end if;
    moved := private.move_rep_clients(p_user, p_reassign_to);
  end if;
  update public.profiles set role = p_role where id = p_user;
  perform private.audit('role_changed', 'profile', p_user, jsonb_build_object('before', t.role, 'after', p_role)
    || case when moved > 0 then jsonb_build_object('clients_moved', moved, 'moved_to', p_reassign_to) else '{}'::jsonb end);
end $$;

-- "also works as a rep" switch. SUPER ADMIN ONLY (migration 10), for admins and super admins.
--   NEW: switching it OFF while the person has active clients needs p_reassign_to (their successor); the clients move in the same step
create or replace function public.admin_set_is_rep(p_user uuid, p_is_rep boolean, p_reassign_to uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.profiles; n int; moved int := 0;
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
    n := private.active_client_count(p_user);
    if n > 0 then
      if p_reassign_to is null then
        raise exception 'reassign this person''s % active client(s) before switching rep access off: choose another rep to take them over', n using errcode = '55006';
      end if;
      moved := private.move_rep_clients(p_user, p_reassign_to);
    end if;
  end if;
  update public.profiles set is_rep = p_is_rep where id = p_user;
  perform private.audit('rep_flag_changed', 'profile', p_user, jsonb_build_object('before', t.is_rep, 'after', p_is_rep)
    || case when moved > 0 then jsonb_build_object('clients_moved', moved, 'moved_to', p_reassign_to) else '{}'::jsonb end);
end $$;

-- ---------- privileges ----------
revoke execute on function private.active_client_count(uuid), private.move_rep_clients(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.admin_set_role(uuid, public.user_role, uuid), public.admin_set_is_rep(uuid, boolean, uuid) from public, anon;
grant  execute on function public.admin_set_role(uuid, public.user_role, uuid), public.admin_set_is_rep(uuid, boolean, uuid) to authenticated;
