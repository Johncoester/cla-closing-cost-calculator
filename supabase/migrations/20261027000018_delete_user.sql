-- =====================================================================
-- CLA Quote Portal: DELETE A USER (migration 18, new file; migrations 1-17 untouched).
-- Safe to run twice. One plain transaction, no enum changes, no table changes. Nothing is sent to anybody.
--
-- WHAT IT ADDS
--   public.admin_delete_user(p_user, p_confirm_email, p_reassign_to default null) returns jsonb
--   Permanently removes ONE person's portal account, but only after they were DISABLED. The set-user-status Edge Function disables (and bans);
--   the new delete-user Edge Function calls this function first, and only when it succeeds removes the photo file and the Auth user.
--
-- WHO MAY DELETE WHOM (the same people who may DISABLE, migrations 10 and 11)
--   super admin: anyone except themselves.
--   admin:       reps, clients and other admins; NEVER a super admin, never themselves.
--   Refused (and nothing changes) when: the caller is not an admin / super admin (42501); the target is the caller (42501); an admin targets a super
--   admin (42501); the target is NOT disabled (55000, "disable first"); the typed email does not match the target's email (22023); the target is
--   the last ACTIVE super admin (55000; cannot happen to a disabled one, kept as a second guard); the target is a rep (or an admin who also reps)
--   with ACTIVE clients and no p_reassign_to was given (23514), or p_reassign_to is not an active rep (23514).
--
-- WHAT HAPPENS TO THEIR DATA
--   deleted   the profile row (name, phone, company, license) and with it, by the existing cascades: their photo row, and every quote they OWNED
--             (a client's saved quotes, a rep's own saved quotes; quotes self-delete after 30 days anyway)
--   moved     if they were a rep with active clients: every active client goes to p_reassign_to (history rows kept for the clients, like
--             admin_set_role does). Nobody is left without a rep.
--   removed   rows that only exist for this person: their own assignment rows when they were a client; the assignment history rows that name them
--             as the rep (assignments.rep_id is "on delete restrict", so these must go first); their invitation rows (so the email can be invited
--             again cleanly); their pricing-table membership (so a re-invited person does not silently get the old special fee)
--   detached  (kept) quotes where they were the rep on somebody else's quote: rep_id becomes null (existing foreign key). The clients' quotes stay
--             and are visible to the NEW rep through the assignment. Feedback they sent: kept, shown without a name (feedback.user_id set null,
--             existing foreign key). Anything they created or changed (invitations, assignments, pricing tables, profiles.invited_by): the
--             "who" column becomes null (existing foreign keys).
--   kept      the audit log (append only; earlier rows still name the old id) and ONE new row 'user_deleted' with: email, role, name, who deleted
--             them (id and email), when (the row's timestamp), how many quotes were deleted / detached, clients moved and to whom, feedback kept,
--             pricing table they were removed from. No passwords, no photo, no message text.
--   outside the database (done by the Edge Function, after this succeeds): the photo file in the avatars bucket, and the Supabase Auth user
--             (sign-in record). The same email can be invited again afterwards (a brand-new account; nothing carries over).
-- =====================================================================

-- ---------- 1. audit action ----------
alter table public.audit_log drop constraint if exists audit_action_known;
alter table public.audit_log add constraint audit_action_known check (action in (
  'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
  'export_run', 'profile_created', 'rep_flag_changed', 'feedback_submitted', 'feedback_decided', 'pricing_table_changed',
  'feedback_shipped', 'user_deleted'));

-- ---------- 2. three existing triggers learn what "person removed" looks like ----------
-- Deleting a profile sets "who" columns to null through the foreign keys (ON DELETE SET NULL). Three triggers would get in the way of that:
--   quotes_set_expiry      made quotes.rep_id immutable even for the foreign-key action, so the key would have been left pointing at nobody.
--                          Now rep_id may become null, but ONLY when the rep it named no longer exists (nobody can change a quote's rep any other way).
--   assignments_before     re-checks "is the rep still rep-capable" on every update; a history row whose rep has since been demoted would have blocked
--                          the delete of the admin who made it. Now an update that only clears assigned_by is not re-validated.
--   assignments_after      would write one 'assignment_changed' audit row per cleared assigned_by. Now it skips exactly that case (the single
--                          'user_deleted' row says everything).
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
    -- immutable after insert, even for admins using the API (the one exception: the rep it named was deleted, so the foreign key clears it)
    new.owner_id   := old.owner_id;
    new.rep_id     := case when new.rep_id is null and old.rep_id is not null
                                and not exists (select 1 from public.profiles p where p.id = old.rep_id)
                           then null else old.rep_id end;
    new.created_at := old.created_at;
  end if;
  -- AUTO-DELETE RULE: 30 days after creation. Change here AND in app_settings text.
  new.expires_at := new.created_at + interval '30 days';
  return new;
end $$;

create or replace function private.assignments_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare rrole public.user_role; risrep boolean; crow public.profiles;
begin
  -- only "assigned_by" was cleared (the person who made the assignment was deleted): nothing to re-validate
  if tg_op = 'UPDATE' and new.assigned_by is null and old.assigned_by is not null
     and new.rep_id = old.rep_id and new.client_email = old.client_email and new.active = old.active
     and new.client_user_id is not distinct from old.client_user_id then
    return new;
  end if;
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

create or replace function private.assignments_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.assigned_by is null and old.assigned_by is not null
     and new.rep_id = old.rep_id and new.client_email = old.client_email and new.active = old.active
     and new.client_user_id is not distinct from old.client_user_id then
    return new;
  end if;
  perform private.audit('assignment_changed', 'assignment', new.id, jsonb_build_object(
    'client_email', new.client_email, 'rep_id', new.rep_id, 'active', new.active,
    'previous', case when tg_op = 'UPDATE' then jsonb_build_object('rep_id', old.rep_id, 'active', old.active) end));
  return new;
end $$;

-- ---------- 3. the RPC ----------
create or replace function public.admin_delete_user(p_user uuid, p_confirm_email text, p_reassign_to uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.profiles; actor_email text;
  n_active int := 0; moved int := 0; n_quotes int; n_detached int; n_feedback int; had_photo boolean; ptable text;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user is null then raise exception 'user is required' using errcode = '22023'; end if;
  if p_user = auth.uid() then raise exception 'you cannot delete yourself' using errcode = '42501'; end if;
  select * into t from public.profiles where id = p_user for update;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  -- same reach as disabling: an admin never touches a super admin
  if not private.is_super_admin() and t.role = 'super_admin' then
    raise exception 'only a super admin can delete a super admin' using errcode = '42501';
  end if;
  if t.status <> 'disabled' then
    raise exception 'disable this person first: only a disabled user can be deleted' using errcode = '55000';
  end if;
  if lower(btrim(coalesce(p_confirm_email, ''))) <> t.email then
    raise exception 'the email you typed does not match this person''s email' using errcode = '22023';
  end if;
  if t.role = 'super_admin' and t.status = 'active' and not private.other_active_super_admin(p_user) then
    raise exception 'there must always be at least one active super admin' using errcode = '55000';
  end if;

  -- a rep (or admin who also reps) hands over the ACTIVE clients first
  n_active := private.active_client_count(p_user);
  if n_active > 0 then
    if p_reassign_to is null then
      raise exception 'this person still has % active client(s): choose another rep to take them over', n_active using errcode = '23514';
    end if;
    moved := private.move_rep_clients(p_user, p_reassign_to);
  end if;

  select count(*)::int into n_quotes   from public.quotes   where owner_id = p_user;
  select count(*)::int into n_detached from public.quotes   where rep_id = p_user and owner_id <> p_user;
  select count(*)::int into n_feedback from public.feedback where user_id = p_user;
  select exists (select 1 from public.photos where owner_id = p_user) into had_photo;
  select pt.name into ptable from public.pricing_table_members m join public.pricing_tables pt on pt.id = m.table_id where m.email = t.email;
  select p.email into actor_email from public.profiles p where p.id = auth.uid();

  -- rows that only exist for this person (deletes fire no assignment trigger, so a rep who lost rep rights later cannot block this)
  delete from public.assignments        where rep_id = p_user or client_email = t.email or client_user_id = p_user;
  delete from public.invitations        where email = t.email;
  delete from public.pricing_table_members where email = t.email;

  perform private.audit('user_deleted', 'profile', p_user, jsonb_build_object(
    'email', t.email, 'role', t.role, 'name', btrim(t.first_name || ' ' || t.last_name), 'was_rep', t.role = 'rep' or t.is_rep,
    'deleted_by_email', actor_email,
    'quotes_deleted', n_quotes, 'quotes_detached', n_detached, 'clients_moved', moved, 'moved_to', p_reassign_to,
    'feedback_kept', n_feedback, 'photo', had_photo, 'pricing_table', ptable));

  -- the cascades do the rest (photo row, owned quotes; set null on everything that only names them)
  delete from public.profiles where id = p_user;
  return jsonb_build_object('email', t.email, 'role', t.role, 'quotes_deleted', n_quotes, 'quotes_detached', n_detached,
                            'clients_moved', moved, 'feedback_kept', n_feedback, 'photo', had_photo);
end $$;

-- ---------- 4. privileges (same pattern as the other admin RPCs) ----------
revoke execute on function public.admin_delete_user(uuid, text, uuid) from public, anon;
grant  execute on function public.admin_delete_user(uuid, text, uuid) to authenticated;
