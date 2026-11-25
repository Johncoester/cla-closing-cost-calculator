-- =====================================================================
-- Migration 22: Upload CLA fees (John, 11/25). New file; migrations 1-21 untouched.
-- Safe to run twice. One plain transaction. NOT APPLIED to any project (local tests only).
--
-- WHAT JOHN ASKED FOR
--   Admins upload CLA's own fees per state (the CLA_Fees tab of "CLA Fee Tables (Live - Calculator)":
--   settlement, title search, doc prep, notary, Simplifile, CPL ...). Any state, not just MD/VA/DC/FL.
--   Nothing goes live until a SUPER ADMIN (John) approves it.
--
-- HOW
--   public.cla_fee_batches      one uploaded file = one batch: pending -> approved | rejected | withdrawn.
--   public.cla_fee_batch_rows   the rows of a batch, same columns as the CLA_Fees tab.
--   public.cla_fees_live        the APPROVED CLA fees, for the states that have ever been approved here.
--                               Approving a batch REPLACES every row of each state in the file (a state not in the
--                               file is untouched). The calculator reads public.get_cla_fees() and, for those states only,
--                               uses these rows instead of the sheet's CLA_Fees rows. Other tabs (recording, taxes,
--                               premiums ...) and every other state still come from the sheet / built-in snapshot.
--   Empty cla_fees_live (the state right after this migration) = the calculator behaves exactly as before.
--
-- WHO MAY DO WHAT
--   submit   admin / super admin: public.admin_submit_cla_fee_batch(file_name, rows, note)
--            The server re-validates every row (the browser check is only for the preview). Any bad row = nothing saved.
--            Caps: 500 rows per file, 20 uploads per person per rolling hour, one PENDING batch per state at a time.
--   withdraw admin / super admin: public.admin_withdraw_cla_fee_batch(batch, note)   (pending only)
--   approve  SUPER ADMIN only: public.super_admin_approve_cla_fee_batch(batch, note) (pending only)
--   reject   SUPER ADMIN only: public.super_admin_reject_cla_fee_batch(batch, note)  (pending only)
--   read     batches, batch rows and live rows (with notes): admins only (RLS select policies).
--            Everyone (anon included, the public calculator) : public.get_cla_fees() -> live rows WITHOUT the notes column.
--   Nobody has an insert / update / delete grant or policy on the three tables; every change is audited ('cla_fees_changed').
-- =====================================================================

-- ---------- 1. tables ----------
create table if not exists public.cla_fee_batches (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'pending',
  file_name      text,
  note           text,
  states         text[] not null,
  row_count      integer not null,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  decided_by     uuid references public.profiles (id) on delete set null,
  decided_at     timestamptz,
  decision_note  text,
  constraint cla_fee_batches_status check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  constraint cla_fee_batches_text_len check (length(coalesce(file_name, '')) <= 200 and length(coalesce(note, '')) <= 500 and length(coalesce(decision_note, '')) <= 500),
  constraint cla_fee_batches_rows check (row_count between 1 and 500)
);
create index if not exists cla_fee_batches_created_idx on public.cla_fee_batches (created_at desc);
alter table public.cla_fee_batches enable row level security;

create table if not exists public.cla_fee_batch_rows (
  batch_id    uuid not null references public.cla_fee_batches (id) on delete cascade,
  line        integer not null,
  active      boolean not null,
  state       text not null,
  fee_name    text not null,
  transaction text not null,
  amount      numeric(12,2) not null,
  paid_by     text not null,
  le_section  text not null,
  default_on  boolean not null,
  notes       text,
  primary key (batch_id, line)
);
alter table public.cla_fee_batch_rows enable row level security;

create table if not exists public.cla_fees_live (
  id          uuid primary key default gen_random_uuid(),
  state       text not null,
  line        integer not null,
  active      boolean not null,
  fee_name    text not null,
  transaction text not null,
  amount      numeric(12,2) not null,
  paid_by     text not null,
  le_section  text not null,
  default_on  boolean not null,
  notes       text,
  batch_id    uuid not null references public.cla_fee_batches (id),
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz not null default now()
);
create index if not exists cla_fees_live_state_idx on public.cla_fees_live (state, line);
alter table public.cla_fees_live enable row level security;

