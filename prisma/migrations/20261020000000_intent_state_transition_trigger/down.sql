-- Rollback for issue #406: removes the state-transition trigger, its function
-- and the allowed-pairs table. No data is lost; intents keep their states.
DROP TRIGGER IF EXISTS "intents_enforce_state_transition" ON "intents";
DROP FUNCTION IF EXISTS "intents_enforce_state_transition"();
DROP TABLE IF EXISTS "intent_state_transitions";
