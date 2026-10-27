-- =====================================================================
-- CLA Quote Portal: FEEDBACK STATUS UPDATES for the sender (migration 17, new file; migrations 1-16 untouched).
-- Safe to run twice. One plain transaction, no enum changes. NO e-mail is sent by anything in here (nothing outbound at all).
--
-- WHAT IT ADDS
--   1. A new status 'shipped' (new -> notified -> approved -> shipped, or dismissed). Three new columns on public.feedback:
--        shipped_at  timestamptz   when it was marked shipped
--        shipped_note text (<= 500) a short "what changed", shown to the sender
--        sender_seen_status text   the status the SENDER last looked at (their "seen" marker; null = never looked at a decision)
--      "Unread" for the sender = status in (approved, shipped, dismissed) and sender_seen_status is distinct from status.
--      Rows that were already decided when this migration runs are backfilled as seen (nobody gets a surprise dot for old decisions).
--   2. public.admin_mark_feedback_shipped(id, note): SUPER ADMIN ONLY (same permission as approve / dismiss), only for an APPROVED item.
--   3. public.mark_my_feedback_seen(id default null): the sender marks their OWN item (or all their own items) as seen. This is the ONLY thing a
--      sender can write, and it can only copy the current status into sender_seen_status (it never changes status or notes).
--   4. admin_set_feedback_status() is replaced: same rules (super admin; approved or dismissed; optional note), plus: a SHIPPED item cannot be
--      re-decided, and a decision that changes the status or the note clears the sender's seen marker (so the sender sees it as new again).
--   5. audit action 'feedback_shipped' (the list of migration 16 plus this one).
--
-- WHO CAN SEE / DO WHAT (unchanged where not listed)
--   Senders (staff) still read ONLY their own rows (RLS feedback_select_own) and still have no insert / update / delete grant: they cannot
--   change a status, a note, or anyone else's seen marker. Admins read all rows; only a super admin decides or ships.
--   The assistant routine (service role: new -> notified) is not touched; 'notified' simply shows to the sender as "Received".
-- =====================================================================

-- ---------- 1. columns, status ----------
alter table public.feedback add column if not exists shipped_at         timestamptz;
alter table public.feedback add column if not exists shipped_note       text;
alter table public.feedback add column if not exists sender_seen_status text;

alter table public.feedback drop constraint if exists feedback_status_known;
alter table public.feedback add constraint feedback_status_known check (status in ('new', 'notified', 'approved', 'shipped', 'dismissed'));
alter table public.feedback drop constraint if exists feedback_shipped_note_len;
alter table public.feedback add constraint feedback_shipped_note_len check (shipped_note is null or length(shipped_note) <= 500);
alter table public.feedback drop constraint if exists feedback_seen_known;
alter table public.feedback add constraint feedback_seen_known check (sender_seen_status is null or sender_seen_status in ('new', 'notified', 'approved', 'shipped', 'dismissed'));

-- already-decided rows count as seen (no dot for decisions that were made before this existed)
update public.feedback set sender_seen_status = status where status in ('approved', 'dismissed') and sender_seen_status is null;

-- audit: one new action
alter table public.audit_log drop constraint if exists audit_action_known;
alter table public.audit_log add constraint audit_action_known check (action in (
  'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
  'export_run', 'profile_created', 'rep_flag_changed', 'feedback_submitted', 'feedback_decided', 'pricing_table_changed', 'feedback_shipped'));

-- ---------- 2. decide (super admin only): same as migration 13, plus no re-deciding a shipped item and the seen marker ----------
create or replace function public.admin_set_feedback_status(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.feedback; note text := nullif(regexp_replace(coalesce(p_note, ''), '^\s+|\s+$', '', 'g'), '');
begin
  if not private.is_super_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('approved', 'dismissed') then
    raise exception 'status must be approved or dismissed' using errcode = '22023';
  end if;
  if note is not null and length(note) > 1000 then raise exception 'note is too long (1000 characters at most)' using errcode = '22023'; end if;
  select * into f from public.feedback where id = p_id for update;
  if not found then raise exception 'no such feedback' using errcode = 'P0002'; end if;
  if f.status = 'shipped' then raise exception 'this item is already shipped' using errcode = '22023'; end if;
  update public.feedback set status = p_status, decided_at = now(), decided_note = note,
         sender_seen_status = case when f.status is distinct from p_status or f.decided_note is distinct from note then null else sender_seen_status end
   where id = p_id;
  perform private.audit('feedback_decided', 'feedback', p_id, jsonb_build_object('before', f.status, 'after', p_status));
end $$;

-- ---------- 3. mark shipped (super admin only, approved items only) ----------
create or replace function public.admin_mark_feedback_shipped(p_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.feedback; note text := nullif(regexp_replace(coalesce(p_note, ''), '^\s+|\s+$', '', 'g'), '');
begin
  if not private.is_super_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if note is not null and length(note) > 500 then raise exception 'note is too long (500 characters at most)' using errcode = '22023'; end if;
  select * into f from public.feedback where id = p_id for update;
  if not found then raise exception 'no such feedback' using errcode = 'P0002'; end if;
  if f.status <> 'approved' then raise exception 'only an approved item can be marked shipped' using errcode = '22023'; end if;
  update public.feedback set status = 'shipped', shipped_at = now(), shipped_note = note, sender_seen_status = null where id = p_id;
  perform private.audit('feedback_shipped', 'feedback', p_id, jsonb_build_object('before', f.status, 'after', 'shipped'));   -- never the note text
end $$;

-- ---------- 4. the sender marks their own items as seen ----------
-- No id = all of the caller's own rows. Only copies the current status into sender_seen_status; returns how many rows changed.
create or replace function public.mark_my_feedback_seen(p_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if auth.uid() is null or not private.is_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.feedback f set sender_seen_status = f.status
   where f.user_id = auth.uid() and (p_id is null or f.id = p_id) and f.sender_seen_status is distinct from f.status;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- 5. function privileges (same pattern as the other RPCs) ----------
revoke execute on function public.admin_set_feedback_status(uuid, text, text), public.admin_mark_feedback_shipped(uuid, text), public.mark_my_feedback_seen(uuid) from public, anon;
grant  execute on function public.admin_set_feedback_status(uuid, text, text), public.admin_mark_feedback_shipped(uuid, text), public.mark_my_feedback_seen(uuid) to authenticated;