-- the same check constraints on both row tables (re-runnable)
do $$ declare t text; begin
  foreach t in array array['cla_fee_batch_rows', 'cla_fees_live'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_valid');
    execute format($c$alter table public.%I add constraint %I check (
      state ~ '^[A-Z]{2}$' and length(fee_name) between 1 and 120 and fee_name = btrim(fee_name)
      and transaction in ('Purchase', 'Refi', 'Financed', 'Both')
      and paid_by in ('Buyer', 'Seller', 'Borrower', 'Split')
      and le_section in ('B', 'C', 'E', 'H')
      and amount >= 0 and amount <= 100000
      and length(coalesce(notes, '')) <= 1000)$c$, t, t || '_valid');
  end loop;
end $$;

revoke all on public.cla_fee_batches, public.cla_fee_batch_rows, public.cla_fees_live from anon, authenticated;
grant select on public.cla_fee_batches, public.cla_fee_batch_rows, public.cla_fees_live to authenticated;
drop policy if exists cla_fee_batches_select_admin on public.cla_fee_batches;
create policy cla_fee_batches_select_admin on public.cla_fee_batches for select to authenticated using (private.is_admin());
drop policy if exists cla_fee_batch_rows_select_admin on public.cla_fee_batch_rows;
create policy cla_fee_batch_rows_select_admin on public.cla_fee_batch_rows for select to authenticated using (private.is_admin());
drop policy if exists cla_fees_live_select_admin on public.cla_fees_live;
create policy cla_fees_live_select_admin on public.cla_fees_live for select to authenticated using (private.is_admin());

-- ---------- 2. audit action ----------
alter table public.audit_log drop constraint if exists audit_action_known;
alter table public.audit_log add constraint audit_action_known check (action in (
  'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
  'export_run', 'profile_created', 'rep_flag_changed', 'feedback_submitted', 'feedback_decided', 'pricing_table_changed',
  'feedback_shipped', 'user_deleted', 'invite_resent', 'cla_fees_changed'));

-- ---------- 3. helpers (private: not callable through the API) ----------
create or replace function private.us_state_codes() returns text[]
language sql immutable set search_path = '' as $$
  select array['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
               'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']
$$;

-- Y / N style flags: returns null when the value is not recognised. Blank = the default.
create or replace function private.cla_fee_flag(v text, dflt boolean) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when btrim(coalesce(v, '')) = '' then dflt
    when lower(btrim(v)) in ('y', 'yes', 'true', '1') then true
    when lower(btrim(v)) in ('n', 'no', 'false', '0') then false
    else null end
$$;
revoke execute on function private.us_state_codes(), private.cla_fee_flag(text, boolean) from public, anon, authenticated;

-- ---------- 4. submit ----------
create or replace function public.admin_submit_cla_fee_batch(p_file_name text, p_rows jsonb, p_note text default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  rec jsonb; i int := 0; errs text[] := '{}';
  v_state text; v_name text; v_tx text; v_amt_raw text; v_amt numeric; v_paid text; v_sec text; v_notes text;
  v_active boolean; v_default boolean;
  keys text[] := '{}'; k text; sts text[] := '{}';
  busy text; bid uuid; n_hour int;
  clean jsonb := '[]'::jsonb;
begin
  if not private.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no fee rows.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'Upload at most 500 fee rows at a time.' using errcode = '22023';
  end if;
  if length(coalesce(p_file_name, '')) > 200 or length(coalesce(p_note, '')) > 500 then
    raise exception 'The file name or note is too long.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cla.cla_fee_batches'));
  select count(*)::int into n_hour from public.cla_fee_batches where created_by = auth.uid() and created_at > now() - interval '1 hour';
  if n_hour >= 20 then
    raise exception 'Upload limit reached (20 per hour). Wait before uploading again.' using errcode = 'PT429';
  end if;

  for rec in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    if jsonb_typeof(rec) <> 'object' then errs := errs || ('Row ' || i || ': not a fee row.'); continue; end if;
    v_state := upper(btrim(coalesce(rec->>'state', '')));
    v_name := regexp_replace(btrim(coalesce(rec->>'fee_name', '')), '\s+', ' ', 'g');
    v_tx := lower(btrim(coalesce(rec->>'transaction', '')));
    v_tx := case v_tx when 'purchase' then 'Purchase' when 'refi' then 'Refi' when 'refinance' then 'Refi'
                      when 'financed' then 'Financed' when 'both' then 'Both' else null end;
    v_paid := lower(btrim(coalesce(rec->>'paid_by', '')));
    v_paid := case v_paid when 'buyer' then 'Buyer' when 'seller' then 'Seller' when 'borrower' then 'Borrower' when 'split' then 'Split' else null end;
    v_sec := upper(btrim(coalesce(rec->>'le_section', '')));
    if v_sec = '' then v_sec := 'C'; end if;
    v_amt_raw := regexp_replace(coalesce(rec->>'amount', ''), '[$,\s]', '', 'g');
    v_amt := null;
    if v_amt_raw ~ '^\d+(\.\d{1,2})?$' then v_amt := v_amt_raw::numeric; end if;
    v_active := private.cla_fee_flag(rec->>'active', true);
    v_default := private.cla_fee_flag(rec->>'default_on', true);
    v_notes := nullif(btrim(coalesce(rec->>'notes', '')), '');

    if not (v_state = any (private.us_state_codes())) then errs := errs || ('Row ' || i || ': state must be a US state code like MD.');
    elsif v_name = '' then errs := errs || ('Row ' || i || ': fee name is required.');
    elsif length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then errs := errs || ('Row ' || i || ': fee name is too long or has hidden characters.');
    elsif v_tx is null then errs := errs || ('Row ' || i || ': transaction must be Purchase, Refi, Financed or Both.');
    elsif v_amt is null then errs := errs || ('Row ' || i || ': amount must be a number like 450 or 4.75.');
    elsif v_amt > 100000 then errs := errs || ('Row ' || i || ': amount is over $100,000.');
    elsif v_paid is null then errs := errs || ('Row ' || i || ': paid by must be Buyer, Seller, Borrower or Split.');
    elsif v_sec not in ('B', 'C', 'E', 'H') then errs := errs || ('Row ' || i || ': LE section must be B, C, E or H.');
    elsif v_active is null then errs := errs || ('Row ' || i || ': Active must be Y or N.');
    elsif v_default is null then errs := errs || ('Row ' || i || ': Default On must be Y or N.');
    elsif length(coalesce(v_notes, '')) > 1000 then errs := errs || ('Row ' || i || ': notes are too long (1000 characters at most).');
    else
      k := v_state || '|' || lower(v_name) || '|' || v_tx || '|' || v_paid;
      if k = any (keys) then
        errs := errs || ('Row ' || i || ': duplicate of an earlier row (same state, fee, transaction and payer).');
      else
        keys := keys || k;
        if not (v_state = any (sts)) then sts := sts || v_state; end if;
        clean := clean || jsonb_build_array(jsonb_build_object('line', i, 'active', v_active, 'state', v_state, 'fee_name', v_name,
          'transaction', v_tx, 'amount', v_amt, 'paid_by', v_paid, 'le_section', v_sec, 'default_on', v_default, 'notes', v_notes));
      end if;
    end if;
  end loop;

  if array_length(errs, 1) > 0 then
    raise exception 'Nothing was saved. Fix these rows: %', array_to_string(errs[1:10], ' ')
      || case when array_length(errs, 1) > 10 then ' (and ' || (array_length(errs, 1) - 10) || ' more)' else '' end
      using errcode = '22023';
  end if;

  select string_agg(s, ', ' order by s) into busy
    from (select distinct unnest(b.states) s from public.cla_fee_batches b where b.status = 'pending') x
   where s = any (sts);
  if busy is not null then
    raise exception 'There is already an upload waiting for approval for %. Approve, reject or withdraw it first.', busy using errcode = '23505';
  end if;

  insert into public.cla_fee_batches (file_name, note, states, row_count, created_by)
  values (nullif(btrim(coalesce(p_file_name, '')), ''), nullif(btrim(coalesce(p_note, '')), ''),
          (select array_agg(s order by s) from unnest(sts) s), jsonb_array_length(clean), auth.uid())
  returning id into bid;

  insert into public.cla_fee_batch_rows (batch_id, line, active, state, fee_name, transaction, amount, paid_by, le_section, default_on, notes)
  select bid, (r->>'line')::int, (r->>'active')::boolean, r->>'state', r->>'fee_name', r->>'transaction', (r->>'amount')::numeric,
         r->>'paid_by', r->>'le_section', (r->>'default_on')::boolean, r->>'notes'
    from jsonb_array_elements(clean) r;

  insert into public.audit_log (actor_id, action, target_type, target_id, details)
  values (auth.uid(), 'cla_fees_changed', 'cla_fee_batch', bid,
          jsonb_build_object('op', 'submit', 'states', to_jsonb(sts), 'rows', jsonb_array_length(clean), 'file_name', p_file_name));
  return bid;
