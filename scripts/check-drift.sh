#!/usr/bin/env bash
# Verifies that the migrations produce exactly the schema in prisma/schema.prisma.
# 1. Applies all migrations to an empty database (A).
# 2. Creates the schema straight from schema.prisma in another empty database (B).
# 3. Compares columns, keys, foreign keys, indexes and enums. Objects written by hand in migrations
#    (partial indexes; CHECK constraints, row-level security and grants are not compared) are listed below.
#
#   ADMIN_URL=postgresql://staysync:pw@localhost:5432/postgres scripts/check-drift.sh
# APPLY_CMD (with {url}) and DIFF_CMD may override how migrations are applied and the schema SQL is produced.
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
: "${ADMIN_URL:?set ADMIN_URL to a postgres URL with CREATEDB rights}"
A=staysync_drift_a_$$
B=staysync_drift_b_$$
base="${ADMIN_URL%/*}"
cleanup() { psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $A" -qc "DROP DATABASE IF EXISTS $B" >/dev/null 2>&1 || true; }
trap cleanup EXIT
psql "$ADMIN_URL" -qc "CREATE DATABASE $A" -qc "CREATE DATABASE $B"

if [ -n "${APPLY_CMD:-}" ]; then
  eval "${APPLY_CMD//\{url\}/$base/$A}"
else
  MIGRATION_DATABASE_URL="$base/$A" DATABASE_URL="$base/$A" npx prisma migrate deploy >/dev/null
fi
if [ -n "${DIFF_CMD:-}" ]; then
  eval "$DIFF_CMD" > /tmp/staysync-schema-$$.sql
else
  npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > /tmp/staysync-schema-$$.sql
fi
psql "$base/$B" -q -v ON_ERROR_STOP=1 -f /tmp/staysync-schema-$$.sql >/dev/null 2>&1
rm -f /tmp/staysync-schema-$$.sql

Q="select 'col', table_name, column_name, data_type, coalesce(character_maximum_length::text,''), is_nullable, coalesce(column_default,'') from information_schema.columns where table_schema='public' and table_name<>'_prisma_migrations'
union all select 'idx', tablename, indexname, indexdef, '', '', '' from pg_indexes where schemaname='public' and tablename<>'_prisma_migrations'
union all select 'con', conrelid::regclass::text, conname, contype::text, pg_get_constraintdef(oid), '', '' from pg_constraint where connamespace='public'::regnamespace and contype in ('p','f','u') and conrelid::regclass::text<>'_prisma_migrations'
union all select 'enum', t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder), '', '', '', '' from pg_enum e join pg_type t on t.oid=e.enumtypid group by t.typname
order by 1,2,3"
# Hand-written objects that exist only in migrations (by design):
ALLOW='^idx\|(discrepancies\|discrepancies_open_dedupe_key|reservation_rooms\|reservation_rooms_occupancy_idx|photos\|photos_one_main_property|photos\|photos_one_main_room_type)\|'
diff <(psql "$base/$A" -AtF'|' -c "$Q" | grep -Ev "$ALLOW") <(psql "$base/$B" -AtF'|' -c "$Q" | grep -Ev "$ALLOW") && echo "No drift: migrations match schema.prisma."
