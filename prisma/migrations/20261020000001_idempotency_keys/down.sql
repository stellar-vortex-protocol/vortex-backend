-- Reverses 20261020000001_idempotency_keys. Stored responses are lost, so a
-- retry after rollback is processed as a new request.
DROP TABLE IF EXISTS "idempotency_keys";
DROP TYPE IF EXISTS "idempotency_key_status";
