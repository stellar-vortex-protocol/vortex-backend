-- Rollback for 20260927000000_processed_events_dead_letters.
--
-- Drops the two event-ing tables this migration creates so a fresh
-- database returns to its pre-migration (empty) state. The provisional,
-- network-keyed tables this migration replaced (see the header of
-- migration.sql) are NOT recreated on rollback: they only exist on
-- databases that ran 20260926000000 before this migration, and losing
-- their (superseded) content is the documented limitation of this
-- rollback. Re-running migration.sql restores the final shape.
DROP TABLE IF EXISTS "processed_events";
DROP TABLE IF EXISTS "dead_letter_events";
