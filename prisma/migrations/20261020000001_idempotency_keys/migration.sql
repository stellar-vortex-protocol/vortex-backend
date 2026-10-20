-- Issue #418 — durable, cross-replica Idempotency-Key store.
--
-- Postgres rather than Redis: the keys guard writes to `intents`, so they get
-- the same durability, backups and failover as the data they protect, and no
-- Redis persistence (AOF/RDB) configuration becomes load-bearing. One indexed
-- primary-key upsert per write request is well within budget.

CREATE TYPE "idempotency_key_status" AS ENUM ('in_progress', 'completed');

CREATE TABLE "idempotency_keys" (
    "key"                   TEXT                     NOT NULL,
    -- "<METHOD> <route pattern>", e.g. "POST /api/v1/intents/:id/fill".
    "scope"                 TEXT                     NOT NULL,
    -- API key, session subject, or the signing address in the body.
    "principal"             TEXT                     NOT NULL,
    "request_hash"          TEXT                     NOT NULL,
    "status"                "idempotency_key_status" NOT NULL,
    "response_status"       INTEGER,
    "response_body"         TEXT,
    "response_content_type" TEXT,
    -- Lease end while in_progress; a crashed request's claim is retaken after it.
    "locked_until"          TIMESTAMPTZ,
    "created_at"            TIMESTAMPTZ              NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"            TIMESTAMPTZ              NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key", "scope", "principal")
);

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration in a transaction, which forbids CONCURRENTLY; idempotency_keys is created empty in this migration.
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys"("expires_at");
