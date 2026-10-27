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
--   public.pricing_table_fees     the settlement fees of one table, grouped into FEE SETS (set_id): one row per state per line: state ('*' = all states = the
--                                 fallback for states with no set of their own; a state in a set beats it), purchase | refi,
--                                 buyer | seller (a refinance borrower is 'buyer'), amount. fee_key is CHECK-constrained to 'settlement':
--                                 a premium, a recording fee or any other fee cannot be stored, by anyone. No row = the standard fee.
--   public.pricing_table_members  EMAIL addresses (lower-cased, trimmed, ANY domain) that use a table: a rep's, or an individual CLIENT's.
--                                 One email belongs to at most ONE table (unique). The email may be added BEFORE the person has a portal
--                                 account: pricing applies as soon as they sign in with that email. Matching is case-insensitive (emails are stored lower-case, profiles too).
--   Deleting a table deletes its fees and its members (ON DELETE CASCADE): those people are back on standard fees.
--   Standard pricing is untouched: the standard fees stay in the fee sheet / snapshot. Nobody in a table = nobody notices anything.
--
-- WHO MAY DO WHAT
--   WRITE  admin and super admin only (private.is_admin(), MFA-aware like every admin action), only through audited RPCs:
--          admin_create_pricing_table / admin_rename_pricing_table / admin_delete_pricing_table /
--          admin_save_pricing_fee_set / admin_remove_pricing_fee_set / admin_add_pricing_member / admin_remove_pricing_member.
--          Nobody has an insert / update / delete grant or policy on the three tables (direct API writes fail with 42501).
--          Every change is audited ('pricing_table_changed', details.op says which).
--   READ   admin and super admin: everything. A rep (or an admin who also reps): only THEIR OWN table's name and fees.
--          A client (realtor): only the fees of the table they resolve to (their own email's table, else their assigned rep's). The members list is admin-only.
--          The calculator uses public.get_my_fee_overrides() (same name and shape as the earlier draft).
--
-- THE ONE RULE FOR "WHOSE PRICING DOES THIS PERSON GET?"  ->  private.pricing_rep_for(user)
--   PRECEDENCE (John, confirmed), implemented by private.pricing_table_for(user):
--     1) the person's OWN email is a member of a table (a rep, an admin who also reps, or a client)  -> that table
--        (so an individual client can have different pricing even while working with a rep who is in another table)
--     2) else the table of their ASSIGNED REP's email, where private.pricing_rep_for(user) is
--          a rep (or an admin who also works as a rep) -> themselves, a client -> their active, assigned rep,
--          anyone else (a plain admin, a disabled user, nobody) -> null
--     3) else no table = standard fees.
--   To change the policy (e.g. clients never follow their rep) edit ONLY pricing_rep_for (return null for clients) or the
--   first branch of pricing_table_for: the RLS policies, get_my_fee_overrides() and the portal all follow them.
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
  set_id      uuid not null default gen_random_uuid(),                         -- the FEE SET this row belongs to (one set = a selection of states + up to three amounts)
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
create index if not exists pricing_table_fees_set_idx on public.pricing_table_fees (table_id, set_id);
alter table public.pricing_table_fees enable row level security;

-- A fee set is stored as one row per state per fee line (so get_my_fee_overrides() and the calculator keep their shape). Two invariants,
-- enforced here as well as in the RPC: a STATE belongs to at most ONE fee set per table, and a set belongs to one table.
create or replace function private.pricing_fee_set_rules() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.pricing_table_fees f where f.table_id = new.table_id and f.state = new.state and f.set_id <> new.set_id) then
    raise exception 'state % is already in another fee set of this pricing table', new.state using errcode = '23505';
  end if;
  if exists (select 1 from public.pricing_table_fees f where f.set_id = new.set_id and f.table_id <> new.table_id) then
    raise exception 'a fee set belongs to one pricing table' using errcode = '23505';
  end if;
  return new;
end $$;
drop trigger if exists pricing_table_fees_set_rules on public.pricing_table_fees;
create trigger pricing_table_fees_set_rules after insert or update on public.pricing_table_fees
  for each row execute function private.pricing_fee_set_rules();

create table if not exists public.pricing_table_members (
  id       uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.pricing_tables (id) on delete cascade,
  email    text not null,
  added_by uuid references public.profiles (id) on delete set null,
  added_at timestamptz not null default now(),
  constraint pricing_member_email_clean check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
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

-- the pricing table a person uses, by EMAIL (null = standard fees): their own email first, else their assigned rep's (see PRECEDENCE above)
create or replace function private.pricing_table_for(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    -- 1) the person's own email (reps, admins who rep, and clients; a plain admin has no pricing)
    (select m.table_id from public.profiles p
       join public.pricing_table_members m on m.email = lower(btrim(p.email))
      where p.id = p_user and p.status = 'active'
        and (p.role in ('rep', 'client') or (p.role in ('super_admin', 'admin') and p.is_rep))),
    -- 2) else the table of their assigned rep (a rep is their own rep; a client's rep is the active assignment)
    (select m.table_id from public.profiles r
       join public.pricing_table_members m on m.email = lower(btrim(r.email))
      where r.id = private.pricing_rep_for(p_user)))
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
  select count(distinct set_id) into nf from public.pricing_table_fees where table_id = p_table;
  select count(*) into nm from public.pricing_table_members where table_id = p_table;
  delete from public.pricing_tables where id = p_table;
  perform private.audit('pricing_table_changed', 'pricing_table', p_table,
    jsonb_build_object('op', 'delete', 'name', old, 'fees_removed', nf, 'members_released', nm));
