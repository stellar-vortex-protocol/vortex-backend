-- Rollback for 20260928000002_pending_slashes.
-- WARNING: drops saga state. Any slash still in challenge_window/submitted is
-- forgotten; reconcile those manually (docs/runbooks/slash-cancellation.md).
DROP TABLE IF EXISTS "pending_slashes";
DROP TYPE IF EXISTS "PendingSlashState";
