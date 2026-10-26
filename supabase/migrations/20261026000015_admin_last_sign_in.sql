-- =====================================================================
-- CLA Quote Portal: "has this person ever signed in?" for the admin Users table
-- Migration 15 (new file; migrations 1-14 untouched). Forward-only, safe to run twice (create or replace). Plain transaction.
-- NOT APPLIED to any live project yet. See the README "Invited, never signed in" section.
--
-- WHY
--   profiles.status = 'active' from the moment a person is INVITED (the profile row is created with the auth user),
--   so the Users table showed "Active" for people who had never opened their invite. profiles.last_seen_at cannot answer
--   this: no code ever writes it (it stays NULL for everybody, including people who sign in every day).
--   The only reliable source is auth.users.last_sign_in_at (NULL until the first sign-in, which includes accepting the
--   invite link). The browser cannot read the auth schema, so admins get it through this one read-only RPC.
--
-- WHAT
--   public.admin_list_last_sign_ins() -> (user_id uuid, last_sign_in_at timestamptz), one row per profile.
--   Admin and super admin only (private.is_admin(), MFA-aware like every other admin read); everyone else gets 42501.
--   It returns ONLY the sign-in time of people who have a profile: no emails, no tokens, no other auth columns.
--   No table, column, grant or policy changes. The site works without it (the page then shows plain "Active", never a wrong badge).
-- =====================================================================
create or replace function public.admin_list_last_sign_ins()
returns table (user_id uuid, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select p.id, u.last_sign_in_at
      from public.profiles p
      left join auth.users u on u.id = p.id;
end $$;
revoke execute on function public.admin_list_last_sign_ins() from public, anon;
grant  execute on function public.admin_list_last_sign_ins() to authenticated;
comment on function public.admin_list_last_sign_ins() is
  'Admin / super admin only: auth.users.last_sign_in_at per profile (NULL = never signed in). Read-only; used by the admin Users table badge.';
