#!/bin/sh
# Runs once on an empty data volume: creates the least-privilege role the API connects as.
set -eu
psql -v ON_ERROR_STOP=1 -v app_password="${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /staysync/app-role.sql