end $$;
revoke execute on function public.admin_submit_cla_fee_batch(text, jsonb, text) from public, anon;
grant  execute on function public.admin_submit_cla_fee_batch(text, jsonb, text) to authenticated;
comment on function public.admin_submit_cla_fee_batch(text, jsonb, text) is
  'Admin / super admin only. Validates and saves an uploaded CLA_Fees file (at most 500 rows) as a PENDING batch. Nothing goes live until a super admin approves it.';

-- ---------- 5. decide ----------
create or replace function private.cla_fee_decide(p_batch uuid, p_status text, p_note text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare b public.cla_fee_batches;
begin
  if length(coalesce(p_note, '')) > 500 then raise exception 'The note is too long (500 characters at most).' using errcode = '22023'; end if;
  select * into b from public.cla_fee_batches where id = p_batch for update;
  if not found then raise exception 'No such upload.' using errcode = 'P0002'; end if;
  if b.status <> 'pending' then raise exception 'This upload was already %.', b.status using errcode = '22023'; end if;

  if p_status = 'approved' then
    delete from public.cla_fees_live where state = any (b.states);
    insert into public.cla_fees_live (state, line, active, fee_name, transaction, amount, paid_by, le_section, default_on, notes, batch_id, approved_by)
    select r.state, r.line, r.active, r.fee_name, r.transaction, r.amount, r.paid_by, r.le_section, r.default_on, r.notes, b.id, auth.uid()
      from public.cla_fee_batch_rows r where r.batch_id = b.id;
  end if;

  update public.cla_fee_batches set status = p_status, decided_by = auth.uid(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = b.id;
  insert into public.audit_log (actor_id, action, target_type, target_id, details)
  values (auth.uid(), 'cla_fees_changed', 'cla_fee_batch', b.id,
          jsonb_build_object('op', case p_status when 'approved' then 'approve' when 'rejected' then 'reject' else 'withdraw' end,
                             'states', to_jsonb(b.states), 'rows', b.row_count, 'note', nullif(btrim(coalesce(p_note, '')), '')));
end $$;
revoke execute on function private.cla_fee_decide(uuid, text, text) from public, anon, authenticated;

create or replace function public.super_admin_approve_cla_fee_batch(p_batch uuid, p_note text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.is_super_admin() then raise exception 'Only a super admin can approve fee uploads.' using errcode = '42501'; end if;
  perform private.cla_fee_decide(p_batch, 'approved', p_note);
end $$;
create or replace function public.super_admin_reject_cla_fee_batch(p_batch uuid, p_note text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.is_super_admin() then raise exception 'Only a super admin can reject fee uploads.' using errcode = '42501'; end if;
  perform private.cla_fee_decide(p_batch, 'rejected', p_note);
end $$;
create or replace function public.admin_withdraw_cla_fee_batch(p_batch uuid, p_note text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
  perform private.cla_fee_decide(p_batch, 'withdrawn', p_note);
end $$;
revoke execute on function public.super_admin_approve_cla_fee_batch(uuid, text), public.super_admin_reject_cla_fee_batch(uuid, text),
                           public.admin_withdraw_cla_fee_batch(uuid, text) from public, anon;
grant  execute on function public.super_admin_approve_cla_fee_batch(uuid, text), public.super_admin_reject_cla_fee_batch(uuid, text),
                           public.admin_withdraw_cla_fee_batch(uuid, text) to authenticated;

-- ---------- 6. what the calculator reads (anyone; no notes) ----------
create or replace function public.get_cla_fees() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'states', coalesce((select jsonb_agg(jsonb_build_object('state', s.state, 'approved_at', s.approved_at) order by s.state)
                          from (select state, max(approved_at) approved_at from public.cla_fees_live group by state) s), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('state', l.state, 'active', l.active, 'fee_name', l.fee_name, 'transaction', l.transaction,
                                                           'amount', l.amount, 'paid_by', l.paid_by, 'le_section', l.le_section, 'default_on', l.default_on)
                                         order by l.state, l.line)
                        from public.cla_fees_live l), '[]'::jsonb))
$$;
revoke execute on function public.get_cla_fees() from public;
grant  execute on function public.get_cla_fees() to anon, authenticated;
comment on function public.get_cla_fees() is
  'Public. The approved CLA fees for every state that has been approved through Upload CLA fees (no notes). States not listed keep the fee sheet.';
