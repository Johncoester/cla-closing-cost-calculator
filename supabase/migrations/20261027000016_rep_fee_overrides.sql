-- =====================================================================
-- CLA Quote Portal: PER-REP SPECIAL SETTLEMENT FEE (rep_fee_overrides)
-- Migration 16 (new file; migrations 1-15 untouched). Forward-only, safe to run twice. Plain transaction, no enum changes.
-- NOT APPLIED to any project. Written and tested on a throwaway local Postgres only. See portal/README.md "Rep special pricing".
--
-- WHAT THE BUSINESS ASKED FOR
--   Some sales reps get a LOWER settlement fee. Only CLA's own "Settlement Fee to CLA Title & Escrow" line may change.
--   Title insurance premiums and recording fees can never change (they are set by the underwriter / the county).
--
-- HOW (the table cannot even STORE anything but the settlement fee)
--   public.rep_fee_overrides: one row = "for this rep, in this state (or '*' = every state), for this kind of transaction,
--   on this side, the settlement fee is $X". fee_key is CHECK-constrained to 'settlement', so a premium, a recording fee or
--   any other line cannot be written into the table, by anyone, ever (adding another discountable fee later means changing
--   that CHECK in a new migration, on purpose).
--     state         '*' | MD | VA | DC | FL      a state row beats the '*' row; no row = the standard fee from the fee sheet
--     transaction   purchase | refi              (a cash purchase uses 'purchase', like the fee sheet's Transaction column)
--     paid_by       buyer | seller               (a refinance "Borrower" is 'buyer')
--     amount        0 .. 99999.99                (0 is allowed: a waived fee)
--   Standard pricing is untouched: the standard fees stay in the fee sheet / snapshot. No row = nobody notices anything.
--
-- WHO MAY DO WHAT
--   WRITE  admin and super admin only (private.is_admin(), MFA-aware like every admin action), only through
--          public.admin_set_rep_fee_override() / public.admin_clear_rep_fee_override(). Nobody has an insert / update / delete
--          grant or policy on the table, so direct API writes fail with 42501 for every role. Each change is audited ('rep_fee_changed').
--   READ   admin and super admin: every row. A rep: only the rows for the rep they ARE. A client (realtor): only the rows of their
--          assigned rep (the ONE rule below). Nobody else. Reads go through RLS; the calculator uses public.get_my_fee_overrides().
--
-- THE ONE RULE FOR "WHOSE SPECIAL FEE DOES THIS PERSON GET?"  ->  private.pricing_rep_for(user)
--   a rep (or an admin who also works as a rep) -> themselves          (their own quotes)
--   a client                                    -> their active, assigned rep (the realtor's quotes use the rep's fee)
--   anyone else (a plain admin, a disabled user, nobody) -> null = standard fees
--   To change that policy (e.g. rep's own quotes only, clients pay standard) edit ONLY that function: the table policy, the
--   get_my_fee_overrides() RPC and the portal all follow it. Rows of a person who stops being a rep stay in the table but are inert.
-- =====================================================================

-- ---------- 1. the table ----------
create table if not exists public.rep_fee_overrides (
  id          uuid primary key default gen_random_uuid(),
  rep_id      uuid not null references public.profiles (id) on delete cascade,
  fee_key     text not null default 'settlement',
  state       text not null default '*',
  transaction text not null,
  paid_by     text not null,
  amount      numeric(7, 2) not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null,
  constraint rep_fee_key_settlement_only check (fee_key = 'settlement'),
  constraint rep_fee_state_known        check (state in ('*', 'MD', 'VA', 'DC', 'FL')),
  constraint rep_fee_transaction_known  check (transaction in ('purchase', 'refi')),
  constraint rep_fee_paid_by_known      check (paid_by in ('buyer', 'seller')),
  constraint rep_fee_amount_range       check (amount >= 0 and amount <= 99999.99),
  constraint rep_fee_refi_has_no_seller check (not (transaction = 'refi' and paid_by = 'seller')),
  constraint rep_fee_one_per_slot       unique (rep_id, fee_key, state, transaction, paid_by)
);
create index if not exists rep_fee_overrides_rep_idx on public.rep_fee_overrides (rep_id);
alter table public.rep_fee_overrides enable row level security;

drop trigger if exists rep_fee_overrides_touch on public.rep_fee_overrides;
create trigger rep_fee_overrides_touch before update on public.rep_fee_overrides
  for each row execute function private.touch_updated_at();

-- audit: one new action (the list of migration 13 plus this)
alter table public.audit_log drop constraint if exists audit_action_known;
alter table public.audit_log add constraint audit_action_known check (action in (
  'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
  'export_run', 'profile_created', 'rep_flag_changed', 'feedback_submitted', 'feedback_decided', 'rep_fee_changed'));

-- ---------- 2. the one rule: whose special fee does this person get? ----------
create or replace function private.pricing_rep_for(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    -- a rep, or an admin / super admin who also works as a rep: their own fee
    when p.role = 'rep' or (p.role in ('super_admin', 'admin') and p.is_rep) then p.id
    -- a client (realtor): the fee of their active, assigned rep (EDIT HERE to make clients pay standard fees: return null)
    when p.role = 'client' then (
      select a.rep_id from public.assignments a
        join public.profiles r on r.id = a.rep_id and r.status = 'active'
                              and (r.role = 'rep' or (r.role in ('super_admin', 'admin') and r.is_rep))
       where a.active and a.client_user_id = p.id
       limit 1)
    else null
  end
  from public.profiles p where p.id = p_user and p.status = 'active'
$$;
revoke execute on function private.pricing_rep_for(uuid) from public, anon, authenticated;
grant  execute on function private.pricing_rep_for(uuid) to authenticated;      -- called from the RLS policy, which runs as the logged-in user

-- ---------- 3. access: read only through RLS; every write goes through the RPCs below ----------
revoke all on public.rep_fee_overrides from anon, authenticated;
grant select on public.rep_fee_overrides to authenticated;
drop policy if exists rep_fee_overrides_select_admin on public.rep_fee_overrides;
create policy rep_fee_overrides_select_admin on public.rep_fee_overrides
  for select to authenticated using (private.is_admin());
drop policy if exists rep_fee_overrides_select_pricing on public.rep_fee_overrides;
create policy rep_fee_overrides_select_pricing on public.rep_fee_overrides
  for select to authenticated using (rep_id = private.pricing_rep_for(auth.uid()));
-- (no insert / update / delete policy and no such grant: direct writes fail with 42501 for every API role)

-- ---------- 4. set one special settlement fee (admin / super admin) ----------
-- Upsert: the same rep + state + transaction + side replaces the previous amount.
create or replace function public.admin_set_rep_fee_override(
  p_rep uuid, p_state text, p_transaction text, p_paid_by text, p_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t public.profiles; st text := upper(btrim(coalesce(p_state, '*'))); tx text := lower(btrim(coalesce(p_transaction, '')));
  pb text := lower(btrim(coalesce(p_paid_by, ''))); old numeric; amt numeric;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into t from public.profiles where id = p_rep;
  if not found then raise exception 'no such user' using errcode = 'P0002'; end if;
  if not (t.role = 'rep' or (t.role in ('super_admin', 'admin') and t.is_rep)) then
    raise exception 'special pricing is only for reps (or an admin who also works as a rep)' using errcode = '23514';
  end if;
  if st = '' then st := '*'; end if;
  if st not in ('*', 'MD', 'VA', 'DC', 'FL') then raise exception 'state must be * (all states), MD, VA, DC or FL' using errcode = '22023'; end if;
  if tx not in ('purchase', 'refi') then raise exception 'transaction must be purchase or refi' using errcode = '22023'; end if;
  if pb not in ('buyer', 'seller') then raise exception 'paid_by must be buyer or seller' using errcode = '22023'; end if;
  if tx = 'refi' and pb = 'seller' then raise exception 'a refinance has no seller settlement fee' using errcode = '22023'; end if;
  if p_amount is null or p_amount < 0 or p_amount > 99999.99 then raise exception 'amount must be between 0 and 99999.99' using errcode = '22023'; end if;
  amt := round(p_amount, 2);
  select amount into old from public.rep_fee_overrides
   where rep_id = p_rep and fee_key = 'settlement' and state = st and transaction = tx and paid_by = pb;
  insert into public.rep_fee_overrides (rep_id, state, transaction, paid_by, amount, updated_by)
    values (p_rep, st, tx, pb, amt, auth.uid())
    on conflict (rep_id, fee_key, state, transaction, paid_by)
    do update set amount = excluded.amount, updated_by = excluded.updated_by;
  if old is distinct from amt then
    perform private.audit('rep_fee_changed', 'profile', p_rep,
      jsonb_build_object('fee', 'settlement', 'state', st, 'transaction', tx, 'paid_by', pb, 'before', old, 'after', amt));
  end if;
end $$;

-- ---------- 5. clear one (back to the standard fee) ----------
create or replace function public.admin_clear_rep_fee_override(p_rep uuid, p_state text, p_transaction text, p_paid_by text)
returns void language plpgsql security definer set search_path = '' as $$
declare st text := upper(btrim(coalesce(p_state, '*'))); tx text := lower(btrim(coalesce(p_transaction, ''))); pb text := lower(btrim(coalesce(p_paid_by, ''))); old numeric;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if st = '' then st := '*'; end if;
  delete from public.rep_fee_overrides
   where rep_id = p_rep and fee_key = 'settlement' and state = st and transaction = tx and paid_by = pb
   returning amount into old;
  if found then
    perform private.audit('rep_fee_changed', 'profile', p_rep,
      jsonb_build_object('fee', 'settlement', 'state', st, 'transaction', tx, 'paid_by', pb, 'before', old, 'after', null));
  end if;
end $$;

-- ---------- 6. what the calculator should apply for the CURRENT user ----------
-- Follows private.pricing_rep_for(): a rep gets their own rows, a client their rep's rows, anyone else gets no rows (standard fees).
create or replace function public.get_my_fee_overrides()
returns table (state text, transaction text, paid_by text, amount numeric)
language sql stable security definer set search_path = '' as $$
  select o.state, o.transaction, o.paid_by, o.amount
    from public.rep_fee_overrides o
   where o.fee_key = 'settlement' and o.rep_id = private.pricing_rep_for(auth.uid())
   order by o.state, o.transaction, o.paid_by
$$;

-- ---------- 7. privileges ----------
revoke execute on function public.admin_set_rep_fee_override(uuid, text, text, text, numeric),
                           public.admin_clear_rep_fee_override(uuid, text, text, text),
                           public.get_my_fee_overrides() from public, anon;
grant  execute on function public.admin_set_rep_fee_override(uuid, text, text, text, numeric),
                           public.admin_clear_rep_fee_override(uuid, text, text, text),
                           public.get_my_fee_overrides() to authenticated;
comment on table public.rep_fee_overrides is
  'Per-rep special CLA settlement fee. Settlement fee ONLY (CHECK fee_key = settlement): premiums and recording fees can never be stored here. Writes: admin RPCs only.';
