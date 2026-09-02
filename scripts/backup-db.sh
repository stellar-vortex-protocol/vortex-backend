#!/usr/bin/env bash
set -euo pipefail

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${BACKUP_DIR:-backups}"
mkdir -p "$backup_dir"

output_path="${backup_dir}/vortex-backup-${timestamp}.sql.gz"
pg_dump "${DATABASE_URL:?DATABASE_URL must be set}" | gzip -9 > "$output_path"

echo "wrote ${output_path}"
