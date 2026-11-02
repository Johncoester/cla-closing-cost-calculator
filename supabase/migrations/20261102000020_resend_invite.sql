-- =====================================================================
-- CLA Quote Portal: RESEND AN INVITE (migration 20, new file; migrations 1-19 untouched). John 11/02/26.
-- Safe to run twice. One plain transaction, no enum changes. Nothing is sent by the migration itself.
--
-- WHAT IT ADDS
--   private.invite_resends            one row per person: when the invite was last RE-sent, by whom, how many times (not reachable through the API)
--   public.admin_resend_invite(p_user uuid) returns jsonb
--       Called by the resend-invite Edge Function AS THE CALLER, before any email goes out. It decides who may, records the resend and the
--       'invite_resent' audit row, and returns the email to send to (the browser never chooses the address).
--   public.list_invite_status()       -> (user_id, signed_in, invite_last_sent_at)   for "Invite last sent <date>" and whether to show the button:
--       admins / super admins: every profile; a rep: only their own ACTIVE clients; anyone else 42501.
--
-- WHO MAY RESEND (John 11/02/26: "allow sales team to reinvite their clients as well")
--   admin / super admin: anyone (rep, client, admin, super admin) who has not signed in and is not disabled.
--   rep (role rep, or an admin / super admin who also works as a rep, private.is_rep()): ONLY a client who is currently assigned to them
--     (an active assignment with rep_id = the caller). Never another rep's client, an unassigned client, or staff.
--   clients: nobody.
-- REFUSED (nothing recorded) when
--   42501  the caller may not resend to this person (see above; admin checks are MFA-aware through private.is_admin())
--   P0002  no such person
--   55000  the person is disabled, or has already signed in (auth.users.last_sign_in_at is set): they use "Forgot password" instead
--   PT429  an invite went to this person less than 60 seconds ago (the original invite or a resend): stops double clicks sending two emails
-- =====================================================================

-- ---------- 1. audit action ----------
alter table public.audit_log drop constraint if exists audit_action_known;
alter table public.audit_log add constraint audit_action_known check (action in (
  'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
  'export_run', 'profile_created', 'rep_flag_changed', 'feedback_submitted', 'feedback_decided', 'pricing_table_changed',
  'feedback_shipped', 'user_deleted', 'invite_resent'));

-- ---------- 2. resend bookkeeping (private schema: no API access) ----------
create table if not exists private.invite_resends (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  last_sent_at  timestamptz not null default now(),
  last_sent_by  uuid references public.profiles (id) on delete set null,
  resend_count  integer not null default 1
);
revoke all on private.invite_resends from public, anon, authenticated;

-- ---------- 3. the check + record ----------
create or replace function public.admin_resend_invite(p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.profiles%rowtype; signed timestamptz; invited timestamptz; confirmed timestamptz; n integer; as_admin boolean := private.is_admin();
begin
  select * into t from public.profiles where id = p_user;
  if not as_admin then
    -- a rep: only their own, currently assigned client (checked before anything else, so a rep learns nothing about other people)
    if not (private.is_rep() and found and t.role = 'client' and exists (
        select 1 from public.assignments a where a.active and a.rep_id = auth.uid() and (a.client_user_id = p_user or a.client_email = t.email))) then
      raise exception 'You can only resend an invite to your own clients.' using errcode = '42501';
    end if;
  elsif not found then raise exception 'no such user' using errcode = 'P0002';
  end if;
  if t.status <> 'active' then raise exception 'This person is disabled. Re-enable them first.' using errcode = '55000'; end if;
  select u.last_sign_in_at, u.invited_at, u.email_confirmed_at into signed, invited, confirmed from auth.users u where u.id = p_user;
  if signed is not null then
    raise exception 'This person has already signed in. They can use "Forgot password" on the sign-in page.' using errcode = '55000';
  end if;
  if invited is not null and invited > now() - interval '60 seconds' then
    raise exception 'An invite was sent less than a minute ago. Wait a minute before sending another.' using errcode = 'PT429';
  end if;
  -- atomic: two clicks at the same moment cannot both pass (the second one updates nothing)
  insert into private.invite_resends as r (user_id, last_sent_at, last_sent_by, resend_count) values (p_user, now(), auth.uid(), 1)
  on conflict (user_id) do update set last_sent_at = now(), last_sent_by = auth.uid(), resend_count = r.resend_count + 1
    where r.last_sent_at <= now() - interval '60 seconds'
  returning r.resend_count into n;
  if n is null then
    raise exception 'An invite was sent less than a minute ago. Wait a minute before sending another.' using errcode = 'PT429';
  end if;
  perform private.audit('invite_resent', 'profile', p_user, jsonb_build_object('email', t.email, 'role', t.role, 'resend_count', n, 'as', case when as_admin then 'admin' else 'rep' end));
  return jsonb_build_object('email', t.email, 'role', t.role, 'confirmed', confirmed is not null, 'resend_count', n);
end $$;
revoke execute on function public.admin_resend_invite(uuid) from public, anon;
grant  execute on function public.admin_resend_invite(uuid) to authenticated;
comment on function public.admin_resend_invite(uuid) is
  'Checks and records an invite resend for a person who never signed in (admins / super admins: anyone; reps: their own active clients); the resend-invite Edge Function then emails them.';

-- ---------- 4. who has signed in / "Invite last sent", for the admin Users table and the rep's client list ----------
create or replace function public.list_invite_status()
returns table (user_id uuid, signed_in boolean, invite_last_sent_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare as_admin boolean := private.is_admin();
begin
  if not as_admin and not private.is_rep() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select p.id, u.last_sign_in_at is not null,
           nullif(greatest(coalesce(u.invited_at, '-infinity'), coalesce(r.last_sent_at, '-infinity')), '-infinity')
      from public.profiles p
      left join auth.users u on u.id = p.id
      left join private.invite_resends r on r.user_id = p.id
     where as_admin or (p.role = 'client' and exists (
             select 1 from public.assignments a where a.active and a.rep_id = auth.uid() and (a.client_user_id = p.id or a.client_email = p.email)));
end $$;
revoke execute on function public.list_invite_status() from public, anon;
grant  execute on function public.list_invite_status() to authenticated;
comment on function public.list_invite_status() is
  'Admins / super admins: every profile; reps: their own active clients. Whether each has signed in and when an invite was last sent. Read-only.';
