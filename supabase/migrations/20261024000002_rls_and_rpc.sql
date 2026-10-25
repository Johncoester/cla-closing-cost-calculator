-- =====================================================================
-- CLA Quote Portal: access rules (RLS), grants, RPC functions
-- Migration 2 of 4
--
-- Portable SQL: every rule is a plain Postgres policy. The only
-- Supabase-specific parts are marked  [SUPABASE]  (auth.uid()/auth.jwt(),
-- the anon / authenticated / service_role roles). On another platform
-- (e.g. RDS Postgres + Cognito) keep the policies and replace auth.uid()
-- with a function reading your session setting (e.g. current_setting('app.user_id')).
--
-- Pattern for every table: ENABLE RLS, REVOKE everything from anon and
-- authenticated, GRANT only what the app needs (column-level where a role
-- must not touch a column), then one policy per action.
-- Disabled users: every policy below goes through private.is_active() or a
-- helper that checks status = 'active', so a disabled user reads nothing.
-- =====================================================================

-- RLS on everywhere ("FORCE" so table owners that are not superusers obey it too)
alter table public.profiles    enable row level security;
alter table public.invitations enable row level security;
alter table public.assignments enable row level security;
alter table public.photos      enable row level security;
alter table public.quotes      enable row level security;
alter table public.audit_log   enable row level security;

-- [SUPABASE] revoke the broad default grants Supabase gives anon/authenticated
revoke all on public.profiles, public.invitations, public.assignments,
              public.photos, public.quotes, public.audit_log
  from anon, authenticated;

grant usage on schema public to anon, authenticated;
grant usage on schema private to authenticated;

-- ---------------- profiles ----------------
-- SELECT: self; admin all; a rep sees the clients assigned to them.
-- (A client reads their rep through public.get_my_rep(): name, phone, photo only.)
grant select on public.profiles to authenticated;
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated using (id = auth.uid() and private.is_active());
drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated using (private.is_admin());
drop policy if exists profiles_select_rep_clients on public.profiles;
create policy profiles_select_rep_clients on public.profiles
  for select to authenticated using (role = 'client' and private.rep_has_client(id));

-- UPDATE: self or admin, and ONLY these columns. role, status, email, id, avatar_path,
-- invited_by are not updatable through the API (use the RPCs below).
grant update (first_name, last_name, phone, company_name, company_phone, company_address,
              company_website, license_or_nmls_number, terms_accepted_at, last_seen_at)
  on public.profiles to authenticated;
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid() and private.is_active())
  with check (id = auth.uid() and private.is_active());
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (private.is_admin()) with check (private.is_admin());
-- INSERT: only the auth.users trigger. DELETE: nobody (disable instead).

-- ---------------- invitations ----------------
-- Created only through public.create_invitation(). Admin can read all; a rep reads their own.
grant select on public.invitations to authenticated;
drop policy if exists invitations_select_admin on public.invitations;
create policy invitations_select_admin on public.invitations
  for select to authenticated using (private.is_admin());
drop policy if exists invitations_select_rep on public.invitations;
create policy invitations_select_rep on public.invitations
  for select to authenticated using (private.is_rep() and invited_by = auth.uid());

-- ---------------- assignments ----------------
-- SELECT: admin all; rep own rows; client own row.
grant select on public.assignments to authenticated;
drop policy if exists assignments_select_admin on public.assignments;
create policy assignments_select_admin on public.assignments
  for select to authenticated using (private.is_admin());
drop policy if exists assignments_select_rep on public.assignments;
create policy assignments_select_rep on public.assignments
  for select to authenticated using (private.is_rep() and rep_id = auth.uid());
drop policy if exists assignments_select_client on public.assignments;
create policy assignments_select_client on public.assignments
  for select to authenticated using (client_user_id = auth.uid() and private.is_active());
-- INSERT: admin any; rep only for themselves. UPDATE/DELETE: admin only.
grant insert (client_email, rep_id) on public.assignments to authenticated;
grant update (rep_id, active) on public.assignments to authenticated;
grant delete on public.assignments to authenticated;
drop policy if exists assignments_insert_admin on public.assignments;
create policy assignments_insert_admin on public.assignments
  for insert to authenticated with check (private.is_admin());
drop policy if exists assignments_insert_rep on public.assignments;
create policy assignments_insert_rep on public.assignments
  for insert to authenticated with check (private.is_rep() and rep_id = auth.uid() and active);
