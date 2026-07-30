# Runbook: Backup & Restore — Persistent Intents Store

> **Applies from:** issue #36 (persistence migration) onwards.
> Until then the service is in-memory and a restart re-seeds from
> `scripts/seed.ts` — no backup is needed today.

---

## 1. Overview

Once intents move off in-memory storage, they represent real financial state:
pending swaps, locked funds, and solver commitments.  Loss of this data means
users cannot verify historical fills, solvers cannot dispute slash events, and
the protocol stats dashboard shows incorrect totals.

This runbook covers:

- Scheduled automated backups
- Manual on-demand backups
- Verifying backup integrity
- Full and point-in-time restore procedures
- Restore drill schedule

---

## 2. Infrastructure Assumptions

| Component | Value |
|---|---|
| Database | PostgreSQL 15 (primary + 1 replica) |
| Hosting | AWS RDS (or self-managed on EC2) |
| Backup storage | S3 bucket `vortex-backups-<env>` |
| Retention | 30 days daily, 12 months monthly |
| Region | Same region as the service to minimise egress |
| Encryption | AES-256 at rest (S3 SSE-S3 or SSE-KMS) |

Adjust the bucket name, region, and credentials in `.env` / ECS task
definition before using any command below.

---

## 3. Environment Variables

```dotenv
# .env (never commit real values)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=vortex
DB_USER=vortex_app
DB_PASSWORD=<secret>
BACKUP_S3_BUCKET=vortex-backups-prod
AWS_REGION=us-east-1
```

---

## 4. Automated Backup (Cron)

### 4.1 Daily full backup

Add the following cron job to the database host (or a dedicated ops container):

```cron
# /etc/cron.d/vortex-backup
# Daily at 02:00 UTC
0 2 * * * postgres /opt/vortex/scripts/backup-daily.sh >> /var/log/vortex-backup.log 2>&1
```

`scripts/backup-daily.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DUMP_FILE="/tmp/vortex-${TIMESTAMP}.dump"

echo "[backup] Starting full backup at ${TIMESTAMP}"

# 1. Create a binary-format dump (faster restore than plain SQL)
PGPASSWORD="${DB_PASSWORD}" pg_dump \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_USER}" \
  --format=custom \
  --compress=9 \
  --file="${DUMP_FILE}" \
  "${DB_NAME}"

# 2. Upload to S3
aws s3 cp "${DUMP_FILE}" \
  "s3://${BACKUP_S3_BUCKET}/daily/${TIMESTAMP}.dump" \
  --sse AES256 \
  --region "${AWS_REGION}"

# 3. Clean up local file
rm -f "${DUMP_FILE}"

echo "[backup] Done — s3://${BACKUP_S3_BUCKET}/daily/${TIMESTAMP}.dump"
```

### 4.2 Retention lifecycle policy (S3)

Apply this lifecycle rule to `vortex-backups-<env>`:

```json
{
  "Rules": [
    {
      "ID": "expire-daily-backups",
      "Prefix": "daily/",
      "Status": "Enabled",
      "Expiration": { "Days": 30 }
    },
    {
      "ID": "expire-monthly-backups",
      "Prefix": "monthly/",
      "Status": "Enabled",
      "Expiration": { "Days": 365 }
    }
  ]
}
```

On the first day of each month the cron should also copy the daily backup to
`monthly/` before the daily prefix's 30-day expiry deletes it.

### 4.3 RDS automated backups (if using AWS RDS)

Enable automated backups and set the retention window to 7 days in Terraform /
the AWS console.  This gives point-in-time recovery (PITR) within the last
7 days at no extra scripting cost, and the `backup-daily.sh` script above
handles the longer 30-day / 12-month archive tier.

---

## 5. Manual On-Demand Backup

Run this whenever you need a backup outside the scheduled window (e.g. before
a schema migration, before a major deploy):

```bash
# From any machine with psql/pg_dump and AWS CLI access

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

PGPASSWORD="${DB_PASSWORD}" pg_dump \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_USER}" \
  --format=custom \
  --compress=9 \
  --file="/tmp/vortex-manual-${TIMESTAMP}.dump" \
  "${DB_NAME}"

aws s3 cp "/tmp/vortex-manual-${TIMESTAMP}.dump" \
  "s3://${BACKUP_S3_BUCKET}/manual/${TIMESTAMP}.dump" \
  --sse AES256
```

---

## 6. Verifying Backup Integrity

After each automated backup, verify the file is readable:

