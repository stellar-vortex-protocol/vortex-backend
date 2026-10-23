# Staged: intent_audit_log partition swap (issue #407)

These migrations are **not applied by `prisma migrate deploy`** yet. Move
them into `prisma/migrations/` (renaming each to a current timestamp, in
order) in a later release, once phase 1 is live and the backfill is verified:

```bash
npm run db:backfill-audit-partitions            # resumable, ≤ 5k rows per transaction
npm run db:backfill-audit-partitions -- --verify  # must print "0 row(s) missing"
```

| Directory | Effect |
|-----------|--------|
| `20261201000000_audit_log_partition_swap` | Verification guard, then swaps `intent_audit_log` ↔ `intent_audit_log_p` by renaming. Catalog-only. |
| `20261201000001_audit_log_drop_legacy` | Optional, ships one or more releases later: drops `intent_audit_log_legacy` after re-verifying. |

Ship the swap with this `prisma/schema.prisma` change, so the model matches
the partitioned table's primary key:

```prisma
model IntentAuditLog {
  id        BigInt   @default(autoincrement()) @map("id")
  // …
  timestamp DateTime @default(now()) @map("timestamp") @db.Timestamptz
  // …
  @@id([id, timestamp])
  @@index([intentId, timestamp(sort: Asc)], name: "audit_log_intent_idx")
  @@map("intent_audit_log")
}
```

No application code changes: the model already maps to `intent_audit_log`,
and writes and reads go through the same name before and after the swap.

## Rollback

- Swap: run its `down.sql`. It copies rows written since the swap back to the
  legacy table, swaps the names back and restores the mirror trigger.
- Drop-legacy: irreversible (restore from backup); it only runs after
  verifying every legacy row exists in the partitioned table.

See `RUNBOOK_BACKUP_RESTORE.md` → "Audit-log partitions" for the full
procedure, retention and `pg_partman`.
