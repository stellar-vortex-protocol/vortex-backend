-- A safe migration: CONCURRENTLY index build and a nullable column add.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "intents_user_idx" ON "intents"("user");

ALTER TABLE "intents" ADD COLUMN "note" TEXT;
