# Database Indexes

> **Status:**
> - Sections 1 & 2 (composite/partial indexes): ✅ implemented in
>   `prisma/migrations/20260828000001_composite_partial_indexes/migration.sql`
> - Section 3 (audit log table + index): ✅ implemented in
>   `prisma/migrations/20260828000002_intent_audit_log/migration.sql`
>   and `prisma/schema.prisma` (`IntentAuditLog` model).
>   `IntentsService.appendAuditEntry()` now writes through to the DB;
>   `GET /api/v1/intents/:id/audit` exposes the trail via the API.

---

## Context

`IntentsService` exposes two high-frequency query patterns:

| Method | SQL equivalent | Called by |
|---|---|---|
| `getByUser(user)` | `SELECT … WHERE user = $1` | `GET /api/v1/intents/user/:address`, `GET /api/v1/intents?user=` |
| `getByState(state)` | `SELECT … WHERE state = $1` | `GET /api/v1/intents/open`, `IntentsSweeperService` (every 30 s) |

Both currently call `getAll()` and filter in JavaScript — acceptable for an
in-memory map with tens of rows, but will degrade to O(n) table scans at scale.

---

## Required Indexes

### 1. `intents_user_idx` — user look-up

```sql
-- Covers IntentsService.getByUser()
CREATE INDEX IF NOT EXISTS intents_user_idx
    ON intents (user);
```

If the table is partitioned by `created_at`, add `created_at DESC` to make
range + user queries index-only:

```sql
CREATE INDEX IF NOT EXISTS intents_user_created_idx
    ON intents (user, created_at DESC);
```

**Cardinality:** `user` (Stellar public key, 56 chars) is high-cardinality — a
B-tree index is the right choice and will avoid collisions with hash indexes.

---

### 2. `intents_state_idx` — state filter

```sql
-- Covers IntentsService.getByState(), especially getByState("open")
-- which is called on every sweeper tick.
CREATE INDEX IF NOT EXISTS intents_state_idx
    ON intents (state);
```

Because `state` is low-cardinality (6 possible values) and queries almost
always add `ORDER BY created_at DESC`, a composite index is more efficient:

```sql
CREATE INDEX IF NOT EXISTS intents_state_created_idx
    ON intents (state, created_at DESC);
```

For PostgreSQL 12+ you can use a **partial index** to keep the hot path
(open intents, which the sweeper polls) especially lean:

```sql
CREATE INDEX IF NOT EXISTS intents_open_partial_idx
    ON intents (created_at DESC)
    WHERE state = 'open';
```

---

### 3. `intent_audit_log` table (issue #62 / #217) — ✅ implemented

Once the audit trail (issue #62) is persisted, the `intent_audit_log` table
will be append-only and queried by `intent_id`:

```sql
CREATE TABLE intent_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    intent_id   UUID        NOT NULL REFERENCES intents(intent_id),
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    to_state    TEXT        NOT NULL,
    actor       TEXT        NOT NULL,
    reason      TEXT        NOT NULL,
    metadata    JSONB
);

-- Index for "give me the full history of intent X"
CREATE INDEX IF NOT EXISTS audit_log_intent_idx
    ON intent_audit_log (intent_id, timestamp ASC);
```

---

## Migration

Create a migration file (e.g. `migrations/0002_add_indexes.sql` or the
equivalent ORM migration) containing the `CREATE INDEX` statements above.
Run it as part of the deployment pipeline **before** removing the in-memory
store so no downtime is incurred.

Example with `node-pg-migrate`:

```bash
node-pg-migrate create --name add_intent_indexes
# paste the CREATE INDEX statements into the generated file
node-pg-migrate up
```

---

## Monitoring

After deploying, verify the indexes are being used with `EXPLAIN ANALYZE`:

```sql
-- Should show "Index Scan using intents_state_idx" (or the partial index)
EXPLAIN ANALYZE
  SELECT * FROM intents WHERE state = 'open' ORDER BY created_at DESC LIMIT 20;

-- Should show "Index Scan using intents_user_created_idx"
EXPLAIN ANALYZE
  SELECT * FROM intents WHERE user = 'GABC...1234' ORDER BY created_at DESC;
```

Alert if `rows_examined / rows_returned > 10` for either query in production.
