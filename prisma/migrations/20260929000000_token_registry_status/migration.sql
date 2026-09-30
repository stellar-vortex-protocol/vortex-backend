-- Soft token lifecycle for the admin registry (issue #435).
-- Existing rows stay active. Stellar rows are marked SAC; EVM rows stay evm.
-- Rollback: drop the new columns and the TokenStatus enum. Intent rows do not
-- reference tokens by foreign key, so dropping these columns does not cascade.

CREATE TYPE "TokenStatus" AS ENUM ('active', 'paused', 'delisted');

ALTER TABLE "tokens" ADD COLUMN "status" "TokenStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "tokens" ADD COLUMN "asset_kind" TEXT;

UPDATE "tokens"
SET "asset_kind" = CASE WHEN "is_stellar" THEN 'stellar-sac' ELSE 'evm' END
WHERE "asset_kind" IS NULL;

ALTER TABLE "tokens" ALTER COLUMN "asset_kind" SET NOT NULL;
ALTER TABLE "tokens" ALTER COLUMN "asset_kind" SET DEFAULT 'evm';
