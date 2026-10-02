-- Down: #410 — Normalise intent token data into foreign keys (phase 1).
--
-- Reverses the expand/contract phase-1 migration: drops the volume indexes,
-- the deferred foreign keys, then the FK/snapshot columns.  The JSON blobs
-- (src_token / dst_token) were retained throughout, so no data is lost.

DROP INDEX IF EXISTS "intents_volume_by_dst_token_idx";
DROP INDEX IF EXISTS "intents_volume_by_token_idx";

ALTER TABLE "intents" DROP CONSTRAINT IF EXISTS "intents_dst_token_id_fkey";
ALTER TABLE "intents" DROP CONSTRAINT IF EXISTS "intents_src_token_id_fkey";

ALTER TABLE "intents"
  DROP COLUMN IF EXISTS "dst_decimals",
  DROP COLUMN IF EXISTS "src_decimals",
  DROP COLUMN IF EXISTS "dst_token_id",
  DROP COLUMN IF EXISTS "src_token_id";
