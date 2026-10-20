#!/bin/sh
# Writes /backups/staysync-YYYYmmdd-HHMMSS.dump (custom format, compressed) and removes dumps older than KEEP_DAYS.
# Restore: pg_restore --clean --if-exists -h postgres -U staysync -d staysync /backups/<file>.dump
set -eu
file="/backups/staysync-$(date -u +%Y%m%d-%H%M%S).dump"
pg_dump -h postgres -U staysync -d "${POSTGRES_DB:-staysync}" --format=custom --compress=9 --file="$file.partial"
mv "$file.partial" "$file"
find /backups -name 'staysync-*.dump' -mtime "+${KEEP_DAYS:-14}" -delete
echo "backup written: $file"
