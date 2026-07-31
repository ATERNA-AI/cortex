#!/usr/bin/env bash
set -euo pipefail
export HOME=/tmp

backup_dir=/var/backups/stormy-cortex
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_dir/stormy-cortex-$stamp.dump"
tmp="$target.partial"

install -d -m 0700 -o stormy -g stormy "$backup_dir"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" --file "$tmp"
pg_restore --list "$tmp" >/dev/null
mv "$tmp" "$target"
sha256sum "$target" >"$target.sha256"
find "$backup_dir" -type f -name 'stormy-cortex-*.dump' -mtime +30 -delete
find "$backup_dir" -type f -name 'stormy-cortex-*.dump.sha256' -mtime +30 -delete
