-- Reverse the api_credentials_intent_search migration.
-- Drops the intent-search indexes, the usd_value_at_create column, the
-- solver_credentials and api_keys tables, and the ApiKeyTier enum.

-- DropIndex
DROP INDEX IF EXISTS "intents_solver_created_idx";

-- DropIndex
DROP INDEX IF EXISTS "intents_deadline_idx";

-- DropIndex
DROP INDEX IF EXISTS "intents_created_at_idx";

-- DropIndex
DROP INDEX IF EXISTS "intents_usd_value_at_create_idx";

-- DropIndex
DROP INDEX IF EXISTS "solver_credentials_solver_address_idx";

-- DropIndex
DROP INDEX IF EXISTS "solver_credentials_cred_prefix_key";

-- DropIndex
DROP INDEX IF EXISTS "api_keys_tier_idx";

-- DropIndex
DROP INDEX IF EXISTS "api_keys_key_prefix_key";

-- AlterTable
ALTER TABLE "intents" DROP COLUMN IF EXISTS "usd_value_at_create";

-- DropTable
DROP TABLE IF EXISTS "solver_credentials";

-- DropTable
DROP TABLE IF EXISTS "api_keys";

-- DropEnum
DROP TYPE IF EXISTS "ApiKeyTier";
