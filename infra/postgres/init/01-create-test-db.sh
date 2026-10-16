#!/bin/sh
# Runs once, on first start of an empty data volume:
#  1. creates the separate database used by integration tests
#  2. creates the least-privilege API role (staysync_app) in both databases
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE ${POSTGRES_DB}_test OWNER "$POSTGRES_USER";
SQL
for db in "$POSTGRES_DB" "${POSTGRES_DB}_test"; do
  psql -v ON_ERROR_STOP=1 -v app_password="${APP_DB_PASSWORD:-change-me-app-password}" \
    --username "$POSTGRES_USER" --dbname "$db" -f /staysync/app-role.sql
done
