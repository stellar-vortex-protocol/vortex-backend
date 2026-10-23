-- Issue #406: enforce the intent state machine at the database layer.
--
-- Every UPDATE that changes intents.state must move along an edge listed in
-- intent_state_transitions. The table is seeded from TRANSITION_TABLE in
-- src/intents/state-machine.ts; the block between the GENERATED markers is
-- produced by renderAllowedPairsSql() and checked for drift by
-- `npm run check:state-machine` (and src/intents/state-machine-sql.spec.ts).
-- Do not edit it by hand.
--
-- Compensation edges (slashed -> filled / expired, the slashing saga's
-- rollback) are deliberately absent: they pass only when the writing
-- transaction sets the override flag first:
--
--   SELECT set_config('vortex.intent_state_override', 'on', true);
--
-- The flag is transaction-local, so it cannot leak to other statements on a
-- pooled connection.
--
-- Locking: CREATE TABLE and CREATE TRIGGER take short catalog locks; no
-- existing row is read or rewritten.

CREATE TABLE IF NOT EXISTS "intent_state_transitions" (
    "from_state" "IntentState" NOT NULL,
    "to_state"   "IntentState" NOT NULL,
    "kind"       TEXT          NOT NULL,
    CONSTRAINT "intent_state_transitions_pkey" PRIMARY KEY ("from_state", "to_state")
);

-- BEGIN GENERATED: intent_state_transitions (src/intents/state-machine.ts)
INSERT INTO "intent_state_transitions" ("from_state", "to_state", "kind") VALUES
  ('open', 'accepted', 'lifecycle'),
  ('open', 'cancelled', 'lifecycle'),
  ('open', 'expired', 'lifecycle'),
  ('open', 'pending_open', 'park'),
  ('open', 'pending_accepted', 'park'),
  ('open', 'pending_cancelled', 'park'),
  ('accepted', 'filled', 'lifecycle'),
  ('accepted', 'slashed', 'lifecycle'),
  ('accepted', 'pending_accepted', 'park'),
  ('accepted', 'pending_filled', 'park'),
  ('accepted', 'pending_cancelled', 'park'),
  ('filled', 'pending_filled', 'park'),
  ('cancelled', 'pending_cancelled', 'park'),
  ('pending_open', 'open', 'confirm'),
  ('pending_accepted', 'accepted', 'confirm'),
  ('pending_filled', 'filled', 'confirm'),
  ('pending_cancelled', 'cancelled', 'confirm')
ON CONFLICT DO NOTHING;
-- END GENERATED: intent_state_transitions

CREATE OR REPLACE FUNCTION "intents_enforce_state_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('vortex.intent_state_override', true) = 'on' THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        SELECT 1 FROM "intent_state_transitions"
        WHERE "from_state" = OLD."state" AND "to_state" = NEW."state"
    ) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'illegal intent state transition % -> % (intent_id=%)',
        OLD."state", NEW."state", OLD."intent_id"
        USING ERRCODE = 'check_violation',
              HINT = 'Allowed edges live in intent_state_transitions; compensations need vortex.intent_state_override';
END;
$$;

DROP TRIGGER IF EXISTS "intents_enforce_state_transition" ON "intents";
CREATE TRIGGER "intents_enforce_state_transition"
    BEFORE UPDATE OF "state" ON "intents"
    FOR EACH ROW
    WHEN (OLD."state" IS DISTINCT FROM NEW."state")
    EXECUTE FUNCTION "intents_enforce_state_transition"();