drop policy if exists assignments_update_admin on public.assignments;
create policy assignments_update_admin on public.assignments
  for update to authenticated using (private.is_admin()) with check (private.is_admin());
drop policy if exists assignments_delete_admin on public.assignments;
create policy assignments_delete_admin on public.assignments
  for delete to authenticated using (private.is_admin());

-- ---------------- photos (metadata) ----------------
-- SELECT: owner, admin, the assigned rep/client of the owner.
grant select on public.photos to authenticated;
drop policy if exists photos_select on public.photos;
create policy photos_select on public.photos
  for select to authenticated using (
    private.is_active() and (owner_id = auth.uid() or private.is_admin() or private.are_paired(auth.uid(), owner_id::text)));
-- INSERT/UPDATE: owner only, own folder only.  DELETE: owner or admin (moderation).
grant insert (owner_id, storage_path, mime_type, size_bytes) on public.photos to authenticated;
grant update (storage_path, mime_type, size_bytes) on public.photos to authenticated;
grant delete on public.photos to authenticated;
drop policy if exists photos_insert_own on public.photos;
create policy photos_insert_own on public.photos
  for insert to authenticated with check (owner_id = auth.uid() and private.is_active());
drop policy if exists photos_update_own on public.photos;
create policy photos_update_own on public.photos
  for update to authenticated using (owner_id = auth.uid() and private.is_active())
  with check (owner_id = auth.uid() and private.is_active());
drop policy if exists photos_delete on public.photos;
create policy photos_delete on public.photos
  for delete to authenticated using (private.is_active() and (owner_id = auth.uid() or private.is_admin()));

-- ---------------- quotes ----------------
-- Expired rows (expires_at <= now()) are invisible to everyone immediately,
-- even before the nightly purge job physically deletes them.
grant select on public.quotes to authenticated;
drop policy if exists quotes_select_owner on public.quotes;
create policy quotes_select_owner on public.quotes
  for select to authenticated using (
    owner_id = auth.uid() and private.is_active() and deleted_at is null and expires_at > now());
drop policy if exists quotes_select_rep on public.quotes;
create policy quotes_select_rep on public.quotes
  for select to authenticated using (
    private.rep_has_client(owner_id) and deleted_at is null and expires_at > now());
drop policy if exists quotes_select_admin on public.quotes;
create policy quotes_select_admin on public.quotes
  for select to authenticated using (private.is_admin() and expires_at > now());
-- INSERT: any active user, as owner only. owner_id/rep_id/created_at/expires_at are set by trigger.
grant insert (owner_id, quote_type, label, state, county, property_address, price,
              inputs, results, fee_version)
  on public.quotes to authenticated;
drop policy if exists quotes_insert_own on public.quotes;
create policy quotes_insert_own on public.quotes
  for insert to authenticated with check (owner_id = auth.uid() and private.is_active());
-- UPDATE: owner, content columns only. Cannot extend expiry, cannot touch deleted_at
-- (soft delete goes through public.delete_my_quote(): an UPDATE that hides the row
-- from its own SELECT policy would be rejected by Postgres).
grant update (quote_type, label, state, county, property_address, price, inputs, results,
              fee_version)
  on public.quotes to authenticated;
drop policy if exists quotes_update_own on public.quotes;
create policy quotes_update_own on public.quotes
  for update to authenticated
  using (owner_id = auth.uid() and private.is_active() and deleted_at is null and expires_at > now())
  with check (owner_id = auth.uid() and private.is_active());
-- DELETE: admin only (owners soft-delete through delete_my_quote()).
grant delete on public.quotes to authenticated;
drop policy if exists quotes_delete_admin on public.quotes;
create policy quotes_delete_admin on public.quotes
  for delete to authenticated using (private.is_admin());

-- ---------------- audit_log ----------------
-- Admin can read. Nobody can write through the API; rows come from triggers/functions.
grant select on public.audit_log to authenticated;
drop policy if exists audit_select_admin on public.audit_log;
create policy audit_select_admin on public.audit_log
  for select to authenticated using (private.is_admin());

-- =====================================================================
-- RPC functions the front end calls (public schema = exposed by the API).
-- All SECURITY DEFINER with explicit authorization checks inside, empty
-- search_path, and EXECUTE granted to authenticated only.
-- =====================================================================

