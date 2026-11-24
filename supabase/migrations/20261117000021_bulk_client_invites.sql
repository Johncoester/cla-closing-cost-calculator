-- =====================================================================
-- Migration 21: bulk client invites (John, 11/17). New file; migrations 1-20 untouched.
-- Safe to run twice. One plain transaction. Nothing is sent by the migration itself.
--
-- WHAT IT ADDS
--   invitations.first_name, last_name, company_name
--     Optional name and company collected at invite time (the Upload clients sheet,
--     or a future invite form). Copied onto the profile when the Auth account is created
--     (private.handle_new_user). cell_phone was already on the invitation (migration 5).
--   create_invitation() gains three optional arguments at the end (defaults null), so
--     existing callers (invite-user Edge Function, single invite form) are unchanged.
--     Exactly one overload (the old 6-argument form is dropped first).
--   private.bulk_invite_sends
--     One row per invite email actually sent by the invite-clients-bulk Edge Function
--     (not reachable through the API). Used for the rolling one-hour cap of 50.
--   public.admin_preview_bulk_clients(p_rows jsonb)  -> jsonb
--     Admin / super admin only. Classifies each row (invite / skip / reject) and
--     looks up the rep. Writes nothing. The Edge Function then invites only the
--     "invite" rows, as role client, with the rep id this function returns.
--   public.admin_bulk_invite_remaining()             -> integer
--   public.admin_bulk_invite_record(p_email text)    -> integer  (remaining after this send)
--     Admin / super admin only. The record function takes an advisory lock so two
--     overlapping uploads cannot both slip past the cap.
--
-- CAPS (enforced again in the Edge Function)
--   50 rows per upload, 50 invite emails per rolling hour from this bulk path.
-- =====================================================================

-- ---------- 1. invitation profile fields ----------
alter table public.invitations
  add column if not exists first_name    text,
  add column if not exists last_name     text,
  add column if not exists company_name  text;
alter table public.invitations drop constraint if exists invitations_name_len;
alter table public.invitations add constraint invitations_name_len check (
  length(coalesce(first_name, '')) <= 80
  and length(coalesce(last_name, '')) <= 80
  and length(coalesce(company_name, '')) <= 160
);

-- ---------- 2. copy those fields when the Auth user (and profile) is created ----------
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

  insert into public.profiles (id, role, status, email, invited_by, cell_phone, is_rep,
                               first_name, last_name, company_name)
  values (new.id, inv.role, 'active', lower(new.email), inv.invited_by, inv.cell_phone,
          inv.role = 'rep' or inv.is_rep,
          coalesce(inv.first_name, ''), coalesce(inv.last_name, ''), inv.company_name);

  update public.invitations set accepted_at = now(), accepted_user_id = new.id where id = inv.id;

  -- connect any assignment that was made by email before the account existed
  update public.assignments set client_user_id = new.id
   where client_email = lower(new.email) and client_user_id is null;

  insert into public.audit_log (actor_id, action, target_type, target_id, details)
  values (new.id, 'profile_created', 'profile', new.id,
          jsonb_build_object('role', inv.role, 'invited_by', inv.invited_by, 'is_rep', inv.role = 'rep' or inv.is_rep));
  return new;
end $$;

-- ---------- 3. create_invitation: optional first / last / company (defaults keep old callers working) ----------
drop function if exists public.create_invitation(text, public.user_role, uuid, text, boolean, boolean);
create or replace function public.create_invitation(p_email text, p_role public.user_role, p_rep_id uuid default null,
                                                    p_cell_phone text default null, p_is_rep boolean default false,
                                                    p_as_rep boolean default false,
                                                    p_first_name text default null, p_last_name text default null,
                                                    p_company_name text default null)
returns public.invitations
language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(p_email)); inv public.invitations; target_rep uuid; cell text; as_admin boolean;
        fname text := nullif(btrim(coalesce(p_first_name, '')), '');
        lname text := nullif(btrim(coalesce(p_last_name, '')), '');
        cname text := nullif(btrim(coalesce(p_company_name, '')), '');
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
  if length(coalesce(fname, '')) > 80 then
    raise exception 'First name is too long (80 characters at most).' using errcode = '22023';
  end if;
  if length(coalesce(lname, '')) > 80 then
    raise exception 'Last name is too long (80 characters at most).' using errcode = '22023';
  end if;
  if length(coalesce(cname, '')) > 160 then
    raise exception 'Company is too long (160 characters at most).' using errcode = '22023';
  end if;
  if p_cell_phone is not null and btrim(p_cell_phone) <> '' then
    cell := private.normalize_us_phone(p_cell_phone);
    if cell is null then
      raise exception 'Enter a valid 10-digit US cell phone number, like (240) 555-0142' using errcode = '22023';
    end if;
  end if;

  -- re-inviting replaces a stale pending invitation
  delete from public.invitations where email = e and accepted_at is null;
  insert into public.invitations (email, role, invited_by, cell_phone, is_rep, first_name, last_name, company_name)
  values (e, p_role, auth.uid(), cell,
          p_role = 'rep' or (p_role in ('super_admin', 'admin') and coalesce(p_is_rep, false)),
          fname, lname, cname)
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

revoke execute on function public.create_invitation(text, public.user_role, uuid, text, boolean, boolean, text, text, text)
  from public, anon;
grant  execute on function public.create_invitation(text, public.user_role, uuid, text, boolean, boolean, text, text, text)
  to authenticated;

