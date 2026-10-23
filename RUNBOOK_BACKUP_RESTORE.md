# Runbook: Backup & Restore — Persistent Intents Store + Cold-Storage Archival

> **Applies from:** issue #36 (persistence migration) onwards.
> Issue #413 adds cold-storage archival to Parquet / S3 for terminal intents.

---

## 1. Overview

Vortex stores three categories of durable data:

| Category | Storage | Backup strategy |
|---|---|---|
| Live intents (open / accepted) | PostgreSQL primary | Pg-dump + RDS automated backups |
| Terminal intents (filled / cancelled / expired / slashed) ≤ 30 days | PostgreSQL primary | Pg-dump |
| Terminal intents > 30 days | Parquet files in S3 (`ARCHIVAL_BUCKET_NAME`) | S3 versioning / lifecycle |

Loss of the live intents table means users cannot verify pending fills; loss of
the terminal archive means analytics and dispute resolution lose historical data.

---

## 2. Infrastructure Assumptions

| Component | Value |
|---|---|
| Database | PostgreSQL 16 (TimescaleDB, primary + streaming replica) |
| Replica routing | `DATABASE_REPLICA_URLS` (issue #411) |
| Backup storage | S3 bucket `vortex-backups-<env>` |
| Archive storage | S3 bucket defined by `ARCHIVAL_BUCKET_NAME` |
| Local dev archive | MinIO (`docker compose --profile archival up`) |
| Retention | Postgres: 30 days (`INTENT_RETENTION_DAYS`) / S3: indefinite |

---

## 3. Environment Variables

```dotenv
# Postgres primary
DATABASE_URL=postgresql://vortex:<SECRET>@db.prod.vortex.trade:5432/vortex?schema=public

# Read replicas (issue #411)
DATABASE_REPLICA_URLS=postgresql://vortex:<SECRET>@replica.prod.vortex.trade:5432/vortex?schema=public
MAX_REPLICA_LAG_MS=5000

# Cold-storage archival (issue #413)
ARCHIVAL_ENABLED=true
ARCHIVAL_BUCKET_NAME=vortex-archives-prod
ARCHIVAL_S3_ENDPOINT=          # blank = AWS S3; set to http://localhost:9000 for MinIO
ARCHIVAL_S3_REGION=us-east-1
ARCHIVAL_S3_ACCESS_KEY_ID=<SECRET>
ARCHIVAL_S3_SECRET_ACCESS_KEY=<SECRET>
ARCHIVAL_RETENTION_DAYS=30     # days before a terminal intent is eligible for archival
ARCHIVAL_PARTITION_PREFIX=date=
ARCHIVAL_MAX_ROWS_PER_FILE=100000

# pg_dump backup bucket (separate from archive)
BACKUP_S3_BUCKET=vortex-backups-prod
AWS_REGION=us-east-1
```

---

## 4. Automated Backup (Cron)

### 4.1 Daily full pg_dump

```cron
# /etc/cron.d/vortex-backup — runs at 02:00 UTC
0 2 * * * postgres /opt/vortex/scripts/backup-db.sh >> /var/log/vortex-backup.log 2>&1
```

See `scripts/backup-db.sh` for the full implementation (pg_dump → S3 upload).

### 4.2 Cold-storage archival job (issue #413)

The `ArchivalJob` runs daily at **02:00 UTC** when `ARCHIVAL_ENABLED=true`.
It:

1. Scans all date partitions from `ARCHIVAL_RETENTION_DAYS` ago to yesterday.
2. For each unarchived date, exports eligible rows cursor-by-cursor into
   partitioned Parquet files at `s3://<ARCHIVAL_BUCKET_NAME>/<ARCHIVAL_PARTITION_PREFIX><YYYY-MM-DD>/`.
3. Writes a `manifest.json` with row counts and SHA-256 checksums.
4. Verifies every uploaded file against the manifest.
5. **Only then** deletes matching rows from Postgres.

**A failed upload or checksum mismatch aborts the job — Postgres rows are never deleted.**

The job is **idempotent**: if `manifest.json` already exists for a date it is skipped.

#### Trigger manually (admin):

```bash
# Inside the running container:
npx tsx scripts/restore-archive.ts --date 2026-09-01 --dry-run
```

Or fire via the admin API (when implemented):

```bash
curl -X POST http://localhost:4000/api/v1/admin/archival/run \
  -H "x-admin-key: <ADMIN_SECRET>" \
  -d '{"date":"2026-09-01"}'
```

#### MinIO local dev:

```bash
# Start MinIO alongside the app:
docker compose --profile archival up -d minio

# Create the bucket:
docker exec vortex-minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker exec vortex-minio mc mb local/vortex-archives

# Then set:
ARCHIVAL_ENABLED=true
ARCHIVAL_S3_ENDPOINT=http://localhost:9000
ARCHIVAL_S3_ACCESS_KEY_ID=minioadmin
ARCHIVAL_S3_SECRET_ACCESS_KEY=minioadmin
```

---

## 5. Manual On-Demand Backup

```bash
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

PGPASSWORD="${DB_PASSWORD}" pg_dump \
  --host="${DB_HOST}" --port="${DB_PORT}" --username="${DB_USER}" \
  --format=custom --compress=9 \
  --file="/tmp/vortex-manual-${TIMESTAMP}.dump" \
  "${DB_NAME}"

aws s3 cp "/tmp/vortex-manual-${TIMESTAMP}.dump" \
  "s3://${BACKUP_S3_BUCKET}/manual/${TIMESTAMP}.dump" --sse AES256
```

---

## 6. Verifying Backup Integrity

### 6.1 pg_dump checksum

```bash
pg_restore --list "/tmp/vortex-${TIMESTAMP}.dump" | head -20
```

### 6.2 Archival manifest

```bash
# Fetch and print the manifest for a date:
aws s3 cp s3://${ARCHIVAL_BUCKET_NAME}/date=2026-09-01/manifest.json - | jq .

# Run the restore script in dry-run mode to re-verify checksums:
tsx scripts/restore-archive.ts --date 2026-09-01 --dry-run
```

Expected output: `All checksums verified ✓`

---

## 7. Restore Procedures

### 7.1 Full pg_dump restore (primary outage)

```bash
# 1. Download the latest backup
aws s3 cp s3://${BACKUP_S3_BUCKET}/daily/<TIMESTAMP>.dump /tmp/restore.dump

# 2. Stop the application (scale ECS to 0, or set MAINTENANCE_MODE=true)

# 3. Drop and recreate the target database
psql -c "DROP DATABASE IF EXISTS ${DB_NAME};"
psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

# 4. Restore
PGPASSWORD="${DB_PASSWORD}" pg_restore \
  --host="${DB_HOST}" --username="${DB_USER}" --dbname="${DB_NAME}" \
  --no-privileges --no-owner --exit-on-error /tmp/restore.dump

# 5. Verify
psql -d "${DB_NAME}" -c "SELECT COUNT(*) FROM intents;"

# 6. Restart the application
```

### 7.2 Restore archived intents from cold storage (issue #413)

Use this when you need historical terminal intents that were already evicted
from Postgres (e.g. for dispute resolution or analytics).

```bash
# Restore into a staging schema (safe — does NOT touch the live schema):
DATABASE_URL="postgresql://vortex:<SECRET>@localhost:5432/vortex?schema=public" \
ARCHIVAL_BUCKET_NAME=vortex-archives-prod \
ARCHIVAL_S3_REGION=us-east-1 \
ARCHIVAL_S3_ACCESS_KEY_ID=<SECRET> \
ARCHIVAL_S3_SECRET_ACCESS_KEY=<SECRET> \
  tsx scripts/restore-archive.ts --date 2026-09-01

# Verify the import:
psql $DATABASE_URL -c 'SELECT COUNT(*) FROM archive_staging.intents;'
psql $DATABASE_URL -c "SELECT state, COUNT(*) FROM archive_staging.intents GROUP BY state;"

# Query the restored data (example: fill volume on that day):
psql $DATABASE_URL -c "
  SELECT SUM(fill_amount::numeric) AS fill_volume
  FROM archive_staging.intents
  WHERE state = 'filled';"

# Drop the staging schema when done:
psql $DATABASE_URL -c 'DROP SCHEMA archive_staging CASCADE;'
```

**Options:**

| Flag | Description |
|---|---|
| `--date YYYY-MM-DD` | Date partition to restore (required) |
| `--dry-run` | Verify checksums only, no Postgres writes |
| `--schema <name>` | Target schema (default: `archive_staging`) |

### 7.3 Point-in-time restore (RDS)

1. Open the RDS console → select the `vortex-prod` instance.
2. Choose **Actions → Restore to point in time**.
3. Target time: 1 minute before the incident (UTC).
4. Launch as `vortex-prod-restored`.
5. Update `DATABASE_URL` in Parameter Store.
6. Validate row counts and restart the application.

---

## 8. Read Replica Health (issue #411)

```bash
# Check current replica lag via the API:
curl http://localhost:4000/api/v1/health | jq .replicas

# Direct Postgres query on a replica:
psql $REPLICA_URL -c "
  SELECT
    pg_is_in_recovery() AS is_replica,
    NOW() - pg_last_xact_replay_timestamp() AS lag;"
```

When `MAX_REPLICA_LAG_MS` is exceeded the service falls back to primary
automatically (logged as `[replica] All replicas lagging or unhealthy — falling back to primary`).

---

## 8a. Audit-log partitions (issue #407)

`intent_audit_log` becomes a table range-partitioned by month on
`"timestamp"`. Partitions are named `intent_audit_log_yYYYYmMM`, bounds are
UTC month starts, and `intent_audit_log_default` catches any row whose month
has no partition, so an insert can never fail at a month boundary. Prisma
keeps using the model `IntentAuditLog` → `intent_audit_log`; it cannot model
partitions, so everything partition-specific is raw SQL.

### 8a.1 Rollout (zero downtime)

| Step | Action | Rollback |
|------|--------|----------|
| 1 | Deploy migration `20261022000000_audit_log_partitioned_expand`. It creates `intent_audit_log_p` (partitioned, sharing `intent_audit_log_id_seq`), its default partition, monthly partitions from the oldest row through three months ahead, and a trigger that mirrors every change on the live table. | `down.sql` |
| 2 | `npm run db:backfill-audit-partitions` copies existing rows in ≤ 5k-row batches (`lock_timeout` 1 s, resumable via `.backfill-audit-partitions.json`). Repeat with `-- --verify` until it prints `0 row(s) missing`. | Nothing to undo |
| 3 | In a later release, move `prisma/staged-migrations/407-audit-log-partitioning/20261201000000_audit_log_partition_swap` into `prisma/migrations/`, together with the `@@id([id, timestamp])` schema change (see that folder's README). It re-verifies, then swaps names in one catalog-only transaction. | swap `down.sql` copies post-swap rows back and swaps the names back |
| 4 | Optional, later: `…_audit_log_drop_legacy` drops `intent_audit_log_legacy` after re-verifying. | Restore from backup |

### 8a.2 Creating partitions ahead

`AuditPartitionService` (leader-elected worker `audit-partitions`) runs at
start-up and every `AUDIT_PARTITION_INTERVAL_MS` (default 6 h). It makes sure
the current month and the next `AUDIT_PARTITION_PREMAKE_MONTHS` (default 3)
have partitions by calling:

```sql
SELECT intent_audit_log_ensure_partition('intent_audit_log'::regclass, DATE '2027-02-01');
```

The function is idempotent. If rows for that month already landed in the
default partition, it moves them into the new partition in the same
transaction. Run it by hand to create a month early. Before the swap the
parent is `intent_audit_log_p`; the service picks whichever table is
partitioned.

**Alternative: `pg_partman`.** Where the extension is available (RDS, Cloud
SQL and Timescale images ship it), it can own creation and retention instead:

```sql
CREATE EXTENSION IF NOT EXISTS pg_partman;
SELECT partman.create_parent(
  p_parent_table   => 'public.intent_audit_log',
  p_control        => 'timestamp',
  p_interval       => '1 month',
  p_premake        => 3,
  p_default_table  => true);
UPDATE partman.part_config
   SET retention = '24 months', retention_keep_table = true
 WHERE parent_table = 'public.intent_audit_log';
-- schedule: SELECT partman.run_maintenance(); (pg_cron or an external cron)
```

When using pg_partman, set `AUDIT_PARTITION_MAINTENANCE_ENABLED=false`, and
note that its child tables follow its own naming (`intent_audit_log_p20270201`),
not `_yYYYYmMM`.

### 8a.3 Retention

`AUDIT_RETENTION_MONTHS=0` (default) keeps every partition attached. With
`N > 0`, partitions whose month began more than `N` months before the current
month are:

1. **Detached.** This is a plain `DETACH PARTITION` under a 1 s lock timeout.
   It is catalog-only. `DETACH … CONCURRENTLY` is not allowed while a default
   partition exists.
2. **Renamed** to `intent_audit_log_detached_yYYYYmMM`, with the foreign key to
   `intents` dropped so intent archival (§4.2) can no longer cascade into the
   retained history.
3. **Exported**, when archival is enabled (`ARCHIVAL_*`), to
   `s3://$ARCHIVAL_BUCKET_NAME/audit-partitions/yYYYYmMM/part-NNNNN.parquet`
   plus `manifest.json` (row counts and SHA-256 per file). An existing
   manifest means the export already happened and is skipped.
4. **Kept** as a table. Only with `AUDIT_RETENTION_DROP_AFTER_EXPORT=true`, and
   only after every file in the manifest is confirmed present, is the
   detached table dropped.

### 8a.4 Restoring a detached or exported month

```sql
-- Re-attach a detached table (it must not overlap an attached partition):
ALTER TABLE intent_audit_log_detached_y2025m03 RENAME TO intent_audit_log_y2025m03;
ALTER TABLE intent_audit_log ATTACH PARTITION intent_audit_log_y2025m03
  FOR VALUES FROM ('2025-03-01 00:00+00') TO ('2025-04-01 00:00+00');
```

For a dropped month, load the Parquet files from `audit-partitions/yYYYYmMM/`
into a table of the same shape, then attach it as above. The files use the
same audit Parquet schema and manifest entries (`type: "audit"`) as intent
archival, so the audit-file import in `scripts/restore-archive.ts` is the
reference for loading them.

### 8a.5 Monitoring

| Metric | Meaning |
|--------|---------|
| `vortex_audit_log_partition_months_ahead` | Future months that already have a partition (should be ≥ 1) |
| `vortex_audit_log_default_partition_rows` | Rows in the default partition (should be 0) |
| `vortex_audit_log_partitions{state}` | Attached / detached partition counts |
| `vortex_audit_log_partition_ops_total{op,result}` | create / detach / export / drop outcomes |

Alerts are in `ops/prometheus/rules/vortex-audit-partitions.yml`. If rows
show up in the default partition, run
`intent_audit_log_ensure_partition()` for the month they belong to (find it
with `SELECT date_trunc('month', "timestamp"), count(*) FROM intent_audit_log_default GROUP BY 1`).

---

## 9. Monitoring & Alerting

| Alert | Condition | Destination |
|---|---|---|
| Backup missing | No new object in `daily/` after 03:00 UTC | PagerDuty P2 |
| Backup size anomaly | File size drops >30% vs 7-day average | Slack #ops-alerts |
| Archival job failed | `[archival] … failed` in logs | PagerDuty P2 |
| Archival checksum mismatch | Job throws checksum error | PagerDuty P1 |
| Replica lag > MAX_REPLICA_LAG_MS | Application log warning | Slack #ops-alerts |
| RDS storage > 80% | CloudWatch metric | PagerDuty P1 |

---

## 10. Restore Drill Schedule

| Frequency | Activity | Owner |
|---|---|---|
| Weekly | Automated pg_dump integrity check | Cron job |
| Weekly | `--dry-run` archival manifest verify for recent dates | Cron job |
| Monthly | Manual restore to staging (`restore-archive.ts`) + row-count spot-check | On-call engineer |
| Quarterly | Full disaster-recovery drill: take prod offline, restore, measure RTO | Engineering lead |

Document each drill in `#ops-drills` with: date, backup file used, actual RTO, any issues found.

---

## 11. Related Issues

- **#36** — Replace in-memory store with persistent database
- **#410** — Token FK normalisation (src_token_id / dst_token_id added to archive schema)
- **#411** — Read-replica routing (`DATABASE_REPLICA_URLS`)
- **#412** — Keyset pagination (reduces primary load from list endpoints)
- **#413** — Cold-storage archival (this document updated)
- **#62** — Audit trail for intent lifecycle transitions
- **#407** — Monthly partitions and retention for `intent_audit_log` (§8a)
