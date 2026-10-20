-- Runtime-managed abuse allowlist (issue #605).

CREATE TYPE "AbuseAllowlistEntryType" AS ENUM ('address', 'ip', 'api_key');

CREATE TABLE "abuse_allowlist_entries" (
    "id" TEXT NOT NULL,
    "type" "AbuseAllowlistEntryType" NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    CONSTRAINT "abuse_allowlist_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX CONCURRENTLY "abuse_allowlist_entries_type_value_key" ON "abuse_allowlist_entries"("type", "value");