-- Owner "deletes" a quote: hides it from the client and their rep. The row is kept for
-- admins until the 30 day purge removes it for good.
create or replace function public.delete_my_quote(p_quote uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_active() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.quotes set deleted_at = now()
   where id = p_quote and owner_id = auth.uid() and deleted_at is null and expires_at > now();
  if not found then raise exception 'no such quote' using errcode = 'P0002'; end if;
end $$;

-- The caller's rep: name, phone, email and photo path only.
create or replace function public.get_my_rep()
returns table (id uuid, first_name text, last_name text, phone text, email text, avatar_path text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.first_name, r.last_name, r.phone, r.email, r.avatar_path
  from public.profiles r
  where r.id = private.rep_of(auth.uid()) and private.is_active()
$$;

-- Invite a person. Writes the invitation (the gate in private.handle_new_user)
-- and, for clients, the rep assignment (works before the account exists).
--   admin: any role; for client, optional p_rep_id
--   rep:   role client only, assigned to themselves
-- After this succeeds, the invite-user Edge Function sends the email with the
-- service-role key (supabase.auth.admin.inviteUserByEmail).
create or replace function public.create_invitation(p_email text, p_role public.user_role, p_rep_id uuid default null)
returns public.invitations
language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(p_email)); inv public.invitations; target_rep uuid;
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

  -- re-inviting replaces a stale pending invitation
  delete from public.invitations where email = e and accepted_at is null;
  insert into public.invitations (email, role, invited_by) values (e, p_role, auth.uid())
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

-- Admin: change role (never through a direct UPDATE).
create or replace function public.admin_set_role(p_user uuid, p_role public.user_role)
returns void language plpgsql security definer set search_path = '' as $$
declare old_role public.user_role;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'you cannot change your own role' using errcode = '42501'; end if;
  select role into old_role from public.profiles where id = p_user;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  update public.profiles set role = p_role where id = p_user;
  perform private.audit('role_changed', 'profile', p_user, jsonb_build_object('before', old_role, 'after', p_role));
end $$;

-- Admin: disable / re-enable. The Edge Function should ALSO ban the auth user
-- (auth.admin.updateUserById(id, {ban_duration})) so existing sessions stop refreshing.
create or replace function public.admin_set_status(p_user uuid, p_status public.user_status)
returns void language plpgsql security definer set search_path = '' as $$
declare old_status public.user_status;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'you cannot disable yourself' using errcode = '42501'; end if;
  select status into old_status from public.profiles where id = p_user;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  update public.profiles set status = p_status where id = p_user;
  perform private.audit(case when p_status = 'disabled' then 'user_disabled' else 'user_enabled' end,
    'profile', p_user, jsonb_build_object('before', old_status, 'after', p_status));
end $$;

-- Admin: move a client email to another rep (history kept: old row goes inactive).
create or replace function public.admin_reassign_client(p_client_email text, p_rep_id uuid)
returns public.assignments language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(p_client_email)); a public.assignments;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.assignments set active = false where client_email = e and active;
  insert into public.assignments (client_email, rep_id, assigned_by) values (e, p_rep_id, auth.uid())
  returning * into a;
  return a;
end $$;

-- Admin: record that they opened a quote (call this when the admin UI opens one).
create or replace function public.admin_log_quote_view(p_quote uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform private.audit('quote_viewed_by_admin', 'quote', p_quote, '{}'::jsonb);
end $$;

-- Admin: record a CSV/export run.
create or replace function public.admin_log_export(p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform private.audit('export_run', 'quote', null, p_details);
end $$;

-- Function privileges: nothing is executable by PUBLIC/anon.
-- private helpers: only the ones RLS policies call are executable by logged-in users.
revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on function
  private.is_active(), private.my_role(), private.is_admin(), private.is_rep(),
  private.rep_has_client(uuid), private.are_paired(uuid, text)
  to authenticated;
revoke execute on function
  public.get_my_rep(), public.delete_my_quote(uuid), public.create_invitation(text, public.user_role, uuid),
  public.admin_set_role(uuid, public.user_role), public.admin_set_status(uuid, public.user_status),
  public.admin_reassign_client(text, uuid), public.admin_log_quote_view(uuid), public.admin_log_export(jsonb)
  from public, anon;
grant execute on function
  public.get_my_rep(), public.delete_my_quote(uuid), public.create_invitation(text, public.user_role, uuid),
  public.admin_set_role(uuid, public.user_role), public.admin_set_status(uuid, public.user_status),
  public.admin_reassign_client(text, uuid), public.admin_log_quote_view(uuid), public.admin_log_export(jsonb)
  to authenticated;
