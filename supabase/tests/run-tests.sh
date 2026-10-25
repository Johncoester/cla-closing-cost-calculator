#!/usr/bin/env bash
# Spins up a throwaway local Postgres, loads a Supabase stand-in, the migrations
# and the seed, then runs the access-rule tests. No network, no cloud, no data kept.
#   bash supabase/tests/run-tests.sh
# Needs Postgres server binaries (Debian/Ubuntu: apt install postgresql postgresql-17-cron).
# Also checks the upgrade path (migrations 1-5 + data, then 6).
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
run "$HERE/00_supabase_shim.sql"
for f in "$ROOT"/migrations/*.sql; do echo "migration: $(basename "$f")"; run "$f"; done
echo "migrations are re-runnable? (second pass)"; for f in "$ROOT"/migrations/*.sql; do run "$f" 2>&1 | grep -iE "error" && { echo "second pass error in $f"; exit 1; } || true; done
run "$ROOT/seed.sql"
run "$HERE/10_access_rules.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //' 
STATUS=${PIPESTATUS[0]}
[ "$STATUS" -eq 0 ] || exit "$STATUS"

# Upgrade check: a database that already has migrations 1-5 + data gets migration 6 on top (see 20_upgrade_from_5.sql).
echo "upgrade check: migrations 1-5 + data, then migration 6"
# (pg_cron is bound to the database named cla_test, so recreate that one instead of adding another)
"${P[@]}" -d postgres -c "drop database cla_test with (force)" -c "create database cla_test"
runu() { "${P[@]}" -d cla_test "$@"; }
runu -f "$HERE/00_supabase_shim.sql"
M6="$(ls "$ROOT"/migrations/*admin_also_rep.sql)"
for f in "$ROOT"/migrations/*.sql; do [ "$f" = "$M6" ] || runu -f "$f" >/dev/null 2>&1; done
runu -v migration6="$M6" -f "$HERE/20_upgrade_from_5.sql" 2>&1 | grep -E "PASS|FAIL|checks,|ERROR|WARNING" | sed 's/^psql:[^ ]* //'
exit ${PIPESTATUS[0]}
