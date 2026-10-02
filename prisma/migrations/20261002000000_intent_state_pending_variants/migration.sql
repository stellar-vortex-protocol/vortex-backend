-- Issue #385: submitted-but-unconfirmed intent variants.
--
-- prisma/schema.prisma's `IntentState` enum declares these four values, but
-- the init migration only created the original six — a fresh database would
-- reject `pending_open` / `pending_accepted` / `pending_filled` /
-- `pending_cancelled` writes at runtime even though the generated client
-- accepts them. ALTER TYPE ... ADD VALUE (rather than CREATE TYPE) keeps the
-- statement additive: it never rewrites or locks existing rows.
--
-- IF NOT EXISTS keeps the migration re-runnable against databases where a
-- earlier partial attempt already added a value.
ALTER TYPE "IntentState" ADD VALUE IF NOT EXISTS 'pending_open';
ALTER TYPE "IntentState" ADD VALUE IF NOT EXISTS 'pending_accepted';
ALTER TYPE "IntentState" ADD VALUE IF NOT EXISTS 'pending_filled';
ALTER TYPE "IntentState" ADD VALUE IF NOT EXISTS 'pending_cancelled';
