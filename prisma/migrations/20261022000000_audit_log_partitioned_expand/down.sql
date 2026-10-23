-- Rollback for issue #407 phase 1. The live table was never modified (only
-- a trigger was added), so dropping the shadow table loses nothing.
SET LOCAL lock_timeout = '1s';
DROP TRIGGER IF EXISTS "intent_audit_log_mirror" ON "intent_audit_log";
DROP FUNCTION IF EXISTS "intent_audit_log_mirror"();
DROP TABLE IF EXISTS "intent_audit_log_p" CASCADE;
DROP FUNCTION IF EXISTS "intent_audit_log_ensure_partition"(regclass, date);
