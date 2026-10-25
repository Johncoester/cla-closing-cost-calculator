-- =====================================================================
-- CLA Quote Portal: core schema (Supabase / Postgres 15+)
-- Migration 1 of 4: tables, constraints, triggers, helper functions
--
-- Targets Supabase: auth.users (Supabase Auth, email + password),
-- auth.uid(), auth.jwt(), roles anon / authenticated / service_role.
-- Nothing in here stores or handles a password; Supabase Auth keeps only
-- bcrypt hashes in auth.users.
--
-- Security model in one paragraph:
--   * Sign-up is invite only. A row in public.invitations must exist for an
--     email before auth.users will accept it (trigger on auth.users), so
--     even if the "Allow new users to sign up" dashboard toggle is left on,
--     strangers cannot create accounts.
--   * A person's role comes ONLY from public.profiles.role, which is set by
--     the invitation and can be changed only by the admin_set_role() RPC.
--     Never from user_metadata (users can edit that).
--   * Every table has RLS on. Default grants are revoked and re-granted
--     per table, per column where needed.
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------- enums ----------
do $$ begin
  create type public.user_role   as enum ('super_admin', 'rep', 'client');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.user_status as enum ('active', 'disabled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.quote_type  as enum ('buyer', 'seller_net');
exception when duplicate_object then null; end $$;

-- ---------- app settings (tiny key/value, admin-managed via SQL editor) ----------
create table if not exists public.app_settings (
  key         text primary key,
  value       text not null,
  description text
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
insert into public.app_settings (key, value, description) values
  ('require_admin_mfa', 'false',
   'When true, super_admin policies require an aal2 (authenticator app) session. Set to true before real client data.'),
  ('quote_retention_days', '30',
   'Informational. The 30 day rule lives in private.quotes_set_expiry(); change both together.')
on conflict (key) do nothing;

-- ---------- profiles (one row per login) ----------
create table if not exists public.profiles (
  id                      uuid primary key references auth.users (id) on delete cascade,
  role                    public.user_role   not null,
  status                  public.user_status not null default 'active',
  email                   text not null,
  first_name              text not null default '',
  last_name               text not null default '',
  phone                   text,
  company_name            text,
  company_phone           text,
  company_address         text,
  company_website         text,
  license_or_nmls_number  text,
  avatar_path             text,                -- maintained by trigger from public.photos
  terms_accepted_at       timestamptz,
  invited_by              uuid references public.profiles (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  last_seen_at            timestamptz,
  is_complete             boolean generated always as (
                            length(btrim(first_name)) > 0
                            and length(btrim(last_name)) > 0
                            and (role <> 'rep' or length(btrim(coalesce(phone, ''))) > 0)
                          ) stored,
  constraint profiles_email_lowercase check (email = lower(email)),
  constraint profiles_email_shape     check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- reps must have a CLA address (database-level guard, not just UI)
  constraint profiles_rep_cla_email   check (role <> 'rep' or email like '%@clatitle.com'),
  constraint profiles_text_lengths    check (
    length(first_name) <= 80 and length(last_name) <= 80
    and length(coalesce(phone, '')) <= 40 and length(coalesce(company_name, '')) <= 160
    and length(coalesce(company_phone, '')) <= 40 and length(coalesce(company_address, '')) <= 300
    and length(coalesce(company_website, '')) <= 200 and length(coalesce(license_or_nmls_number, '')) <= 40)
);
create unique index if not exists profiles_email_key on public.profiles (email);
create index if not exists profiles_role_idx on public.profiles (role);

-- ---------- invitations (the only door into auth.users) ----------
create table if not exists public.invitations (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  role              public.user_role not null,
  invited_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  accepted_at       timestamptz,
  accepted_user_id  uuid references public.profiles (id) on delete set null,
  constraint invitations_email_lowercase check (email = lower(email)),
  constraint invitations_rep_cla_email   check (role <> 'rep' or email like '%@clatitle.com')
);
create unique index if not exists invitations_pending_email_key
  on public.invitations (email) where accepted_at is null;

-- ---------- assignments (which rep owns which client / agent) ----------
-- Matches by EMAIL so it works before the client has an account.
-- One active rep per client email (open decision: recommended default).
create table if not exists public.assignments (
  id              uuid primary key default gen_random_uuid(),
  client_email    text not null,
  client_user_id  uuid references public.profiles (id) on delete set null,
  rep_id          uuid not null references public.profiles (id) on delete restrict,
  assigned_by     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  active          boolean not null default true,
  constraint assignments_email_lowercase check (client_email = lower(client_email))
);
create unique index if not exists assignments_one_active_rep_per_client
  on public.assignments (client_email) where active;
create index if not exists assignments_rep_idx    on public.assignments (rep_id) where active;
create index if not exists assignments_client_idx on public.assignments (client_user_id) where active;

-- ---------- photos (metadata for files in the private 'avatars' bucket) ----------
create table if not exists public.photos (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null unique references public.profiles (id) on delete cascade, -- one photo per person
  storage_path  text not null,
  mime_type     text not null,
  size_bytes    integer not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint photos_mime_ok   check (mime_type in ('image/jpeg', 'image/png')),
  constraint photos_size_ok   check (size_bytes > 0 and size_bytes <= 2097152),          -- 2 MB
  constraint photos_path_ok   check (storage_path = owner_id::text || '/avatar')
);

-- ---------- quotes (auto-saved, auto-deleted 30 days after creation) ----------
create table if not exists public.quotes (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references public.profiles (id) on delete cascade,
  rep_id           uuid references public.profiles (id) on delete set null,   -- rep at time of quote; set by trigger
  quote_type       public.quote_type not null,
  label            text,
  state            text,
  county           text,
  property_address text,
  price            numeric(14, 2),
  inputs           jsonb not null default '{}'::jsonb,
  results          jsonb not null default '{}'::jsonb,
  fee_version      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  expires_at       timestamptz not null,                      -- set by trigger: created_at + 30 days
  deleted_at       timestamptz,                               -- client "delete" = hide; purge removes for real
  constraint quotes_expiry_after_create check (expires_at > created_at),
  constraint quotes_json_size check (pg_column_size(inputs) < 200000 and pg_column_size(results) < 400000),
  constraint quotes_text_lengths check (
    length(coalesce(label, '')) <= 160 and length(coalesce(property_address, '')) <= 300
    and length(coalesce(state, '')) <= 40 and length(coalesce(county, '')) <= 120)
);
create index if not exists quotes_owner_idx   on public.quotes (owner_id, created_at desc);
create index if not exists quotes_rep_idx     on public.quotes (rep_id, created_at desc);
create index if not exists quotes_expires_idx on public.quotes (expires_at);

-- ---------- audit log (append only) ----------
create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  at           timestamptz not null default now(),
  actor_id     uuid,                    -- no FK: history must survive user removal
  action       text not null,
  target_type  text,
  target_id    uuid,
  details      jsonb not null default '{}'::jsonb,   -- before/after values; never passwords or photo bytes
  constraint audit_action_known check (action in (
    'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
    'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
    'export_run', 'profile_created'))
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);

-- append only, even for service_role / postgres sessions that forget themselves
create or replace function private.audit_log_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append only' using errcode = '42501';
end $$;
drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function private.audit_log_immutable();

-- =====================================================================
-- Helper functions (SECURITY DEFINER, empty search_path, private schema
-- so they are not exposed through the REST API)
-- =====================================================================

-- active, non-disabled profile of the caller
create or replace function private.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active')
$$;

create or replace function private.my_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.status = 'active'
$$;

-- super admin check. If app_settings.require_admin_mfa = 'true', also needs an aal2 session.
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() = 'super_admin', false)
     and (
       coalesce((select value from public.app_settings where key = 'require_admin_mfa'), 'false') <> 'true'
       or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     )
$$;

create or replace function private.is_rep() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() = 'rep', false)
$$;

