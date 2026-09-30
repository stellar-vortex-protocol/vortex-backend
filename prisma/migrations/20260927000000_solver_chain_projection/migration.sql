-- Migration: 20260927000000_solver_chain_projection
-- Issue #399: Index solver-registry contract events into the Solvers table.
--
-- Adds two columns to the solvers table:
--   source              — "api" (REST registration) | "chain" (on-chain event projection)
--   chain_updated_ledger — ledger sequence of the most recent on-chain event applied to this row

ALTER TABLE "solvers"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'api',
  ADD COLUMN "chain_updated_ledger" INTEGER;

-- Index for efficient lookup of chain-sourced solver records (e.g. to detect
-- drift between on-chain state and the local projection).
CREATE INDEX "solvers_source_idx" ON "solvers" ("source");
