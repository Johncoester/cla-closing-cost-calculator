# Rep special pricing (migration 16): design and how to apply

**Status: built and tested locally only (branch `rep-pricing`, worktree `/workspace/cla-calculator-rep-pricing-wt`, based on `main` 1828dcf).
Nothing is pushed, no migration applied, no edge function deployed.** Cache-bust letter for this change: `20261027a`.

## What John asked for
Some sales reps get a lower price. **Only CLA's own settlement fee**, not title insurance and not recording fees (they cannot change).
John wants to edit it inside the portal, not in a spreadsheet.

## How the settlement fee works today (unchanged for everyone without an override)
`CLA_Fees` tab of the fee sheet (snapshot: `fee-snapshot.js`). The line is **"Settlement Fee to CLA Title & Escrow"**, one row per state x transaction x payer:

| | MD / VA / DC | FL |
|---|---|---|
| Purchase / cash, buyer pays | $1,075 | $1,100 |
| Purchase / cash, seller pays | $670 | $950 |
| Refinance, borrower pays | $450 | $450 |

`index.html` builds the CLA fee list (`claFees` / `sellerFeeInputs`) and hands it to `calc()` as `fees`; each row becomes one "Title – <fee name>" line. Premiums
(`Title – Lender's Title Policy`, owner's policy, endorsements) and recording fees (`Recording fees – Deed`...) are computed by `calc()` itself from other sheet tabs and
never come from that list. Other CLA fees (notary, doc prep, storage, title search, "Processing Fee to CLA" on refis, CPL) are in the list but are **not** settlement fees.

## The override (what was added)
* **Database (migration 16, file only):** `public.rep_fee_overrides` (rep, state or `*`, `purchase`/`refi`, `buyer`/`seller`, amount). `fee_key` is CHECK-constrained to `'settlement'`,
  so a premium, recording fee or any other fee **cannot be stored**. Refi "borrower" = `buyer`; a refi has no seller row. A state row beats the `*` (all states) row. No row = standard fee.
* **Who may write:** admin and super admin only, through `admin_set_rep_fee_override()` / `admin_clear_rep_fee_override()` (MFA-aware `private.is_admin()`); no insert/update/delete grant or policy exists. Every change is audited (`rep_fee_changed`, before/after). Target must be a rep or an admin who also works as a rep.
* **Who may read:** admins everything; a rep only the rows for the rep they are; a client only their rep's rows (RLS) and the calculator calls `get_my_fee_overrides()`.
* **The one rule for whose fee a person gets:** `private.pricing_rep_for(user)` (migration 16) and, mirrored, `getMyFeeOverrides()` in the mock adapter:
  a rep (or admin who also reps) gets **their own** fee; a client (realtor) gets **their active, assigned rep's** fee; anyone else (plain admin, unassigned client, guest) pays the standard fee.
  **Assumption, not confirmed by John:** the rep's own quotes AND their assigned clients' quotes use the rep's special fee. To switch to "rep's own quotes only", change the `when p.role = 'client' then (...)` branch of that one SQL function to `null` (and the `repId` line in the mock adapter); nothing else moves.
* **Calculator (`index.html`):** `repFeeOverride()` / `applyRepFees()` replace the amount of rows named `Settlement Fee to CLA Title & Escrow` only (buyer, borrower, seller), before `calc()` runs. `calc()` itself is untouched.
  The fee panel shows the special amount with "(special rate, standard $1,075.00)"; the printed / saved quote shows only the amount (no "special" wording). Seller net sheet follows (the seller's settlement fee). A fee of $0 (waived) simply drops the line.
  `portal-hook.js` calls `A.getMyFeeOverrides()` for signed-in users and `CLA_QUOTE_API.setFeeOverrides()`; any failure (migration not applied, network) = standard fees, silently. Guests always get standard fees.
* **Admin screen (`portal/admin.html`):** new sixth tab **Rep pricing** (admin and super admin; the page already refuses everyone else): pick a rep, "Applies to" (all states or MD/VA/DC/FL), three boxes (purchase buyer, purchase seller, refinance borrower; empty = standard), Save, "Back to standard", and a list of every special fee with Clear buttons. The standard amounts shown beside the boxes come from the built-in fee snapshot (the calculator uses the live sheet; they match unless the sheet changed since the snapshot).

## Files
`supabase/migrations/20261027000016_rep_fee_overrides.sql` (new), `supabase/tests/10_access_rules.sql` (+ section), `supabase/tests/80_upgrade_from_15.sql` (new), `supabase/tests/run-tests.sh` (upgrade check 7),
`index.html`, `portal/admin.html`, `portal/js/{mock-adapter,supabase-adapter,auth-adapter,portal-hook,portal-ui}.js`, `test.js`, `portal/test-portal.js`, this file, cache-bust `20261027a`.
The migration number is 16; the repo names migrations `<timestamp>NN_name.sql`, so the file is `20261027000016_...`.

## Tests (run locally)
`node test.js` (calculator, incl. insurance / recording byte-for-byte unchanged with an override, in 8 state x transaction combinations), `node portal/test-portal.js` (adapters, admin screen, calculator integration, cache-bust),
`bash supabase/tests/run-tests.sh` (throwaway local Postgres: RLS, RPCs, second-run safety, upgrade from migrations 1-15).

## How to apply later (NOT done; needs John's go-ahead)
1. Review the branch; merge `rep-pricing` into `main` (the cache-bust `20261027a` is already in the branch).
2. Apply `supabase/migrations/20261027000016_rep_fee_overrides.sql` to project `zxwhlhjxfzwqhhhmeeps` (SQL editor or `supabase db push`). Plain transaction, safe to run twice. No edge function changes.
3. Push; GitHub Pages serves it. Until step 2 the Rep pricing tab shows an error when opened and the calculator quietly uses standard fees.
4. In the portal: Admin > Rep pricing > pick the rep > enter fees > Save. Test by signing in as that rep (or one of their realtors) and opening the calculator.

## Open questions for John
* Do a rep's assigned realtors really get the rep's fee (current assumption), or only the rep's own quotes?
* Any other CLA fee that may be discounted later (notary $200/$150, doc prep $205, title search, "Processing Fee to CLA" on refis, ...)? Today only the settlement fee can be; adding another is one CHECK change in a new migration plus a name match in `index.html`.
* Should a discount be limited to a floor (e.g. never below $X) or to specific states only? The screen supports per-state fees; there is no floor.
* Do refinances count? (Supported: refi borrower settlement fee; leave the box empty to skip.)