-- is the caller an active rep with an active assignment to this client user?
create or replace function private.rep_has_client(client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_rep() and exists (
    select 1 from public.assignments a
    where a.active and a.rep_id = auth.uid() and a.client_user_id = client)
$$;

-- are these two profiles an active rep/client pair (either direction)?
-- Takes text so storage folder names that are not uuids simply return false.
create or replace function private.are_paired(a uuid, b_text text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.assignments x
    join public.profiles r on r.id = x.rep_id and r.status = 'active'
    join public.profiles c on c.id = x.client_user_id and c.status = 'active'
    where x.active
      and ((x.rep_id = a and x.client_user_id::text = b_text)
        or (x.client_user_id = a and x.rep_id::text = b_text)))
$$;

-- who is the caller's rep right now (null if none)
create or replace function private.rep_of(client uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.rep_id from public.assignments a
  join public.profiles r on r.id = a.rep_id and r.status = 'active' and r.role = 'rep'
  where a.active and a.client_user_id = client
  limit 1
$$;

-- write an audit row. actor = caller (may be null for cron/system)
create or replace function private.audit(p_action text, p_type text, p_target uuid, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, action, target_type, target_id, details)
  values (auth.uid(), p_action, p_type, p_target, coalesce(p_details, '{}'::jsonb))
$$;

-- =====================================================================
-- Triggers
-- =====================================================================

-- generic updated_at
create or replace function private.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();
drop trigger if exists quotes_touch on public.quotes;
create trigger quotes_touch before update on public.quotes
  for each row execute function private.touch_updated_at();

-- ---- quotes: owner, rep, 30 day expiry ----
create or replace function private.quotes_set_expiry() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.user_role;
begin
  if tg_op = 'INSERT' then
    new.owner_id   := coalesce(new.owner_id, auth.uid());
    -- API callers cannot back-date; only server-side sessions (seed, SQL editor) can.
    if auth.uid() is not null then new.created_at := now(); else new.created_at := coalesce(new.created_at, now()); end if;
    select p.role into r from public.profiles p where p.id = new.owner_id;
    new.rep_id := case when r = 'rep' then new.owner_id
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
drop trigger if exists quotes_expiry on public.quotes;
create trigger quotes_expiry before insert or update on public.quotes
  for each row execute function private.quotes_set_expiry();

-- soft delete -> audit
create or replace function private.quotes_audit_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform private.audit('quote_deleted', 'quote', new.id, jsonb_build_object('owner_id', new.owner_id));
  end if;
  return new;
end $$;
drop trigger if exists quotes_delete_audit on public.quotes;
create trigger quotes_delete_audit after update on public.quotes
  for each row execute function private.quotes_audit_delete();

-- ---- assignments: validate, link client account, audit ----
create or replace function private.assignments_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare rrole public.user_role; crow public.profiles;
begin
  select p.role into rrole from public.profiles p where p.id = new.rep_id;
  if rrole is distinct from 'rep' then
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
drop trigger if exists assignments_before_trg on public.assignments;
create trigger assignments_before_trg before insert or update on public.assignments
  for each row execute function private.assignments_before();

create or replace function private.assignments_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.audit('assignment_changed', 'assignment', new.id, jsonb_build_object(
    'client_email', new.client_email, 'rep_id', new.rep_id, 'active', new.active,
    'previous', case when tg_op = 'UPDATE' then jsonb_build_object('rep_id', old.rep_id, 'active', old.active) end));
  return new;
end $$;
drop trigger if exists assignments_after_trg on public.assignments;
create trigger assignments_after_trg after insert or update on public.assignments
  for each row execute function private.assignments_after();

-- ---- photos: keep profiles.avatar_path in sync, audit ----
create or replace function private.photos_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.profiles set avatar_path = null where id = old.owner_id;
    perform private.audit('photo_removed', 'photo', old.id, jsonb_build_object('owner_id', old.owner_id));
    return old;
  end if;
  new.updated_at := now();
  update public.profiles set avatar_path = new.storage_path where id = new.owner_id;
  perform private.audit('photo_changed', 'photo', new.id,
    jsonb_build_object('owner_id', new.owner_id, 'mime_type', new.mime_type, 'size_bytes', new.size_bytes));
  return new;
end $$;
drop trigger if exists photos_sync_ins_upd on public.photos;
create trigger photos_sync_ins_upd before insert or update on public.photos
  for each row execute function private.photos_sync();
drop trigger if exists photos_sync_del on public.photos;
create trigger photos_sync_del after delete on public.photos
  for each row execute function private.photos_sync();

-- ---- auth.users -> profiles (invite gate) ----
-- Runs when Supabase Auth creates a user (inviteUserByEmail does this).
-- No pending invitation for the email = signup rejected.
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

  insert into public.profiles (id, role, status, email, invited_by)
  values (new.id, inv.role, 'active', lower(new.email), inv.invited_by);

  update public.invitations set accepted_at = now(), accepted_user_id = new.id where id = inv.id;

  -- connect any assignment that was made by email before the account existed
  update public.assignments set client_user_id = new.id
   where client_email = lower(new.email) and client_user_id is null;

  insert into public.audit_log (actor_id, action, target_type, target_id, details)
  values (new.id, 'profile_created', 'profile', new.id, jsonb_build_object('role', inv.role, 'invited_by', inv.invited_by));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Keep profiles.email in step with a CONFIRMED change in auth.users.email.
-- (Supabase only updates auth.users.email after the new address is verified.)
create or replace function private.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is distinct from old.email and new.email is not null then
    update public.profiles set email = lower(new.email) where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function private.handle_user_email_change();
