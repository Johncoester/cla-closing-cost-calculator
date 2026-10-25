#!/usr/bin/env bash
# Spins up a throwaway local Postgres, loads a Supabase stand-in, the migrations
# and the seed, then runs the access-rule tests. No network, no cloud, no data kept.
#   bash supabase/tests/run-tests.sh
# Needs Postgres server binaries (Debian/Ubuntu: apt install postgresql postgresql-17-cron).
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
exit $STATUS