```bash
# List the custom-format table of contents (non-destructive)
PGPASSWORD="${DB_PASSWORD}" pg_restore \
  --list \
  "/tmp/vortex-${TIMESTAMP}.dump" | head -20
```

For a deeper check, restore to a throwaway database:

```bash
# Create a scratch DB
psql -c "CREATE DATABASE vortex_verify;"

# Restore
PGPASSWORD="${DB_PASSWORD}" pg_restore \
  --host="${DB_HOST}" \
  --username="${DB_USER}" \
  --dbname="vortex_verify" \
  --no-privileges \
  --no-owner \
  "/tmp/vortex-${TIMESTAMP}.dump"

# Spot-check row counts
psql -d vortex_verify -c "SELECT COUNT(*) FROM intents;"
psql -d vortex_verify -c "SELECT COUNT(*) FROM intent_audit_log;"

# Tear down
psql -c "DROP DATABASE vortex_verify;"
```

Add a weekly cron that runs the above and alerts to Slack / PagerDuty if the
row count differs from the primary by more than 1 %.

---

## 7. Restore Procedures

### 7.1 Full restore from S3 backup

Use this when the database is unrecoverable (disk failure, accidental DROP).

**Expected RTO: ~15 minutes for a 1 GB database.**

```bash
# Step 1: Download the latest (or chosen) backup
BACKUP_KEY="daily/20260101T020000Z.dump"   # ← set to the desired backup

aws s3 cp \
  "s3://${BACKUP_S3_BUCKET}/${BACKUP_KEY}" \
  /tmp/restore.dump

# Step 2: Stop the application to prevent writes during restore
# (scale ECS service to 0, or set MAINTENANCE_MODE=true)

# Step 3: Drop and recreate the target database
psql -c "DROP DATABASE IF EXISTS ${DB_NAME};"
psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

# Step 4: Restore
PGPASSWORD="${DB_PASSWORD}" pg_restore \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_USER}" \
  --dbname="${DB_NAME}" \
  --no-privileges \
  --no-owner \
  --exit-on-error \
  /tmp/restore.dump

# Step 5: Verify
psql -d "${DB_NAME}" -c "SELECT COUNT(*) FROM intents;"

# Step 6: Restart the application
```

### 7.2 Point-in-time restore (RDS)

If using AWS RDS with automated backups enabled:

1. Open the RDS console → select the `vortex-prod` instance.
2. Choose **Actions → Restore to point in time**.
3. Set the target time (UTC) to 1 minute before the incident.
4. Launch as a new instance (`vortex-prod-restored`).
5. Update `DB_HOST` in the ECS task definition / Parameter Store to point at
   the new instance.
6. Validate row counts and application health, then delete the original
   instance or rename it as a snapshot.

### 7.3 Partial restore (single table)

To restore only the `intents` table without affecting other tables:

```bash
PGPASSWORD="${DB_PASSWORD}" pg_restore \
  --host="${DB_HOST}" \
  --username="${DB_USER}" \
  --dbname="${DB_NAME}" \
  --table=intents \
  --data-only \
  /tmp/restore.dump
```

> **Warning:** restoring `intents` data-only without also restoring
> `intent_audit_log` will leave audit entries orphaned if foreign-key
> constraints reference `intents.intent_id`.  Restore both tables together or
> temporarily disable FK constraints.

---

## 8. Monitoring & Alerting

| Alert | Condition | Destination |
|---|---|---|
| Backup missing | No new object in `daily/` after 03:00 UTC | PagerDuty P2 |
| Backup size anomaly | File size drops >30 % vs 7-day average | Slack #ops-alerts |
| Restore drill failed | Weekly verify cron exits non-zero | PagerDuty P2 |
| RDS storage > 80 % | CloudWatch metric | PagerDuty P1 |

---

## 9. Restore Drill Schedule

A backup that has never been tested is not a backup.

| Frequency | Activity | Owner |
|---|---|---|
| Weekly | Automated integrity check (section 6) | Cron job |
| Monthly | Manual restore to `vortex-staging` and smoke-test the API | On-call engineer |
| Quarterly | Full disaster-recovery drill: take prod offline, restore from backup, measure RTO | Engineering lead |

Document each drill result in the `#ops-drills` Slack channel with:
- Date and time
- Backup file used
- Actual RTO achieved
- Any issues found and remediation taken

---

## 10. Related Issues

- **#36** — Replace in-memory store with persistent database (prerequisite for this runbook)
- **#59** — Standalone seed script for local dev
- **#60** — Database indexes for `getByUser` / `getByState` query patterns
- **#62** — Audit trail for cancelled and expired intents
