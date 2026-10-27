#!/usr/bin/env bash
# Spins up a throwaway local Postgres, loads a Supabase stand-in, the migrations
# and the seed, then runs the access-rule tests. No network, no cloud, no data kept.
#   bash supabase/tests/run-tests.sh
# Needs Postgres server binaries (Debian/Ubuntu: apt install postgresql postgresql-17-cron).
# Also checks the upgrade paths (migrations 1-5 + data, then 6; migrations 1-6 + data, then 9 and 10 = the admin role; migrations 1-10 + data, then 11 = admins manage admins; migrations 1-11 + data, then 12 = reassign on demote; migrations 1-12 + data, then 13 = staff feedback; migrations 1-13 + data, then 14 = guided tour flag).
# Without pg_cron the purge scheduling check is skipped with a notice.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$BIN" ] || { echo "SKIPPED: no Postgres server binaries found (install postgresql to run these tests)"; exit 0; }
D="$(mktemp -d /tmp/cla-pg-XXXXXX)"; PORT="${PGTESTPORT:-54329}"
cleanup() { "$BIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
"$BIN/initdb" -D "$D/data" -U postgres -A trust >/dev/null
CRON=""; ls "$($BIN/pg_config --pkglibdir)"/pg_cron.so >/dev/null 2>&1 && CRON="-c shared_preload_libraries=pg_cron -c cron.database_name=cla_test"
"$BIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses='' $CRON" -l "$D/log" -w start >/dev/null
P=("$BIN/psql" -h "$D" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${P[@]}" -d postgres -c "create database cla_test" 
run() { "${P[@]}" -d cla_test -f "$1"; }
# Supabase applies every migration file as ONE transaction. Mirror that (--single-transaction), so a file that
# uses an enum value added in the same file (the reason migration 9 and 10 are separate) fails here too.
runm() { "${P[@]}" -d cla_test --single-transaction -f "$1"; }
run "$HERE/00_supabase_shim.sql"
for f in "$ROOT"/migrations/*.sql; do echo "migration: $(basename "$f")"; runm "$f"; done
echo "migrations are re-runnable? (second pass)"; for f in "$ROOT"/migrations/*.sql; do runm "$f" 2>&1 | grep -iE "error" && { echo "second pass error in $f"; exit 1; } || true; done
run "$ROOT/seed.sql"
run "$HERE/10_access_rules.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //' 
STATUS=${PIPESTATUS[0]}
[ "$STATUS" -eq 0 ] || exit "$STATUS"

# Upgrade check 1: a database that already has migrations 1-5 + data gets migration 6 on top (see 20_upgrade_from_5.sql).
echo "upgrade check: migrations 1-5 + data, then migration 6"
# (pg_cron is bound to the database named cla_test, so recreate that one instead of adding another)
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu() { "${P[@]}" -d cla_test "$@"; }
runu -f "$HERE/00_supabase_shim.sql"
M6="$(ls "$ROOT"/migrations/*admin_also_rep.sql)"
for f in "$ROOT"/migrations/*.sql; do
  case "$f" in *admin_also_rep.sql|*admin_role_enum.sql|*_admin_role.sql|*admin_manage_admins.sql|*reassign_on_demote.sql|*staff_feedback.sql|*tour_seen.sql|*pricing_tables.sql|*feedback_status_updates.sql) continue;; esac
  runu --single-transaction -f "$f" >/dev/null 2>&1
done
runu -v migration6="$M6" -f "$HERE/20_upgrade_from_5.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit "${PIPESTATUS[0]}"

# Upgrade check 2: a database that already has migrations 1-6 + data (the live state before the admin role) gets
# migration 9 (enum value) and migration 10 (rules) on top, each as its own transaction (see 30_upgrade_from_6.sql).
echo "upgrade check: migrations 1-6 + data, then migrations 9 and 10 (admin role)"
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu -f "$HERE/00_supabase_shim.sql"
M9="$(ls "$ROOT"/migrations/*admin_role_enum.sql)"; M10="$(ls "$ROOT"/migrations/*_admin_role.sql)"
for f in "$ROOT"/migrations/*.sql; do
  case "$f" in *admin_role_enum.sql|*_admin_role.sql|*admin_manage_admins.sql|*reassign_on_demote.sql|*staff_feedback.sql|*tour_seen.sql|*pricing_tables.sql|*feedback_status_updates.sql) continue;; esac
  runu --single-transaction -f "$f" >/dev/null 2>&1
done
# Why migrations 9 and 10 are two files: both in ONE transaction must fail (Postgres: an enum value added in a
# transaction cannot be used until that transaction commits). If this ever starts passing, the split is no longer needed.
if "${P[@]}" -d cla_test --single-transaction -f "$M9" -f "$M10" >/dev/null 2>"$D/onetx.err"; then
  echo "FAIL  migrations 9 and 10 ran in one transaction (the split is no longer needed?)"; exit 1
elif grep -q "unsafe use of new value" "$D/onetx.err"; then
  echo "PASS  migrations 9+10 in ONE transaction are rejected by Postgres (unsafe use of new value): the split is required"
else
  echo "FAIL  one-transaction run failed for another reason:"; cat "$D/onetx.err"; exit 1
fi
runu -v migration9="$M9" -v migration10="$M10" -f "$HERE/30_upgrade_from_6.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit "${PIPESTATUS[0]}"

# Upgrade check 3: the LIVE state (migrations 1-10 applied, with data, an admin and a super admin) gets migration 11
# (an admin may also manage other admins) on top as one plain transaction (see 40_upgrade_from_10.sql).
echo "upgrade check: migrations 1-10 + data, then migration 11 (admins manage admins)"
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu -f "$HERE/00_supabase_shim.sql"
M11="$(ls "$ROOT"/migrations/*admin_manage_admins.sql)"
for f in "$ROOT"/migrations/*.sql; do
  case "$f" in *admin_manage_admins.sql|*reassign_on_demote.sql|*staff_feedback.sql|*tour_seen.sql|*pricing_tables.sql|*feedback_status_updates.sql) continue;; esac
  runu --single-transaction -f "$f" >/dev/null 2>&1
done
runu -v migration11="$M11" -f "$HERE/40_upgrade_from_10.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit "${PIPESTATUS[0]}"

# Upgrade check 4: the state after migration 11 (with data: reps with clients, admins, a super admin) gets migration 12
# (a demoted rep's clients are moved to a successor, never left without a rep) on top (see 50_upgrade_from_11.sql).
echo "upgrade check: migrations 1-11 + data, then migration 12 (reassign on demote)"
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu -f "$HERE/00_supabase_shim.sql"
M12="$(ls "$ROOT"/migrations/*reassign_on_demote.sql)"
for f in "$ROOT"/migrations/*.sql; do
  case "$f" in *reassign_on_demote.sql|*staff_feedback.sql|*tour_seen.sql|*pricing_tables.sql|*feedback_status_updates.sql) continue;; esac
  runu --single-transaction -f "$f" >/dev/null 2>&1
done
runu -v migration12="$M12" -f "$HERE/50_upgrade_from_11.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit "${PIPESTATUS[0]}"

# Upgrade check 5: the LIVE state (migrations 1-12 with data) gets migration 13 (staff feedback) on top (see 60_upgrade_from_12.sql).
echo "upgrade check: migrations 1-12 + data, then migration 13 (staff feedback)"
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu -f "$HERE/00_supabase_shim.sql"
M13="$(ls "$ROOT"/migrations/*staff_feedback.sql)"
for f in "$ROOT"/migrations/*.sql; do
  case "$f" in *staff_feedback.sql|*tour_seen.sql|*pricing_tables.sql|*feedback_status_updates.sql) continue;; esac
  runu --single-transaction -f "$f" >/dev/null 2>&1
done
runu -v migration13="$M13" -f "$HERE/60_upgrade_from_12.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit "${PIPESTATUS[0]}"

# Upgrade check 6: the LIVE state (migrations 1-13 with data: existing people) gets migration 14 (guided tour flag) on top (see 70_upgrade_from_13.sql).
echo "upgrade check: migrations 1-13 + data, then migration 14 (guided tour flag)"
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu -f "$HERE/00_supabase_shim.sql"
M14="$(ls "$ROOT"/migrations/*tour_seen.sql)"
for f in "$ROOT"/migrations/*.sql; do
  case "$f" in *tour_seen.sql|*pricing_tables.sql|*feedback_status_updates.sql) continue;; esac
  runu --single-transaction -f "$f" >/dev/null 2>&1
done
runu -v migration14="$M14" -f "$HERE/70_upgrade_from_13.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit "${PIPESTATUS[0]}"

# Upgrade check 7: the LIVE state (migrations 1-15 with data) gets migration 16 (named pricing tables) on top (see 80_upgrade_from_15.sql).
echo "upgrade check: migrations 1-15 + data, then migration 16 (named pricing tables for the settlement fee)"
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu -f "$HERE/00_supabase_shim.sql"
M16="$(ls "$ROOT"/migrations/*pricing_tables.sql)"
for f in "$ROOT"/migrations/*.sql; do
  case "$f" in *pricing_tables.sql|*feedback_status_updates.sql) continue;; esac
  runu --single-transaction -f "$f" >/dev/null 2>&1
done
runu -v migration16="$M16" -f "$HERE/80_upgrade_from_15.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit "${PIPESTATUS[0]}"

# Upgrade check 8: the LIVE state (migrations 1-16 with data: feedback in every status) gets migration 17 (feedback status updates for the sender) on top (see 90_upgrade_from_16.sql).
echo "upgrade check: migrations 1-16 + data, then migration 17 (feedback status updates: shipped, seen marker)"
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu -f "$HERE/00_supabase_shim.sql"
M17="$(ls "$ROOT"/migrations/*feedback_status_updates.sql)"
for f in "$ROOT"/migrations/*.sql; do
  case "$f" in *feedback_status_updates.sql) continue;; esac
  runu --single-transaction -f "$f" >/dev/null 2>&1
done
runu -v migration17="$M17" -f "$HERE/90_upgrade_from_16.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
exit ${PIPESTATUS[0]}
