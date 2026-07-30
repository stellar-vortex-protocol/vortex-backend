-- CreateEnum
CREATE TYPE "IntentState" AS ENUM ('open', 'accepted', 'filled', 'cancelled', 'expired', 'slashed');

-- CreateEnum
CREATE TYPE "SupportedChain" AS ENUM ('stellar', 'ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'avalanche');

-- CreateTable
CREATE TABLE "intents" (
    "id"               TEXT        NOT NULL,
    "intent_id"        TEXT        NOT NULL,
    "user"             TEXT        NOT NULL,
    "src_chain"        "SupportedChain" NOT NULL,
    "src_token"        JSONB       NOT NULL,
    "src_amount"       TEXT        NOT NULL,
    "dst_token"        JSONB       NOT NULL,
    "min_dst_amount"   TEXT        NOT NULL,
    "quoted_dst_amount" TEXT,
    "solver"           TEXT,
    "state"            "IntentState" NOT NULL DEFAULT 'open',
    "created_at"       INTEGER     NOT NULL,
    "deadline"         INTEGER     NOT NULL,
    "filled_at"        INTEGER,
    "fill_amount"      TEXT,
    "tx_hash"          TEXT,

    CONSTRAINT "intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solvers" (
    "id"               TEXT        NOT NULL,
    "address"          TEXT        NOT NULL,
    "name"             TEXT        NOT NULL,
    "bond_amount"      TEXT        NOT NULL,
    "fills_completed"  INTEGER     NOT NULL DEFAULT 0,
    "fills_failed"     INTEGER     NOT NULL DEFAULT 0,
    "total_volume"     TEXT        NOT NULL DEFAULT '0',
    "avg_fill_time"    DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_active"        BOOLEAN     NOT NULL DEFAULT true,
    "registered_at"    INTEGER     NOT NULL,
    "supported_chains" JSONB       NOT NULL,
    "supported_tokens" JSONB       NOT NULL,

    CONSTRAINT "solvers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id"        TEXT    NOT NULL,
    "address"   TEXT    NOT NULL,
    "symbol"    TEXT    NOT NULL,
    "name"      TEXT    NOT NULL,
    "decimals"  INTEGER NOT NULL,
    "chain"     "SupportedChain" NOT NULL,
    "logo_uri"  TEXT,
    "price_usd" DOUBLE PRECISION,
    "is_stellar" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "intents_intent_id_key" ON "intents"("intent_id");
CREATE INDEX "intents_user_idx"   ON "intents"("user");
CREATE INDEX "intents_state_idx"  ON "intents"("state");
CREATE INDEX "intents_solver_idx" ON "intents"("solver");

-- CreateIndex
CREATE UNIQUE INDEX "solvers_address_key" ON "solvers"("address");
CREATE INDEX "solvers_is_active_idx" ON "solvers"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_address_chain_key" ON "tokens"("address", "chain");
CREATE INDEX "tokens_chain_idx"  ON "tokens"("chain");
CREATE INDEX "tokens_symbol_idx" ON "tokens"("symbol");