end $$;

-- ---------- 6. fee sets: save (add / edit) / remove ----------
-- A FEE SET = a selection of states + up to three settlement amounts (purchase buyer, purchase seller, refinance borrower; null = standard).
-- States: any of MD, VA, DC, FL (e.g. MD+VA), OR the single value '*' (all states = the FALLBACK for states with no set of their own).
-- A state may be in only ONE set of a table: picking one that is in another set is refused (23505, message names the states of that set) unless
-- p_move, which takes the state out of the other set. p_set null = add a new set; p_set = edit that set (replaces its states and amounts).
-- Returns the set id. Audited as one 'pricing_table_changed' row: op fee_set_add / fee_set_edit, with states, amounts, before / after and moved_states.
create or replace function public.admin_save_pricing_fee_set(
  p_table uuid, p_set uuid, p_states text[], p_purchase_buyer numeric, p_purchase_seller numeric, p_refi_borrower numeric, p_move boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  tname text; sts text[]; s text; sid uuid; amts numeric[]; before_j jsonb := null; moved text[] := '{}'; clash record; k int;
  slots text[][] := array[array['purchase', 'buyer'], array['purchase', 'seller'], array['refi', 'buyer']];
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into tname from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into sts from (select upper(btrim(u)) x from unnest(coalesce(p_states, '{}')) u) q where x <> '';
  if cardinality(sts) = 0 then raise exception 'pick at least one state (or all states)' using errcode = '22023'; end if;
  foreach s in array sts loop
    if s not in ('*', 'MD', 'VA', 'DC', 'FL') then raise exception 'states must be MD, VA, DC, FL or * (all states)' using errcode = '22023'; end if;
  end loop;
  if '*' = any(sts) and cardinality(sts) > 1 then raise exception 'all states cannot be combined with single states (it is the fallback for states with no set of their own)' using errcode = '22023'; end if;
  amts := array[p_purchase_buyer, p_purchase_seller, p_refi_borrower];
  if amts[1] is null and amts[2] is null and amts[3] is null then raise exception 'enter at least one fee (empty boxes keep the standard fee)' using errcode = '22023'; end if;
  for k in 1..3 loop
    if amts[k] is not null and (amts[k] < 0 or amts[k] > 99999.99) then raise exception 'amount must be between 0 and 99999.99' using errcode = '22023'; end if;
    amts[k] := round(amts[k], 2);
  end loop;
  if p_set is not null then
    if not exists (select 1 from public.pricing_table_fees where table_id = p_table and set_id = p_set) then raise exception 'no such fee set' using errcode = 'P0002'; end if;
    sid := p_set;
    select jsonb_build_object('states', (select jsonb_agg(distinct state order by state) from public.pricing_table_fees where table_id = p_table and set_id = p_set),
      'purchase_buyer', max(amount) filter (where transaction = 'purchase' and paid_by = 'buyer'), 'purchase_seller', max(amount) filter (where transaction = 'purchase' and paid_by = 'seller'),
      'refi_borrower', max(amount) filter (where transaction = 'refi' and paid_by = 'buyer')) into before_j
      from public.pricing_table_fees where table_id = p_table and set_id = p_set;
  else
    sid := gen_random_uuid();
  end if;
  -- a state that is in ANOTHER set of this table: refuse, or move it
  for clash in
    select f.state, f.set_id from public.pricing_table_fees f where f.table_id = p_table and f.state = any(sts) and f.set_id <> sid group by f.state, f.set_id order by f.state
  loop
    if not coalesce(p_move, false) then
      raise exception '% is already in another fee set of "%" (%)', clash.state, tname,
        (select string_agg(distinct state, ', ' order by state) from public.pricing_table_fees where table_id = p_table and set_id = clash.set_id) using errcode = '23505';
    end if;
    moved := moved || clash.state;
    delete from public.pricing_table_fees where table_id = p_table and state = clash.state and set_id = clash.set_id;
  end loop;
  delete from public.pricing_table_fees where table_id = p_table and set_id = sid;
  foreach s in array sts loop
    for k in 1..3 loop
      if amts[k] is not null then
        insert into public.pricing_table_fees (table_id, set_id, state, transaction, paid_by, amount, updated_by)
          values (p_table, sid, s, slots[k][1], slots[k][2], amts[k], auth.uid());
      end if;
    end loop;
  end loop;
  perform private.audit('pricing_table_changed', 'pricing_table', p_table, jsonb_build_object(
    'op', case when p_set is null then 'fee_set_add' else 'fee_set_edit' end, 'table', tname, 'fee', 'settlement', 'set_id', sid, 'states', to_jsonb(sts),
    'before', before_j, 'after', jsonb_build_object('states', to_jsonb(sts), 'purchase_buyer', amts[1], 'purchase_seller', amts[2], 'refi_borrower', amts[3]),
    'moved_states', to_jsonb(moved)));
  return sid;
end $$;

-- Remove a whole fee set: those states go back to the all-states set of the table if it has one, else to the standard fee. A missing set is a quiet no-op.
create or replace function public.admin_remove_pricing_fee_set(p_table uuid, p_set uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare tname text; before_j jsonb; n int;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into tname from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  select jsonb_build_object('states', jsonb_agg(distinct state order by state)) into before_j from public.pricing_table_fees where table_id = p_table and set_id = p_set;
  delete from public.pricing_table_fees where table_id = p_table and set_id = p_set;
  get diagnostics n = row_count;
  if n > 0 then
    perform private.audit('pricing_table_changed', 'pricing_table', p_table,
      jsonb_build_object('op', 'fee_set_remove', 'table', tname, 'fee', 'settlement', 'set_id', p_set, 'before', before_j, 'after', null));
  end if;
end $$;

-- ---------- 7. members: add (optionally move from another table) / remove ----------
-- Returns 'added', 'moved' or 'already' (the email is already in THIS table). An email that is in ANOTHER table is refused (23505, message
-- says which table) unless p_move is true, which moves it. Any email is allowed (rep or client), and it need not have an account yet.
create or replace function public.admin_add_pricing_member(p_table uuid, p_email text, p_move boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare e text := lower(regexp_replace(coalesce(p_email, ''), '^\s+|\s+$', '', 'g')); tname text; cur record;
begin
  if not private.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select name into tname from public.pricing_tables where id = p_table;
  if not found then raise exception 'no such pricing table' using errcode = 'P0002'; end if;
  if e = '' or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'enter a valid email address' using errcode = '22023'; end if;
  if length(e) > 254 then raise exception 'that email address is too long' using errcode = '22023'; end if;
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
-- Follows private.pricing_table_for(): the person's own email's table, else their assigned rep's table, else no rows (standard fees). Same name and shape as the earlier draft, so the calculator hook is unchanged.
create or replace function public.get_my_fee_overrides()
returns table (state text, transaction text, paid_by text, amount numeric)
language sql stable security definer set search_path = '' as $$
  with f as (
    select x.state, x.transaction, x.paid_by, x.amount, x.set_id from public.pricing_table_fees x
     where x.fee_key = 'settlement' and x.table_id = private.pricing_table_for(auth.uid())),
  own as (select distinct f.state, f.set_id from f where f.state <> '*')
  select r.state, r.transaction, r.paid_by, r.amount from (
    -- every row of the table as stored: a state's own set, and the all-states ('*') set (the calculator lets a state row beat the '*' row)
    select f.state, f.transaction, f.paid_by, f.amount from f
    union all
    -- a state with its OWN set beats the all-states set as a whole: a line that its set leaves empty is the STANDARD fee, not the all-states fee.
    -- Expressed as a row with a NULL amount for that state (the calculator reads null as "no override").
    select o.state, a.transaction, a.paid_by, null::numeric from own o join f a on a.state = '*'
     where not exists (select 1 from f b where b.state = o.state and b.transaction = a.transaction and b.paid_by = a.paid_by)
  ) r order by r.state, r.transaction, r.paid_by
$$;

-- ---------- 9. privileges ----------
revoke execute on function public.admin_create_pricing_table(text), public.admin_rename_pricing_table(uuid, text), public.admin_delete_pricing_table(uuid),
                           public.admin_save_pricing_fee_set(uuid, uuid, text[], numeric, numeric, numeric, boolean), public.admin_remove_pricing_fee_set(uuid, uuid),
                           public.admin_add_pricing_member(uuid, text, boolean), public.admin_remove_pricing_member(uuid, text),
                           public.get_my_fee_overrides() from public, anon;
grant  execute on function public.admin_create_pricing_table(text), public.admin_rename_pricing_table(uuid, text), public.admin_delete_pricing_table(uuid),
                           public.admin_save_pricing_fee_set(uuid, uuid, text[], numeric, numeric, numeric, boolean), public.admin_remove_pricing_fee_set(uuid, uuid),
                           public.admin_add_pricing_member(uuid, text, boolean), public.admin_remove_pricing_member(uuid, text),
                           public.get_my_fee_overrides() to authenticated;
comment on table public.pricing_tables is 'Named pricing tables ("Marvin''s Pricing") for the CLA settlement fee. Writes: admin RPCs only.';
comment on table public.pricing_table_fees is 'Settlement fee amounts of a pricing table (CHECK fee_key = settlement): premiums and recording fees can never be stored here.';
comment on table public.pricing_table_members is 'Emails (lower-case, any domain: reps or individual clients) that use a pricing table; one email, one table. May be added before the person has an account.';
