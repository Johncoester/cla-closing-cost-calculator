-- =====================================================================
-- CLA Quote Portal: STAFF FEEDBACK ("Send feedback" for admins, super admins and reps)
-- Migration 13 (new file; migrations 1-12 untouched). Safe to run twice. Plain transaction, no enum changes.
--
-- WHO / WHAT
--   Staff = an ACTIVE profile with role super_admin, admin or rep (by ROLE: the "also works as a rep" flag does not matter,
--   clients / realtors and guests are never staff). Staff send feedback through ONE door, public.submit_feedback(); nobody can
--   insert, update or delete a feedback row through the API (no grants, no policies for those).
--   READ:  staff read their OWN rows (a "My feedback" status list); admin and super admin read ALL rows (private.is_admin(), MFA-aware).
--   DECIDE: only a super admin, through public.admin_set_feedback_status() (approved / dismissed + optional note).
--   The service role / SQL editor (what the assistant routine uses) can do anything, e.g. mark rows notified. See the
--   "ASSISTANT QUERIES" block at the bottom (comments only).
--
-- WHAT IS STORED (nothing else): id, created_at, user_id, role_at_submit, category, message, page_path, status, notified_at,
--   decided_at, decided_note, user_agent. The message is user content: treat it as untrusted wherever it is shown (the portal escapes it).
--
-- LIMITS (enforced in the RPC, per user): message 1-2000 characters after trimming; category bug|idea|question|other;
--   page path only (query and hash are cut off), at most 200 characters; at most 10 per rolling hour and 40 per rolling day.
-- =====================================================================

-- ---------- 1. the table ----------
create table if not exists public.feedback (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  user_id        uuid references public.profiles (id) on delete set null,     -- history survives removing the person
  role_at_submit text not null,
  category       text not null,
  message        text not null,
  page_path      text,
  status         text not null default 'new',
  notified_at    timestamptz,
  decided_at     timestamptz,
  decided_note   text,
  user_agent     text,
  constraint feedback_role_known     check (role_at_submit in ('super_admin', 'admin', 'rep')),
  constraint feedback_category_known check (category in ('bug', 'idea', 'question', 'other')),
  constraint feedback_message_len    check (length(message) between 1 and 2000),
  constraint feedback_page_len       check (page_path is null or length(page_path) <= 200),
  constraint feedback_status_known   check (status in ('new', 'notified', 'approved', 'dismissed')),
  constraint feedback_note_len       check (decided_note is null or length(decided_note) <= 1000),
  constraint feedback_agent_len      check (user_agent is null or length(user_agent) <= 300)
);
create index if not exists feedback_user_idx   on public.feedback (user_id, created_at desc);
create index if not exists feedback_status_idx on public.feedback (status, created_at);
alter table public.feedback enable row level security;

-- audit: two new actions (the list of migration 6 plus these)
alter table public.audit_log drop constraint if exists audit_action_known;
alter table public.audit_log add constraint audit_action_known check (action in (
  'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
  'export_run', 'profile_created', 'rep_flag_changed', 'feedback_submitted', 'feedback_decided'));

-- ---------- 2. helper: is the caller staff? ----------
create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.role in ('super_admin', 'admin', 'rep') from public.profiles p where p.id = auth.uid() and p.status = 'active'),
    false)
$$;
revoke execute on function private.is_staff() from public, anon, authenticated;
grant  execute on function private.is_staff() to authenticated;      -- called from RLS policies

-- ---------- 3. access: read only through RLS; every write goes through the RPCs below ----------
revoke all on public.feedback from anon, authenticated;
grant select on public.feedback to authenticated;
drop policy if exists feedback_select_own on public.feedback;
create policy feedback_select_own on public.feedback
  for select to authenticated using (user_id = auth.uid() and private.is_staff());
drop policy if exists feedback_select_admin on public.feedback;
create policy feedback_select_admin on public.feedback
  for select to authenticated using (private.is_admin());
-- (no insert / update / delete policy and no such grant: direct writes fail with 42501 for every API role)