-- ---------- 4. hourly cap bookkeeping (private: no API access) ----------
create table if not exists private.bulk_invite_sends (
  id        uuid primary key default gen_random_uuid(),
  sent_at   timestamptz not null default now(),
  sent_by   uuid references public.profiles (id) on delete set null,
  email     text not null
);
create index if not exists bulk_invite_sends_sent_at_idx on private.bulk_invite_sends (sent_at);
revoke all on private.bulk_invite_sends from public, anon, authenticated;

create or replace function public.admin_bulk_invite_remaining()
returns integer
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  return greatest(0, 50 - (select count(*)::int from private.bulk_invite_sends where sent_at > now() - interval '1 hour'));
end $$;
revoke execute on function public.admin_bulk_invite_remaining() from public, anon;
grant  execute on function public.admin_bulk_invite_remaining() to authenticated;
comment on function public.admin_bulk_invite_remaining() is
  'Admin / super admin only. How many bulk-invite emails may still go out in the current rolling hour (cap 50).';

create or replace function public.admin_bulk_invite_record(p_email text)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare n int; e text := lower(btrim(coalesce(p_email, '')));
begin
  if not private.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('cla.bulk_invite_sends'));
  select count(*)::int into n from private.bulk_invite_sends where sent_at > now() - interval '1 hour';
  if n >= 50 then
    raise exception 'Hourly invite limit reached. Wait before sending more.' using errcode = 'PT429';
  end if;
  insert into private.bulk_invite_sends (sent_by, email) values (auth.uid(), e);
  return 50 - n - 1;
end $$;
revoke execute on function public.admin_bulk_invite_record(text) from public, anon;
grant  execute on function public.admin_bulk_invite_record(text) to authenticated;
comment on function public.admin_bulk_invite_record(text) is
  'Admin / super admin only. Records one successfully sent bulk-invite email against the rolling hourly cap of 50; returns how many remain.';

-- ---------- 5. classify a batch (no writes) ----------
create or replace function public.admin_preview_bulk_clients(p_rows jsonb)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  out jsonb := '[]'::jsonb;
  rec jsonb;
  i int := 0;
  e text; rep_email text; fn text; ln text; co text; cell_raw text; cell text;
  status text; reason text; rid uuid; rrole public.user_role; risrep boolean; rstatus public.user_status;
  seen text[] := '{}';
begin
  if not private.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 50 then
    raise exception 'Upload at most 50 clients at a time.' using errcode = '22023';
  end if;

  for rec in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    status := 'invite'; reason := null; rid := null; cell := null;
    e := lower(btrim(coalesce(rec->>'email', '')));
    rep_email := lower(btrim(coalesce(rec->>'rep_email', rec->>'repEmail', '')));
    fn := nullif(btrim(coalesce(rec->>'first_name', rec->>'firstName', '')), '');
    ln := nullif(btrim(coalesce(rec->>'last_name', rec->>'lastName', '')), '');
    co := nullif(btrim(coalesce(rec->>'company', rec->>'company_name', rec->>'companyName', '')), '');
    cell_raw := nullif(btrim(coalesce(rec->>'cell_phone', rec->>'cellPhone', rec->>'phone', '')), '');

    if e = '' then
      status := 'reject'; reason := 'Email is required.';
    elsif e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      status := 'reject'; reason := 'Enter a valid email address.';
    elsif e = any (seen) then
      status := 'reject'; reason := 'Duplicate email in this file.';
    elsif length(coalesce(fn, '')) > 80 then
      status := 'reject'; reason := 'First name is too long (80 characters at most).';
    elsif length(coalesce(ln, '')) > 80 then
      status := 'reject'; reason := 'Last name is too long (80 characters at most).';
    elsif length(coalesce(co, '')) > 160 then
      status := 'reject'; reason := 'Company is too long (160 characters at most).';
    elsif cell_raw is not null then
      cell := private.normalize_us_phone(cell_raw);
      if cell is null then
        status := 'reject'; reason := 'Enter a valid 10-digit US cell phone number, like (240) 555-0142';
      end if;
    end if;

    if status = 'invite' and rep_email = '' then
      status := 'reject'; reason := 'A sales rep email is required.';
    elsif status = 'invite' then
      select p.id, p.role, p.is_rep, p.status into rid, rrole, risrep, rstatus
        from public.profiles p where p.email = rep_email;
      if rid is null then
        status := 'reject'; reason := 'No sales rep has that email.';
      elsif rstatus <> 'active' then
        status := 'reject'; reason := 'That sales rep is disabled.'; rid := null;
      elsif not (rrole = 'rep' or coalesce(risrep, false)) then
        status := 'reject'; reason := 'That email is not a sales rep.'; rid := null;
      end if;
    end if;

    if status = 'invite' and exists (select 1 from public.profiles p where p.email = e) then
      status := 'skip'; reason := 'This email already has an account.'; rid := null;
    end if;

    if e <> '' then seen := array_append(seen, e); end if;

    out := out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'index', i,
      'email', nullif(e, ''),
      'first_name', fn,
      'last_name', ln,
      'company_name', co,
      'cell_phone', cell,
      'rep_email', nullif(rep_email, ''),
      'rep_id', rid,
      'status', status,
      'reason', reason
    )));
  end loop;
  return out;
end $$;
revoke execute on function public.admin_preview_bulk_clients(jsonb) from public, anon;
grant  execute on function public.admin_preview_bulk_clients(jsonb) to authenticated;
comment on function public.admin_preview_bulk_clients(jsonb) is
  'Admin / super admin only. Classifies up to 50 client-invite rows (invite, skip existing accounts, or reject). Writes nothing.';
