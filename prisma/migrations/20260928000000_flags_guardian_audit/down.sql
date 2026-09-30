-- Rollback for 20260928000000_flags_guardian_audit.
DROP TABLE IF EXISTS "guardian_actions";
DROP TABLE IF EXISTS "flag_change_requests";
DROP TABLE IF EXISTS "feature_flags";
DROP TABLE IF EXISTS "admin_audit_log";