-- ---------- 4. send feedback ----------
create or replace function public.submit_feedback(p_category text, p_message text, p_page text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); r public.user_role;
  cat text := lower(regexp_replace(coalesce(p_category, ''), '^\s+|\s+$', '', 'g'));      -- btrim() alone only strips spaces, not tabs / newlines
  msg text := regexp_replace(coalesce(p_message, ''), '^\s+|\s+$', '', 'g'); pg text; ua text; new_id uuid;
begin
  if uid is null or not private.is_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  if cat not in ('bug', 'idea', 'question', 'other') then
    raise exception 'category must be bug, idea, question or other' using errcode = '22023';
  end if;
  if msg = '' then raise exception 'message is required' using errcode = '22023'; end if;
  if length(msg) > 2000 then raise exception 'message is too long (2000 characters at most)' using errcode = '22023'; end if;
  -- the page: path only. Cut the query and hash off, keep it short, never trust it to look like a path.
  pg := nullif(regexp_replace(split_part(split_part(coalesce(p_page, ''), '#', 1), '?', 1), '^\s+|\s+$', '', 'g'), '');
  if pg is not null then pg := left(pg, 200); end if;
  -- user agent, taken from the request itself (not from a parameter, so it cannot be forged by the caller's JSON body)
  begin ua := left(nullif(btrim(current_setting('request.headers', true)::json ->> 'user-agent'), ''), 300);
  exception when others then ua := null; end;
  -- rate limit: 10 per rolling hour, 40 per rolling day, per person (a lock per person keeps two parallel sends honest)
  perform pg_advisory_xact_lock(hashtext('cla.feedback.' || uid::text));
  if (select count(*) from public.feedback f where f.user_id = uid and f.created_at > now() - interval '1 hour') >= 10
     or (select count(*) from public.feedback f where f.user_id = uid and f.created_at > now() - interval '1 day') >= 40 then
    raise exception 'you have sent a lot of feedback recently: please try again later' using errcode = '54000';
  end if;
  select p.role into r from public.profiles p where p.id = uid;
  insert into public.feedback (user_id, role_at_submit, category, message, page_path, user_agent)
  values (uid, r::text, cat, msg, pg, ua) returning id into new_id;
  perform private.audit('feedback_submitted', 'feedback', new_id, jsonb_build_object('category', cat));   -- never the message text
  return new_id;
end $$;

-- ---------- 5. decide (super admin only) ----------
create or replace function public.admin_set_feedback_status(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.feedback; note text := nullif(regexp_replace(coalesce(p_note, ''), '^\s+|\s+$', '', 'g'), '');
begin
  if not private.is_super_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('approved', 'dismissed') then
    raise exception 'status must be approved or dismissed' using errcode = '22023';
  end if;
  if note is not null and length(note) > 1000 then raise exception 'note is too long (1000 characters at most)' using errcode = '22023'; end if;
  select * into f from public.feedback where id = p_id;
  if not found then raise exception 'no such feedback' using errcode = 'P0002'; end if;
  update public.feedback set status = p_status, decided_at = now(), decided_note = note where id = p_id;
  perform private.audit('feedback_decided', 'feedback', p_id, jsonb_build_object('before', f.status, 'after', p_status));
end $$;

-- ---------- 6. function privileges (same pattern as the other RPCs) ----------
revoke execute on function public.submit_feedback(text, text, text), public.admin_set_feedback_status(uuid, text, text) from public, anon;
grant  execute on function public.submit_feedback(text, text, text), public.admin_set_feedback_status(uuid, text, text) to authenticated;

-- =====================================================================
-- ASSISTANT QUERIES (service role / SQL editor / Supabase MCP execute_sql). Comments only; nothing here runs.
--   -- new, not yet notified (oldest first):
--   select id, created_at, role_at_submit, category, message, page_path, user_id,
--          (select email from public.profiles p where p.id = f.user_id) as email
--     from public.feedback f where status = 'new' order by created_at;
--   -- after telling John:
--   update public.feedback set status = 'notified', notified_at = now() where id in ('<id>', ...) and status = 'new';
--   -- John's decision (the portal's super-admin buttons do the same, with an audit row; this is the SQL-editor equivalent):
--   update public.feedback set status = 'approved',  decided_at = now(), decided_note = '<optional note>' where id = '<id>';
--   update public.feedback set status = 'dismissed', decided_at = now(), decided_note = '<optional note>' where id = '<id>';
-- =====================================================================
