-- =====================================================================
-- CLA Quote Portal: cell phone numbers
-- Migration 5 of 5 (new file; migrations 1-4 are untouched).
--
-- What already existed: profiles.phone (free text, <= 40 chars; required for
-- reps by is_complete) and profiles.company_phone. They stay as they are
-- ("phone" is the person's main/office line).
--
-- What this adds:
--   * profiles.cell_phone      nullable (optional for everyone, clients included)
--   * invitations.cell_phone   optional, entered by the inviter, copied to the
--                              profile when the invitee signs up
--   * both stored ONLY as US E.164: +1XXXXXXXXXX (NANP: area code and exchange
--     start with 2-9). A BEFORE trigger normalizes whatever was typed
--     ("(240) 555-0142", "240.555.0142", "1 240 555 0142", "+12405550142") and
--     raises a readable error when it cannot; a CHECK constraint is the backstop.
--   * edit rights: the existing profiles UPDATE policies apply unchanged (the owner
--     edits their own row; admins can edit non-sensitive fields as before). This file
--     only adds cell_phone to the per-column UPDATE grant.
--   * visibility: unchanged rules. profiles SELECT already lets self / admin /
--     the assigned rep see the row, so cell_phone is visible to exactly them.
--     A client reads their rep through the NEW public.get_my_rep_contact() (get_my_rep()
--     is left as it was; it cannot gain a column without a return-type change that
--     would break re-running migration 2).
--   * public.create_invitation() gets an optional p_cell_phone argument.
--   * a rep may read the pending invitation of a client assigned to them (to show the invited cell).
-- Safe to run twice.
-- =====================================================================

-- ---------- normalizer (private; NULL when the input is not a US number) ----------
create or replace function private.normalize_us_phone(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text;
begin
  if p is null or p !~ '^[0-9()+.\s-]+$' then return null; end if;   -- digits and common separators only
  d := regexp_replace(p, '\D', '', 'g');
  if length(d) = 11 and left(d, 1) = '1' then d := substr(d, 2); end if;
  if d ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then return '+1' || d; end if;
  return null;
end $$;

-- BEFORE INSERT/UPDATE trigger shared by profiles and invitations
create or replace function private.normalize_cell_phone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.cell_phone is not null then
    if btrim(new.cell_phone) = '' then
      new.cell_phone := null;
    else
      new.cell_phone := private.normalize_us_phone(new.cell_phone);
      if new.cell_phone is null then
        raise exception 'Enter a valid 10-digit US cell phone number, like (240) 555-0142' using errcode = '22023';
      end if;
    end if;
  end if;
  return new;
end $$;

-- ---------- columns, constraints, triggers ----------
alter table public.profiles    add column if not exists cell_phone text;
alter table public.invitations add column if not exists cell_phone text;

alter table public.profiles drop constraint if exists profiles_cell_phone_e164;
alter table public.profiles add constraint profiles_cell_phone_e164
  check (cell_phone is null or cell_phone ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$');
alter table public.invitations drop constraint if exists invitations_cell_phone_e164;
alter table public.invitations add constraint invitations_cell_phone_e164
  check (cell_phone is null or cell_phone ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$');

drop trigger if exists profiles_normalize_cell on public.profiles;
create trigger profiles_normalize_cell before insert or update of cell_phone on public.profiles
  for each row execute function private.normalize_cell_phone();
drop trigger if exists invitations_normalize_cell on public.invitations;
create trigger invitations_normalize_cell before insert or update of cell_phone on public.invitations
  for each row execute function private.normalize_cell_phone();

-- ---------- per-column grant: owner (and admin, via the existing policy) may edit it ----------
grant update (cell_phone) on public.profiles to authenticated;

-- ---------- invitation -> profile copy at sign-up ----------
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

  insert into public.profiles (id, role, status, email, invited_by, cell_phone)
  values (new.id, inv.role, 'active', lower(new.email), inv.invited_by, inv.cell_phone);

  update public.invitations set accepted_at = now(), accepted_user_id = new.id where id = inv.id;

  -- connect any assignment that was made by email before the account existed
  update public.assignments set client_user_id = new.id
   where client_email = lower(new.email) and client_user_id is null;

  insert into public.audit_log (actor_id, action, target_type, target_id, details)
  values (new.id, 'profile_created', 'profile', new.id, jsonb_build_object('role', inv.role, 'invited_by', inv.invited_by));
  return new;
end $$;

-- ---------- a client reads their rep, including the rep's cell ----------
create or replace function public.get_my_rep_contact()
returns table (id uuid, first_name text, last_name text, phone text, cell_phone text, email text, avatar_path text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.first_name, r.last_name, r.phone, r.cell_phone, r.email, r.avatar_path
  from public.profiles r
  where r.id = private.rep_of(auth.uid()) and private.is_active()
$$;

-- ---------- create_invitation with an optional cell number ----------
-- Replaces the 3-argument version (drop first so PostgREST never sees two overloads).
drop function if exists public.create_invitation(text, public.user_role, uuid);
create or replace function public.create_invitation(p_email text, p_role public.user_role, p_rep_id uuid default null,
                                                    p_cell_phone text default null)
returns public.invitations
language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(p_email)); inv public.invitations; target_rep uuid; cell text;
begin
  if auth.uid() is null or not private.is_active() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if private.is_admin() then
    target_rep := p_rep_id;
  elsif private.is_rep() then
    if p_role <> 'client' then raise exception 'reps can only invite clients' using errcode = '42501'; end if;
    target_rep := auth.uid();
  else
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email' using errcode = '22023'; end if;
  if p_role = 'rep' and e not like '%@clatitle.com' then
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
  insert into public.invitations (email, role, invited_by, cell_phone) values (e, p_role, auth.uid(), cell)
  returning * into inv;

  if p_role = 'client' and target_rep is not null then
    if exists (select 1 from public.assignments a where a.client_email = e and a.active and a.rep_id <> target_rep)
       and not private.is_admin() then
      raise exception 'that client already belongs to another rep' using errcode = '23505';
    end if;
    if private.is_admin() then
      update public.assignments set active = false where client_email = e and active and rep_id <> target_rep;
    end if;
    insert into public.assignments (client_email, rep_id, assigned_by)
    select e, target_rep, auth.uid()
    where not exists (select 1 from public.assignments a where a.client_email = e and a.active);
  end if;

  perform private.audit('invite_sent', 'invitation', inv.id,
    jsonb_build_object('email', e, 'role', p_role, 'rep_id', target_rep));
  return inv;
end $$;

-- ---------- a rep sees the pending invitation (and its cell) of a client assigned to them ----------
-- Migration 2 only lets a rep read invitations they sent. A client an ADMIN invited and assigned to the
-- rep would otherwise show no cell on the rep's dashboard until sign-up.
create or replace function private.rep_has_client_email(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_rep() and exists (
    select 1 from public.assignments a
    where a.active and a.rep_id = auth.uid() and a.client_email = lower(p_email))
$$;
drop policy if exists invitations_select_rep_assigned on public.invitations;
create policy invitations_select_rep_assigned on public.invitations
  for select to authenticated using (accepted_at is null and private.rep_has_client_email(email));

-- ---------- function privileges (same pattern as migration 2) ----------
revoke execute on function private.normalize_us_phone(text), private.normalize_cell_phone(), private.rep_has_client_email(text)
  from public, anon, authenticated;
grant execute on function private.rep_has_client_email(text) to authenticated;   -- used by the policy above
revoke execute on function public.get_my_rep_contact(), public.create_invitation(text, public.user_role, uuid, text)
  from public, anon;
grant execute on function public.get_my_rep_contact(), public.create_invitation(text, public.user_role, uuid, text)
  to authenticated;
