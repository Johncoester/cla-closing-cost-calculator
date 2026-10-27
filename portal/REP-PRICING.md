# Rep pricing tables (migration 16): design and how to apply

**Status: built and tested locally only (branch `rep-pricing`, worktree `/workspace/cla-calculator-rep-pricing-wt`, based on `main` 1828dcf).
Nothing is pushed to the real repo, no migration applied, no edge function deployed.** Cache-bust letter for this change: `20261027b`.
(The first version of this feature, per-rep override rows, was replaced by the named pricing tables below after John's review.)

## What John asked for
Some sales reps get a lower price. **Only CLA's own settlement fee**, not title insurance and not recording fees (they cannot change).
John edits it inside the portal: **New pricing table** asks for a name (example "Marvin's Pricing"), you set the fees, then you assign reps by adding their **email** to that table.

## How the settlement fee works today (unchanged for everyone not in a table)
`CLA_Fees` tab of the fee sheet (snapshot: `fee-snapshot.js`). The line is **"Settlement Fee to CLA Title & Escrow"**, one row per state x transaction x payer:

| | MD / VA / DC | FL |
|---|---|---|
| Purchase / cash, buyer pays | $1,075 | $1,100 |
| Purchase / cash, seller pays | $670 | $950 |
| Refinance, borrower pays | $450 | $450 |

`index.html` builds the CLA fee list (`claFees` / `sellerFeeInputs`) and hands it to `calc()` as `fees`; each row becomes one "Title – <fee name>" line. Premiums
(`Title – Lender's Title Policy`, owner's policy, endorsements) and recording fees (`Recording fees – Deed`...) are computed by `calc()` itself from other sheet tabs and
never come from that list. Other CLA fees (notary, doc prep, storage, title search, "Processing Fee to CLA" on refis, CPL) are in the list but are **not** settlement fees.

## The design
* **Database (migration 16, file only):** three tables.
  * `public.pricing_tables` (id, **name**: 1-80 characters, unique ignoring case).
  * `public.pricing_table_fees` (table, state or `*`, `purchase`/`refi`, `buyer`/`seller`, amount 0..99,999.99). `fee_key` is CHECK-constrained to `'settlement'`, so a premium, recording fee or any other fee **cannot be stored**. Refi "borrower" = `buyer`; a refi has no seller row. A state row beats the `*` (all states) row. No row = standard fee.
  * `public.pricing_table_members` (table, **email**). Stored lower-case and trimmed (CHECK), `unique(email)` = **one email can be in only one table**. Must be an `@clatitle.com` address (reps use CLA email), and an email that already belongs to a **client** account is refused ("add their rep instead"). The rep does **not** need an account yet: the match is on the email, so the pricing applies from their first sign-in with it.
* **Who may write:** admin and super admin only, through audited RPCs (MFA-aware `private.is_admin()`); no insert/update/delete grant or policy exists on the three tables.
  `admin_create_pricing_table`, `admin_rename_pricing_table`, `admin_delete_pricing_table` (cascades: fees and members removed, they go back to standard), `admin_set_pricing_fee`, `admin_clear_pricing_fee`, `admin_add_pricing_member(table, email, p_move)` (returns `added` / `moved` / `already`; an email in another table is error 23505 `<email> is already in pricing table "<name>"` unless `p_move`), `admin_remove_pricing_member`.
  Every change is one audit row, `pricing_table_changed`, with `details.op` = create | rename | delete | fee_set | fee_clear | member_add | member_move | member_remove (and before / after).
* **Who may read:** admins everything; a rep only their own table's name and fees (never the member list: those are other reps' emails); a client their rep's table's fees. The calculator calls `get_my_fee_overrides()` (same name and shape as before: `state, transaction, paid_by, amount`).
* **The one rule for whose pricing a person gets:** `private.pricing_rep_for(user)` (migration 16) and, mirrored, the `repUser` line in `getMyFeeOverrides()` of the mock adapter:
  a rep (or admin who also reps) gets the table their **own email** is in; a client (realtor) gets the table their **active, assigned rep's email** is in; anyone else (plain admin, unassigned client, guest, rep in no table) pays the standard fee.
  **Assumption, not confirmed by John:** the rep's own quotes AND their assigned clients' quotes use the rep's table. To switch to "rep's own quotes only", change the `when p.role = 'client' then (...)` branch of that one SQL function to `null` (and the `repUser` line in the mock adapter); nothing else moves.
* **Calculator (`index.html`, unchanged by the rework):** `repFeeOverride()` / `applyRepFees()` replace the amount of rows named `Settlement Fee to CLA Title & Escrow` only (buyer, borrower, seller), before `calc()` runs. `calc()` itself is untouched.
  The fee panel shows the special amount with "(special rate, standard $1,075.00)"; the printed / saved quote shows only the amount (no "special" wording). Seller net sheet follows (the seller's settlement fee). A fee of $0 (waived) simply drops the line.
  `portal-hook.js` calls `A.getMyFeeOverrides()` for signed-in users and `CLA_QUOTE_API.setFeeOverrides()`; any failure (migration not applied, network) = standard fees, silently. Guests always get standard fees.
* **Admin screen (`portal/admin.html`):** sixth tab **Rep pricing** (admin and super admin; the page already refuses everyone else).
  * List of pricing tables (name, fees set, member emails) and **New pricing table** (asks for a name).
  * Open a table: **Rename**, **Delete table** (confirm first; members go back to standard), the fee boxes (purchase buyer, purchase seller, refinance borrower; "Applies to" all states or MD/VA/DC/FL; empty = standard; a list of every fee set with Clear), and **Members**: type an email + Add, Remove per email. Each member shows whether they have a portal account and their role, or "No portal account yet". An email already in another table shows which one and a **Move to this table** button.
  * The standard amounts shown beside the boxes come from the built-in fee snapshot (the calculator uses the live sheet; they match unless the sheet changed since the snapshot).
* **Public demo:** mock mode with fake data: https://johncoester.github.io/cla-calculator-rep-pricing-demo/ (sign in with any password; see the demo steps in the hand-off).

## Files
`supabase/migrations/20261027000016_pricing_tables.sql` (new), `supabase/tests/10_access_rules.sql` (+ "named pricing tables" section), `supabase/tests/80_upgrade_from_15.sql` (new), `supabase/tests/run-tests.sh` (upgrade check 7),
`index.html`, `portal/admin.html`, `portal/js/{mock-adapter,mock-data,supabase-adapter,auth-adapter,portal-hook,portal-ui}.js`, `test.js`, `portal/test-portal.js`, this file, cache-bust `20261027b`.
The migration number is 16; the repo names migrations `<timestamp>NN_name.sql`, so the file is `20261027000016_...`.

## Tests (run locally)
`node test.js` (calculator, incl. insurance / recording byte-for-byte unchanged with an override, in 8 state x transaction combinations), `node portal/test-portal.js` (adapters, admin screen, calculator integration, cache-bust),
`PGTESTPORT=54331 bash supabase/tests/run-tests.sh` (throwaway local Postgres: RLS, RPCs, one-email-one-table, second-run safety, upgrade from migrations 1-15).

## How to apply later (NOT done; needs John's go-ahead)
1. Review the branch; merge `rep-pricing` into `main` (the cache-bust `20261027b` is already in the branch).
2. Apply `supabase/migrations/20261027000016_pricing_tables.sql` to project `zxwhlhjxfzwqhhhmeeps` (SQL editor or `supabase db push`). Plain transaction, safe to run twice. No edge function changes.
3. Push; GitHub Pages serves it. Until step 2 the Rep pricing tab shows an error when opened and the calculator quietly uses standard fees.
4. In the portal: Admin > Rep pricing > New pricing table > name it > enter fees > Save > add the rep's email. Test by signing in as that rep (or one of their realtors) and opening the calculator.
Migration 16 was never applied live, so nothing needs migrating from the earlier per-rep design (there is no data).

## Open questions for John
* Do a rep's assigned realtors really get the rep's table (current assumption), or only the rep's own quotes?
* Members must be `@clatitle.com` emails and may not be an existing client account. OK? (One line in the migration and the mock adapter.)
* Any other CLA fee that may be discounted later (notary $200/$150, doc prep $205, title search, "Processing Fee to CLA" on refis, ...)? Today only the settlement fee can be; adding another is one CHECK change in a new migration plus a name match in `index.html`.
* Should a discount be limited to a floor (e.g. never below $X)? The screen supports per-state fees; there is no floor. A $0 fee waives the line.
* Refinances count? (Supported: refi borrower settlement fee; leave the box empty to skip.)
