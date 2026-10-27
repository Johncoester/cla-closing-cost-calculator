-- =====================================================================
-- CLA Quote Portal: NAMED PRICING TABLES for the CLA settlement fee ("Marvin's Pricing")
-- Migration 16 (new file; migrations 1-15 untouched). Forward-only, safe to run twice. Plain transaction, no enum changes.
-- NOT APPLIED to any project. Written and tested on a throwaway local Postgres only. See portal/REP-PRICING.md.
-- (An earlier draft of migration 16, per-rep override rows, was never applied anywhere and is replaced by this file.)
--
-- WHAT THE BUSINESS ASKED FOR
--   Some sales reps get a LOWER settlement fee. Only CLA's own "Settlement Fee to CLA Title & Escrow" line may change.
--   Title insurance premiums and recording fees can never change.
--   John: "New Fee Table: it asks for a pricing name, example Marvin's Pricing. We set up the fees and we can assign the rep by
--   adding their email to Marvin's pricing fee table."
--
-- HOW
--   public.pricing_tables         a named table ("Marvin's Pricing"); the name is unique ignoring case and surrounding spaces.
--   public.pricing_table_fees     the settlement fees of one table: state ('*' = every state, a state row beats it), purchase | refi,
--                                 buyer | seller (a refinance borrower is 'buyer'), amount. fee_key is CHECK-constrained to 'settlement':
--                                 a premium, a recording fee or any other fee cannot be stored, by anyone. No row = the standard fee.
--   public.pricing_table_members  EMAIL addresses (lower-cased, trimmed, @clatitle.com) that use a table. One email belongs to at most ONE
--                                 table (unique). The email may be added BEFORE the rep has a portal account: pricing applies as soon as
--                                 they sign in with that email. Matching is case-insensitive (emails are stored lower-case, profiles too).
--   Deleting a table deletes its fees and its members (ON DELETE CASCADE): those people are back on standard fees.
--   Standard pricing is untouched: the standard fees stay in the fee sheet / snapshot. Nobody in a table = nobody notices anything.
--
-- WHO MAY DO WHAT
--   WRITE  admin and super admin only (private.is_admin(), MFA-aware like every admin action), only through audited RPCs:
--          admin_create_pricing_table / admin_rename_pricing_table / admin_delete_pricing_table /
--          admin_set_pricing_fee / admin_clear_pricing_fee / admin_add_pricing_member / admin_remove_pricing_member.
--          Nobody has an insert / update / delete grant or policy on the three tables (direct API writes fail with 42501).
--          Every change is audited ('pricing_table_changed', details.op says which).
--   READ   admin and super admin: everything. A rep (or an admin who also reps): only THEIR OWN table's name and fees.
--          A client (realtor): only the table of their assigned rep, fees only. The members list (other reps' emails) is admin-only.
--          The calculator uses public.get_my_fee_overrides() (same name and shape as the earlier draft).
--
-- THE ONE RULE FOR "WHOSE PRICING DOES THIS PERSON GET?"  ->  private.pricing_rep_for(user)
--   a rep (or an admin who also works as a rep) -> themselves          (their own quotes)
--   a client                                    -> their active, assigned rep (the realtor's quotes use the rep's table)
--   anyone else (a plain admin, a disabled user, nobody) -> null = standard fees
--   private.pricing_table_for(user) then looks up the table that rep's EMAIL is a member of.
--   To change that policy (e.g. rep's own quotes only, clients pay standard) edit ONLY pricing_rep_for: the RLS policies, the
--   get_my_fee_overrides() RPC and the portal all follow it.
-- =====================================================================

-- ---------- 1. the tables ----------
create table if not exists public.pricing_tables (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_table_name_len check (name = btrim(name) and length(name) between 1 and 80)
);
create unique index if not exists pricing_tables_name_key on public.pricing_tables (lower(name));
alter table public.pricing_tables enable row level security;

create table if not exists public.pricing_table_fees (
  id          uuid primary key default gen_random_uuid(),
  table_id    uuid not null references public.pricing_tables (id) on delete cascade,
  fee_key     text not null default 'settlement',
  state       text not null default '*',
  transaction text not null,
  paid_by     text not null,
  amount      numeric(7, 2) not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null,
  constraint pricing_fee_key_settlement_only check (fee_key = 'settlement'),
  constraint pricing_fee_state_known         check (state in ('*', 'MD', 'VA', 'DC', 'FL')),
  constraint pricing_fee_transaction_known   check (transaction in ('purchase', 'refi')),
  constraint pricing_fee_paid_by_known       check (paid_by in ('buyer', 'seller')),
  constraint pricing_fee_amount_range        check (amount >= 0 and amount <= 99999.99),
  constraint pricing_fee_refi_has_no_seller  check (not (transaction = 'refi' and paid_by = 'seller')),
  constraint pricing_fee_one_per_slot        unique (table_id, fee_key, state, transaction, paid_by)
);
alter table public.pricing_table_fees enable row level security;

create table if not exists public.pricing_table_members (
  id       uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.pricing_tables (id) on delete cascade,
  email    text not null,
  added_by uuid references public.profiles (id) on delete set null,
  added_at timestamptz not null default now(),
  constraint pricing_member_email_clean check (email = lower(btrim(email)) and email ~ '^[^@\s]+@clatitle\.com$' and length(email) <= 254),
  constraint pricing_member_email_once  unique (email)                       -- one email, at most ONE pricing table
);
create index if not exists pricing_table_members_table_idx on public.pricing_table_members (table_id);
alter table public.pricing_table_members enable row level security;

drop trigger if exists pricing_tables_touch on public.pricing_tables;
create trigger pricing_tables_touch before update on public.pricing_tables
  for each row execute function private.touch_updated_at();
drop trigger if exists pricing_table_fees_touch on public.pricing_table_fees;
create trigger pricing_table_fees_touch before update on public.pricing_table_fees
  for each row execute function private.touch_updated_at();

-- audit: one new action (the list of migration 13 plus this)
alter table public.audit_log drop constraint if exists audit_action_known;
alter table public.audit_log add constraint audit_action_known check (action in (
  'invite_sent', 'user_disabled', 'user_enabled', 'role_changed', 'assignment_changed',
  'quote_viewed_by_admin', 'quote_deleted', 'quotes_purged', 'photo_changed', 'photo_removed',
  'export_run', 'profile_created', 'rep_flag_changed', 'feedback_submitted', 'feedback_decided', 'pricing_table_changed'));

-- ---------- 2. the one rule: whose pricing does this person get? ----------
create or replace function private.pricing_rep_for(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    -- a rep, or an admin / super admin who also works as a rep: their own pricing
    when p.role = 'rep' or (p.role in ('super_admin', 'admin') and p.is_rep) then p.id
    -- a client (realtor): the pricing of their active, assigned rep (EDIT HERE to make clients pay standard fees: return null)
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
grant  execute on function private.pricing_rep_for(uuid) to authenticated;      -- called from RLS policies, which run as the logged-in user

-- the pricing table that person's rep belongs to, by EMAIL (null = standard fees)
create or replace function private.pricing_table_for(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.table_id
    from public.profiles r
    join public.pricing_table_members m on m.email = lower(btrim(r.email))
   where r.id = private.pricing_rep_for(p_user)
$$;
revoke execute on function private.pricing_table_for(uuid) from public, anon, authenticated;
grant  execute on function private.pricing_table_for(uuid) to authenticated;

-- ---------- 3. access: read only through RLS; every write goes through the RPCs below ----------
revoke all on public.pricing_tables, public.pricing_table_fees, public.pricing_table_members from anon, authenticated;
grant select on public.pricing_tables, public.pricing_table_fees, public.pricing_table_members to authenticated;
drop policy if exists pricing_tables_select_admin on public.pricing_tables;
create policy pricing_tables_select_admin on public.pricing_tables for select to authenticated using (private.is_admin());
drop policy if exists pricing_tables_select_mine on public.pricing_tables;
create policy pricing_tables_select_mine on public.pricing_tables for select to authenticated using (id = private.pricing_table_for(auth.uid()));
drop policy if exists pricing_fees_select_admin on public.pricing_table_fees;
create policy pricing_fees_select_admin on public.pricing_table_fees for select to authenticated using (private.is_admin());
drop policy if exists pricing_fees_select_mine on public.pricing_table_fees;
create policy pricing_fees_select_mine on public.pricing_table_fees for select to authenticated using (table_id = private.pricing_table_for(auth.uid()));
drop policy if exists pricing_members_select_admin on public.pricing_table_members;
create policy pricing_members_select_admin on public.pricing_table_members for select to authenticated using (private.is_admin());   -- other reps' emails: admins only
-- (no insert / update / delete policy and no such grant: direct writes fail with 42501 for every API role)

-- ---------- 4. helpers (admin RPC internals) ----------
create or replace function private.clean_pricing_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
declare n text := regexp_replace(coalesce(p_name, ''), '^\s+|\s+$', '', 'g');
begin
  n := regexp_replace(n, '\s+', ' ', 'g');
  if n = '' then raise exception 'a pricing table needs a name' using errcode = '22023'; end if;
  if length(n) > 80 then raise exception 'the name is too long (80 characters at most)' using errcode = '22023'; end if;
  return n;
end $$;
revoke execute on function private.clean_pricing_name(text) from public, anon, authenticated;

-- ---------- 5. tables: create / rename / delete ----------
create or replace function public.admin_create_pricing_table(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare n text; new_id uuid;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  n := private.clean_pricing_name(p_name);
  if exists (select 1 from public.pricing_tables where lower(name) = lower(n)) then
    raise exception 'a pricing table named "%" already exists', n using errcode = '23505';
  end if;
  insert into public.pricing_tables (name, created_by) values (n, auth.uid()) returning id into new_id;
  perform private.audit('pricing_table_changed', 'pricing_table', new_id, jsonb_build_object('op', 'create', 'name', n));
  return new_id;
end $$;

create or replace function public.admin_rename_pricing_table(p_table uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare n text; old text;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into old from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  n := private.clean_pricing_name(p_name);
  if exists (select 1 from public.pricing_tables where lower(name) = lower(n) and id <> p_table) then
    raise exception 'a pricing table named "%" already exists', n using errcode = '23505';
  end if;
  if n = old then return; end if;
  update public.pricing_tables set name = n where id = p_table;
  perform private.audit('pricing_table_changed', 'pricing_table', p_table, jsonb_build_object('op', 'rename', 'before', old, 'after', n));
end $$;

-- Deleting a table deletes its fees and its member list: those people are back on the standard fees (ON DELETE CASCADE).
create or replace function public.admin_delete_pricing_table(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare old text; nf int; nm int;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into old from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  select count(*) into nf from public.pricing_table_fees where table_id = p_table;
  select count(*) into nm from public.pricing_table_members where table_id = p_table;
  delete from public.pricing_tables where id = p_table;
  perform private.audit('pricing_table_changed', 'pricing_table', p_table,
    jsonb_build_object('op', 'delete', 'name', old, 'fees_removed', nf, 'members_released', nm));
end $$;

-- ---------- 6. fees: set (upsert) / clear ----------
create or replace function public.admin_set_pricing_fee(p_table uuid, p_state text, p_transaction text, p_paid_by text, p_amount numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  st text := upper(btrim(coalesce(p_state, '*'))); tx text := lower(btrim(coalesce(p_transaction, '')));
  pb text := lower(btrim(coalesce(p_paid_by, ''))); old numeric; amt numeric; tname text;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into tname from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  if st = '' then st := '*'; end if;
  if st not in ('*', 'MD', 'VA', 'DC', 'FL') then raise exception 'state must be * (all states), MD, VA, DC or FL' using errcode = '22023'; end if;
  if tx not in ('purchase', 'refi') then raise exception 'transaction must be purchase or refi' using errcode = '22023'; end if;
  if pb not in ('buyer', 'seller') then raise exception 'paid_by must be buyer or seller' using errcode = '22023'; end if;
  if tx = 'refi' and pb = 'seller' then raise exception 'a refinance has no seller settlement fee' using errcode = '22023'; end if;
  if p_amount is null or p_amount < 0 or p_amount > 99999.99 then raise exception 'amount must be between 0 and 99999.99' using errcode = '22023'; end if;
  amt := round(p_amount, 2);
  select amount into old from public.pricing_table_fees
   where table_id = p_table and fee_key = 'settlement' and state = st and transaction = tx and paid_by = pb;
  insert into public.pricing_table_fees (table_id, state, transaction, paid_by, amount, updated_by)
    values (p_table, st, tx, pb, amt, auth.uid())
    on conflict (table_id, fee_key, state, transaction, paid_by)
    do update set amount = excluded.amount, updated_by = excluded.updated_by;
  if old is distinct from amt then
    perform private.audit('pricing_table_changed', 'pricing_table', p_table,
      jsonb_build_object('op', 'fee_set', 'table', tname, 'fee', 'settlement', 'state', st, 'transaction', tx, 'paid_by', pb, 'before', old, 'after', amt));
  end if;
end $$;

create or replace function public.admin_clear_pricing_fee(p_table uuid, p_state text, p_transaction text, p_paid_by text)
returns void language plpgsql security definer set search_path = '' as $$
declare st text := upper(btrim(coalesce(p_state, '*'))); tx text := lower(btrim(coalesce(p_transaction, ''))); pb text := lower(btrim(coalesce(p_paid_by, ''))); old numeric; tname text;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into tname from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  if st = '' then st := '*'; end if;
  delete from public.pricing_table_fees
   where table_id = p_table and fee_key = 'settlement' and state = st and transaction = tx and paid_by = pb
   returning amount into old;
  if found then
    perform private.audit('pricing_table_changed', 'pricing_table', p_table,
      jsonb_build_object('op', 'fee_clear', 'table', tname, 'fee', 'settlement', 'state', st, 'transaction', tx, 'paid_by', pb, 'before', old, 'after', null));
  end if;
end $$;

-- ---------- 7. members: add (optionally move from another table) / remove ----------
-- Returns 'added', 'moved' or 'already' (the email is already in THIS table). An email that is in ANOTHER table is refused (23505, message
-- says which table) unless p_move is true, which moves it. The email need not have an account yet; an existing CLIENT account is refused.
create or replace function public.admin_add_pricing_member(p_table uuid, p_email text, p_move boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare e text := lower(regexp_replace(coalesce(p_email, ''), '^\s+|\s+$', '', 'g')); tname text; cur record; role_now public.user_role;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into tname from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  if e = '' or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'enter a valid email address' using errcode = '22023'; end if;
  if e !~ '^[^@\s]+@clatitle\.com$' then raise exception 'reps use an @clatitle.com email address' using errcode = '22023'; end if;
  select role into role_now from public.profiles where email = e;
  if role_now = 'client' then raise exception 'that email belongs to a client (realtor) account: add their rep instead' using errcode = '22023'; end if;
  select m.id, m.table_id, t.name into cur from public.pricing_table_members m join public.pricing_tables t on t.id = m.table_id where m.email = e;
  if found then
    if cur.table_id = p_table then return 'already'; end if;
    if not coalesce(p_move, false) then
      raise exception '% is already in pricing table "%"', e, cur.name using errcode = '23505';
    end if;
    update public.pricing_table_members set table_id = p_table, added_by = auth.uid(), added_at = now() where id = cur.id;
    perform private.audit('pricing_table_changed', 'pricing_table', p_table,
      jsonb_build_object('op', 'member_move', 'email', e, 'table', tname, 'from_table', cur.name, 'from_table_id', cur.table_id));
    return 'moved';
  end if;
  insert into public.pricing_table_members (table_id, email, added_by) values (p_table, e, auth.uid());
  perform private.audit('pricing_table_changed', 'pricing_table', p_table, jsonb_build_object('op', 'member_add', 'email', e, 'table', tname));
  return 'added';
end $$;

create or replace function public.admin_remove_pricing_member(p_table uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare e text := lower(regexp_replace(coalesce(p_email, ''), '^\s+|\s+$', '', 'g')); tname text;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into tname from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  delete from public.pricing_table_members where table_id = p_table and email = e;
  if found then
    perform private.audit('pricing_table_changed', 'pricing_table', p_table, jsonb_build_object('op', 'member_remove', 'email', e, 'table', tname));
  end if;
end $$;

-- ---------- 8. what the calculator should apply for the CURRENT user ----------
-- Follows private.pricing_rep_for() + the email lookup: a member rep gets their table's fees, a client their rep's table's fees,
-- anyone else gets no rows (standard fees). Same name and shape as the earlier draft, so the calculator hook is unchanged.
create or replace function public.get_my_fee_overrides()
returns table (state text, transaction text, paid_by text, amount numeric)
language sql stable security definer set search_path = '' as $$
  select f.state, f.transaction, f.paid_by, f.amount
    from public.pricing_table_fees f
   where f.fee_key = 'settlement' and f.table_id = private.pricing_table_for(auth.uid())
   order by f.state, f.transaction, f.paid_by
$$;

-- ---------- 9. privileges ----------
revoke execute on function public.admin_create_pricing_table(text), public.admin_rename_pricing_table(uuid, text), public.admin_delete_pricing_table(uuid),
                           public.admin_set_pricing_fee(uuid, text, text, text, numeric), public.admin_clear_pricing_fee(uuid, text, text, text),
                           public.admin_add_pricing_member(uuid, text, boolean), public.admin_remove_pricing_member(uuid, text),
                           public.get_my_fee_overrides() from public, anon;
grant  execute on function public.admin_create_pricing_table(text), public.admin_rename_pricing_table(uuid, text), public.admin_delete_pricing_table(uuid),
                           public.admin_set_pricing_fee(uuid, text, text, text, numeric), public.admin_clear_pricing_fee(uuid, text, text, text),
                           public.admin_add_pricing_member(uuid, text, boolean), public.admin_remove_pricing_member(uuid, text),
                           public.get_my_fee_overrides() to authenticated;
comment on table public.pricing_tables is 'Named pricing tables ("Marvin''s Pricing") for the CLA settlement fee. Writes: admin RPCs only.';
comment on table public.pricing_table_fees is 'Settlement fee amounts of a pricing table (CHECK fee_key = settlement): premiums and recording fees can never be stored here.';
comment on table public.pricing_table_members is 'Rep emails (lower-case, @clatitle.com) that use a pricing table; one email, one table. May be added before the rep has an account.';
