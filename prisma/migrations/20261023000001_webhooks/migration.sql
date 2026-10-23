-- Issue #432: signed webhook delivery.
--
-- webhook_subscriptions holds integrator endpoints (signing secrets sealed
-- with AES-256-GCM, never plaintext); webhook_deliveries is both the delivery
-- log and the outbox — each row is written before its delivery job is queued.
CREATE TYPE "WebhookSubscriptionStatus" AS ENUM ('active', 'disabled');
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'retrying', 'succeeded', 'failed');

CREATE TABLE "webhook_subscriptions" (
  "id" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "events" JSONB NOT NULL,
  "description" TEXT,
  "secret_ciphertext" TEXT NOT NULL,
  "secret_hint" TEXT NOT NULL,
  "status" "WebhookSubscriptionStatus" NOT NULL DEFAULT 'active',
  "disabled_reason" TEXT,
  "disabled_at" TIMESTAMPTZ,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "next_sequence" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_deliveries" (
  "id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "payload" TEXT NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "attempt_log" JSONB NOT NULL DEFAULT '[]',
  "last_status_code" INTEGER,
  "last_error" TEXT,
  "next_attempt_at" TIMESTAMPTZ,
  "replay_of" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,

  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id")
    REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is created in this migration, so the build takes no meaningful lock.
CREATE INDEX "webhook_subscriptions_owner_idx" ON "webhook_subscriptions"("owner");

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is created in this migration, so the build takes no meaningful lock.
CREATE INDEX "webhook_subscriptions_status_idx" ON "webhook_subscriptions"("status");

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is created in this migration, so the build takes no meaningful lock.
CREATE INDEX "webhook_deliveries_subscription_idx" ON "webhook_deliveries"("subscription_id", "created_at" DESC);

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is created in this migration, so the build takes no meaningful lock.
CREATE INDEX "webhook_deliveries_status_next_idx" ON "webhook_deliveries"("status", "next_attempt_at");
